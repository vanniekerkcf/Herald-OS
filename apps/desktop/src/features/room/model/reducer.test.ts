import { beforeEach, describe, expect, it } from 'vitest'
import { type RoomFrame, type RoomHelperRecord, roomFrame, roomRequest, type RoomSessionRow } from './frames.ts'
import { EMPTY_ROOM, FINISHED_KEEP_MS, HANDOFF_KEEP_MS, nextPruneAt, reduceRoom, type RoomInput, UNLISTED_IDLE_KEEP_MS } from './reducer.ts'
import type { RoomState } from './types.ts'

const T0 = 1_000_000
let nextSeq = 0

beforeEach(() => {
  nextSeq = 0
})

function f(type: string, payload: Record<string, unknown> = {}, sessionId = 'live-1', seq?: number): RoomFrame {
  return roomFrame({ type, session_id: sessionId, seq: seq ?? ++nextSeq, payload })!
}

const live = (frame: RoomFrame, at: number, epoch: string | null = 'e1'): RoomInput => ({ type: 'live', epoch, frame, at })

function events(sessionId: string, frames: RoomFrame[], options: Partial<Extract<RoomInput, { type: 'events' }>> = {}): RoomInput {
  return { type: 'events', sessionId, epoch: 'e1', latestSeq: Math.max(nextSeq, ...frames.map(frame => frame.seq ?? 0)), truncated: false, frames, requests: null, backfill: false, sentAt: T0, at: T0, ...options }
}

function list(rows: Array<Partial<RoomSessionRow> & { id: string }>, sentAt: number, at = sentAt): RoomInput {
  return { type: 'active_list', rows: rows.map(row => ({ sessionKey: `stored-${row.id}`, status: 'idle', title: '', startedAt: null, ...row })), sentAt, at }
}

function helpers(records: Array<Partial<RoomHelperRecord> & { subagentId: string }>, sentAt: number, initial = false): RoomInput {
  return { type: 'delegation', records: records.map(record => ({ parentId: null, goal: null, startedAt: null, queued: false, toolCount: null, lastTool: null, ownerSessionKey: null, ...record })), initial, sentAt, at: sentAt }
}

const run = (state: RoomState, ...inputs: RoomInput[]): RoomState => inputs.reduce(reduceRoom, state)
const fold = (...inputs: RoomInput[]): RoomState => run(EMPTY_ROOM, ...inputs)
const agentOf = (state: RoomState, id = 's:live-1') => state.agents[id]
const view = (state: RoomState, id = 's:live-1') => {
  const { phase, area, target, step, tool } = agentOf(state, id)

  return { phase, area, target, step, tool }
}

