import { beforeEach, describe, expect, it } from 'vitest'
import type { RoomActivity, RoomActivityKind } from '../../../../shared/room.ts'
import type { RoomCronJob } from './automations.ts'
import type { RoomElsewhereRow } from './elsewhere.ts'
import { factsOf } from './facts.ts'
import { roomFrame } from './frames.ts'
import { OUTSIDE_STALE_MS, unlisted } from './outside.ts'
import { EMPTY_ROOM, FINISHED_KEEP_MS, nextPruneAt, reduceRoom, type RoomInput } from './reducer.ts'
import { summarizeRoom } from './summary.ts'
import type { RoomState } from './types.ts'

const T0 = 1_792_000_000_000
const MIN = 60_000
let seq = 0

beforeEach(() => {
  seq = 0
})

const ev = (kind: RoomActivityKind, patch: Partial<RoomActivity> = {}): RoomActivity => {
  seq += 1

  return { seq, kind, session: 'tg1', child: null, tool: null, target: null, call: null, status: null, source: 'telegram', at: T0 + seq, ...patch }
}

const outside = (events: RoomActivity[], at = T0 + 1_000): RoomInput => ({ type: 'outside', events, at })
const row = (patch: Partial<RoomElsewhereRow> & { id: string }): RoomElsewhereRow => ({ source: 'telegram', where: 'Telegram', title: '', startedAt: T0 - 10 * MIN, lastActiveAt: T0 - 30_000, active: true, usage: null, ...patch })
const lane = (rows: RoomElsewhereRow[] | null, at: number): RoomInput => ({ type: 'elsewhere', rows, at })
const run = (state: RoomState, ...inputs: RoomInput[]): RoomState => inputs.reduce(reduceRoom, state)
const view = (state: RoomState, id = 'e:tg1') => {
  const { phase, area, target, step, tool } = state.agents[id]

  return { phase, area, target, step, tool }
}
const texts = (state: RoomState, id: string, now: number) => factsOf(state.agents[id], state, now).map(fact => fact.text)
const bot = () => run(EMPTY_ROOM, lane([row({ id: 'tg1', title: 'Support bot' })], T0))

