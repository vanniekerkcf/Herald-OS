import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AnimationClock, createAnimationClock } from './clock.ts'

const START = Date.UTC(2026, 9, 15, 1, 0, 0)

function timerClock(): AnimationClock {
  return createAnimationClock({ now: () => Date.now(), setTimer: (run, ms) => setTimeout(run, ms), clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) })
}

/** A window's animation frames, run by hand. */
function frames() {
  const queued = new Map<number, () => void>()
  let last = 0

  return {
    frame: (run: () => void) => {
      queued.set(++last, run)

      return last
    },
    cancelFrame: (handle: unknown) => {
      queued.delete(handle as number)
    },
    queued: () => queued.size,
    flush: () => {
      const due = [...queued.values()]
      queued.clear()

      for (const run of due) {
        run()
      }
    }
  }
}

describe('the animation clock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('wakes once for the earliest tick of many keys, and runs each at its time', () => {
    const clock = timerClock()
    const ran: [string, number][] = []

    for (const [key, ms] of [['b', 300], ['a', 100], ['c', 200]] as const) {
      clock.schedule(key, START + ms, now => ran.push([key, now - START]))
    }

    expect(clock.pending()).toBe(3)
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(99)
    expect(ran).toEqual([])

    vi.advanceTimersByTime(1)
    expect(ran).toEqual([['a', 100]])
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(200)
    expect(ran).toEqual([
      ['a', 100],
      ['c', 200],
      ['b', 300]
    ])
    expect(clock.pending()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs ticks due together in one wake', () => {
    const clock = timerClock()
    const ran: string[] = []
    clock.schedule('a', START + 50, () => ran.push('a'))
    clock.schedule('b', START + 50, () => ran.push('b'))

    vi.advanceTimersByTime(50)

    expect(ran).toEqual(['a', 'b'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('replaces a key scheduled again, earlier or later', () => {
    const clock = timerClock()
    const ran: string[] = []
    clock.schedule('a', START + 100, () => ran.push('first'))
    clock.schedule('a', START + 40, () => ran.push('sooner'))

    expect(clock.pending()).toBe(1)
    vi.advanceTimersByTime(40)
    expect(ran).toEqual(['sooner'])

    clock.schedule('a', START + 60, () => ran.push('first again'))
    clock.schedule('a', START + 500, () => ran.push('later'))
    vi.advanceTimersByTime(100)
    expect(ran).toEqual(['sooner'])

    vi.advanceTimersByTime(400)
    expect(ran).toEqual(['sooner', 'later'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a key, and holds no timer once nothing is left', () => {
    const clock = timerClock()
    const ran: string[] = []
    clock.schedule('a', START + 100, () => ran.push('a'))
    clock.schedule('b', START + 200, () => ran.push('b'))

    clock.cancel('a')
    expect(clock.pending()).toBe(1)
    expect(vi.getTimerCount()).toBe(1)

    clock.cancel('b')
    clock.cancel('never scheduled')
    expect(clock.pending()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(1000)
    expect(ran).toEqual([])
  })

  it('keeps one timer for a tick that schedules itself again', () => {
    const clock = timerClock()
    const ran: number[] = []
    const tick = (now: number) => {
      ran.push(now - START)

      if (ran.length < 4) {
        clock.schedule('loop', now + 180, tick)
      }

      expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
    }
    clock.schedule('loop', START + 180, tick)

    vi.advanceTimersByTime(2000)

    expect(ran).toEqual([180, 360, 540, 720])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs nothing while paused, and what came due as soon as it resumes', () => {
    const clock = timerClock()
    const ran: [string, number][] = []
    clock.schedule('a', START + 100, now => ran.push(['a', now - START]))
    clock.schedule('b', START + 900, now => ran.push(['b', now - START]))

    clock.setPaused(true)
    expect(vi.getTimerCount()).toBe(0)
    clock.schedule('c', START + 200, now => ran.push(['c', now - START]))
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(500)
    expect(ran).toEqual([])
    expect(clock.pending()).toBe(3)

    clock.setPaused(false)
    vi.advanceTimersByTime(0)
    expect(ran).toEqual([
      ['a', 500],
      ['c', 500]
    ])

    vi.advanceTimersByTime(400)
    expect(ran.at(-1)).toEqual(['b', 900])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops the rest of a round when a tick pauses it', () => {
    const clock = timerClock()
    const ran: string[] = []
    clock.schedule('a', START + 10, () => {
      ran.push('a')
      clock.setPaused(true)
    })
    clock.schedule('b', START + 10, () => ran.push('b'))

    vi.advanceTimersByTime(10)
    expect(ran).toEqual(['a'])
    expect(clock.pending()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    clock.setPaused(false)
    vi.advanceTimersByTime(0)
    expect(ran).toEqual(['a', 'b'])
  })

  it('skips a tick an earlier one in the same round cancelled', () => {
    const clock = timerClock()
    const ran: string[] = []
    clock.schedule('a', START + 10, () => {
      ran.push('a')
      clock.cancel('b')
    })
    clock.schedule('b', START + 10, () => ran.push('b'))

    vi.advanceTimersByTime(10)

    expect(ran).toEqual(['a'])
    expect(clock.pending()).toBe(0)
  })

  it('keeps going when a tick throws, and still reports the error', () => {
    const clock = timerClock()
    const ran: string[] = []
    clock.schedule('bad', START + 10, () => {
      throw new Error('broken pet')
    })
    clock.schedule('good', START + 10, () => ran.push('good'))
    clock.schedule('later', START + 50, () => ran.push('later'))

    expect(() => vi.advanceTimersByTime(10)).toThrow('broken pet')
    expect(ran).toEqual(['good'])

    vi.advanceTimersByTime(40)
    expect(ran).toEqual(['good', 'later'])
  })

  it('waits for an animation frame for ticks due within about 20 ms, and a timer for later ones', () => {
    const screen = frames()
    const clock = createAnimationClock({ now: () => Date.now(), setTimer: (run, ms) => setTimeout(run, ms), clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>), frame: screen.frame, cancelFrame: screen.cancelFrame })
    const ran: string[] = []

    clock.schedule('walk', START + 16, () => ran.push('walk'))
    expect(screen.queued()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(16)
    screen.flush()
    expect(ran).toEqual(['walk'])
    expect(screen.queued()).toBe(0)

    clock.schedule('idle', Date.now() + 180, () => ran.push('idle'))
    expect(screen.queued()).toBe(0)
    expect(vi.getTimerCount()).toBe(1)

    clock.schedule('walk', Date.now() + 10, () => ran.push('walk again'))
    expect(screen.queued()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    clock.cancel('walk')
    expect(screen.queued()).toBe(0)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('runs ticks due within half a frame on a frame, and leaves later ones for the next', () => {
    const screen = frames()
    const clock = createAnimationClock({ now: () => Date.now(), setTimer: (run, ms) => setTimeout(run, ms), clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>), frame: screen.frame, cancelFrame: screen.cancelFrame })
    const ran: string[] = []
    clock.schedule('a', START + 18, () => ran.push('a'))
    clock.schedule('b', START + 30, () => ran.push('b'))

    vi.advanceTimersByTime(12)
    screen.flush()
    expect(ran).toEqual(['a'])
    expect(clock.pending()).toBe(1)

    vi.advanceTimersByTime(16)
    screen.flush()
    expect(ran).toEqual(['a', 'b'])
    expect(screen.queued()).toBe(0)
  })

  it('does not wait out the jump when the wall clock is set back', () => {
    const clock = timerClock()
    const ran: number[] = []
    clock.schedule('frame', START + 180, now => ran.push(now))
    clock.schedule('later', START + 900, now => ran.push(now))

    vi.setSystemTime(START - 3_600_000)
    vi.advanceTimersByTime(400)
    expect(ran).toHaveLength(1)

    clock.schedule('fresh', Date.now() + 100, now => ran.push(now))
    vi.advanceTimersByTime(1000)

    expect(ran).toHaveLength(3)
    expect(clock.pending()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats an unreadable time as now', () => {
    const clock = timerClock()
    const ran: string[] = []
    clock.schedule('odd', Number.NaN, () => ran.push('odd'))

    vi.advanceTimersByTime(0)

    expect(ran).toEqual(['odd'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