describe('a session through a turn', () => {
  it('rests in the lounge, stands up for a turn, walks to each tool and back', () => {
    let state = fold(list([{ id: 'live-1', title: 'Budget review' }], T0))

    expect(view(state)).toEqual({ phase: 'idle', area: 'lounge', target: null, step: null, tool: null })
    expect(agentOf(state)).toMatchObject({ kind: 'conversation', title: 'Budget review', sessionKey: 'stored-live-1' })

    state = run(state, live(f('message.start'), T0 + 10))
    expect(view(state)).toEqual({ phase: 'thinking', area: 'lounge', target: null, step: 'thinking', tool: null })
    expect(agentOf(state).turnStartedAt).toBe(T0 + 10)

    state = run(state, live(f('tool.start', { tool_id: 't1', name: 'read_file', args: { path: '/x/Budget.xlsx' } }), T0 + 20))
    expect(view(state)).toEqual({ phase: 'tool', area: 'files', target: 'Budget.xlsx', step: 'reading Budget.xlsx', tool: 'read_file' })

    state = run(state, live(f('tool.complete', { tool_id: 't1', name: 'read_file' }), T0 + 30))
    expect(view(state)).toEqual({ phase: 'thinking', area: 'files', target: 'Budget.xlsx', step: 'thinking', tool: null })

    state = run(state, live(f('tool.start', { tool_id: 't2', name: 'skill_view', args: {} }), T0 + 40))
    expect(view(state)).toMatchObject({ phase: 'tool', area: 'memory', step: 'reading a skill' })

    state = run(state, live(f('tool.complete', { tool_id: 't2', name: 'skill_view' }), T0 + 45), live(f('tool.start', { tool_id: 't3', name: 'delegate_task', args: { goal: 'x' } }), T0 + 50))
    expect(view(state)).toEqual({ phase: 'tool', area: 'memory', target: null, step: 'handing work to a helper', tool: 'delegate_task' })

    state = run(state, live(f('message.complete', { status: 'complete', text: 'done' }), T0 + 60))
    expect(view(state)).toEqual({ phase: 'idle', area: 'lounge', target: null, step: null, tool: null })
    expect(agentOf(state).turnStartedAt).toBeNull()
    expect(agentOf(state).basis?.idleSince).toBe(T0 + 60)
  })

  it('keeps the tool running while a parallel one ends', () => {
    const state = fold(
      live(f('message.start'), T0),
      live(f('tool.start', { tool_id: 'a', name: 'web_search', args: {} }), T0 + 1),
      live(f('tool.start', { tool_id: 'b', name: 'read_file', args: { path: 'a.md' } }), T0 + 2),
      live(f('tool.complete', { tool_id: 'a', name: 'web_search' }), T0 + 3)
    )

    expect(view(state)).toMatchObject({ phase: 'tool', area: 'files', step: 'reading a.md' })
  })

  it('gets ready while Hermes builds its agent', () => {
    expect(view(fold(list([{ id: 'live-1', status: 'starting' }], T0)))).toEqual({ phase: 'starting', area: 'lounge', target: null, step: 'getting ready', tool: null })
  })

  it('runs commands in the session folder and never says the command', () => {
    const state = fold(
      live(f('session.info', { cwd: '/Users/me/Hermes-OS', running: true }), T0),
      live(f('tool.start', { tool_id: 't', name: 'terminal', args: { command: 'npm test -- --secret' } }), T0 + 1)
    )

    expect(view(state)).toEqual({ phase: 'tool', area: 'terminal', target: 'Hermes-OS', step: 'running a command', tool: 'terminal' })
  })

  it('waits on the bench while clarify asks the person', () => {
    const state = fold(live(f('message.start'), T0), live(f('tool.start', { tool_id: 'q', name: 'clarify', args: { question: 'Which?' } }), T0 + 1))

    expect(view(state)).toMatchObject({ phase: 'waiting', area: 'bench', step: 'waiting for you in Hermes' })
  })

  it('counts the usage ticks Hermes sends while a turn runs as a turn at work', () => {
    const state = fold(list([{ id: 'live-1' }], T0), live(f('session.usage', { usage: { input: 10, output: 2 } }), T0 + 10))

    expect(view(state)).toEqual({ phase: 'thinking', area: 'lounge', target: null, step: 'thinking', tool: null })
    expect(agentOf(state).lastEventAt).toBe(T0 + 10)
  })

  it('takes the turn start from session.info', () => {
    const state = fold(live(f('session.info', { running: true, turn_started_at: 1_700_000_000 }), T0))

    expect(agentOf(state).turnStartedAt).toBe(1_700_000_000_000)
    expect(agentOf(state).phase).toBe('thinking')
  })

  it('becomes a mission once it keeps a todo list', () => {
    expect(agentOf(fold(live(f('todo.updated', { todos: [], revision: 1 }), T0))).kind).toBe('mission')

    const state = fold(live(f('message.start'), T0), live(f('tool.start', { tool_id: 't', name: 'todo', args: { todos: [] } }), T0 + 1), live(f('message.complete'), T0 + 2))

    expect(agentOf(state).kind).toBe('mission')
  })

  it('traces each field to the frame that set it', () => {
    const state = fold(live(f('message.start', {}, 'live-1', 7), T0), live(f('tool.start', { tool_id: 't', name: 'read_file', args: { path: 'a.md' } }, 'live-1', 8), T0 + 5))
    const { trace } = agentOf(state)

    expect(trace.phase).toEqual({ source: 'frame', type: 'tool.start', seq: 8, at: T0 + 5 })
    expect(trace.target).toEqual({ source: 'frame', type: 'tool.start', seq: 8, at: T0 + 5 })
    expect(trace.lastEventAt).toEqual({ source: 'frame', type: 'tool.start', seq: 8, at: T0 + 5 })
    expect(trace.kind).toEqual({ source: 'frame', type: 'message.start', seq: 7, at: T0 })
  })

  it('traces each field to its own frame within one read of the buffer', () => {
    const frames = [f('message.start'), f('tool.start', { tool_id: 't', name: 'read_file', args: { path: 'a.md' } }), f('tool.complete', { tool_id: 't', name: 'read_file' })]
    const { trace } = agentOf(fold(events('live-1', frames, { sentAt: T0, at: T0 + 9 })))

    expect(trace.phase).toEqual({ source: 'frame', type: 'tool.complete', seq: 3, at: T0 + 9 })
    expect(trace.area).toEqual({ source: 'frame', type: 'tool.start', seq: 2, at: T0 + 9 })
    expect(trace.step).toEqual({ source: 'frame', type: 'tool.complete', seq: 3, at: T0 + 9 })
  })
})

