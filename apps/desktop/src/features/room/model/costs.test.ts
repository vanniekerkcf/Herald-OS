import { beforeEach, describe, expect, it } from 'vitest'
import { type RoomCronJob, roomCronRun } from './automations.ts'
import { meterOf, roomCostRow, roomTotal, rowUsage, tokensText } from './costs.ts'
import { roomElsewhereRow } from './elsewhere.ts'
import { roomFrame } from './frames.ts'
import { EMPTY_ROOM, reduceRoom, type RoomInput } from './reducer.ts'
import type { RoomAgent, RoomState, RoomUsage } from './types.ts'

const T0 = 7_000_000
let seq = 0

beforeEach(() => {
  seq = 0
})

const live = (type: string, payload: Record<string, unknown>, at: number, sessionId = 'live-1'): RoomInput => ({ type: 'live', epoch: 'e1', frame: roomFrame({ type, session_id: sessionId, seq: ++seq, payload })!, at })
const run = (state: RoomState, ...inputs: RoomInput[]): RoomState => inputs.reduce(reduceRoom, state)
const fold = (...inputs: RoomInput[]): RoomState => run(EMPTY_ROOM, ...inputs)
const list = (at: number): RoomInput => ({ type: 'active_list', rows: [{ id: 'live-1', sessionKey: 'stored-1', status: 'idle', title: 'Budget review', startedAt: null }], sentAt: at, at })
const usage = (patch: Partial<RoomUsage>): RoomUsage => ({ input: 10_000, output: 2_345, reasoning: null, calls: null, turn: null, costUsd: null, costStatus: null, at: 1, ...patch })
const job: RoomCronJob = { key: ':job1', id: 'job1', profile: null, name: 'Morning digest', paused: false, lastRunAt: null, lastOutcome: null, nextRunAt: null, claimed: false }

