import { describe, expect, it } from 'vitest'
import { cronRunJob, ELSEWHERE_MAX, ELSEWHERE_RECENT_MS, elsewhereRows, type RoomElsewhereRow, roomElsewhereRow, whereOf } from './elsewhere.ts'
import { factsOf } from './facts.ts'
import { EMPTY_ROOM, reduceRoom, type RoomInput } from './reducer.ts'
import { ROOM_TIMING, emptyClock, roomDue } from './schedule.ts'
import { summarizeRoom } from './summary.ts'
import type { RoomState } from './types.ts'

const T0 = 1_792_000_000_000
const MIN = 60_000

const row = (patch: Partial<RoomElsewhereRow> & { id: string }): RoomElsewhereRow => ({ source: 'telegram', where: 'Telegram', title: '', startedAt: T0 - 10 * MIN, lastActiveAt: T0 - 30_000, active: true, usage: null, ...patch })

const run = (state: RoomState, ...inputs: RoomInput[]): RoomState => inputs.reduce(reduceRoom, state)

const lane = (rows: RoomElsewhereRow[] | null, at: number): RoomInput => ({ type: 'elsewhere', rows, at })

const herald = { sessionKeys: new Set<string>(), jobIds: new Set<string>() }

describe('a session row from the session database', () => {
  it('keeps its title, source, times and is_active, never its preview, model or counts', () => {
    const parsed = roomElsewhereRow({ id: 's1', source: 'Telegram', title: 'Support bot', preview: 'Hi, my card was charged twice', model: 'gpt-x', message_count: 42, started_at: 1_791_999_000, last_active: 1_791_999_900, is_active: true })

    expect(parsed).toEqual({ id: 's1', source: 'telegram', where: 'Telegram', title: 'Support bot', startedAt: 1_791_999_000_000, lastActiveAt: 1_791_999_900_000, active: true, usage: null })
    expect(JSON.stringify(parsed)).not.toMatch(/card|charged|gpt-x|42/)
  })

  it('keeps its token counts and cost only when cost meters ask for them', () => {
    const raw = { id: 's1', source: 'telegram', input_tokens: 9000, output_tokens: 1200, reasoning_tokens: 400, estimated_cost_usd: 0.031, actual_cost_usd: null, cost_status: 'estimated', model: 'gpt-x' }

    expect(roomElsewhereRow(raw)?.usage).toBeNull()
    expect(roomElsewhereRow(raw, true)?.usage).toEqual({ input: 9000, output: 1200, costUsd: 0.031, costStatus: 'estimated' })
    expect(JSON.stringify(roomElsewhereRow(raw, true))).not.toMatch(/gpt-x|400/)
  })

  it('says where it runs from a fixed table, never the raw source', () => {
    expect(whereOf('cli')).toBe('the Hermes CLI')
    expect(whereOf('desktop')).toBe("Hermes's desktop app")
    expect(whereOf('cron')).toBe('a scheduled job')
    expect(whereOf('some_new_platform <script>')).toBe('another Hermes app')
    expect(whereOf(null)).toBe('another Hermes app')
  })

  it('names the job of a cron run', () => {
    expect(cronRunJob('cron_a1b2c3_20261015_031200')).toBe('a1b2c3')
    expect(cronRunJob('cron_chat')).toBeNull()
  })
})

