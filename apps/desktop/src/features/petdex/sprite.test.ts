import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AnimationClock, createAnimationClock } from './clock.ts'
import { animateSprite, FRAME_MS, frameAt, IDLE_LOOPS, spriteFrame, type SpriteMotion, WALK_FRAME_MS } from './sprite.ts'

const START = Date.UTC(2026, 9, 15, 1, 0, 0)
const RUN_MS = 3000

/** The desktop pet's frame loop before the shared clock: a timer of its own for every sprite. */
function ownTimerLoop({ pose, frames, since, reduced, paused, rest }: SpriteMotion, paint: (frame: number) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const draw = () => {
    if (stopped) {
      return
    }

    const step = frameAt(rest ? 'idle' : pose, frames, Date.now() - since, reduced)
    paint(step.nextMs === null && pose !== 'idle' ? Math.floor(frames / 2) : step.frame)

    if (step.nextMs !== null && !paused) {
      timer = setTimeout(draw, Math.max(16, step.nextMs))
    }
  }

  draw()

  return () => {
    stopped = true

    if (timer) {
      clearTimeout(timer)
    }
  }
}

const timerClock = (): AnimationClock => createAnimationClock({ now: () => Date.now(), setTimer: (run, ms) => setTimeout(run, ms), clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) })

/** A clock on a 60 Hz screen whose frames fall every 16 ms from START. */
const screenClock = (): AnimationClock =>
  createAnimationClock({
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    frame: run => setTimeout(run, 16 - ((Date.now() - START) % 16)),
    cancelFrame: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
  })

/** Every frame painted (ms from START, frame) in `ms`, and the timers still set at the end. */
function record(start: (paint: (frame: number) => void) => () => void, ms = RUN_MS): { painted: [number, number][]; timers: number } {
  const painted: [number, number][] = []
  const stop = start(frame => painted.push([Date.now() - START, frame]))
  vi.advanceTimersByTime(ms)
  const timers = vi.getTimerCount()
  stop()

  return { painted, timers }
}

const motion = (extra: Partial<SpriteMotion>): SpriteMotion => ({ pose: 'idle', frames: 6, since: START, reduced: false, paused: false, ...extra })

const CASES: Record<string, SpriteMotion> = {
  'idle from its start': motion({}),
  'idle joined mid-loop': motion({ since: START - 1000 }),
  'idle long rested': motion({ since: START - 60_000 }),
  'a looping wave': motion({ pose: 'wave', frames: 4 }),
  'a walk to the left': motion({ pose: 'walk-left', frames: 8 }),
  'a worried pet at rest': motion({ pose: 'waiting', frames: 6, rest: true }),
  'reduced motion': motion({ pose: 'failed', frames: 5, reduced: true }),
  'paused while hidden': motion({ pose: 'run', frames: 6, since: START - 400, paused: true }),
  'a one-frame row': motion({ pose: 'jump', frames: 1 }),
  'a clock set back': motion({ pose: 'review', frames: 6, since: START + 5000 }),
  'a pose that started a moment ago': motion({ pose: 'run', frames: 6, since: START - 170 })
}

