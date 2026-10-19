import { PET_FRAME_HEIGHT, PET_FRAME_WIDTH, type PetActivity } from '../../../shared/pet.ts'
import type { AnimationClock } from './clock.ts'

/*
 * A petdex spritesheet read the way Hermes draws it: one 192x208 frame per cell, a row per state,
 * and a row stops at its first blank frame. Codex atlases have nine rows of eight frames, older
 * ones eight rows of nine, with different row names.
 */

export type PetPose = 'idle' | 'wave' | 'run' | 'failed' | 'review' | 'jump' | 'waiting' | 'walk-right' | 'walk-left'

export interface SheetLayout {
  columns: number
  rows: number
  rowNames: string[]
  /** Frames in each row up to its first blank one, at least 1. */
  frames: number[]
}

export const CODEX_ROWS: readonly string[] = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']
export const LEGACY_ROWS: readonly string[] = ['idle', 'wave', 'run', 'failed', 'review', 'jump', 'extra1', 'extra2']

/** A name for each of a sheet's rows; rows past the atlas's own are `row<n>`, which no pose uses. */
export function rowNamesFor(rowCount: number): string[] {
  const names = rowCount >= CODEX_ROWS.length ? CODEX_ROWS : LEGACY_ROWS

  return Array.from({ length: Math.max(0, Math.floor(rowCount) || 0) }, (_, row) => names[row] ?? `row${row}`)
}

const cellsIn = (size: number, cell: number): number => Math.max(1, Math.floor(size / cell) || 0)

export function layoutFromBlanks(width: number, height: number, isBlank: (column: number, row: number) => boolean): SheetLayout {
  const columns = cellsIn(width, PET_FRAME_WIDTH)
  const rows = cellsIn(height, PET_FRAME_HEIGHT)
  const frames = Array.from({ length: rows }, (_, row) => {
    let count = 0

    while (count < columns && !isBlank(count, row)) {
      count++
    }

    return Math.max(1, count)
  })

  return { columns, rows, rowNames: rowNamesFor(rows), frames }
}

/** The faintest alpha that counts as drawn: lower is antialiasing dust or compression noise. */
const VISIBLE_ALPHA = 16

export function alphaIsBlank(alpha: ArrayLike<number>, stride = 1): boolean {
  const step = Math.max(1, Math.floor(stride) || 1)

  for (let index = 0; index < alpha.length; index += step) {
    if (alpha[index] >= VISIBLE_ALPHA) {
      return false
    }
  }

  return true
}

export interface PoseRow {
  row: number
  frames: number
  /** Drawn flipped: a walk to the left on a sheet with only a right or in-place run. */
  mirror: boolean
}

/** Hermes steps six frames per state (petdex `steps(6)`); walks use the whole row. */
const STATE_FRAMES = 6

const ROWS_FOR: Record<PetPose, readonly string[]> = {
  idle: ['idle'],
  wave: ['wave', 'waving'],
  run: ['run', 'running'],
  jump: ['jump', 'jumping'],
  failed: ['failed'],
  review: ['review'],
  waiting: ['waiting'],
  'walk-right': ['running-right', 'run', 'running'],
  'walk-left': ['running-left']
}

const isWalk = (pose: PetPose): boolean => pose === 'walk-left' || pose === 'walk-right'

export function poseRow(pose: PetPose, layout: SheetLayout): PoseRow {
  const rowOf = (names: readonly string[]): number => names.map(name => layout.rowNames.indexOf(name)).find(row => row >= 0 && row < layout.rows) ?? -1
  const own = rowOf(ROWS_FOR[pose])
  const mirrored = own < 0 && pose === 'walk-left' ? rowOf(ROWS_FOR['walk-right']) : -1
  const row = Math.max(0, own, mirrored)
  const frames = Math.max(1, layout.frames[row] ?? 1)

  return { row, frames: isWalk(pose) ? frames : Math.min(STATE_FRAMES, frames), mirror: mirrored >= 0 }
}

/** How long listening waves at the person before it settles into waiting on them. */
export const PERK_MS = 2400

const ACTIVITY_POSES: Record<Exclude<PetActivity, 'listening'>, PetPose> = {
  idle: 'idle',
  thinking: 'review',
  running: 'run',
  cheering: 'jump',
  drooping: 'failed',
  waiting: 'waiting'
}

export function poseFor(activity: PetActivity, walking: -1 | 0 | 1, sinceMs: number): PetPose {
  if (walking) {
    return walking < 0 ? 'walk-left' : 'walk-right'
  }

  if (activity === 'listening') {
    return sinceMs < PERK_MS ? 'wave' : 'waiting'
  }

  return ACTIVITY_POSES[activity]
}

export const FRAME_MS = 180
export const WALK_FRAME_MS = 120
export const IDLE_LOOPS = 2

export interface FrameStep {
  frame: number
  /** Until the next frame; null when the pose rests on this one and needs no timer. */
  nextMs: number | null
}

export function frameAt(pose: PetPose, frames: number, sinceMs: number, reduced: boolean): FrameStep {
  const count = Math.max(1, Math.floor(frames) || 1)
  const since = Number.isFinite(sinceMs) ? Math.max(0, sinceMs) : 0
  const frameMs = isWalk(pose) ? WALK_FRAME_MS : FRAME_MS

  if (reduced || count === 1 || (pose === 'idle' && since >= IDLE_LOOPS * count * frameMs)) {
    return { frame: 0, nextMs: null }
  }

  return { frame: Math.floor(since / frameMs) % count, nextMs: frameMs - (since % frameMs) }
}

/** What a drawn sprite does: its pose and the frames in the pose's row, since when, and what holds it still. */
export interface SpriteMotion {
  pose: PetPose
  frames: number
  /** When the pose started, a `Date.now()` time. */
  since: number
  reduced: boolean
  /** Shows the frame it is on and sets no timer. */
  paused: boolean
  /** Loops the way idle does, a couple of times, and then holds still. */
  rest?: boolean
}

/** The frame a sprite shows at `now` and how long until it draws again; null when it holds this frame with no timer. */
export function spriteFrame(motion: SpriteMotion, now: number): FrameStep {
  const { pose, frames } = motion
  const step = frameAt(motion.rest ? 'idle' : pose, frames, now - motion.since, motion.reduced)
  // A pose held still (motion reduced, a worried pet at rest) shows its middle frame: a row's first
  // frame is often the plain standing one, so it would read as idle.
  const frame = step.nextMs === null && pose !== 'idle' ? Math.floor(frames / 2) : step.frame

  return { frame, nextMs: step.nextMs === null || motion.paused ? null : Math.max(16, step.nextMs) }
}

/** Paint a sprite now and then frame by frame on `clock` under `key` until it holds still; returns the stop. */
export function animateSprite(clock: AnimationClock, key: string, motion: SpriteMotion, paint: (frame: number) => void, now = Date.now()): () => void {
  const draw = (at: number) => {
    const step = spriteFrame(motion, at)
    paint(step.frame)

    if (step.nextMs !== null) {
      const next = at + step.nextMs
      // An animation frame may run the tick a few milliseconds early: it shows the frame asked for.
      clock.schedule(key, next, ran => draw(Math.max(ran, next)))
    }
  }

  draw(now)

  return () => clock.cancel(key)
}