describe('the rows the lane shows', () => {
  it('leaves out Herald’s own sessions, helpers, runs of automations the room shows and stale ones', () => {
    const rows = [
      row({ id: 'own', source: 'herald_os' }),
      row({ id: 'renamed', source: 'hermes_os' }),
      row({ id: 'child', source: 'tool' }),
      row({ id: 'held', source: 'cli' }),
      row({ id: 'cron_job1_20261015_030000', source: 'cron', where: 'a scheduled job' }),
      row({ id: 'cron_other_20261015_030000', source: 'cron', where: 'a scheduled job' }),
      row({ id: 'old', active: false, lastActiveAt: T0 - ELSEWHERE_RECENT_MS - 1 }),
      row({ id: 'bot' })
    ]

    expect(elsewhereRows(rows, { sessionKeys: new Set(['held']), jobIds: new Set(['job1']) }, T0).map(entry => entry.id)).toEqual(['bot', 'cron_other_20261015_030000'])
  })

  it('puts active work first, then the most recently active, and holds at most a few', () => {
    const rows = Array.from({ length: ELSEWHERE_MAX + 3 }, (_, index) => row({ id: `r${index}`, active: index % 2 === 0, lastActiveAt: T0 - index * MIN }))
    const shown = elsewhereRows(rows, herald, T0)

    expect(shown).toHaveLength(ELSEWHERE_MAX)
    expect(shown.slice(0, 3).map(entry => entry.id)).toEqual(['r0', 'r2', 'r4'])
    expect(shown.findIndex(entry => !entry.active)).toBeGreaterThan(5)
  })
})

describe('the elsewhere lane in the room', () => {
  it('is empty unless the person turns it on, and leaves the moment it is turned off', () => {
    let state = run(EMPTY_ROOM, { type: 'active_list', rows: [], sentAt: T0, at: T0 })

    expect(Object.values(state.agents).some(agent => agent.kind === 'elsewhere')).toBe(false)
    expect(roomDue(state, { ...emptyClock(), listed: true }).elsewhere).toBe(Infinity)
    expect(roomDue(state, { ...emptyClock(), listed: true }, new Set(), { elsewhere: true }).elsewhere).toBe(0)
    expect(roomDue(state, { ...emptyClock(), listed: true, elsewhereAt: T0 }, new Set(), { elsewhere: true }).elsewhere).toBe(T0 + ROOM_TIMING.elsewhereMs)

    state = run(state, lane([row({ id: 'bot', title: 'Support bot' })], T0))
    expect(state.elsewhereOn).toBe(true)
    expect(state.agents['e:bot']).toMatchObject({ kind: 'elsewhere', area: 'elsewhere', phase: 'thinking', step: null, title: 'Support bot', sessionId: '' })

    state = run(state, lane(null, T0 + MIN))
    expect(state.elsewhereOn).toBe(false)
    expect(state.agents['e:bot']).toBeUndefined()
  })

  it('says it is coarse: where the work runs and how active it was at the last read', () => {
    const state = run(EMPTY_ROOM, lane([row({ id: 'bot', title: 'Support bot' }), row({ id: 'cli', source: 'cli', where: 'the Hermes CLI', active: false, lastActiveAt: T0 - 25 * MIN })], T0))

    expect(factsOf(state.agents['e:bot'], state, T0 + 10 * MIN).map(fact => fact.text)).toEqual(['Telegram · active now'])
    expect(factsOf(state.agents['e:cli'], state, T0 + 10 * MIN).map(fact => fact.text)).toEqual(['the Hermes CLI · last active 25 minutes ago'])
    expect(state.agents['e:bot'].trace.elsewhere).toEqual({ source: 'sessions_db', type: 'GET /api/sessions', at: T0 })
    expect(state.agents['e:cli']).toMatchObject({ phase: 'idle', area: 'elsewhere' })
  })

  it('stays out of the session list’s reach and of the room’s own counts', () => {
    let state = run(EMPTY_ROOM, lane([row({ id: 'bot', title: 'Support bot' })], T0))

    state = run(state, { type: 'active_list', rows: [], sentAt: T0 + 1, at: T0 + 1 })
    expect(state.agents['e:bot']).toBeDefined()

    const summary = summarizeRoom(state, T0 + 1)

    expect(summary).toMatchObject({ total: 0, working: 0, elsewhere: 1 })
    expect(summary.lines).toEqual(['Support bot (outside Herald): Telegram · active now'])
  })
})