describe('records and frames, by which is newer', () => {
  it('does not let a list asked for before a live frame undo the frame', () => {
    const state = fold(list([{ id: 'live-1' }], T0), live(f('message.start'), T0 + 10), list([{ id: 'live-1', status: 'idle' }], T0 + 5, T0 + 20))

    expect(agentOf(state).phase).toBe('thinking')
  })

  it('lets a list asked for after the frames say the turn is over', () => {
    const state = fold(live(f('message.start'), T0), live(f('tool.start', { tool_id: 't', name: 'web_search' }), T0 + 1), list([{ id: 'live-1', status: 'idle' }], T0 + 100))

    expect(view(state)).toEqual({ phase: 'idle', area: 'lounge', target: null, step: null, tool: null })
  })

  it('does not move lastEventAt for a list that changes nothing', () => {
    const state = fold(list([{ id: 'live-1', status: 'working' }], T0), list([{ id: 'live-1', status: 'working' }], T0 + 3_000), list([{ id: 'live-1', status: 'working' }], T0 + 6_000))

    expect(agentOf(state).lastEventAt).toBe(T0)
  })

  it('drops sessions the list no longer has, with their helpers, unless a frame came after it was asked for', () => {
    let state = fold(list([{ id: 'live-1' }, { id: 'live-2' }], T0), live(f('subagent.start', { subagent_id: 'h1', goal: 'g', task_count: 1, task_index: 0 }, 'live-2'), T0 + 1))

    expect(Object.keys(state.agents).sort()).toEqual(['h:h1', 's:live-1', 's:live-2'])

    state = run(state, live(f('message.start', {}, 'live-3'), T0 + 50), list([{ id: 'live-1' }], T0 + 10, T0 + 60))
    expect(Object.keys(state.agents).sort()).toEqual(['s:live-1', 's:live-3'])
  })

  it("never makes a second pet of a helper's own session someone watches", () => {
    const state = fold(
      list([{ id: 'live-1' }], T0),
      live(f('subagent.start', { subagent_id: 'h1', goal: 'Find hotels', task_count: 1, task_index: 0, child_session_id: 'child-stored' }), T0 + 1),
      list([{ id: 'live-1' }, { id: 'watch-live', sessionKey: 'child-stored', status: 'working' }], T0 + 10)
    )

    expect(Object.keys(state.agents).sort()).toEqual(['h:h1', 's:live-1'])
  })
})

