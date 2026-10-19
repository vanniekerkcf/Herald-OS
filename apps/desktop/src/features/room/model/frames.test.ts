import type { ActiveSubagent, SessionActiveItem } from '@herald-os/client'
import { describe, expect, it } from 'vitest'
import { callSignature, guardrailOf, roomFrame, roomHelperRecord, roomRequest, roomSessionMeta, roomSessionRow, summaryLine } from './frames.ts'
import { EMPTY_ROOM, reduceRoom, type RoomInput } from './reducer.ts'
import { factsOf } from './facts.ts'
import { summarizeRoom } from './summary.ts'

const MARKER = 'private-marker-7f3a'

const raw = (type: string, seq: number, payload: Record<string, unknown> = {}, sessionId = 'live-1') => ({ type, session_id: sessionId, seq, payload })

describe('frames are cut down on arrival', () => {
  it('keeps nothing of text, thinking, arguments, previews, results, status lines or todo items', () => {
    const frames = [
      raw('session.info', 1, { running: true, cwd: `/Users/me/${MARKER}/herald`, title: 'Budget review', stored_session_id: 'stored-1', tools: { all: [MARKER] }, usage: { note: MARKER } }),
      raw('message.start', 2, { text: MARKER }),
      raw('reasoning.delta', 3, { text: MARKER }),
      raw('thinking.delta', 4, { text: MARKER }),
      raw('message.delta', 5, { text: MARKER }),
      raw('tool.start', 6, {
        tool_id: 't1',
        name: 'terminal',
        context: MARKER,
        args: { command: `echo ${MARKER}`, workdir: '/home/me/project' },
        labels: [{ kind: 'tool', app: '', action: '', emoji: '', text: MARKER, name: 'terminal', preview: MARKER }]
      }),
      raw('tool.complete', 7, { tool_id: 't1', name: 'terminal', summary: MARKER, result: MARKER, result_text: MARKER, inline_diff: MARKER }),
      raw('tool.start', 8, { tool_id: 't2', name: 'write_file', context: MARKER, args: { path: `/tmp/${MARKER}/notes.md`, content: MARKER } }),
      raw('tool.start', 9, { tool_id: 't3', name: 'browser_navigate', args: { url: `https://me:${MARKER}@example.com/${MARKER}?q=${MARKER}` } }),
      raw('tool.start', 10, { tool_id: 't4', name: 'tool_call', args: { query: MARKER }, labels: [{ kind: 'connector', app: 'Gmail', action: 'send', emoji: '', text: MARKER, name: 'gmail_send', preview: MARKER }] }),
      raw('status.update', 11, { kind: 'status', text: MARKER }),
      raw('todo.updated', 12, { todos: [{ content: MARKER, status: 'pending' }], revision: 1 }),
      raw('subagent.spawn_requested', 13, { subagent_id: 'sa1', goal: 'Find hotels', task_count: 1, task_index: 0, text: MARKER, tool_preview: MARKER }),
      raw('subagent.tool', 14, { subagent_id: 'sa1', goal: 'Find hotels', task_count: 1, task_index: 0, tool_name: 'web_search', tool_preview: MARKER, text: MARKER }),
      raw('subagent.progress', 15, { subagent_id: 'sa1', goal: 'Find hotels', task_count: 1, task_index: 0, text: MARKER }),
      raw('subagent.thinking', 16, { subagent_id: 'sa1', goal: 'Find hotels', task_count: 1, task_index: 0, text: MARKER }),
      raw('subagent.complete', 17, {
        subagent_id: 'sa1',
        goal: 'Find hotels',
        task_count: 1,
        task_index: 0,
        status: 'completed',
        summary: 'Found three hotels near the station',
        files_read: [`/x/${MARKER}.txt`],
        files_written: [`/y/${MARKER}.txt`],
        input_tokens: 1200,
        output_tokens: 340,
        reasoning_tokens: 56,
        api_calls: 4,
        cost_usd: 0.0123,
        output_tail: [{ tool: 'web_search', preview: MARKER, is_error: false }]
      }),
      raw('message.complete', 18, { text: MARKER, reasoning: MARKER, status: 'complete' })
    ]
    const at = 1_000
    const inputs: RoomInput[] = [
      {
        type: 'active_list',
        rows: [roomSessionRow({ current: false, id: 'live-1', last_active: 1, message_count: 4, model: MARKER, preview: MARKER, session_key: 'stored-1', started_at: 1, status: 'working', title: 'Budget review' } satisfies SessionActiveItem)!],
        sentAt: at,
        at
      },
      {
        type: 'events',
        sessionId: 'live-1',
        epoch: 'e1',
        latestSeq: 18,
        truncated: false,
        frames: frames.map(roomFrame).filter(frame => frame !== null),
        requests: [roomRequest({ id: 'srq-1', method: 'clarify', params: { session_id: 'live-1', question: MARKER } }), roomRequest({ id: 'srq-2', method: 'secret', params: { session_id: 'live-1', prompt: MARKER, env_var: MARKER } })].filter(
          request => request !== null
        ),
        backfill: false,
        sentAt: at + 1,
        at: at + 2
      },
      {
        type: 'delegation',
        records: [roomHelperRecord({ subagent_id: 'sa2', goal: 'Read the contract', status: 'running', tool_count: 2, last_tool: 'read_file', owner_agent_session_id: 'stored-1', model: MARKER, missed_steer: MARKER } satisfies ActiveSubagent)!],
        initial: false,
        sentAt: at + 3,
        at: at + 4
      },
      { type: 'session_meta', rows: [roomSessionMeta({ id: 'stored-1', title: 'Budget review', preview: MARKER, source: 'herald_os' })!], at: at + 5 }
    ]
    const state = inputs.reduce(reduceRoom, EMPTY_ROOM)
    const facts = Object.values(state.agents).flatMap(agent => factsOf(agent, state, at + 10))

    expect(Object.keys(state.agents).sort()).toEqual(['h:sa1', 'h:sa2', 's:live-1'])
    expect(JSON.stringify(state)).not.toContain(MARKER)
    expect(JSON.stringify(facts)).not.toContain(MARKER)
    expect(JSON.stringify(summarizeRoom(state, at + 10))).not.toContain(MARKER)
    expect(state.agents['h:sa1'].result).toMatchObject({ status: 'completed', summary: 'Found three hotels near the station', filesRead: 1, filesWritten: 1 })
  })

  it('keeps a helper’s token, call and cost counts for cost meters, and never says them', () => {
    const frame = roomFrame(raw('subagent.complete', 1, { subagent_id: 'a', goal: 'g', task_count: 1, task_index: 0, status: 'completed', input_tokens: 1200, output_tokens: 340, reasoning_tokens: 56, api_calls: 4, cost_usd: 0.0123 }))!
    const state = reduceRoom(EMPTY_ROOM, { type: 'live', epoch: 'e1', frame, at: 5 })
    const helper = state.agents['h:a']

    expect(helper.result).toMatchObject({ inputTokens: 1200, outputTokens: 340, reasoningTokens: 56, apiCalls: 4, costUsd: 0.0123 })
    expect(JSON.stringify([factsOf(helper, state, 6), summarizeRoom(state, 6)])).not.toMatch(/1200|340|0\.0123/)
    expect(roomFrame(raw('subagent.complete', 2, { subagent_id: 'b', status: 'completed', input_tokens: -1, api_calls: 'many' }))).toMatchObject({ helper: { inputTokens: null, apiCalls: null } })
  })

  it('cuts a helper summary to 160 characters', () => {
    const frame = roomFrame(raw('subagent.complete', 1, { subagent_id: 'a', goal: 'g', task_count: 1, task_index: 0, status: 'completed', summary: 'x'.repeat(500) }))

    expect(frame?.type === 'subagent' && frame.helper.summary?.length).toBe(160)
  })

  it('keeps a helper summary to its first plain sentence', () => {
    expect(summaryLine('The file `/tmp/a/Budget.csv` contains:\n| Item | Amount |\n|------|------|\n| rent | 1200 |\nTotal 1200.')).toBe('The file /tmp/a/Budget.csv contains: Total 1200.')
    expect(summaryLine('A **petdex pet** is an _animated_ mascot. It walks around.')).toBe('A petdex pet is an animated mascot.')
    expect(summaryLine('## Result\n- Found [three hotels](https://example.com/x?token=1) near the station\n```\nrm -rf x\n```')).toBe('Result Found three hotels near the station')
    expect(summaryLine('```\nonly code\n```')).toBeNull()
  })

  it('needs a session id to place a frame', () => {
    expect(roomFrame({ type: 'sessions.changed', payload: {} })).toBeNull()
    expect(roomFrame({ type: 'message.start', session_id: '', seq: 1 })).toBeNull()
    expect(roomFrame(null)).toBeNull()
  })

  it('keeps frames without a seq, for backends that do not stamp them', () => {
    expect(roomFrame({ type: 'message.start', session_id: 's' })).toEqual({ type: 'message.start', sessionId: 's', seq: null, event: 'message.start' })
  })

  it('keeps the four usage counts of message.complete and session.usage, and nothing else they carry', () => {
    expect(roomFrame(raw('message.complete', 1, { status: 'complete', text: MARKER, usage: { model: MARKER, input: 10, output: 5, reasoning: 1, calls: 1, total: 16, context_used: 4_000 } }))).toEqual({
      type: 'message.complete',
      sessionId: 'live-1',
      seq: 1,
      event: 'message.complete',
      status: 'complete',
      usage: { input: 10, output: 5, reasoning: 1, calls: 1 }
    })
    expect(roomFrame(raw('session.usage', 2, { usage: { input: 20, output: 7, model: MARKER } }))).toEqual({ type: 'usage', sessionId: 'live-1', seq: 2, event: 'session.usage', usage: { input: 20, output: 7, reasoning: null, calls: null } })
    expect(roomFrame(raw('session.usage', 3, { usage: { model: MARKER } }))).toEqual({ type: 'activity', turn: true, sessionId: 'live-1', seq: 3, event: 'session.usage' })
    expect(roomFrame(raw('message.complete', 4, { status: 'complete' }))).toMatchObject({ usage: null })
  })

  it('turns deltas and anything unknown into bare activity', () => {
    expect(roomFrame(raw('message.delta', 3, { text: 'hello' }))).toEqual({ type: 'activity', turn: true, sessionId: 'live-1', seq: 3, event: 'message.delta' })
    expect(roomFrame(raw('notification.show', 4, { text: 'hello' }))).toEqual({ type: 'activity', turn: false, sessionId: 'live-1', seq: 4, event: 'notification.show' })
  })
})

