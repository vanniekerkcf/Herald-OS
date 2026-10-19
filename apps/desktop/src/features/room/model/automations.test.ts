import { describe, expect, it } from 'vitest'
import { automationOf, cronJobSignature, type RoomCronJob, roomCronJob, roomCronRun } from './automations.ts'
import { factsOf } from './facts.ts'
import { EMPTY_ROOM, reduceRoom, type RoomInput } from './reducer.ts'
import { ROOM_TIMING, emptyClock, roomDue } from './schedule.ts'
import { summarizeRoom } from './summary.ts'
import type { RoomState } from './types.ts'

const T0 = Date.UTC(2026, 9, 15, 3, 0, 0)
const MIN = 60_000

const job = (patch: Partial<RoomCronJob> = {}): RoomCronJob => ({ key: ':job1', id: 'job1', profile: null, name: 'Morning digest', paused: false, lastRunAt: null, lastOutcome: null, nextRunAt: null, claimed: false, ...patch })

type Runs = Extract<RoomInput, { type: 'automations' }>['runs']

const automations = (jobs: RoomCronJob[], runs: Runs, at: number): RoomInput => ({ type: 'automations', jobs, runs, at })

const run = (state: RoomState, ...inputs: RoomInput[]): RoomState => inputs.reduce(reduceRoom, state)

describe('a cron job, cut down', () => {
  it('keeps its name and status, never its prompt, script, delivery target or error text', () => {
    const parsed = roomCronJob({
      id: 'abc123',
      name: 'Morning digest',
      prompt: 'Summarise my inbox',
      script: 'echo secret',
      deliver: 'telegram:123',
      last_error: 'Traceback: token=abc',
      state: 'scheduled',
      enabled: true,
      last_run_at: '2026-10-15T02:00:00+00:00',
      last_status: 'ok',
      next_run_at: 1_792_000_000,
      profile: 'work'
    })

    expect(parsed).toEqual({ key: 'work:abc123', id: 'abc123', profile: 'work', name: 'Morning digest', paused: false, lastRunAt: Date.UTC(2026, 9, 15, 2), lastOutcome: 'ok', nextRunAt: 1_792_000_000_000, claimed: false })
    expect(JSON.stringify(parsed)).not.toMatch(/inbox|secret|telegram|Traceback/)
  })

  it('reads paused jobs, failed runs and rows without an id', () => {
    expect(roomCronJob({ id: 'a', state: 'paused' })?.paused).toBe(true)
    expect(roomCronJob({ id: 'a', enabled: false })?.paused).toBe(true)
    expect(roomCronJob({ id: 'a', last_status: 'error' })?.lastOutcome).toBe('failed')
    expect(roomCronJob({ id: 'a', fire_claim: { by: 'gateway', at: '2026-10-15T03:00:00Z' } })?.claimed).toBe(true)
    expect(roomCronJob({ name: 'no id' })).toBeNull()
  })

  it('takes a run row’s times and Hermes’s is_active, never its title or preview', () => {
    const parsed = roomCronRun({ id: 'cron_abc_20261015_020000', started_at: 1_792_000_000, ended_at: null, is_active: true, title: 'Inbox summary', preview: 'You have 3 emails from…', end_reason: null })

    expect(parsed).toEqual({ id: 'cron_abc_20261015_020000', startedAt: 1_792_000_000_000, endedAt: null, active: true, failed: false, usage: null })
    expect(roomCronRun({ id: 'r', end_reason: 'error: timeout' })?.failed).toBe(true)
  })

  it('keeps a run’s token counts and cost for cost meters, as a session row has them', () => {
    const parsed = roomCronRun({ id: 'r', input_tokens: 800, output_tokens: 90, reasoning_tokens: 12, estimated_cost_usd: 0.002, actual_cost_usd: null, cost_status: 'estimated', model: 'gpt-x', title: 'Inbox summary' })

    expect(parsed?.usage).toEqual({ input: 800, output: 90, costUsd: 0.002, costStatus: 'estimated' })
    expect(JSON.stringify(parsed)).not.toMatch(/gpt-x|Inbox/)
  })

  it('moves its signature when a run starts or ends', () => {
    expect(cronJobSignature(job())).not.toBe(cronJobSignature(job({ lastRunAt: T0 })))
    expect(cronJobSignature(job())).not.toBe(cronJobSignature(job({ nextRunAt: T0 })))
    expect(cronJobSignature(job())).not.toBe(cronJobSignature(job({ claimed: true })))
    expect(cronJobSignature(job())).toBe(cronJobSignature(job({ name: 'Renamed' })))
  })
})