function agent(id: string, kind: RoomAgent['kind'], patch: Partial<RoomAgent> = {}): RoomAgent {
  return {
    id,
    kind,
    sessionId: '',
    sessionKey: null,
    title: '',
    parentId: null,
    phase: 'idle',
    area: 'lounge',
    target: null,
    step: null,
    tool: null,
    startedAt: null,
    turnStartedAt: null,
    lastEventAt: 0,
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

describe('usage, from what Hermes reports', () => {
  it("takes a conversation's running totals from its frames, the turn's tokens since it began, and never the model", () => {
    let state = fold(live('message.complete', { status: 'complete', usage: { model: 'private-model', input: 1_000, output: 200, reasoning: 50, calls: 2, total: 1_250 } }, T0))

    expect(state.agents['s:live-1'].usage).toEqual({ input: 1_000, output: 200, reasoning: 50, calls: 2, turn: null, costUsd: null, costStatus: null, at: T0 })

    state = run(state, live('message.start', {}, T0 + 10))
    expect(state.agents['s:live-1'].usage?.turn).toBe(0)

    state = run(state, live('session.usage', { usage: { input: 1_500, output: 300, reasoning: 80, calls: 3 } }, T0 + 20))
    expect(state.agents['s:live-1'].usage).toMatchObject({ input: 1_500, output: 300, calls: 3, turn: 600 })
    expect(state.agents['s:live-1'].phase).toBe('thinking')

    state = run(state, live('message.complete', { status: 'complete', usage: { input: 2_100, output: 400, reasoning: 90, calls: 4 } }, T0 + 30))
    expect(state.agents['s:live-1'].usage).toMatchObject({ input: 2_100, output: 400, calls: 4, turn: 1_300 })
    expect(state.agents['s:live-1'].trace.usage).toEqual({ source: 'frame', type: 'message.complete', seq: 4, at: T0 + 30 })
    expect(JSON.stringify(state)).not.toContain('private-model')
  })

  it("takes the money for Herald's own sessions from the session database, by stored id, and lets the frames' token totals win", () => {
    let state = fold(list(T0), live('message.complete', { status: 'complete', usage: { input: 1_000, output: 200 } }, T0 + 1))
    const rows = [roomCostRow({ id: 'stored-1', input_tokens: 900, output_tokens: 150, estimated_cost_usd: 0.04, actual_cost_usd: null, cost_status: 'estimated', title: 'never kept', model: 'm' })!, roomCostRow({ id: 'other', input_tokens: 5 })!]

    state = run(state, { type: 'costs', rows, at: T0 + 5 })
    expect(state.agents['s:live-1'].usage).toMatchObject({ input: 1_000, output: 200, costUsd: 0.04, costStatus: 'estimated' })
    expect(state.agents['s:live-1'].trace.usage).toEqual({ source: 'sessions_db', type: 'GET /api/sessions', at: T0 + 5 })
    expect(state.agents['s:live-1'].lastEventAt).toBe(T0 + 1)
    expect(JSON.stringify(state)).not.toContain('never kept')
    expect(run(state, { type: 'costs', rows, at: T0 + 6 })).toBe(state)

    const quiet = run(fold(list(T0)), { type: 'costs', rows, at: T0 + 5 })
    expect(quiet.agents['s:live-1'].usage).toMatchObject({ input: 900, output: 150, reasoning: null, turn: null, costUsd: 0.04 })
  })

  it("keeps a helper's usage for its whole job, a lane row's while meters ask for it, and an automation run's", () => {
    const helper = fold(live('subagent.complete', { subagent_id: 'a', goal: 'g', task_count: 1, task_index: 0, status: 'completed', input_tokens: 1_200, output_tokens: 340, reasoning_tokens: 56, api_calls: 4, cost_usd: 0.0123 }, T0))

    expect(helper.agents['h:a'].usage).toEqual({ input: 1_200, output: 340, reasoning: 56, calls: 4, turn: null, costUsd: 0.0123, costStatus: 'estimated', at: T0 })

    const raw = { id: 'tg1', source: 'telegram', title: 'Support bot', is_active: true, input_tokens: 5_000, output_tokens: 700, estimated_cost_usd: 0.01, actual_cost_usd: 0.012, cost_status: 'actual' }
    const counted = fold({ type: 'elsewhere', rows: [roomElsewhereRow(raw, true)!], at: T0 })
    expect(counted.agents['e:tg1'].usage).toEqual({ input: 5_000, output: 700, reasoning: null, calls: null, turn: null, costUsd: 0.012, costStatus: 'actual', at: T0 })
    expect(run(counted, { type: 'elsewhere', rows: [roomElsewhereRow(raw)!], at: T0 + 1 }).agents['e:tg1'].usage).toBeNull()

    const run1 = roomCronRun({ id: 'cron_job1_20261015_030000', started_at: 1, is_active: false, input_tokens: 800, output_tokens: 90, estimated_cost_usd: 0.002, cost_status: 'estimated', title: 'never kept' })
    const automated = fold({ type: 'automations', jobs: [job], runs: { ':job1': run1 }, at: T0 })
    expect(automated.agents['a::job1'].usage).toMatchObject({ input: 800, output: 90, costUsd: 0.002, costStatus: 'estimated' })
    expect(run(automated, { type: 'automations', jobs: [job], runs: {}, at: T0 + 1 }).agents['a::job1'].usage).toMatchObject({ input: 800 })
    expect(JSON.stringify(automated)).not.toContain('never kept')
  })
})

describe('a session row’s usage', () => {
  it('keeps token counts and cost only, and never calls a session billed without a billed amount', () => {
    expect(rowUsage({ input_tokens: 5, output_tokens: 6, estimated_cost_usd: 0.2, actual_cost_usd: 0.25, cost_status: 'actual', model: 'm', title: 't' })).toEqual({ input: 5, output: 6, costUsd: 0.25, costStatus: 'actual' })
    expect(rowUsage({ estimated_cost_usd: 0.2, actual_cost_usd: null, cost_status: 'actual' })).toEqual({ input: null, output: null, costUsd: 0.2, costStatus: 'estimated' })
    expect(rowUsage({ estimated_cost_usd: 0.2, cost_status: 'whatever' })).toMatchObject({ costUsd: 0.2, costStatus: 'estimated' })
    expect(rowUsage({ input_tokens: 10, estimated_cost_usd: 0, cost_status: 'included' })).toMatchObject({ costStatus: 'included' })
    expect(rowUsage({ input_tokens: 10, estimated_cost_usd: 0, cost_status: 'unknown' })).toMatchObject({ costStatus: 'unknown' })
    expect(rowUsage({ input_tokens: -3, title: 'x' })).toBeNull()
    expect(roomCostRow({ title: 'no id' })).toBeNull()
  })
})

describe('what a meter says', () => {
  it('says tokens the short way', () => {
    expect(tokensText(950)).toBe('950 tokens')
    expect(tokensText(1)).toBe('1 token')
    expect(tokensText(12_345)).toBe('12.3k tokens')
    expect(tokensText(12_000)).toBe('12k tokens')
    expect(tokensText(1_234_567)).toBe('1.2M tokens')
    expect(tokensText(999_990)).toBe('1M tokens')
  })

  it('says a billed amount plainly, an estimate as one, a plan in words, and only tokens otherwise', () => {
    expect(meterOf(agent('s:1', 'conversation', { usage: usage({ costUsd: 0.04, costStatus: 'actual', turn: 2_100 }) }))).toEqual({
      text: '12.3k tokens · $0.04',
      title: 'Tokens Hermes counted for this conversation (this turn: 2.1k). The cost is what the provider billed.'
    })
    expect(meterOf(agent('s:1', 'mission', { usage: usage({ costUsd: 0.04, costStatus: 'estimated' }) }))).toEqual({ text: '12.3k tokens · ~$0.04 est.', title: "Tokens Hermes counted for this mission. The cost is Hermes's estimate." })
    expect(meterOf(agent('s:1', 'conversation', { usage: usage({ costUsd: 0.004, costStatus: 'estimated' }) }))?.text).toBe('12.3k tokens · <$0.01 est.')
    expect(meterOf(agent('a:1', 'automation', { usage: usage({ costUsd: 0, costStatus: 'included' }) }))?.text).toBe('12.3k tokens · included in a plan')
    expect(meterOf(agent('e:1', 'elsewhere', { usage: usage({ costUsd: 0, costStatus: 'unknown' }) }))).toEqual({ text: '12.3k tokens', title: 'Tokens Hermes counted for this session. Hermes does not know its cost.' })
    expect(meterOf(agent('s:1', 'conversation', { usage: usage({}) }))).toEqual({ text: '12.3k tokens', title: 'Tokens Hermes counted for this conversation.' })
    expect(meterOf(agent('h:1', 'helper', { usage: usage({ costUsd: 0.5, costStatus: 'estimated' }) }))?.title).toContain('the conversation that started the helper')
    expect(meterOf(agent('s:1', 'conversation', { usage: usage({ input: null, output: null }) }))).toBeNull()
    expect(meterOf(agent('s:1', 'conversation'))).toBeNull()
  })

  it('shows nothing for a session the database has not counted yet, and only its money when it has one', () => {
    expect(meterOf(agent('e:1', 'elsewhere', { usage: usage({ input: 0, output: 0 }) }))).toBeNull()
    expect(meterOf(agent('e:1', 'elsewhere', { usage: usage({ input: 0, output: 0, costUsd: 0.01, costStatus: 'estimated' }) }))).toEqual({ text: '~$0.01 est.', title: "The cost is Hermes's estimate." })
  })
})

describe('the total', () => {
  it('adds up the work in the room but not helpers, and marks the money as an estimate when any part is one', () => {
    const agents = {
      's:1': agent('s:1', 'conversation', { usage: usage({ input: 9_000, output: 1_000, costUsd: 0.1, costStatus: 'actual' }) }),
      'a:1': agent('a:1', 'automation', { usage: usage({ input: 1_500, output: 500, costUsd: 0.05, costStatus: 'estimated' }) }),
      'e:1': agent('e:1', 'elsewhere', { usage: usage({ input: 800, output: 200, costUsd: 0.01, costStatus: 'actual' }) }),
      'h:1': agent('h:1', 'helper', { usage: usage({ input: 40_000, output: 10_000, costUsd: 0.5, costStatus: 'estimated' }) }),
      'e:kid': agent('e:kid', 'elsewhere', { parentId: 'e:1', usage: usage({ input: 40_000, output: 10_000 }) })
    }
    const total = roomTotal({ agents })

    expect(total?.text).toBe('In the room: 13k tokens · ~$0.16 est.')
    expect(total?.title).toContain("Helpers are not added: Hermes adds a helper's cost to the conversation that started it.")
    expect(total?.title).toContain("Part of the cost is Hermes's estimate.")

    const billed = roomTotal({ agents: { 's:1': agents['s:1'], 'e:1': agents['e:1'] } })
    expect(billed?.text).toBe('In the room: 11k tokens · $0.11')
    expect(billed?.title).toContain('The cost is what the providers billed.')

    const partly = roomTotal({ agents: { 's:1': agents['s:1'], 's:2': agent('s:2', 'conversation', { usage: usage({ input: 1_000, output: 0, costStatus: 'unknown' }) }) } })
    expect(partly?.text).toBe('In the room: 11k tokens · ~$0.10 est.')
    expect(partly?.title).toContain('Hermes does not know the cost of one of them, so the total is an estimate.')

    expect(roomTotal({ agents: { 'a:1': agent('a:1', 'automation', { usage: usage({ input: 10, output: 5, costUsd: 0, costStatus: 'included' }) }) } })?.text).toBe('In the room: 15 tokens · included in a plan')
    expect(roomTotal({ agents: { 'h:1': agents['h:1'] } })).toBeNull()
    expect(roomTotal(EMPTY_ROOM)).toBeNull()
  })
})
