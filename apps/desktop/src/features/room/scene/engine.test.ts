import { describe, expect, it, vi } from 'vitest'
import { PET_FRAME_HEIGHT, PET_FRAME_WIDTH } from '../../../../shared/pet.ts'
import type { RoomMotion } from '../../../../shared/room.ts'
import { layoutFromBlanks } from '../../pet/sprite.ts'
import type { CachedSheet } from '../../petdex/cache.ts'
import type { RoomAgent, RoomHandoff } from '../model/types.ts'
import { BUBBLE_MS } from './choreography.ts'
import { createRoomEngine, type PetFrame, type PetMarks, paintKey, type SceneInput, SETTLE_MS } from './engine.ts'
import { layoutRoom, slotPoint } from './layout.ts'
import { FADE_MS } from './motion.ts'
import { MOVING_TICK_MS } from './poses.ts'
import type { SheetHolder, SheetState } from './sheets.ts'

// The shared cache's module reads the preload bridge when it loads; tests run without a DOM.
vi.hoisted(() => {
  Object.assign(globalThis, { window: { innerWidth: 1440, innerHeight: 900 } })
})

const KEY = 'room-test'

function agent(id: string, patch: Partial<RoomAgent> = {}): RoomAgent {
  return {
    id,
    kind: 'conversation',
    sessionId: 's1',
    sessionKey: null,
    title: id,
    parentId: null,
    phase: 'idle',
    area: 'lounge',
    target: null,
    step: null,
    tool: null,
    startedAt: 1,
    turnStartedAt: null,
    lastEventAt: 1,
    approval: null,
    asking: null,
    repeat: null,
    guardrail: null,
    result: null,
    toolCount: null,
    desk: null,
    automation: null,
    elsewhere: null,
    usage: null,
    trace: {},
    ...patch
  }
}

function handoff(kind: RoomHandoff['kind'], from: string, to: string, at: number): RoomHandoff {
  return { id: `${kind}:${from}:${to}`, kind, from, to, at, trace: { source: 'frame', type: kind === 'note' ? 'subagent.spawn' : 'subagent.complete', at } }
}

const codex = layoutFromBlanks(8 * PET_FRAME_WIDTH, 9 * PET_FRAME_HEIGHT, (column, row) => column >= [6, 8, 8, 4, 5, 8, 6, 8, 7][row])

const sheetFor = (slug: string): CachedSheet => ({ key: `${slug}@1`, slug, sheet: { url: '', width: 1, height: 1, layout: codex }, image: {} as CanvasImageSource })

/** A clock with one key, run by hand: each tick due by then, at its own time. */
function fakeClock() {
  let time = 1_000_000
  let ran = time
  let pending: { at: number; tick: (now: number) => void } | null = null
  const clock = {
    schedule: vi.fn((_key: string, at: number, tick: (now: number) => void) => {
      pending = { at, tick }
    }),
    cancel: vi.fn(() => {
      pending = null
    })
  }

  return {
    clock,
    now: () => time,
    /** When the last tick ran. */
    ran: () => ran,
    pending: () => pending,
    advance(ms: number) {
      const until = time + ms

      while (pending && pending.at <= until) {
        const { at, tick } = pending
        pending = null
        time = Math.max(time, at)
        ran = time
        tick(time)
      }

      time = until
    }
  }
}

/** `sheet` says how every held sheet is doing, and can change as a test goes. */
function setup({ motion = 'full', loaded = true, failed = false, running = true }: { motion?: RoomMotion; loaded?: boolean; failed?: boolean; running?: boolean } = {}) {
  const time = fakeClock()
  const frames: PetFrame[][] = []
  const marks: { marks: Readonly<Record<string, PetMarks>>; gone: ReadonlySet<string> }[] = []
  const sheet = { loaded, failed }
  const sheets: SheetHolder = {
    hold: vi.fn(),
    get: vi.fn((slug: string) => (sheet.loaded ? sheetFor(slug) : null)),
    state: vi.fn((): SheetState => (sheet.loaded ? 'ready' : sheet.failed ? 'failed' : 'loading')),
    dispose: vi.fn()
  }
  const engine = createRoomEngine({ clock: time.clock, key: KEY, sheets, paint: drawn => frames.push([...drawn]), marks: (next, gone) => marks.push({ marks: next, gone }), now: time.now })
  const layout = layoutRoom(1100, 620)
  engine.setLayout(layout)

  if (running) {
    engine.setRunning(true)
  }

  const last = () => frames[frames.length - 1] ?? []
  const pet = (id: string) => last().find(frame => frame.id === id)
  const mark = () => marks[marks.length - 1] ?? { marks: {}, gone: new Set<string>() }
  const feed = (agents: RoomAgent[], patch: Partial<SceneInput> = {}) =>
    engine.setInput({
      agents,
      known: new Set(agents.map(entry => entry.id)),
      handoffs: [],
      assignment: Object.fromEntries(agents.map(entry => [entry.id, { slug: 'boba', tint: null }])),
      installed: [{ slug: 'boba', displayName: 'Boba', revision: '1', mime: 'image/png' }],
      motion,
      settled: true,
      ...patch
    })

  return { time, engine, layout, frames, marks, sheet, sheets, last, pet, mark, feed }
}

