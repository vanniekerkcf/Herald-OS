import { describe, expect, it } from 'vitest'
import { roomFrame, type RoomSessionRow } from './frames.ts'
import { EMPTY_ROOM, reduceRoom } from './reducer.ts'
import { earliestDue, emptyClock, ROOM_TIMING, type RoomClock, roomDue, turnEnded } from './schedule.ts'
import type { RoomState } from './types.ts'

const T0 = 100_000
const idleRow = (id: string): RoomSessionRow => ({ id, sessionKey: `k-${id}`, status: 'idle', title: '', startedAt: null })
const workingRow = (id: string): RoomSessionRow => ({ ...idleRow(id), status: 'working' })
const listOf = (rows: RoomSessionRow[]): RoomState => reduceRoom(EMPTY_ROOM, { type: 'active_list', rows, sentAt: T0, at: T0 })
const clockAt = (patch: Partial<RoomClock>): RoomClock => ({ ...emptyClock(), listed: true, listAt: T0, helpersAt: T0, configAt: T0, jobsAt: T0, desksAt: T0, ...patch })
const none = { list: false, helpers: false, config: false, sessions: new Set<string>(), automations: false, elsewhere: false, costs: false, desks: false }

describe('when each call is due', () => {
  it('asks for everything at once on the first look, the list before anything else', () => {
    expect(roomDue(listOf([idleRow('a')]), emptyClock())).toEqual({ activeList: 0, delegation: Infinity, config: Infinity, sessions: {}, automations: 0, runs: {}, elsewhere: Infinity, costs: Infinity, desks: 0 })
    expect(roomDue(listOf([idleRow('a')]), { ...emptyClock(), listAt: T0, listed: true })).toEqual({ activeList: T0 + 15_000, delegation: 0, config: 0, sessions: { a: 0 }, automations: 0, runs: {}, elsewhere: Infinity, costs: Infinity, desks: 0 })
  })

  it('reads the list every 3 s while anything works, every 15 s when quiet, and soon after sessions.changed', () => {
    expect(roomDue(listOf([idleRow('a')]), clockAt({})).activeList).toBe(T0 + 15_000)
    expect(roomDue(listOf([workingRow('a')]), clockAt({})).activeList).toBe(T0 + 3_000)
    expect(roomDue(listOf([idleRow('a')]), clockAt({ changedAt: T0 + 1_000 })).activeList).toBe(T0 + 1_500)
  })

  it('reads a working session every second and an idle one every 10 s', () => {
    const state = listOf([workingRow('w'), idleRow('i')])

    expect(roomDue(state, clockAt({ polledAt: { w: T0, i: T0 } })).sessions).toEqual({ w: T0 + 1_000, i: T0 + 10_000 })
  })

  it('skips a round for a session whose frames came live in the last 2 s, but reads it at least every 10 s', () => {
    const state = listOf([workingRow('w')])

    expect(roomDue(state, clockAt({ polledAt: { w: T0 }, liveAt: { w: T0 + 500 } })).sessions.w).toBe(T0 + 2_500)
    expect(roomDue(state, clockAt({ polledAt: { w: T0 }, liveAt: { w: T0 + 9_500 } })).sessions.w).toBe(T0 + 10_000)
    expect(roomDue(state, clockAt({ polledAt: { w: T0 }, liveAt: { w: T0 - 5_000 } })).sessions.w).toBe(T0 + 1_000)
  })

  it('does not read a session this window holds a request for', () => {
    expect(roomDue(listOf([workingRow('w')]), clockAt({ polledAt: { w: T0 } }), new Set(['w'])).sessions).toEqual({})
  })

  it('reads delegation.status every 2 s while helpers run or a delegate_task runs, else every 20 s', () => {
    const quiet = listOf([idleRow('a')])
    const delegating = reduceRoom(quiet, { type: 'live', epoch: 'e1', frame: roomFrame({ type: 'tool.start', session_id: 'a', seq: 1, payload: { tool_id: 't', name: 'delegate_task', args: {} } })!, at: T0 + 1 })
    const helping = reduceRoom(quiet, { type: 'live', epoch: 'e1', frame: roomFrame({ type: 'subagent.start', session_id: 'a', seq: 1, payload: { subagent_id: 'h', goal: 'g', task_count: 1, task_index: 0 } })!, at: T0 + 1 })

    expect(roomDue(quiet, clockAt({})).delegation).toBe(T0 + 20_000)
    expect(roomDue(delegating, clockAt({})).delegation).toBe(T0 + 2_000)
    expect(roomDue(helping, clockAt({})).delegation).toBe(T0 + 2_000)
  })

  it("reads Hermes's tool progress setting every minute", () => {
    expect(roomDue(listOf([]), clockAt({})).config).toBe(T0 + 60_000)
  })

  it('stops asking for what Hermes does not have', () => {
    const state: RoomState = { ...listOf([workingRow('w')]), caps: { activeList: false, eventsSince: false, delegation: false, config: false, automations: false, sessionsDb: false } }

    expect(roomDue(state, emptyClock(), new Set(), { elsewhere: true, costs: true })).toEqual({ activeList: Infinity, delegation: Infinity, config: Infinity, sessions: {}, automations: Infinity, runs: {}, elsewhere: Infinity, costs: Infinity, desks: 0 })
  })

  it('sleeps until the earliest call not already in flight', () => {
    const due = roomDue(listOf([workingRow('w'), idleRow('i')]), clockAt({ polledAt: { w: T0, i: T0 } }))

    expect(earliestDue(due, none)).toBe(T0 + 1_000)
    expect(earliestDue(due, { ...none, sessions: new Set(['w']) })).toBe(T0 + 3_000)
    expect(earliestDue({ activeList: Infinity, delegation: Infinity, config: Infinity, sessions: {}, automations: Infinity, runs: {}, elsewhere: Infinity, costs: Infinity, desks: Infinity }, none)).toBe(Infinity)
  })

  it("reads Herald's own sessions' costs only while cost meters are on: once a minute, soon after a turn ends, at most every 15 s", () => {
    const state = listOf([idleRow('a')])

    expect(roomDue(state, clockAt({})).costs).toBe(Infinity)
    expect(roomDue(state, { ...emptyClock(), listAt: T0 }, new Set(), { elsewhere: false, costs: true }).costs).toBe(Infinity)
    expect(roomDue(state, clockAt({}), new Set(), { elsewhere: false, costs: true }).costs).toBe(0)
    expect(roomDue(state, clockAt({ costsAt: T0 }), new Set(), { elsewhere: false, costs: true }).costs).toBe(T0 + ROOM_TIMING.costsMs)
    expect(roomDue(state, clockAt({ costsAt: T0, costsWanted: T0 + 40_000 }), new Set(), { elsewhere: false, costs: true }).costs).toBe(T0 + 40_000)
    expect(roomDue(state, clockAt({ costsAt: T0, costsWanted: T0 + 2_000 }), new Set(), { elsewhere: false, costs: true }).costs).toBe(T0 + ROOM_TIMING.costsFloorMs)
  })

  it('reads the lane early for work live detail brought in, but never sooner than 15 s after the last read', () => {
    const state = listOf([])

    expect(roomDue(state, clockAt({ elsewhereAt: T0 }), new Set(), { elsewhere: true }).elsewhere).toBe(T0 + ROOM_TIMING.elsewhereMs)
    expect(roomDue(state, clockAt({ elsewhereAt: T0, elsewhereWanted: T0 + 20_000 }), new Set(), { elsewhere: true }).elsewhere).toBe(T0 + 20_000)
    expect(roomDue(state, clockAt({ elsewhereAt: T0, elsewhereWanted: T0 + 3_000 }), new Set(), { elsewhere: true }).elsewhere).toBe(T0 + ROOM_TIMING.elsewhereFloorMs)
  })

  it('notices when one of Herald’s sessions finishes a turn', () => {
    const working = listOf([workingRow('a')])
    const idle = listOf([idleRow('a')])

    expect(turnEnded(working, idle)).toBe(true)
    expect(turnEnded(idle, working)).toBe(false)
    expect(turnEnded(idle, idle)).toBe(false)
  })
})