describe('helpers', () => {
  const spawn = (stage: string, extra: Record<string, unknown> = {}, sessionId = 'live-1') => f(`subagent.${stage}`, { subagent_id: 'h1', goal: 'Find hotels in Rome', task_count: 1, task_index: 0, ...extra }, sessionId)

  it('are handed a note, work, and walk their result back', () => {
    let state = fold(list([{ id: 'live-1', title: 'Trip plan', status: 'working' }], T0), live(spawn('spawn_requested'), T0 + 1))
    const helper = agentOf(state, 'h:h1')

    expect(helper).toMatchObject({ kind: 'helper', parentId: 's:live-1', sessionId: 'live-1', sessionKey: 'stored-live-1', title: 'Find hotels in Rome', phase: 'queued', step: 'waiting to start', area: 'lounge' })
    expect(state.handoffs).toEqual([{ id: 'note:h:h1', kind: 'note', from: 's:live-1', to: 'h:h1', at: T0 + 1, trace: { source: 'frame', type: 'subagent.spawn_requested', seq: 1, at: T0 + 1 } }])

    state = run(state, live(spawn('start'), T0 + 2), live(spawn('tool', { tool_name: 'web_search', tool_count: 1 }), T0 + 3))
    expect(view(state, 'h:h1')).toEqual({ phase: 'tool', area: 'browser', target: null, step: 'searching the web', tool: 'web_search' })
    expect(agentOf(state, 'h:h1').toolCount).toBe(1)

    state = run(state, live(spawn('complete', { status: 'timeout', summary: 'Ran out of time', duration_seconds: 300 }), T0 + 4))
    expect(agentOf(state, 'h:h1')).toMatchObject({ phase: 'finished', step: null, tool: null, result: { status: 'timeout', summary: 'Ran out of time', durationSeconds: 300, at: T0 + 4 } })
    expect(state.handoffs.map(handoff => [handoff.kind, handoff.from, handoff.to])).toEqual([
      ['note', 's:live-1', 'h:h1'],
      ['result', 'h:h1', 's:live-1']
    ])
  })

  it('nest under the helper that spawned them', () => {
    const state = fold(live(spawn('start'), T0), live(f('subagent.start', { subagent_id: 'h2', parent_id: 'h1', goal: 'Check prices', task_count: 1, task_index: 0 }), T0 + 1))

    expect(agentOf(state, 'h:h2')).toMatchObject({ parentId: 'h:h1', sessionId: 'live-1' })
  })

  it('join their conversation through its stored id', () => {
    const state = fold(
      list([{ id: 'live-1', sessionKey: 'stored-A', title: 'Trip plan' }], T0),
      helpers([{ subagentId: 'h9', goal: 'Read the brief', ownerSessionKey: 'stored-A', lastTool: 'read_file', toolCount: 4 }], T0 + 1)
    )

    expect(agentOf(state, 'h:h9')).toMatchObject({ parentId: 's:live-1', sessionId: 'live-1', sessionKey: 'stored-A', phase: 'tool', area: 'files', step: 'reading a file', tool: 'read_file', toolCount: 4 })
    expect(state.handoffs).toHaveLength(1)
  })

  it('found on the first look are not handed a note', () => {
    const state = fold(list([{ id: 'live-1', sessionKey: 'stored-A' }], T0), helpers([{ subagentId: 'h9', ownerSessionKey: 'stored-A' }], T0 + 1, true))

    expect(agentOf(state, 'h:h9').phase).toBe('thinking')
    expect(state.handoffs).toEqual([])
  })

  it('that leave delegation.status without a word are finished after one more look', () => {
    let state = fold(list([{ id: 'live-1', sessionKey: 'stored-A' }], T0), helpers([{ subagentId: 'h9', ownerSessionKey: 'stored-A' }], T0 + 1, true), helpers([], T0 + 2_000))

    expect(agentOf(state, 'h:h9').phase).toBe('thinking')

    state = run(state, helpers([], T0 + 4_000))
    expect(agentOf(state, 'h:h9')).toMatchObject({ phase: 'finished', result: null })
    expect(state.handoffs.map(handoff => handoff.kind)).toEqual(['result'])
  })

  it('still queued are not finished by their absence', () => {
    const state = fold(live(spawn('spawn_requested'), T0), helpers([], T0 + 2_000), helpers([], T0 + 4_000), helpers([], T0 + 6_000))

    expect(agentOf(state, 'h:h1').phase).toBe('queued')
  })

  it('finished go after their walk back, hand-offs a little later', () => {
    const state = fold(live(spawn('start'), T0), live(spawn('complete', { status: 'completed' }), T0 + 1))

    expect(nextPruneAt(state)).toBe(T0 + 1 + FINISHED_KEEP_MS)
    expect(run(state, { type: 'tick', now: T0 + FINISHED_KEEP_MS }).agents['h:h1']).toBeDefined()

    const later = run(state, { type: 'tick', now: T0 + 1 + FINISHED_KEEP_MS })
    expect(later.agents['h:h1']).toBeUndefined()
    expect(later.handoffs).toHaveLength(2)
    expect(run(later, { type: 'tick', now: T0 + 1 + HANDOFF_KEEP_MS }).handoffs).toEqual([])
  })

  it('a quiet tick leaves the state as it was', () => {
    const state = fold(list([{ id: 'live-1' }], T0))

    expect(run(state, { type: 'tick', now: T0 + 1 })).toBe(state)
  })
})

