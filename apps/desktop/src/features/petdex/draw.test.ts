import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PET_FRAME_HEIGHT, PET_FRAME_WIDTH } from '../../../shared/pet.ts'
import type { CachedSheet } from './cache.ts'
import { cellSource, drawPetFrame, PET_TINTS, tintFilter } from './draw.ts'

/** A 2D context that writes down what is done to it, and every filter it is given. */
function recorder() {
  const calls: unknown[][] = []
  const filters: string[] = []
  const ctx = {
    imageSmoothingQuality: 'low',
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    translate: (x: number, y: number) => calls.push(['translate', x, y]),
    scale: (x: number, y: number) => calls.push(['scale', x, y]),
    clearRect: (...args: number[]) => calls.push(['clearRect', ...args]),
    drawImage: (...args: unknown[]) => {
      calls.push(['drawImage', ...args])
      expect(ctx.imageSmoothingQuality === 'high' || filters.length > 0).toBe(true)
    },
    get filter() {
      return filters.at(-1) ?? 'none'
    },
    set filter(value: string) {
      filters.push(value)
    }
  }

  return { ctx, calls, filters }
}

const image = { name: 'decoded sheet' } as unknown as CanvasImageSource
const cached: CachedSheet = { key: 'boba@1', slug: 'boba', image, sheet: { url: 'blob:boba', width: 8 * PET_FRAME_WIDTH, height: 9 * PET_FRAME_HEIGHT, layout: { columns: 8, rows: 9, rowNames: [], frames: [] } } }
const dest = { x: 10, y: 20, width: 96, height: 104 }

describe('PET_TINTS', () => {
  it('starts with the pet’s own colours, then seven hue turns', () => {
    expect(PET_TINTS[0]).toEqual({ hue: 0, label: 'own colours' })
    expect(PET_TINTS.length - 1).toBeGreaterThanOrEqual(6)
    expect(PET_TINTS.length - 1).toBeLessThanOrEqual(8)
    expect(new Set(PET_TINTS.map(tint => tint.label)).size).toBe(PET_TINTS.length)
    PET_TINTS.slice(1).forEach(tint => expect(tint.hue > 0 && tint.hue < 360).toBe(true))
  })

  it('keeps every two tints clearly apart, and the first ones furthest apart', () => {
    const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))
    const hues = PET_TINTS.map(tint => tint.hue)

    hues.forEach((hue, index) => hues.slice(index + 1).forEach(other => expect(apart(hue, other)).toBeGreaterThanOrEqual(40)))
    hues.slice(0, 4).forEach((hue, index) => hues.slice(index + 1, 4).forEach(other => expect(apart(hue, other)).toBeGreaterThanOrEqual(90)))
  })
})

describe('tintFilter', () => {
  it('turns the hue and lifts the saturation a little for a tint, and leaves own colours alone', () => {
    expect(tintFilter(1)).toBe(`hue-rotate(${PET_TINTS[1].hue}deg) saturate(1.2)`)
    PET_TINTS.slice(1).forEach((tint, index) => expect(tintFilter(index + 1)).toContain(`hue-rotate(${tint.hue}deg)`))

    for (const own of [null, 0, -1, 1.5, PET_TINTS.length, Number.NaN]) {
      expect(tintFilter(own)).toBeNull()
    }
  })
})

describe('cellSource', () => {
  it('finds a frame by column and its row by height', () => {
    expect(cellSource(cached.sheet.layout, { row: 2, frame: 3 })).toEqual({ x: 3 * PET_FRAME_WIDTH, y: 2 * PET_FRAME_HEIGHT, width: PET_FRAME_WIDTH, height: PET_FRAME_HEIGHT })
    expect(cellSource(cached.sheet.layout, { row: 0, frame: 0 })).toEqual({ x: 0, y: 0, width: 192, height: 208 })
  })

  it('stays on the sheet', () => {
    expect(cellSource({ columns: 8, rows: 9 }, { row: 40, frame: 99 })).toMatchObject({ x: 7 * PET_FRAME_WIDTH, y: 8 * PET_FRAME_HEIGHT })
    expect(cellSource({ columns: 8, rows: 9 }, { row: -3, frame: Number.NaN })).toMatchObject({ x: 0, y: 0 })
    expect(cellSource({ columns: 9, rows: 8 }, { row: 7.9, frame: 8.2 })).toMatchObject({ x: 8 * PET_FRAME_WIDTH, y: 7 * PET_FRAME_HEIGHT })
  })
})

