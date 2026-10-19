import { describe, expect, it, vi } from 'vitest'
import type { CachedSheet } from '../../petdex/cache.ts'
import { tintColour } from '../../petdex/draw.ts'
import type { RoomAgent } from '../model/types.ts'
import type { PetFrame } from './engine.ts'
import { layoutRoom } from './layout.ts'
import { FEET, FIGURE_TONE, paintPets, spriteRect } from './paint.ts'

const sheet = { key: 'boba@1', slug: 'boba', sheet: { url: '', width: 1, height: 1, layout: { columns: 1, rows: 1, rowNames: ['idle'], frames: [1] } }, image: {} } as unknown as CachedSheet

function frame(id: string, patch: Partial<PetFrame> = {}): PetFrame {
  return { id, agent: { id } as RoomAgent, x: 100, y: 200, opacity: 1, pose: 'idle', cell: { row: 0, frame: 2, mirror: false, nextAt: null }, sheet, fallback: false, tint: null, leaving: false, ...patch }
}

/** A 2D context that writes down what is asked of it. */
function recorder() {
  const calls: { name: string; args: unknown[]; alpha: number; fill: unknown }[] = []
  const ctx: Record<string, unknown> = { globalAlpha: 1, fillStyle: '' }
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args, alpha: ctx.globalAlpha as number, fill: ctx.fillStyle })

      return name === 'createRadialGradient' ? { addColorStop: vi.fn() } : undefined
    }

  for (const name of ['setTransform', 'clearRect', 'createRadialGradient', 'save', 'restore', 'translate', 'scale', 'beginPath', 'arc', 'fill', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'closePath', 'stroke']) {
    ctx[name] = record(name)
  }

  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

/** Every point a path went to or curved towards. */
const pathPoints = (calls: ReturnType<typeof recorder>['calls']): { x: number; y: number }[] =>
  calls.flatMap(call => {
    const args = call.args as number[]
    const pairs = ['moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo'].includes(call.name) ? args.length / 2 : 0

    return Array.from({ length: pairs }, (_, index) => ({ x: args[index * 2], y: args[index * 2 + 1] }))
  })

describe('paintPets', () => {
  const layout = layoutRoom(1100, 620)

  it('scales to device pixels and clears the scene first', () => {
    const { ctx, calls } = recorder()
    paintPets(ctx, [], layout, 2, vi.fn())

    expect(calls[0]).toMatchObject({ name: 'setTransform', args: [2, 0, 0, 2, 0, 0] })
    expect(calls[1]).toMatchObject({ name: 'clearRect', args: [0, 0, layout.width, layout.height] })
  })

  it('draws each pet in the order given, on a shadow at its feet, with its cell and tint', () => {
    const { ctx, calls } = recorder()
    const draw = vi.fn()
    paintPets(ctx, [frame('back', { y: 150 }), frame('front', { y: 400, tint: 2, cell: { row: 1, frame: 3, mirror: true, nextAt: 5 } })], layout, 1, draw)

    expect(draw.mock.calls.map(call => call[2])).toEqual([
      { row: 0, frame: 2, mirror: false },
      { row: 1, frame: 3, mirror: true }
    ])
    expect(draw.mock.calls[1][3]).toEqual(spriteRect({ x: 100, y: 400 }, layout.pet))
    expect(draw.mock.calls[1][4]).toBe(2)
    expect(calls.filter(call => call.name === 'translate').map(call => call.args)).toEqual([
      [100, 150],
      [100, 400]
    ])
  })

  it('fades a pet as a whole, and skips one that is not visible at all', () => {
    const { ctx, calls } = recorder()
    const draw = vi.fn()
    paintPets(ctx, [frame('fading', { opacity: 0.25 }), frame('gone', { opacity: 0 })], layout, 1, draw)

    expect(draw).toHaveBeenCalledTimes(1)
    expect(calls.filter(call => call.name === 'fill').map(call => call.alpha)).toEqual([0.25])
  })

  it('draws only the shadow of a pet whose sheet is not in yet', () => {
    const { ctx, calls } = recorder()
    const draw = vi.fn()
    paintPets(ctx, [frame('waiting', { sheet: null, cell: null })], layout, 1, draw)

    expect(draw).not.toHaveBeenCalled()
    expect(calls.filter(call => call.name === 'fill')).toHaveLength(1)
    expect(calls.some(call => call.name === 'stroke')).toBe(false)
  })

  it('draws a plain figure on its shadow for a pet whose sheet cannot be had, in its tint or a neutral tone, faded like a sprite', () => {
    const { ctx, calls } = recorder()
    const draw = vi.fn()
    paintPets(ctx, [frame('tinted', { sheet: null, cell: null, fallback: true, tint: 2 }), frame('plain', { sheet: null, cell: null, fallback: true, opacity: 0.5 })], layout, 1, draw)
    const fills = calls.filter(call => call.name === 'fill')

    expect(draw).not.toHaveBeenCalled()
    expect(fills.map(call => (typeof call.fill === 'string' ? [call.fill, call.alpha] : 'shadow'))).toEqual(['shadow', [tintColour(2), 1], [tintColour(2), 1], 'shadow', [FIGURE_TONE, 0.5], [FIGURE_TONE, 0.5]])
    expect(tintColour(2)).not.toBe(FIGURE_TONE)
  })

  it('stands the figure in the frame a sprite would fill, its base at the pet’s feet', () => {
    const { ctx, calls } = recorder()
    paintPets(ctx, [frame('plain', { x: 300, y: 400, sheet: null, cell: null, fallback: true })], layout, 1, vi.fn())
    const rect = spriteRect({ x: 300, y: 400 }, layout.pet)
    const points = pathPoints(calls)

    expect(points.length).toBeGreaterThan(0)
    expect(points.every(point => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= 400 + 1e-6)).toBe(true)
    expect(Math.max(...points.map(point => point.y))).toBeCloseTo(400)
    expect(Math.min(...points.map(point => point.x)) + Math.max(...points.map(point => point.x))).toBeCloseTo(600)
  })

  it('stands a pet with its feet near the bottom of its frame', () => {
    const rect = spriteRect({ x: 100, y: 200 }, layout.pet)

    expect(rect.x + rect.width / 2).toBe(100)
    expect(rect.y + rect.height * FEET).toBeCloseTo(200)
  })
})