describe('tool calls sign by name and arguments', () => {
  it('signs the same call the same, whatever the key order', () => {
    expect(callSignature('read_file', { path: 'a', limit: 2 })).toBe(callSignature('read_file', { limit: 2, path: 'a' }))
    expect(callSignature('read_file', { path: 'a' })).not.toBe(callSignature('read_file', { path: 'b' }))
    expect(callSignature('read_file', { path: 'a' })).not.toBe(callSignature('write_file', { path: 'a' }))
    expect(callSignature('read_file', { path: MARKER })).not.toContain(MARKER)
  })
})

describe("Hermes's guardrail halts", () => {
  it('parses the tool and the code, and nothing else', () => {
    expect(guardrailOf('⚠️ Tool guardrail halted web_search: loop_web_search_cap')).toEqual({ tool: 'web_search', code: 'loop_web_search_cap' })
    expect(guardrailOf('⚠️ Tool guardrail halted terminal: identical_call_streak_halt')).toEqual({ tool: 'terminal', code: 'identical_call_streak_halt' })
    expect(guardrailOf('⚠️ Tool guardrail halted terminal: something_new')).toBeNull()
    expect(guardrailOf('compacting the conversation')).toBeNull()
    expect(roomFrame(raw('status.update', 1, { kind: 'lifecycle', text: '⚠️ Tool guardrail halted read_file: repeated_exact_failure_block' }))).toMatchObject({ type: 'guardrail', tool: 'read_file', code: 'repeated_exact_failure_block' })
  })
})