describe('a sprite on the shared clock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  for (const [name, case_] of Object.entries(CASES)) {
    it(`paints the same frames at the same times as its own timer did: ${name}`, () => {
      const before = record(paint => ownTimerLoop(case_, paint))
      vi.setSystemTime(START)
      const clock = timerClock()
      const after = record(paint => animateSprite(clock, 'pet', case_, paint))

      expect(after).toEqual(before)
      expect(after.painted.length).toBeGreaterThan(0)
    })
  }

  it('plays idle twice through and then rests on its first frame with no timer', () => {
    const clock = timerClock()
    const { painted, timers } = record(paint => animateSprite(clock, 'pet', motion({}), paint))
    const loop = IDLE_LOOPS * 6

    expect(painted).toEqual([...Array.from({ length: loop }, (_, index) => [index * FRAME_MS, index % 6]), [loop * FRAME_MS, 0]])
    expect(timers).toBe(0)
    expect(clock.pending()).toBe(0)
  })

  it('walks at its own pace and loops while the walk lasts', () => {
    const clock = timerClock()
    const { painted, timers } = record(paint => animateSprite(clock, 'pet', motion({ pose: 'walk-right', frames: 8 }), paint))

    expect(painted.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, index) => [index * WALK_FRAME_MS, index % 8]))
    expect(timers).toBe(1)
  })

  it('holds a worried pet at rest on the middle of its row once its idle loops are over', () => {
    const clock = timerClock()
    const { painted, timers } = record(paint => animateSprite(clock, 'pet', motion({ pose: 'waiting', frames: 6, rest: true }), paint))

    expect(painted.at(-1)).toEqual([IDLE_LOOPS * 6 * FRAME_MS, 3])
    expect(painted.slice(0, 6).map(([, frame]) => frame)).toEqual([0, 1, 2, 3, 4, 5])
    expect(timers).toBe(0)
  })

  it('shows one still frame with motion reduced, and the frame it is on while paused, with no timer', () => {
    const clock = timerClock()

    expect(record(paint => animateSprite(clock, 'a', motion({ pose: 'failed', frames: 5, reduced: true }), paint))).toEqual({ painted: [[0, 2]], timers: 0 })
    expect(record(paint => animateSprite(clock, 'b', motion({ pose: 'idle', reduced: true }), paint))).toEqual({ painted: [[RUN_MS, 0]], timers: 0 })
    expect(record(paint => animateSprite(clock, 'c', motion({ pose: 'run', since: Date.now() - 400, paused: true }), paint))).toEqual({ painted: [[2 * RUN_MS, 2]], timers: 0 })
    expect(clock.pending()).toBe(0)
  })

  it('stops when told, leaving nothing on the clock', () => {
    const clock = timerClock()
    const painted: number[] = []
    const stop = animateSprite(clock, 'pet', motion({ pose: 'wave', frames: 4 }), frame => painted.push(frame))

    vi.advanceTimersByTime(400)
    stop()
    vi.advanceTimersByTime(1000)

    expect(painted).toEqual([0, 1, 2])
    expect(clock.pending()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('animates many sprites on one timer', () => {
    const clock = timerClock()
    const stops = ['a', 'b', 'c', 'd'].map((key, index) => animateSprite(clock, key, motion({ pose: 'wave', frames: 4, since: START - index * 45 }), () => undefined))

    for (let step = 0; step < 20; step++) {
      vi.advanceTimersByTime(37)
      expect(vi.getTimerCount()).toBe(1)
    }

    expect(clock.pending()).toBe(4)
    stops.forEach(stop => stop())
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows the same frames in the same order on a 60 Hz screen, each within a frame of its time', () => {
    for (const case_ of [CASES['a pose that started a moment ago'], motion({ pose: 'run', frames: 6, since: START - 162 }), CASES['a walk to the left'], CASES['idle from its start']]) {
      vi.setSystemTime(START)
      const before = record(paint => ownTimerLoop(case_, paint))
      vi.setSystemTime(START)
      const after = record(paint => animateSprite(screenClock(), 'pet', case_, paint))
      const changes = (painted: [number, number][]) => painted.filter(([, frame], index) => index === 0 || painted[index - 1][1] !== frame)

      expect(changes(after.painted).map(([, frame]) => frame)).toEqual(changes(before.painted).map(([, frame]) => frame))
      changes(after.painted).forEach(([at], index) => expect(Math.abs(at - changes(before.painted)[index][0])).toBeLessThanOrEqual(16))
      expect(after.timers).toBe(before.timers)
    }
  })
})

describe('spriteFrame', () => {
  it('waits at least 16 ms between frames, and not at all when paused', () => {
    expect(spriteFrame(motion({ pose: 'wave', frames: 4, since: START - 175 }), START)).toEqual({ frame: 0, nextMs: 16 })
    expect(spriteFrame(motion({ pose: 'wave', frames: 4, since: START - 175, paused: true }), START)).toEqual({ frame: 0, nextMs: null })
  })

  it('shows the middle frame of a held pose and the first one of idle', () => {
    expect(spriteFrame(motion({ pose: 'review', frames: 6, reduced: true }), START)).toEqual({ frame: 3, nextMs: null })
    expect(spriteFrame(motion({ pose: 'idle', frames: 6, reduced: true }), START)).toEqual({ frame: 0, nextMs: null })
    expect(spriteFrame(motion({ pose: 'jump', frames: 3, rest: true, since: START - 60_000 }), START)).toEqual({ frame: 1, nextMs: null })
  })
})
