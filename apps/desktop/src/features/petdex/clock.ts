/** One timer for every animated pet in a window: each asks for its next tick and the clock wakes once for the earliest. */
export interface AnimationClock {
  /** Run `tick` once at `at` (a `Date.now()` time); scheduling the same key again replaces it. */
  schedule(key: string, at: number, tick: (now: number) => void): void
  cancel(key: string): void
  /** Nothing runs while paused; resuming runs what came due. */
  setPaused(paused: boolean): void
  /** Ticks waiting to run. */
  pending(): number
}

/** What a clock runs on: the window's own timers, or fakes in tests. */
export interface ClockHost {
  now: () => number
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
  /** `requestAnimationFrame`, where there is one. */
  frame?: ((run: () => void) => unknown) | null
  cancelFrame?: ((frame: unknown) => void) | null
}

/** A tick due this soon waits for the next animation frame rather than a timer. */
const FRAME_WINDOW_MS = 20
/** An animation frame also runs the ticks due within half a frame of it, so a tick asked for one frame on is not a frame late. */
const FRAME_SLACK_MS = 8
/** Browsers run a longer timer at once. */
const LONGEST_TIMER_MS = 2 ** 31 - 1

export function createAnimationClock({ now, setTimer, clearTimer, frame = null, cancelFrame = null }: ClockHost): AnimationClock {
  const ticks = new Map<string, { at: number; tick: (now: number) => void }>()
  let paused = false
  let running = false
  let wake: { at: number; byFrame: boolean; handle: unknown } | null = null
  let seen = now()

  /** The time now; when the wall clock was set back, what waits moves back with it rather than wait out the jump. */
  function look(): number {
    const at = now()

    if (at < seen) {
      for (const entry of ticks.values()) {
        entry.at -= seen - at
      }
    }

    seen = at

    return at
  }

  function disarm(): void {
    if (wake?.byFrame) {
      cancelFrame?.(wake.handle)
    } else if (wake) {
      clearTimer(wake.handle)
    }

    wake = null
  }

  function arm(): void {
    if (running) {
      return
    }

    if (paused || !ticks.size) {
      disarm()

      return
    }

    const at = look()
    const earliest = Math.min(...[...ticks.values()].map(entry => entry.at))

    if (wake?.at === earliest) {
      return
    }

    disarm()
    const delay = Math.min(LONGEST_TIMER_MS, Math.max(0, earliest - at))
    const byFrame = frame !== null && delay <= FRAME_WINDOW_MS
    wake = { at: earliest, byFrame, handle: byFrame ? frame(() => run(true)) : setTimer(() => run(false), delay) }
  }

  function run(byFrame: boolean): void {
    wake = null

    if (paused) {
      return
    }

    const at = look()
    const due = [...ticks].filter(([, entry]) => entry.at <= at + (byFrame ? FRAME_SLACK_MS : 0))
    const failures: unknown[] = []
    running = true

    for (const [key, entry] of due) {
      // An earlier tick in this round may have cancelled or replaced it, or paused the clock.
      if (paused || ticks.get(key) !== entry) {
        continue
      }

      ticks.delete(key)

      try {
        entry.tick(at)
      } catch (error) {
        failures.push(error)
      }
    }

    running = false
    arm()

    if (failures.length) {
      throw failures[0]
    }
  }

  return {
    schedule(key, at, tick) {
      const time = look()
      ticks.set(key, { at: Number.isNaN(at) ? time : at, tick })
      arm()
    },
    cancel(key) {
      if (ticks.delete(key)) {
        arm()
      }
    },
    setPaused(next) {
      paused = next
      arm()
    },
    pending: () => ticks.size
  }
}

/** The renderer's one clock for every pet it draws: the desktop pet, the Room and Settings' previews. */
export const petClock: AnimationClock = createAnimationClock({
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  frame: typeof requestAnimationFrame === 'function' ? run => requestAnimationFrame(run) : null,
  cancelFrame: handle => cancelAnimationFrame(handle as number)
})