describe('drawPetFrame', () => {
  it('draws one cell of the sheet into its place', () => {
    const { ctx, calls, filters } = recorder()

    drawPetFrame(ctx as unknown as CanvasRenderingContext2D, cached, { row: 1, frame: 4, mirror: false }, dest, null)

    expect(calls).toEqual([['save'], ['drawImage', image, 4 * PET_FRAME_WIDTH, PET_FRAME_HEIGHT, PET_FRAME_WIDTH, PET_FRAME_HEIGHT, 10, 20, 96, 104], ['restore']])
    expect(filters).toEqual([])
  })

  it('flips a mirrored cell within its place', () => {
    const { ctx, calls } = recorder()

    drawPetFrame(ctx as unknown as CanvasRenderingContext2D, cached, { row: 2, frame: 0, mirror: true }, dest, 0)

    expect(calls).toEqual([['save'], ['translate', 106, 20], ['scale', -1, 1], ['drawImage', image, 0, 2 * PET_FRAME_HEIGHT, PET_FRAME_WIDTH, PET_FRAME_HEIGHT, 0, 0, 96, 104], ['restore']])
  })

  describe('with a tint', () => {
    const made: { ctx: ReturnType<typeof recorder> }[] = []

    beforeAll(() => {
      vi.stubGlobal(
        'OffscreenCanvas',
        class {
          readonly drawing = recorder()

          constructor() {
            made.push({ ctx: this.drawing })
          }

          getContext() {
            return this.drawing.ctx
          }
        }
      )
    })

    afterAll(() => {
      vi.unstubAllGlobals()
    })

    it('tints through one reusable cell-sized canvas, and never leaves a filter on the window’s canvas', () => {
      const first = recorder()
      const second = recorder()

      drawPetFrame(first.ctx as unknown as CanvasRenderingContext2D, cached, { row: 3, frame: 2, mirror: false }, dest, 2)
      drawPetFrame(second.ctx as unknown as CanvasRenderingContext2D, cached, { row: 0, frame: 1, mirror: true }, dest, 5)

      expect(made).toHaveLength(1)
      const cell = made[0].ctx
      expect(cell.filters).toEqual(['none', tintFilter(2), 'none', 'none', tintFilter(5), 'none'])
      expect(cell.calls.filter(call => call[0] === 'drawImage')).toEqual([
        ['drawImage', image, 2 * PET_FRAME_WIDTH, 3 * PET_FRAME_HEIGHT, PET_FRAME_WIDTH, PET_FRAME_HEIGHT, 0, 0, PET_FRAME_WIDTH, PET_FRAME_HEIGHT],
        ['drawImage', image, PET_FRAME_WIDTH, 0, PET_FRAME_WIDTH, PET_FRAME_HEIGHT, 0, 0, PET_FRAME_WIDTH, PET_FRAME_HEIGHT]
      ])

      const scratch = first.calls.find(call => call[0] === 'drawImage')![1]
      expect(scratch).not.toBe(image)
      expect(first.calls).toEqual([['save'], ['drawImage', scratch, 0, 0, PET_FRAME_WIDTH, PET_FRAME_HEIGHT, 10, 20, 96, 104], ['restore']])
      expect(second.calls).toEqual([['save'], ['translate', 106, 20], ['scale', -1, 1], ['drawImage', scratch, 0, 0, PET_FRAME_WIDTH, PET_FRAME_HEIGHT, 0, 0, 96, 104], ['restore']])
      expect(first.filters).toEqual([])
      expect(second.filters).toEqual([])
    })

    it('draws own colours straight from the sheet', () => {
      const { ctx, calls } = recorder()
      const before = made[0].ctx.calls.length

      drawPetFrame(ctx as unknown as CanvasRenderingContext2D, cached, { row: 0, frame: 0, mirror: false }, dest, PET_TINTS.length)

      expect(calls[1]).toEqual(['drawImage', image, 0, 0, PET_FRAME_WIDTH, PET_FRAME_HEIGHT, 10, 20, 96, 104])
      expect(made[0].ctx.calls.length).toBe(before)
    })
  })
})