describe('approvals and other requests', () => {
  const approval = (requestId = 'apr-1', rpcId = 'srq-1') =>
    roomRequest({ id: rpcId, method: 'approval', params: { session_id: 'live-1', request_id: requestId, command: 'rm a.txt', description: 'Delete a.txt', choices: ['once', 'session', 'deny'] } })!

  it('raise the sign from open_requests and lower it when a newer read has none', () => {
    let state = fold(
      list([{ id: 'live-1', status: 'working' }], T0),
      live(f('message.start'), T0 + 1),
      live(f('tool.start', { tool_id: 't', name: 'terminal', args: { command: 'rm a.txt' } }), T0 + 2),
      events('live-1', [], { requests: [approval()], sentAt: T0 + 3, at: T0 + 4 })
    )

    expect(view(state)).toEqual({ phase: 'waiting', area: 'bench', target: null, step: 'waiting for your OK', tool: 'terminal' })
    expect(agentOf(state).approval).toMatchObject({ requestId: 'apr-1', rpcId: 'srq-1', sessionId: 'live-1', params: { description: 'Delete a.txt' } })
    expect(agentOf(state).trace.approval).toEqual({ source: 'open_request', type: 'session.events.since', at: T0 + 4 })

    state = run(state, events('live-1', [], { requests: [], sentAt: T0 + 10, at: T0 + 11 }))
    expect(view(state)).toMatchObject({ phase: 'tool', area: 'terminal', step: 'running a command' })
    expect(agentOf(state).approval).toBeNull()
  })

  it('say other requests are waiting in Hermes, and never hold them up as approvals', () => {
    const state = fold(list([{ id: 'live-1', status: 'waiting' }], T0), events('live-1', [], { requests: [roomRequest({ id: 'srq-2', method: 'clarify', params: { question: 'Which?' } })!], sentAt: T0 + 1 }))

    expect(agentOf(state)).toMatchObject({ approval: null, asking: 'clarify', phase: 'waiting', step: 'waiting for you in Hermes' })
  })

  it('come from this window too, and go when it no longer holds them', () => {
    const local = approval('apr-7', 'srq-7').approval!
    let state = fold(list([{ id: 'live-1', status: 'working' }], T0), { type: 'local_requests', approvals: [local], at: T0 + 1 })

    expect(agentOf(state).approval).toEqual(local)
    expect(agentOf(state).trace.approval).toEqual({ source: 'local_request', type: 'approval', at: T0 + 1 })

    state = run(state, { type: 'local_requests', approvals: [], at: T0 + 2 })
    expect(agentOf(state).approval).toBeNull()
  })

  it('hold up the one this window already had when the Room first sees the session', () => {
    const local = approval('apr-7', 'srq-7').approval!
    const state = fold({ type: 'local_requests', approvals: [local], at: T0 }, list([{ id: 'live-1', status: 'waiting' }], T0 + 1))

    expect(agentOf(state)).toMatchObject({ approval: local, phase: 'waiting', step: 'waiting for your OK' })
    expect(agentOf(state).trace.approval).toEqual({ source: 'local_request', type: 'approval', at: T0 + 1 })
  })

  it('stay down after an answer even when a read raced it, until the memory of it fades', () => {
    let state = fold(list([{ id: 'live-1', status: 'waiting' }], T0), events('live-1', [], { requests: [approval()], sentAt: T0 + 1 }), { type: 'answered', requestId: 'apr-1', at: T0 + 2 })

    expect(agentOf(state).approval).toBeNull()
    expect(agentOf(state).phase).toBe('thinking')

    state = run(state, events('live-1', [], { requests: [approval()], sentAt: T0 + 1, at: T0 + 3 }))
    expect(agentOf(state).approval).toBeNull()

    state = run(state, { type: 'answer_failed', requestId: 'apr-1', at: T0 + 4 }, events('live-1', [], { requests: [approval()], sentAt: T0 + 5 }))
    expect(agentOf(state).approval?.requestId).toBe('apr-1')
  })

  it('are withdrawn by request.cancel', () => {
    const state = fold(list([{ id: 'live-1', status: 'waiting' }], T0), events('live-1', [], { requests: [approval()], sentAt: T0 + 1 }), live(f('request.cancel', { id: 'srq-1', method: 'approval', reason: 'timeout' }), T0 + 5))

    expect(agentOf(state).approval).toBeNull()
  })
})