describe('an automation’s status', () => {
  it('is running while its latest run is active, and keeps that between reads of its runs', () => {
    const running = automationOf(job(), { id: 'r1', startedAt: T0, endedAt: null, active: true, failed: false, usage: null }, null)

    expect(running).toMatchObject({ running: true, runStartedAt: T0 })
    expect(automationOf(job(), undefined, running)).toMatchObject({ running: true, runStartedAt: T0 })
    expect(automationOf(job({ lastRunAt: T0 + MIN, lastOutcome: 'ok' }), { id: 'r1', startedAt: T0, endedAt: T0 + MIN, active: false, failed: false, usage: null }, running)).toMatchObject({
      running: false,
      runStartedAt: null,
      lastRunAt: T0 + MIN,
      lastOutcome: 'ok'
    })
  })

  it('falls back on the run for the last outcome when the job says nothing', () => {
    expect(automationOf(job(), { id: 'r1', startedAt: T0, endedAt: T0 + MIN, active: false, failed: true, usage: null }, null)).toMatchObject({ lastRunAt: T0 + MIN, lastOutcome: 'failed' })
    expect(automationOf(job(), null, null)).toMatchObject({ running: false, lastRunAt: null, lastOutcome: null })
  })
})

describe('automations in the room', () => {
  it('stand in the Automations corner: at work while a run is under way, resting between runs', () => {
    let state = run(EMPTY_ROOM, automations([job()], { ':job1': { id: 'r1', startedAt: T0, endedAt: null, active: true, failed: false, usage: null } }, T0 + 5_000))
    const pet = state.agents['a::job1']

    expect(pet).toMatchObject({ kind: 'automation', title: 'Morning digest', phase: 'tool', area: 'automations', step: 'running', target: null, sessionId: '' })
    expect(pet.trace.automation).toEqual({ source: 'cron_runs', type: 'GET /api/cron/jobs/{id}/runs', at: T0 + 5_000 })
    expect(factsOf(pet, state, T0 + 3 * MIN).map(fact => fact.text)).toEqual(['running for 3 minutes'])

    state = run(state, automations([job({ lastRunAt: T0 + 4 * MIN, lastOutcome: 'ok' })], { ':job1': { id: 'r1', startedAt: T0, endedAt: T0 + 4 * MIN, active: false, failed: false, usage: null } }, T0 + 4 * MIN))
    expect(state.agents['a::job1']).toMatchObject({ phase: 'idle', area: 'automations', step: null })
    expect(factsOf(state.agents['a::job1'], state, T0 + 124 * MIN).map(fact => fact.text)).toEqual(['ran 2 hours ago'])
  })

  it('says when a job failed, was never run or is paused', () => {
    const state = run(EMPTY_ROOM, automations([job({ key: ':a', id: 'a', lastRunAt: T0, lastOutcome: 'failed' }), job({ key: ':b', id: 'b', name: 'Weekly report', paused: true })], {}, T0 + 30_000))

    expect(factsOf(state.agents['a::a'], state, T0 + 30_000).map(fact => fact.text)).toEqual(['failed just now'])
    expect(factsOf(state.agents['a::b'], state, T0 + 30_000).map(fact => fact.text)).toEqual(['not run yet', 'paused'])
  })

  it('leaves when its job is deleted, and the session list never drops it', () => {
    let state = run(EMPTY_ROOM, automations([job()], {}, T0))

    state = run(state, { type: 'active_list', rows: [], sentAt: T0 + 10, at: T0 + 10 }, { type: 'local_requests', approvals: [], at: T0 + 11 }, { type: 'tick', now: T0 + 40 * MIN })
    expect(state.agents['a::job1']).toBeDefined()

    state = run(state, automations([], {}, T0 + 41 * MIN))
    expect(state.agents['a::job1']).toBeUndefined()
  })

  it('counts a run under way as work, and an automation between runs not at all', () => {
    const state = run(EMPTY_ROOM, automations([job(), job({ key: ':b', id: 'b', name: 'Weekly report' })], { ':job1': { id: 'r1', startedAt: T0, endedAt: null, active: true, failed: false, usage: null } }, T0))
    const summary = summarizeRoom(state, T0 + MIN)

    expect(summary).toMatchObject({ total: 1, working: 1, idle: 0, automations: 1 })
    expect(summary.lines).toEqual(['Morning digest (automation): running'])
  })

  it('reads the job list again soon after cron.changed, and a running job’s runs often', () => {
    const state = run(EMPTY_ROOM, automations([job()], { ':job1': { id: 'r1', startedAt: T0, endedAt: null, active: true, failed: false, usage: null } }, T0))
    const clock = { ...emptyClock(), listed: true, jobsAt: T0, runsAt: { ':job1': T0 } }

    expect(roomDue(state, clock).automations).toBe(T0 + ROOM_TIMING.jobsBusyMs)
    expect(roomDue(state, { ...clock, jobsChangedAt: T0 + 100 }).automations).toBe(T0 + 100 + ROOM_TIMING.jobsChangedMs)
    expect(roomDue(state, clock).runs[':job1']).toBe(T0 + ROOM_TIMING.runsBusyMs)
    expect(roomDue(state, { ...clock, runsWanted: { ':job1': T0 + 5_000 } }).runs[':job1']).toBe(T0 + 5_000)
    expect(roomDue({ ...state, caps: { ...state.caps, automations: false } }, clock).automations).toBe(Infinity)
  })
})
