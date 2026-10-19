import { describe, expect, it } from 'vitest'
import { PET_FRAME_HEIGHT, PET_FRAME_WIDTH } from '../../../../shared/pet.ts'
import { FRAME_MS, IDLE_LOOPS, layoutFromBlanks, type SheetLayout, WALK_FRAME_MS } from '../../pet/sprite.ts'
import type { RoomPhase, RoomResult } from '../model/types.ts'
import { cellAt, MOVING_TICK_MS, nextWake, poseOf, WORK_LOOPS } from './poses.ts'

/** A sheet whose row `n` has `counts[n]` frames before its first blank cell. */
const sheet = (columns: number, counts: number[]): SheetLayout => layoutFromBlanks(columns * PET_FRAME_WIDTH, counts.length * PET_FRAME_HEIGHT, (column, row) => column >= counts[row])

const codex = sheet(8, [6, 8, 8, 4, 5, 8, 6, 8, 7])
const legacy = sheet(9, [6, 4, 9, 7, 6, 5, 2, 2])

const result = (status: RoomResult['status']): RoomResult => ({ status, summary: null, durationSeconds: null, filesRead: null, filesWritten: null, inputTokens: null, outputTokens: null, reasoningTokens: null, apiCalls: null, costUsd: null, at: 1 })

describe('poseOf', () => {
  it.each<[RoomPhase, string]>([
    ['idle', 'idle'],
    ['thinking', 'review'],
    ['starting', 'review'],
    ['queued', 'review'],
    ['tool', 'run'],
    ['waiting', 'waiting']
  ])('shows %s as %s', (phase, pose) => {
    expect(poseOf({ phase, result: null }, 0)).toBe(pose)
  })

  it('cheers a helper whose work completed and droops for any other ending', () => {
    expect(poseOf({ phase: 'finished', result: result('completed') }, 0)).toBe('jump')

    for (const status of ['failed', 'error', 'timeout', 'interrupted'] as const) {
      expect(poseOf({ phase: 'finished', result: result(status) }, 0)).toBe('failed')
    }

    expect(poseOf({ phase: 'finished', result: null }, 0)).toBe('failed')
  })

  it('walks whatever it is doing', () => {
    expect(poseOf({ phase: 'tool', result: null }, -1)).toBe('walk-left')
    expect(poseOf({ phase: 'waiting', result: null }, 1)).toBe('walk-right')
  })
})

describe('cellAt', () => {
  it('loops a working pose and says when its next frame is due', () => {
    const cell = cellAt('run', codex, 1000, 1000 + FRAME_MS * 2 + 30, false)

    expect(cell.row).toBe(codex.rowNames.indexOf('running'))
    expect(cell.frame).toBe(2)
    expect(cell.nextAt).toBe(1000 + FRAME_MS * 3)
  })

  it('walks at the walking frame rate, mirrored on a sheet without a left run', () => {
    const cell = cellAt('walk-left', legacy, 0, WALK_FRAME_MS + 1, false)

    expect(cell.mirror).toBe(true)
    expect(cell.frame).toBe(1)
    expect(cell.nextAt).toBe(WALK_FRAME_MS * 2)
  })

  it('rests an idle pet on its first frame after a couple of loops', () => {
    const frames = codex.frames[0]
    const settled = cellAt('idle', codex, 0, IDLE_LOOPS * frames * FRAME_MS, false)

    expect(cellAt('idle', codex, 0, FRAME_MS, false).nextAt).not.toBeNull()
    expect(settled).toMatchObject({ frame: 0, nextAt: null })
  })

  it('settles a finished helper on the middle of its cheer or droop', () => {
    const jumpRow = codex.rowNames.indexOf('jumping')
    const frames = Math.min(6, codex.frames[jumpRow])
    const settled = cellAt('jump', codex, 0, IDLE_LOOPS * frames * FRAME_MS + 1, false)

    expect(cellAt('jump', codex, 0, FRAME_MS, false).nextAt).not.toBeNull()
    expect(settled).toMatchObject({ row: jumpRow, frame: Math.floor(frames / 2), nextAt: null })
  })

  it('holds every pose on one frame when nothing animates', () => {
    const run = cellAt('run', codex, 0, 5000, true)

    expect(run.nextAt).toBeNull()
    expect(run.frame).toBe(Math.floor(Math.min(6, codex.frames[codex.rowNames.indexOf('running')]) / 2))
    expect(cellAt('idle', codex, 0, 5000, true)).toMatchObject({ frame: 0, nextAt: null })
  })

  it('holds a working pose once its latest news is a few loops old, and plays again on news', () => {
    const frames = Math.min(6, codex.frames[codex.rowNames.indexOf('running')])
    const loops = WORK_LOOPS * frames * FRAME_MS

    expect(cellAt('run', codex, 0, loops - 1, false, 0).nextAt).not.toBeNull()
    expect(cellAt('run', codex, 0, loops, false, 0)).toMatchObject({ frame: Math.floor(frames / 2), nextAt: null })
    expect(cellAt('run', codex, 0, loops + 500, false, loops + 400).nextAt).not.toBeNull()
    expect(cellAt('run', codex, 0, loops + FRAME_MS * 2 + 10, false, loops + FRAME_MS * 2).frame).toBe(cellAt('run', codex, 0, loops + FRAME_MS * 2 + 10, false, loops + FRAME_MS * 2 + 10).frame)
    expect(cellAt('walk-right', codex, 0, loops * 3, false, 0).nextAt).not.toBeNull()
  })
})

describe('nextWake', () => {
  it('ticks about a frame from now while anything walks or fades', () => {
    expect(nextWake(1000, true, [{ nextAt: 5000 }])).toBe(1000 + MOVING_TICK_MS)
  })

  it('wakes once at the earliest next sprite frame across pets', () => {
    expect(nextWake(1000, false, [{ nextAt: 1300 }, { nextAt: null }, { nextAt: 1120 }])).toBe(1120)
  })

  it('wakes for a bubble or note due to change even when every pet rests', () => {
    expect(nextWake(1000, false, [{ nextAt: null }], 4000)).toBe(4000)
    expect(nextWake(1000, false, [{ nextAt: 1500 }], 4000)).toBe(1500)
  })

  it('sets nothing at all when every pet rests', () => {
    expect(nextWake(1000, false, [{ nextAt: null }, { nextAt: null }])).toBeNull()
    expect(nextWake(1000, false, [])).toBeNull()
  })

  it('never asks for a moment already past', () => {
    expect(nextWake(1000, false, [{ nextAt: 900 }])).toBe(1001)
  })
})