describe('repeats and guardrails', () => {
  const call = (path: string) => f('tool.start', { tool_id: `t${nextSeq}`, name: 'read_file', args: { path } })

  it('counts the same call in a row and starts over on a different one or a new turn', () => {
    let state = fold(live(f('message.start'), T0), live(call('a.md'), T0 + 1), live(call('a.md'), T0 + 2), live(call('a.md'), T0 + 3))

    expect(agentOf(state).repeat?.count).toBe(3)

    state = run(state, live(call('b.md'), T0 + 4))
    expect(agentOf(state).repeat?.count).toBe(1)

    state = run(state, live(call('b.md'), T0 + 5), live(f('message.start'), T0 + 6))
    expect(agentOf(state).repeat).toBeNull()
  })

  it("keeps Hermes's guardrail halt for the turn", () => {
    let state = fold(live(f('message.start'), T0), live(f('status.update', { kind: 'lifecycle', text: '⚠️ Tool guardrail halted read_file: identical_call_streak_halt' }), T0 + 1))

    expect(agentOf(state).guardrail).toEqual({ tool: 'read_file', code: 'identical_call_streak_halt', at: T0 + 1 })

    state = run(state, live(f('message.start'), T0 + 2))
    expect(agentOf(state).guardrail).toBeNull()
  })
})

