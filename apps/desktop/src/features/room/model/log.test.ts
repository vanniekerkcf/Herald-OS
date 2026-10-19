import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomLogEntry } from '../../../../shared/room.ts'
import { createRoomLogger, logViewOf } from './log.ts'
import type { RoomAgent, RoomHandoff, RoomState } from './types.ts'

function agent(id: string, patch: Partial<RoomAgent> = {}): RoomAgent {
  return {
    id,
    kind: 'conversation',
    sessionId: 'live-1',
    sessionKey: 'stored-1',
    title: '',
    parentId: null,
    phase: 'idle',
    area: 'lounge',
    target: null,
    step: null,
    tool: null,
    startedAt: 1,
    turnStartedAt: null,
    lastEventAt: 1,
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

function room(agents: RoomAgent[], handoffs: RoomHandoff[] = []): RoomState {
  return {
    epoch: 'epoch-1',
    agents: Object.fromEntries(agents.map(entry => [entry.id, entry])),
    seen: {},
    handoffs,
    toolProgress: 'all',
    caps: { activeList: true, eventsSince: true, delegation: true, config: true, automations: true, sessionsDb: true },
    updatedAt: 1
  }
}

const handoff = (id: string, kind: RoomHandoff['kind'], from: string, to: string): RoomHandoff => ({ id, kind, from, to, at: 5, trace: { source: 'frame', type: 'subagent.complete', at: 5 } })

const result = (status: NonNullable<RoomAgent['result']>['status']): RoomAgent['result'] => ({
  status,
  summary: null,
  durationSeconds: null,
  filesRead: null,
  filesWritten: null,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  apiCalls: null,
  costUsd: null,
  at: 5
})

let sent: RoomLogEntry[][]
const all = () => sent.flat()
const logger = () => createRoomLogger({ send: entries => sent.push(entries), flushMs: 2000 })

beforeEach(() => {
  sent = []
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 15, 10, 0))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('logViewOf', () => {
  it('keeps the kind, phase, area, step, target, wait, parent, where and outcome, and nothing else', () => {
    const view = logViewOf(agent('h:1', { kind: 'helper', parentId: 's:1', phase: 'tool', area: 'sheets', step: 'reading Budget.xlsx', target: 'Budget.xlsx', asking: 'clarify' }))

    expect(view).toEqual({ kind: 'helper', phase: 'tool', area: 'sheets', step: 'reading Budget.xlsx', target: 'Budget.xlsx', wait: true, parent: 's:1', where: null, outcome: null })
  })

  it('says where outside work runs, and an approval waiting there', () => {
    const view = logViewOf(agent('e:1', { kind: 'elsewhere', area: 'elsewhere', elsewhere: { where: 'Telegram', active: true, lastActiveAt: 1, approval: true, liveAt: 1 } }))

    expect(view).toMatchObject({ where: 'Telegram', wait: true })
    expect(logViewOf(agent('s:1', { elsewhere: { where: 'Telegram', active: true, lastActiveAt: 1, approval: false, liveAt: null } })).where).toBeNull()
  })

  it("gives a helper's end, and an automation's last run only while none is under way", () => {
    const job = { jobId: 'job-1', profile: null, paused: false, running: false, runStartedAt: null, lastRunAt: 1, lastOutcome: 'failed' as const }

    expect(logViewOf(agent('h:1', { kind: 'helper', phase: 'finished', result: result('timeout') })).outcome).toBe('timeout')
    expect(logViewOf(agent('a:1', { kind: 'automation', automation: job })).outcome).toBe('failed')
    expect(logViewOf(agent('a:1', { kind: 'automation', phase: 'tool', automation: { ...job, running: true } })).outcome).toBeNull()
    expect(logViewOf(agent('s:1', { result: result('failed') })).outcome).toBeNull()
  })
})

describe('createRoomLogger', () => {
  it('starts with a begin and every agent in the Room', () => {
    const log = logger()
    log.start(room([agent('s:1', { phase: 'tool', area: 'docs', step: 'writing Notes.docx', target: 'Notes.docx' }), agent('h:2', { kind: 'helper', parentId: 's:1', phase: 'queued' })]), 100)
    log.flush()

    expect(all()).toEqual([
      { t: 100, k: 'begin' },
      { t: 100, k: 'agent', id: 's:1', kind: 'conversation', phase: 'tool', area: 'docs', step: 'writing Notes.docx', target: 'Notes.docx', wait: false, parent: null, where: null, outcome: null },
      { t: 100, k: 'agent', id: 'h:2', kind: 'helper', phase: 'queued', area: 'lounge', step: null, target: null, wait: false, parent: 's:1', where: null, outcome: null }
    ])
  })

  it('writes only what changed', () => {
    const log = logger()
    const first = agent('s:1')
    const second = agent('s:2')
    log.start(room([first, second]), 100)
    log.flush()
    sent = []

    log.update(room([first, second]), 200)
    log.update(room([{ ...first, title: 'Renamed', lastEventAt: 9, usage: { input: 1, output: 2, reasoning: null, calls: 1, turn: null, costUsd: 0.5, costStatus: 'actual', at: 9 } }, second]), 300)
    log.flush()

    expect(all()).toEqual([])

    log.update(room([{ ...first, phase: 'thinking' }, second]), 400)
    log.flush()

    expect(all()).toEqual([{ t: 400, k: 'agent', id: 's:1', kind: 'conversation', phase: 'thinking', area: 'lounge', step: null, target: null, wait: false, parent: null, where: null, outcome: null }])
  })

  it('writes a newcomer and a gone for an agent that left', () => {
    const log = logger()
    const first = agent('s:1')
    log.start(room([first]), 100)
    log.update(room([first, agent('h:2', { kind: 'helper', parentId: 's:1' })]), 200)
    log.update(room([agent('h:2', { kind: 'helper', parentId: 's:1' })]), 300)
    log.flush()

    expect(all().map(entry => [entry.t, entry.k, 'id' in entry ? entry.id : null])).toEqual([
      [100, 'begin', null],
      [100, 'agent', 's:1'],
      [200, 'agent', 'h:2'],
      [300, 'gone', 's:1']
    ])
  })

  it('writes each hand-off once, failed when its helper did not complete', () => {
    const log = logger()
    const parent = agent('s:1')
    const helper = agent('h:2', { kind: 'helper', parentId: 's:1', phase: 'finished', result: result('error') })
    const old = handoff('note:old', 'note', 's:1', 'h:0')
    log.start(room([parent, helper], [old]), 100)
    log.flush()
    sent = []

    const note = handoff('note:h:2', 'note', 's:1', 'h:2')
    const back = handoff('result:h:2', 'result', 'h:2', 's:1')
    log.update(room([parent, helper], [old, note]), 200)
    log.update(room([parent, helper], [old, note, back]), 300)
    log.update(room([parent, helper], [note, back]), 400)
    log.flush()

    expect(all()).toEqual([
      { t: 200, k: 'handoff', kind: 'note', from: 's:1', to: 'h:2', failed: false },
      { t: 300, k: 'handoff', kind: 'result', from: 'h:2', to: 's:1', failed: true }
    ])

    sent = []
    log.update(room([parent, { ...helper, result: result('completed') }], [handoff('result:h:3', 'result', 'h:2', 's:1')]), 500)
    log.flush()

    expect(all().find(entry => entry.k === 'handoff')).toMatchObject({ failed: false })
  })

  it('never writes titles, desks, approval text, usage, results or anything else of an agent', () => {
    const log = logger()
    const secret = (name: string) => `SECRET-${name}`
    const busy = agent('s:1', {
      sessionId: secret('session'),
      sessionKey: secret('stored'),
      title: secret('title'),
      phase: 'waiting',
      area: 'bench',
      tool: secret('tool'),
      approval: { requestId: secret('request'), rpcId: secret('rpc'), sessionId: secret('live'), params: { description: secret('description'), command: secret('command'), tool_name: secret('toolname'), choices: [secret('choice')], allow_permanent: true, allow_session: true } },
      repeat: { signature: secret('signature'), count: 4 },
      guardrail: { tool: secret('guarded'), code: secret('code'), at: 1 },
      desk: secret('desk'),
      usage: { input: 987654321, output: 123456789, reasoning: 55555, calls: 4444, turn: 333, costUsd: 9.87654, costStatus: 'actual', at: 1 },
      trace: { title: { source: 'frame', type: secret('trace'), at: 1 } }
    })
    const helper = agent('h:2', { kind: 'helper', parentId: 's:1', title: secret('goal'), phase: 'finished', result: { ...result('completed')!, summary: secret('summary'), filesRead: 3 }, toolCount: 777 })
    const job = agent('a:3', { kind: 'automation', area: 'automations', title: secret('job'), automation: { jobId: secret('jobid'), profile: secret('profile'), paused: true, running: false, runStartedAt: null, lastRunAt: 1, lastOutcome: 'ok' } })
    const state = { ...room([busy, helper, job]), desks: { 'docs:1': { id: 'docs:1', area: 'docs' as const, name: secret('document'), front: true, usedAt: 1 } }, meta: { stored: { id: 'stored', title: secret('meta'), source: null } } }
    log.start(state, 100)
    log.update({ ...state, agents: { ...state.agents, 's:1': { ...busy, title: secret('title-2'), phase: 'tool', step: 'running a command' } } }, 200)
    log.stop(300)
    const written = JSON.stringify(sent)

    expect(written).not.toContain('SECRET')
    expect(written).not.toMatch(/987654321|123456789|55555|4444|9\.87654|777/)
    expect(written).toContain('running a command')
  })

  it('sends in batches at most every flushMs', () => {
    const log = logger()
    const first = agent('s:1')
    log.start(room([first]), 100)
    log.update(room([{ ...first, phase: 'thinking' }]), 200)

    expect(sent).toHaveLength(0)

    vi.advanceTimersByTime(1999)

    expect(sent).toHaveLength(0)

    vi.advanceTimersByTime(1)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toHaveLength(3)

    log.update(room([{ ...first, phase: 'tool' }]), 300)
    vi.advanceTimersByTime(500)
    log.update(room([{ ...first, phase: 'idle' }]), 400)
    vi.advanceTimersByTime(1500)

    expect(sent).toHaveLength(2)
    expect(sent[1].map(entry => entry.t)).toEqual([300, 400])

    vi.advanceTimersByTime(10_000)

    expect(sent).toHaveLength(2)
  })

  it('ends with an end sent at once, and writes nothing after until it starts again', () => {
    const log = logger()
    const first = agent('s:1')
    log.start(room([first]), 100)
    log.stop(200)

    expect(sent).toHaveLength(1)
    expect(sent[0].at(-1)).toEqual({ t: 200, k: 'end' })

    log.update(room([{ ...first, phase: 'tool' }]), 300)
    log.stop(400)
    vi.advanceTimersByTime(5000)

    expect(sent).toHaveLength(1)

    log.start(room([first]), 500)
    log.flush()

    expect(sent[1].map(entry => entry.k)).toEqual(['begin', 'agent'])
  })

  it('closes a day at midnight and opens the next with what the Room showed', () => {
    const log = logger()
    const first = agent('s:1', { phase: 'tool', step: 'reading Budget.xlsx' })
    const evening = new Date(2026, 9, 15, 23, 50).getTime()
    const morning = new Date(2026, 9, 16, 0, 20).getTime()
    const midnight = new Date(2026, 9, 16).getTime()
    log.start(room([first]), evening)
    log.update(room([{ ...first, phase: 'idle', step: null }]), morning)
    log.flush()

    expect(all().map(entry => [entry.t, entry.k, entry.k === 'agent' ? entry.phase : null])).toEqual([
      [evening, 'begin', null],
      [evening, 'agent', 'tool'],
      [midnight - 1, 'end', null],
      [midnight, 'begin', null],
      [midnight, 'agent', 'tool'],
      [morning, 'agent', 'idle']
    ])
  })
})