describe('records and requests', () => {
  it('keeps plain approvals with only what the card shows', () => {
    expect(
      roomRequest({
        id: 'srq-9',
        method: 'approval',
        params: { session_id: 'live-1', request_id: 'apr-1', command: 'rm a.txt', description: 'Delete a file', tool_name: 'terminal', choices: ['once', 'deny'], allow_permanent: false, gateway_session_id: 'x', smart_denied: true }
      })
    ).toEqual({
      rpcId: 'srq-9',
      kind: 'approval',
      approval: { requestId: 'apr-1', rpcId: 'srq-9', sessionId: 'live-1', params: { description: 'Delete a file', command: 'rm a.txt', tool_name: 'terminal', choices: ['once', 'deny'], allow_permanent: false, allow_session: null } }
    })
  })

  it('says what other requests are, and leaves out those nobody waits on', () => {
    expect(roomRequest({ id: 'a', method: 'clarify', params: {} })).toEqual({ rpcId: 'a', kind: 'clarify', approval: null })
    expect(roomRequest({ id: 'b', method: 'sudo', params: {} })?.kind).toBe('sudo')
    expect(roomRequest({ id: 'c', method: 'secret', params: {} })?.kind).toBe('secret')
    expect(roomRequest({ id: 'd', method: 'vault.code', params: {} })?.kind).toBe('other')
    expect(roomRequest({ id: 'e', method: 'terminal.read', params: {} })).toBeNull()
    expect(roomRequest({ id: 'f', method: 'tour', params: {} })).toBeNull()
  })

  it('reads active_list rows without their preview', () => {
    expect(roomSessionRow({ current: true, id: 'live-1', last_active: 1, message_count: 3, model: 'm', preview: 'hello', session_key: 'stored-1', started_at: 1_700_000_000, status: 'streaming', title: '  Trip  plan ' })).toEqual({
      id: 'live-1',
      sessionKey: 'stored-1',
      status: 'working',
      title: 'Trip plan',
      startedAt: 1_700_000_000_000
    })
    expect(roomSessionRow({ id: 'x', status: 'resuming' })?.status).toBe('starting')
    expect(roomSessionRow({ id: 'x', status: 'weird' })?.status).toBeNull()
  })
})