describe('watermarks and epochs', () => {
  it('applies a frame once, whether it came live, polled or both', () => {
    const start = f('message.start', {}, 'live-1', 1)
    const tool = f('tool.start', { tool_id: 't', name: 'read_file', args: { path: 'a.md' } }, 'live-1', 2)
    const state = fold(live(start, T0), live(tool, T0 + 1), events('live-1', [start, tool], { sentAt: T0 + 2 }), live(tool, T0 + 3))

    expect(agentOf(state).repeat?.count).toBe(1)
    expect(state.seen['live-1']).toBe(2)
  })

  it('starts over when the backend numbers its frames again', () => {
    const state = fold(
      { type: 'session_meta', rows: [{ id: 'stored-1', title: 'T', source: 'cli' }], at: T0 },
      live(f('message.start', {}, 'live-1', 40), T0 + 1, 'e1'),
      events('live-1', [f('message.start', {}, 'live-1', 1)], { epoch: 'e2', sentAt: T0 + 2 })
    )

    expect(state).toMatchObject({ epoch: 'e2', agents: {}, seen: {}, handoffs: [], meta: { 'stored-1': { title: 'T' } } })
  })

  it('reads a renumbered buffer from the start', () => {
    const state = fold(live(f('message.start', {}, 'live-1', 50), T0), events('live-1', [f('tool.start', { tool_id: 't', name: 'web_search' }, 'live-1', 3)], { latestSeq: 3, sentAt: T0 + 1 }))

    expect(agentOf(state).phase).toBe('tool')
    expect(state.seen['live-1']).toBe(3)
  })

  it("resets to nothing but the stored session rows, this window's own approvals and Herald's own desks and commands", () => {
    const state = run(fold(list([{ id: 'live-1' }], T0), { type: 'session_meta', rows: [], at: T0 }), { type: 'reset', epoch: null, at: T0 + 5 })

    expect(state).toEqual({ ...EMPTY_ROOM, meta: {}, local: [], desks: {}, desksTrace: null, commands: [], updatedAt: T0 + 5 })
  })
})

describe('a first read of a buffer', () => {
  it('tells what happened before the Room looked without staging it again', () => {
    const backfill = [
      f('message.start'),
      f('subagent.spawn_requested', { subagent_id: 'old', goal: 'Old work', task_count: 1, task_index: 0 }),
      f('subagent.complete', { subagent_id: 'old', goal: 'Old work', task_count: 1, task_index: 0, status: 'completed' }),
      f('subagent.start', { subagent_id: 'running', goal: 'Still at it', task_count: 1, task_index: 0 }),
      f('message.complete')
    ]
    const state = fold(list([{ id: 'live-1', status: 'idle' }], T0), events('live-1', backfill, { backfill: true, sentAt: T0 + 1 }))

    expect(Object.keys(state.agents).sort()).toEqual(['h:running', 's:live-1'])
    expect(state.handoffs).toEqual([])
    expect(agentOf(state)).toMatchObject({ phase: 'idle', turnStartedAt: null })
    expect(agentOf(state).basis?.idleSince).toBeNull()
  })
})

describe('caps and config', () => {
  it('turns parts of the Room off and keeps the rest', () => {
    const state = fold({ type: 'caps', caps: { delegation: false }, at: T0 })

    expect(state.caps).toEqual({ activeList: true, eventsSince: true, delegation: false, config: true, automations: true, sessionsDb: true })
  })

  it("lets idle sessions go after a long quiet when nothing lists Hermes's sessions", () => {
    const state = fold({ type: 'caps', caps: { activeList: false }, at: T0 }, live(f('message.start'), T0), live(f('message.complete'), T0 + 1))

    expect(nextPruneAt(state)).toBe(T0 + 1 + UNLISTED_IDLE_KEEP_MS)
    expect(run(state, { type: 'tick', now: T0 + 1 + UNLISTED_IDLE_KEEP_MS }).agents).toEqual({})
  })

  it("keeps Hermes's tool progress setting with where it came from", () => {
    expect(fold({ type: 'config', toolProgress: 'off', at: T0 })).toMatchObject({ toolProgress: 'off', toolProgressTrace: { source: 'config', type: 'config.get', at: T0 }, updatedAt: T0 })
  })

  it('fills an untitled conversation from the stored session list', () => {
    const state = fold(list([{ id: 'live-1', sessionKey: 'stored-A' }], T0), { type: 'session_meta', rows: [{ id: 'stored-A', title: 'Inbox triage', source: 'herald_os' }], at: T0 + 1 })

    expect(agentOf(state).title).toBe('Inbox triage')
  })
})