describe('the room engine', () => {
  it('paints nothing when a tick would draw the same again, and paints again when woken', () => {
    const scene = setup({ motion: 'still' })
    scene.feed([agent('a', { phase: 'idle', area: 'lounge' })])
    scene.time.advance(1000)
    const painted = scene.frames.length

    scene.feed([agent('a', { phase: 'idle', area: 'lounge', lastEventAt: 5 })])
    scene.time.advance(1000)

    expect(scene.frames).toHaveLength(painted)

    scene.engine.wake()
    scene.time.advance(1)

    expect(scene.frames).toHaveLength(painted + 1)
  })

  it('does nothing until it runs, and stops ticking when it stops', () => {
    const scene = setup({ running: false })
    scene.feed([agent('a')])
    scene.time.advance(1000)

    expect(scene.time.clock.schedule).not.toHaveBeenCalled()
    expect(scene.frames).toHaveLength(0)

    scene.engine.setRunning(true)
    scene.time.advance(SETTLE_MS)

    expect(scene.frames.length).toBeGreaterThan(0)

    scene.engine.setRunning(false)
    const painted = scene.frames.length
    scene.time.advance(60_000)

    expect(scene.time.clock.cancel).toHaveBeenCalledWith(KEY)
    expect(scene.time.pending()).toBeNull()
    expect(scene.frames).toHaveLength(painted)
  })

  it('runs on one clock key only', () => {
    const scene = setup()
    scene.feed([agent('a'), agent('b', { phase: 'tool', area: 'terminal' })])
    scene.time.advance(5000)
    scene.engine.dispose()

    expect(scene.time.clock.schedule.mock.calls.every(call => call[0] === KEY)).toBe(true)
    expect(scene.time.clock.cancel.mock.calls.every(call => (call as unknown[])[0] === KEY)).toBe(true)
    expect(scene.sheets.dispose).toHaveBeenCalled()
  })

  it('puts the pets already there at their spots at once and does not replay old hand-offs', () => {
    const scene = setup()
    scene.feed([agent('p', { phase: 'tool', area: 'docs' }), agent('h', { kind: 'helper', parentId: 'p', phase: 'tool', area: 'terminal' })], { handoffs: [handoff('note', 'p', 'h', 1_000_000)] })
    scene.time.advance(SETTLE_MS)

    expect(scene.pet('p')).toMatchObject({ ...slotPoint(scene.layout, 'docs', 0), pose: 'run', opacity: 1 })
    expect(scene.pet('h')).toMatchObject({ ...slotPoint(scene.layout, 'terminal', 0), pose: 'run' })
    expect(scene.mark().marks).toEqual({})
  })

  it('lets what arrives while the Room catches up appear at its spot, without acting out its hand-off', () => {
    const scene = setup()
    const parent = agent('p', { phase: 'tool', area: 'docs' })
    scene.feed([parent])
    scene.time.advance(100)
    scene.feed([parent, agent('h', { kind: 'helper', parentId: 'p', phase: 'tool', area: 'terminal', startedAt: 2 })], { handoffs: [handoff('note', 'p', 'h', scene.time.now())] })
    scene.time.advance(1)

    expect(scene.pet('h')).toMatchObject(slotPoint(scene.layout, 'terminal', 0))

    scene.time.advance(SETTLE_MS + 1000)

    expect(scene.marks.every(entry => Object.keys(entry.marks).length === 0)).toBe(true)
    expect(scene.pet('p')).toMatchObject(slotPoint(scene.layout, 'docs', 0))
  })

  it('catches up the same way after a long pause', () => {
    const scene = setup()
    scene.feed([agent('a')])
    scene.time.advance(SETTLE_MS)
    scene.engine.setRunning(false)
    scene.time.advance(60_000)
    scene.feed([agent('a'), agent('b', { area: 'canvas', startedAt: 2 })])
    scene.engine.setRunning(true)
    scene.time.advance(1)

    expect(scene.pet('b')).toMatchObject(slotPoint(scene.layout, 'canvas', 0))

    scene.time.advance(SETTLE_MS)
    scene.feed([agent('a'), agent('b', { area: 'canvas', startedAt: 2 }), agent('c', { area: 'docs', startedAt: 3 })])
    scene.time.advance(1)

    expect(Math.hypot(scene.pet('c')!.x - scene.layout.doorway.x, scene.pet('c')!.y - scene.layout.doorway.y)).toBeLessThan(1)
  })

  it('walks a newcomer in from the door, a frame at a time, and then rests', () => {
    const scene = setup()
    scene.feed([agent('a')])
    scene.time.advance(SETTLE_MS)
    scene.feed([agent('a'), agent('b', { phase: 'tool', area: 'canvas', startedAt: 2 })])
    scene.time.advance(1)

    const entering = scene.pet('b')!

    expect(Math.hypot(entering.x - scene.layout.doorway.x, entering.y - scene.layout.doorway.y)).toBeLessThan(1)
    expect(scene.time.pending()?.at).toBe(scene.time.ran() + MOVING_TICK_MS)

    scene.time.advance(500)

    expect(scene.pet('b')?.pose).toBe('walk-right')
    expect(scene.pet('b')!.opacity).toBe(1)

    scene.time.advance(30_000)

    expect(scene.pet('b')).toMatchObject({ ...slotPoint(scene.layout, 'canvas', 0), pose: 'run' })
    expect(scene.time.pending()).toBeNull()

    scene.feed([agent('a'), agent('b', { phase: 'tool', area: 'canvas', startedAt: 2, lastEventAt: scene.time.now() })])
    scene.time.advance(1)

    expect(scene.time.pending()!.at - scene.time.ran()).toBeGreaterThan(MOVING_TICK_MS)

    scene.feed([agent('a'), agent('b', { phase: 'idle', area: 'lounge', startedAt: 2 })])
    scene.time.advance(60_000)

    expect(scene.pet('b')).toMatchObject({ ...slotPoint(scene.layout, 'lounge', 1), pose: 'idle' })
    expect(scene.time.pending()).toBeNull()
  })

  it('puts a newcomer at its spot with a short fade when motion is calm', () => {
    const scene = setup({ motion: 'calm' })
    scene.feed([agent('a')])
    scene.time.advance(SETTLE_MS)
    scene.feed([agent('a'), agent('b', { area: 'docs', startedAt: 2 })])
    scene.time.advance(1)

    expect(scene.pet('b')).toMatchObject(slotPoint(scene.layout, 'docs', 0))
    expect(scene.pet('b')!.opacity).toBeLessThan(1)

    scene.time.advance(FADE_MS + 50)

    expect(scene.pet('b')!.opacity).toBe(1)
    expect(scene.last().some(frame => frame.pose.startsWith('walk'))).toBe(false)
  })

  it('animates nothing and schedules nothing when motion is still', () => {
    const scene = setup({ motion: 'still' })
    scene.feed([agent('a', { phase: 'tool', area: 'terminal' })])
    scene.time.advance(SETTLE_MS)

    expect(scene.pet('a')?.cell?.nextAt).toBeNull()
    expect(scene.time.pending()).toBeNull()

    scene.feed([agent('a', { phase: 'tool', area: 'terminal' }), agent('b', { area: 'docs', startedAt: 2 })])
    scene.time.advance(1)

    expect(scene.pet('b')).toMatchObject({ ...slotPoint(scene.layout, 'docs', 0), opacity: 1, pose: 'idle' })
    expect(scene.time.pending()).toBeNull()
  })

  it('plays a new note: the parent walks it over to its helper coming in at the door', () => {
    const scene = setup()
    const parent = agent('p', { phase: 'tool', area: 'docs' })
    scene.feed([parent])
    scene.time.advance(SETTLE_MS)
    const helper = agent('h', { kind: 'helper', parentId: 'p', phase: 'queued', area: 'terminal', startedAt: 2 })
    scene.feed([parent, helper], { handoffs: [handoff('note', 'p', 'h', scene.time.now())] })
    scene.time.advance(1)

    expect(scene.mark().marks.p).toEqual({ carry: 'note', bubble: null })

    scene.time.advance(400)

    expect(scene.pet('p')?.pose).toBe('walk-left')

    let handed = false

    for (let step = 0; step < 200 && !handed; step++) {
      scene.time.advance(50)
      handed = scene.mark().marks.h?.carry === 'note' && !scene.mark().marks.p
    }

    expect(handed).toBe(true)

    scene.time.advance(30_000)

    expect(scene.pet('p')).toMatchObject(slotPoint(scene.layout, 'docs', 0))
    expect(scene.pet('h')).toMatchObject(slotPoint(scene.layout, 'terminal', 0))
    expect(scene.mark().marks).toEqual({})
  })

  it('plays a result: the helper walks it back, says its summary, hands it over and leaves through the door', () => {
    const scene = setup()
    const parent = agent('p', { phase: 'thinking', area: 'docs' })
    const working = agent('h', { kind: 'helper', parentId: 'p', phase: 'tool', area: 'terminal', startedAt: 2 })
    scene.feed([parent, working])
    scene.time.advance(SETTLE_MS)
    const done = { ...working, phase: 'finished' as const, result: { status: 'completed' as const, summary: 'Found three budget files', durationSeconds: 4, filesRead: 3, filesWritten: 0, inputTokens: null, outputTokens: null, reasoningTokens: null, apiCalls: null, costUsd: null, at: 1 } }
    scene.feed([parent, done], { handoffs: [handoff('result', 'h', 'p', scene.time.now())] })
    scene.time.advance(1)
    scene.time.advance(300)

    expect(scene.pet('h')?.pose).toMatch(/^walk-/)
    expect(scene.mark().marks.h?.carry).toBe('result')

    let said = false

    for (let step = 0; step < 200 && !said; step++) {
      scene.time.advance(50)
      said = scene.mark().marks.h?.bubble === 'Found three budget files'
    }

    expect(said).toBe(true)

    scene.time.advance(BUBBLE_MS + 30_000)

    expect(scene.mark().gone.has('h')).toBe(true)
    expect(scene.pet('h')).toBeUndefined()

    scene.feed([parent, done], { handoffs: [handoff('result', 'h', 'p', 0)] })
    scene.time.advance(1000)

    expect(scene.pet('h')).toBeUndefined()
  })

  it('walks a helper out through the door when its hand-off is cut short', () => {
    const scene = setup()
    const parent = agent('p', { phase: 'thinking', area: 'docs' })
    const done = agent('h', { kind: 'helper', parentId: 'p', phase: 'finished', area: 'terminal', result: { status: 'completed', summary: 'Done', durationSeconds: 1, filesRead: 0, filesWritten: 0, inputTokens: null, outputTokens: null, reasoningTokens: null, apiCalls: null, costUsd: null, at: 1 } })
    scene.feed([parent, done])
    scene.time.advance(SETTLE_MS)
    scene.feed([parent, done], { handoffs: [handoff('result', 'h', 'p', scene.time.now())] })
    scene.time.advance(500)
    scene.feed([done], { known: new Set(['h']) })
    scene.time.advance(100)

    expect(scene.pet('h')).toMatchObject({ leaving: true })
    expect(scene.mark().gone.has('h')).toBe(true)

    scene.time.advance(30_000)

    expect(scene.pet('h')).toBeUndefined()
  })

  it('walks a pet whose agent has gone out through the door; one only crowded out goes at once', () => {
    const scene = setup()
    scene.feed([agent('a', { area: 'docs' }), agent('b', { area: 'studio' })])
    scene.time.advance(SETTLE_MS)
    scene.feed([agent('a', { area: 'docs' })])
    scene.time.advance(200)

    expect(scene.pet('b')).toMatchObject({ leaving: true })
    expect(scene.pet('b')?.pose).toMatch(/^walk-/)

    scene.time.advance(30_000)

    expect(scene.pet('b')).toBeUndefined()

    scene.feed([], { known: new Set(['a']) })
    scene.time.advance(1)

    expect(scene.pet('a')).toBeUndefined()
  })

  it('draws a pet once its sheet is in, and holds the sheets in use', () => {
    const scene = setup({ loaded: false })
    scene.feed([agent('a')])
    scene.time.advance(SETTLE_MS)

    expect(scene.pet('a')?.cell).toBeNull()
    expect(scene.sheets.hold).toHaveBeenCalledWith([{ slug: 'boba', revision: '1', mime: 'image/png' }])
  })

  it('draws a still figure for a pet whose sheet failed, never while it loads, and the sprite once it is in', () => {
    const scene = setup({ loaded: false })
    scene.feed([agent('a')])
    scene.time.advance(SETTLE_MS)

    expect(scene.pet('a')).toMatchObject({ sheet: null, cell: null, fallback: false })

    const painted = scene.frames.length
    scene.sheet.failed = true
    scene.feed([agent('a')])
    scene.time.advance(1)

    expect(scene.frames).toHaveLength(painted + 1)
    expect(scene.pet('a')).toMatchObject({ sheet: null, cell: null, fallback: true })
    expect(scene.time.pending()).toBeNull()

    scene.sheet.loaded = true
    scene.engine.wake()
    scene.time.advance(1)

    expect(scene.pet('a')?.fallback).toBe(false)
    expect(scene.pet('a')?.cell).not.toBeNull()
  })

  it('draws the figure for an installed pet main found no sheet for, and none when no pet is installed', () => {
    const scene = setup({ loaded: false })
    scene.feed([agent('a')], { installed: [{ slug: 'boba', displayName: 'Boba', revision: null, mime: null }] })
    scene.time.advance(SETTLE_MS)

    expect(scene.pet('a')?.fallback).toBe(true)
    expect(scene.sheets.hold).not.toHaveBeenCalled()

    const bare = setup({ loaded: false, failed: true })
    bare.feed([agent('a')], { installed: [], assignment: {} })
    bare.time.advance(SETTLE_MS)

    expect(bare.pet('a')).toMatchObject({ sheet: null, fallback: false })

    const removed = setup({ loaded: false, failed: true })
    removed.feed([agent('a')])
    removed.time.advance(SETTLE_MS)
    removed.feed([agent('a')], { installed: [], assignment: {} })
    removed.time.advance(1)

    expect(removed.pet('a')?.fallback).toBe(false)
  })

  it('counts the figure in what a paint shows', () => {
    const layout = layoutRoom(1100, 620)
    const shown: PetFrame = { id: 'a', agent: agent('a'), x: 10, y: 20, opacity: 1, pose: 'idle', cell: null, sheet: null, fallback: false, tint: null, leaving: false }

    expect(paintKey([shown], layout)).not.toBe(paintKey([{ ...shown, fallback: true }], layout))
  })

  it('fades an outside agent in where it first stands, never at the door', () => {
    const scene = setup()
    scene.feed([agent('a')])
    scene.time.advance(SETTLE_MS)
    scene.feed([agent('a'), agent('o', { kind: 'elsewhere', phase: 'tool', area: 'terminal', startedAt: 2 })])
    scene.time.advance(1)

    expect(scene.pet('o')).toMatchObject(slotPoint(scene.layout, 'terminal', 0))
    expect(scene.pet('o')!.opacity).toBeLessThan(1)

    scene.time.advance(FADE_MS + 50)

    expect(scene.pet('o')).toMatchObject({ ...slotPoint(scene.layout, 'terminal', 0), opacity: 1 })
    expect(scene.last().some(frame => frame.pose.startsWith('walk'))).toBe(false)
  })

  it('fades a leaving outside agent out where it stands instead of walking it through the door', () => {
    const scene = setup()
    scene.feed([agent('a'), agent('o', { kind: 'elsewhere', phase: 'tool', area: 'terminal' })])
    scene.time.advance(SETTLE_MS)
    scene.feed([agent('a')])
    scene.time.advance(100)

    expect(scene.pet('o')).toMatchObject({ ...slotPoint(scene.layout, 'terminal', 0), leaving: true })
    expect(scene.pet('o')!.opacity).toBeLessThan(1)
    expect(scene.pet('o')?.pose).not.toMatch(/^walk-/)

    scene.time.advance(FADE_MS + 50)

    expect(scene.pet('o')).toBeUndefined()
  })

  it('puts every pet at its new spot when the room is resized', () => {
    const scene = setup()
    scene.feed([agent('a')])
    scene.time.advance(SETTLE_MS)
    scene.feed([agent('a'), agent('b', { area: 'canvas', startedAt: 2 })])
    scene.time.advance(300)
    const smaller = layoutRoom(800, 500)
    scene.engine.setLayout(smaller)
    scene.time.advance(1)

    expect(scene.pet('b')).toMatchObject({ ...slotPoint(smaller, 'canvas', 0), opacity: 1 })
    expect(scene.pet('b')?.pose).toBe('idle')
  })
})