describe('live detail from Hermes outside Herald', () => {
  it('brings in the session an event names at once, before the lane names it, traced to the event', () => {
    const state = run(EMPTY_ROOM, outside([ev('session.start', { at: T0 })], T0 + 100))
    const agent = state.agents['e:tg1']

    expect(agent).toMatchObject({ kind: 'elsewhere', title: '', parentId: null, phase: 'thinking', area: 'elsewhere', step: 'thinking', turnStartedAt: T0, approval: null })
    expect(agent.elsewhere).toEqual({ where: 'Telegram', active: true, lastActiveAt: T0, approval: false, liveAt: T0 })
    expect(agent.trace.phase).toEqual({ source: 'activity', type: 'session.start', seq: 1, at: T0 })
    expect(unlisted(agent)).toBe(true)
    expect(state.outsideSeq).toBe(1)
    expect(state.updatedAt).toBe(0)
    expect(unlisted(run(state, lane([row({ id: 'tg1', title: 'Support bot' })], T0 + 200)).agents['e:tg1'])).toBe(false)
  })

  it('walks to the area of each tool with the step from the fixed tables, and back to the lane when the turn ends', () => {
    let state = run(bot(), outside([ev('session.start'), ev('tool.start', { tool: 'read_file', target: 'Budget.xlsx', call: 'c1' })]))

    expect(view(state)).toEqual({ phase: 'tool', area: 'files', target: 'Budget.xlsx', step: 'reading Budget.xlsx', tool: 'read_file' })

    state = run(state, outside([ev('tool.end', { tool: 'read_file', call: 'c1', status: 'ok' })]))
    expect(view(state)).toEqual({ phase: 'thinking', area: 'files', target: 'Budget.xlsx', step: 'thinking', tool: null })

    state = run(state, outside([ev('tool.start', { tool: 'todo', call: 'c2' })]))
    expect(view(state)).toEqual({ phase: 'tool', area: 'files', target: null, step: 'updating the plan', tool: 'todo' })

    state = run(state, outside([ev('tool.end', { tool: 'todo' }), ev('tool.start', { tool: 'terminal', target: 'Hermes-OS', call: 'c3' })]))
    expect(view(state)).toEqual({ phase: 'tool', area: 'terminal', target: 'Hermes-OS', step: 'running a command', tool: 'terminal' })

    state = run(state, outside([ev('tool.end', { tool: 'terminal', call: 'c3' }), ev('session.end', { status: 'completed' })]))
    expect(view(state)).toEqual({ phase: 'idle', area: 'elsewhere', target: null, step: null, tool: null })
    expect(state.agents['e:tg1']).toMatchObject({ title: 'Support bot', turnStartedAt: null })
  })

  it('rests in the lane once the plugin says the turn ended, though the session list still counts the session active', () => {
    const ended = run(bot(), outside([ev('session.start', { at: T0 }), ev('session.end', { status: 'completed', at: T0 + 2_000 })], T0 + 3_000))

    expect(ended.agents['e:tg1'].elsewhere?.active).toBe(true)
    expect(view(ended)).toMatchObject({ phase: 'idle', area: 'elsewhere', step: null })
    expect(texts(ended, 'e:tg1', T0 + 2_000 + 3 * MIN)).toEqual(['Telegram · last active 3 minutes ago'])
    expect(view(run(ended, lane([row({ id: 'tg1', title: 'Support bot', active: true })], T0 + 4_000)))).toMatchObject({ phase: 'idle' })
    expect(summarizeRoom(ended, T0 + 3_000)).toMatchObject({ elsewhere: 0, lines: [] })
    expect(summarizeRoom(bot(), T0).elsewhere).toBe(1)
  })

  it('brings in helpers with a note, takes their own tool calls, and walks their result back', () => {
    let state = run(bot(), outside([ev('session.start'), ev('tool.start', { tool: 'delegate_task', call: 'd1' }), ev('helper.start', { child: 'kid' })]))
    const helper = state.agents['e:kid']

    expect(helper).toMatchObject({ kind: 'elsewhere', parentId: 'e:tg1', title: '', phase: 'thinking', area: 'lounge', step: 'thinking' })
    expect(helper.elsewhere?.where).toBe('Telegram')
    expect(state.handoffs).toMatchObject([{ kind: 'note', from: 'e:tg1', to: 'e:kid' }])

    state = run(state, outside([ev('tool.start', { session: 'kid', source: 'tool', tool: 'web_search', call: 'w1' })]))
    expect(view(state, 'e:kid')).toEqual({ phase: 'tool', area: 'browser', target: null, step: 'searching the web', tool: 'web_search' })
    expect(view(state)).toMatchObject({ tool: 'delegate_task', step: 'handing work to a helper' })

    const end = ev('helper.end', { child: 'kid', status: 'failed' })
    state = run(state, outside([end]))
    expect(state.agents['e:kid']).toMatchObject({ phase: 'finished', area: 'browser', step: null, tool: null, result: { status: 'failed', summary: null, inputTokens: null, at: end.at } })
    expect(state.handoffs.map(handoff => `${handoff.kind}:${handoff.from}>${handoff.to}`)).toEqual(['note:e:tg1>e:kid', 'result:e:kid>e:tg1'])
    expect(texts(state, 'e:kid', end.at)).toEqual(['could not finish'])
    expect(nextPruneAt(state)).toBe(end.at + FINISHED_KEEP_MS)

    state = run(state, { type: 'tick', now: end.at + FINISHED_KEEP_MS })
    expect(state.agents['e:kid']).toBeUndefined()
    expect(state.agents['e:tg1']).toBeDefined()
  })

  it('stages no walk for a helper that ended before the Room heard of it', () => {
    let state = run(bot(), outside([ev('session.start', { at: T0 }), ev('helper.start', { child: 'kid', at: T0 })], T0 + 10))

    state = run(state, outside([ev('helper.end', { child: 'kid', at: T0 + 1 })], T0 + 1 + FINISHED_KEEP_MS))
    expect(state.agents['e:kid']).toBeUndefined()
    expect(state.handoffs.map(handoff => handoff.kind)).toEqual(['note'])
    expect(run(state, outside([ev('helper.end', { child: 'unknown' })])).agents['e:unknown']).toBeUndefined()
  })

  it('puts work on the bench while an approval waits there, says where to answer it, and never holds up a card', () => {
    let state = run(bot(), outside([ev('session.start'), ev('tool.start', { tool: 'terminal', call: 't1' }), ev('approval.start', { call: 'a1' }), ev('approval.start', { call: 'a1' })]))
    const agent = state.agents['e:tg1']

    expect(view(state)).toEqual({ phase: 'waiting', area: 'bench', target: null, step: 'waiting for your OK in Telegram', tool: 'terminal' })
    expect(agent.approval).toBeNull()
    expect(agent.elsewhere?.approval).toBe(true)
    expect(agent.trace.approval).toMatchObject({ source: 'activity', type: 'approval.start' })
    expect(texts(state, 'e:tg1', T0 + 10)).toEqual(['waiting for your OK in Telegram', 'Telegram · active now'])
    expect(summarizeRoom(state, T0 + 10)).toMatchObject({ waiting: 0, elsewhere: 1, lines: ['Support bot (outside Herald): waiting for your OK in Telegram'] })

    state = run(state, outside([ev('approval.end', { call: 'a1', status: 'answered' })]))
    expect(view(state)).toEqual({ phase: 'tool', area: 'terminal', target: null, step: 'running a command', tool: 'terminal' })
    expect(state.agents['e:tg1'].elsewhere?.approval).toBe(false)

    state = run(state, outside([ev('tool.end', { tool: 'terminal', call: 't1' }), ev('tool.start', { tool: 'clarify', call: 'q1' })]))
    expect(view(state)).toEqual({ phase: 'waiting', area: 'bench', target: null, step: 'waiting for you in Telegram', tool: 'clarify' })
    expect(state.agents['e:tg1'].approval).toBeNull()
  })

  it('leaves Herald’s own sessions, helpers and automation runs to the room, and helpers it never saw start', () => {
    const job: RoomCronJob = { key: ':job1', id: 'job1', profile: null, name: 'Morning digest', paused: false, lastRunAt: null, lastOutcome: null, nextRunAt: null, claimed: false }
    let state = run(
      EMPTY_ROOM,
      { type: 'active_list', rows: [{ id: 'live-1', sessionKey: 'stored-1', status: 'working', title: 'Herald chat', startedAt: null }], sentAt: T0, at: T0 },
      { type: 'live', epoch: 'e1', frame: roomFrame({ type: 'subagent.start', session_id: 'live-1', seq: 1, payload: { subagent_id: 'h1', child_session_id: 'child-h', goal: 'g', task_count: 1, task_index: 0 } })!, at: T0 },
      { type: 'automations', jobs: [job], runs: {}, at: T0 }
    )
    const before = Object.keys(state.agents).sort()

    state = run(
      state,
      outside([
        ev('tool.start', { session: 'stored-1', source: 'cli', tool: 'read_file' }),
        ev('tool.start', { session: 'child-h', source: 'cli', tool: 'read_file' }),
        ev('helper.start', { session: 'stored-1', child: 'child-x' }),
        ev('helper.start', { session: 'elsewhere-1', child: 'child-h' }),
        ev('session.start', { session: 'cron_job1_20261015_030000', source: 'cron' }),
        ev('session.start', { session: 'mine', source: 'herald_os' }),
        ev('session.start', { session: 'renamed', source: 'hermes_os' }),
        ev('tool.start', { session: 'stray', source: 'tool', tool: 'read_file' })
      ])
    )

    expect(Object.keys(state.agents).sort()).toEqual(before)
    expect(state.outsideSeq).toBe(seq)

    state = run(state, outside([ev('session.start', { session: 'cron_other_20261015_030000', source: 'cron' })]))
    expect(state.agents['e:cron_other_20261015_030000']?.elsewhere?.where).toBe('a scheduled job')
  })

  it('takes the board’s own runs out of the lane when a lane read came before the automations', () => {
    const job: RoomCronJob = { key: ':job1', id: 'job1', profile: null, name: 'Morning digest', paused: false, lastRunAt: null, lastOutcome: null, nextRunAt: null, claimed: false }
    const early = run(EMPTY_ROOM, lane([row({ id: 'cron_job1_20261015_030000', source: 'cron', where: 'a scheduled job' }), row({ id: 'cron_other_20261015_030000', source: 'cron', where: 'a scheduled job' })], T0))

    expect(Object.keys(early.agents).sort()).toEqual(['e:cron_job1_20261015_030000', 'e:cron_other_20261015_030000'])

    const read = run(early, { type: 'automations', jobs: [job], runs: {}, at: T0 + 1_000 })

    expect(Object.keys(read.agents).sort()).toEqual(['a::job1', 'e:cron_other_20261015_030000'])
  })

  it('takes each event once, in main’s order, however often a subscribe replays it', () => {
    const events = [ev('session.start'), ev('tool.start', { tool: 'read_file', target: 'a.md', call: 'c1' }), ev('tool.end', { tool: 'read_file', call: 'c1' })]
    const once = run(EMPTY_ROOM, outside([events[2], events[0], events[1]]))

    expect(view(once)).toMatchObject({ phase: 'thinking', area: 'files' })
    expect(run(once, outside(events))).toBe(once)

    const more = run(once, outside([...events, ev('tool.start', { tool: 'web_search', call: 'c2' })]))
    expect(view(more)).toMatchObject({ phase: 'tool', area: 'browser', step: 'searching the web' })
    expect(more.agents['e:tg1'].basis?.tools).toEqual(['web_search#c2'])
  })

  it('goes back to the lane’s coarse view when busy work stops reporting for 10 minutes, and its helpers go', () => {
    let state = run(bot(), outside([ev('session.start', { at: T0 }), ev('tool.start', { tool: 'read_file', call: 'c1', at: T0 + 1 }), ev('helper.start', { child: 'kid', at: T0 + 2 })], T0 + 10))

    state = run(state, { type: 'tick', now: T0 + 2 + OUTSIDE_STALE_MS - 1 })
    expect(view(state)).toMatchObject({ phase: 'tool', area: 'files' })
    expect(state.agents['e:kid']).toBeDefined()
    expect(nextPruneAt(state)).toBe(T0 + 2 + OUTSIDE_STALE_MS)

    state = run(state, { type: 'tick', now: T0 + 2 + OUTSIDE_STALE_MS })
    expect(view(state)).toEqual({ phase: 'thinking', area: 'elsewhere', target: null, step: null, tool: null })
    expect(state.agents['e:tg1'].elsewhere).toMatchObject({ approval: false, liveAt: null })
    expect(state.agents['e:tg1'].trace.phase).toMatchObject({ source: 'activity', type: 'live.stale' })
    expect(state.agents['e:kid']).toBeUndefined()
    expect(nextPruneAt(state)).toBeNull()
  })

  it('keeps live work and its live fields through the lane’s reads, until it has been quiet for 10 minutes', () => {
    let state = run(EMPTY_ROOM, outside([ev('session.start', { session: 'cli1', source: 'cli', at: T0 }), ev('tool.start', { session: 'cli1', source: 'cli', tool: 'patch', target: 'main.py', call: 'p1', at: T0 + 1 })], T0 + 10))

    state = run(state, lane([row({ id: 'cli1', source: 'cli', where: 'the Hermes CLI', title: 'Refactor', lastActiveAt: T0 - 5 * MIN })], T0 + 20))
    expect(state.agents['e:cli1']).toMatchObject({ title: 'Refactor', sessionKey: 'cli1', phase: 'tool', area: 'files', step: 'editing main.py' })
    expect(state.agents['e:cli1'].elsewhere).toEqual({ where: 'the Hermes CLI', active: true, lastActiveAt: T0 + 1, approval: false, liveAt: T0 + 1 })

    state = run(state, lane([], T0 + 30))
    expect(state.agents['e:cli1']).toMatchObject({ phase: 'tool', step: 'editing main.py' })

    state = run(state, outside([ev('tool.end', { session: 'cli1', source: 'cli', tool: 'patch', call: 'p1', at: T0 + 40 }), ev('session.end', { session: 'cli1', source: 'cli', at: T0 + 41 })], T0 + 50))
    expect(run(state, lane([], T0 + 41 + OUTSIDE_STALE_MS - 1)).agents['e:cli1']).toBeDefined()
    expect(run(state, lane([], T0 + 41 + OUTSIDE_STALE_MS)).agents['e:cli1']).toBeUndefined()
    expect(run(state, lane(null, T0 + 60)).agents['e:cli1']).toBeUndefined()
  })

  it('drops all live detail and the helpers outside Herald when live detail is turned off', () => {
    let state = run(bot(), outside([ev('session.start'), ev('tool.start', { tool: 'read_file', target: 'a.md', call: 'c1' }), ev('approval.start', { call: 'a1' }), ev('helper.start', { child: 'kid' })]))

    state = run(state, { type: 'outside_off', at: T0 + 5_000 })
    expect(state.agents['e:kid']).toBeUndefined()
    expect(view(state)).toEqual({ phase: 'thinking', area: 'elsewhere', target: null, step: null, tool: null })
    expect(state.agents['e:tg1'].elsewhere).toMatchObject({ approval: false, liveAt: null })
    expect(state.outsideSeq).toBeUndefined()
    expect(run(state, { type: 'outside_off', at: T0 + 6_000 })).toBe(state)
    expect(view(run(state, outside([ev('session.start')])))).toMatchObject({ phase: 'thinking', step: 'thinking' })
  })

  it('says where live work runs, what it is doing and when a turn has gone quiet', () => {
    const state = run(bot(), outside([ev('session.start', { at: T0 }), ev('tool.start', { tool: 'read_file', target: 'Budget.xlsx', call: 'c1', at: T0 + 1 })], T0 + 10))

    expect(summarizeRoom(state, T0 + 20)).toMatchObject({ total: 0, elsewhere: 1, lines: ['Support bot (outside Herald): reading Budget.xlsx'] })
    expect(texts(state, 'e:tg1', T0 + 1 + 4 * MIN)).toEqual(['Telegram · active now', 'quiet for 4 minutes during a turn'])
    expect(texts(bot(), 'e:tg1', T0 + 10 * MIN)).toEqual(['Telegram · active now'])

    const quietLane = run(EMPTY_ROOM, lane([row({ id: 'tg1', title: 'Support bot', active: false, lastActiveAt: T0 - 20 * MIN })], T0), outside([ev('session.start', { at: T0 })], T0 + 10))
    expect(summarizeRoom(quietLane, T0 + 20).elsewhere).toBe(1)

    const helper = run(state, outside([ev('helper.start', { child: 'kid', at: T0 + 2 })], T0 + 10))
    expect(summarizeRoom(helper, T0 + 20).lines).toContain('A helper outside Herald: thinking')
  })
})
