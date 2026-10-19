import { describe, expect, it } from 'vitest'
import { roomFrame, roomRequest } from './frames.ts'
import { EMPTY_ROOM, reduceRoom, type RoomInput } from './reducer.ts'
import { summarizeRoom } from './summary.ts'

const T0 = 9_000_000
let seq = 0

const live = (sessionId: string, type: string, payload: Record<string, unknown>, at = T0): RoomInput => ({ type: 'live', epoch: 'e1', frame: roomFrame({ type, session_id: sessionId, seq: ++seq, payload })!, at })
const row = (id: string, title: string, status: 'idle' | 'working' | 'waiting', startedAt: number) => ({ id, sessionKey: `stored-${id}`, status, title, startedAt })

describe('the Room in words', () => {
  it('counts what is at work and says a line per agent from the fixed tables, waiting first', () => {
    const inputs: RoomInput[] = [
      { type: 'active_list', rows: [row('budget', 'Budget review', 'working', 1), row('inbox', 'Inbox triage', 'waiting', 2), row('trip', 'Trip plan', 'working', 3), row('old', '', 'idle', 4)], sentAt: T0, at: T0 },
      live('budget', 'todo.updated', { todos: [], revision: 1 }),
      live('budget', 'tool.start', { tool_id: 't1', name: 'read_file', args: { path: '/Users/me/Budget.xlsx' } }),
      {
        type: 'events',
        sessionId: 'inbox',
        epoch: 'e1',
        latestSeq: 0,
        truncated: false,
        frames: [],
        requests: [roomRequest({ id: 'srq-1', method: 'approval', params: { session_id: 'inbox', request_id: 'apr-1' } })!],
        backfill: false,
        sentAt: T0 + 1,
        at: T0 + 1
      },
      live('trip', 'subagent.start', { subagent_id: 'h1', goal: 'Find hotels', task_count: 1, task_index: 0 }),
      live('trip', 'subagent.tool', { subagent_id: 'h1', goal: 'Find hotels', task_count: 1, task_index: 0, tool_name: 'browser_navigate' }),
      live('trip', 'subagent.start', { subagent_id: 'h2', goal: 'Book a table', task_count: 1, task_index: 0 }),
      live('trip', 'subagent.complete', { subagent_id: 'h2', goal: 'Book a table', task_count: 1, task_index: 0, status: 'completed' })
    ]
    const summary = summarizeRoom(inputs.reduce(reduceRoom, EMPTY_ROOM), T0 + 2)

    expect(summary).toEqual({
      total: 5,
      working: 3,
      waiting: 1,
      idle: 1,
      helpers: 1,
      automations: 0,
      elsewhere: 0,
      lines: ['Inbox triage (conversation): waiting for your OK', 'Budget review (mission): reading Budget.xlsx', 'Trip plan (conversation): thinking', 'Find hotels (helper of Trip plan): browsing the web', 'Conversation: idle']
    })
  })

  it('reads out facts worth knowing after the step', () => {
    const inputs: RoomInput[] = [
      live('s1', 'message.start', {}, T0),
      live('s1', 'tool.start', { tool_id: 'a', name: 'terminal', args: { command: 'make' } }, T0),
      live('s1', 'tool.start', { tool_id: 'b', name: 'terminal', args: { command: 'make' } }, T0),
      live('s1', 'tool.start', { tool_id: 'c', name: 'terminal', args: { command: 'make' } }, T0)
    ]

    expect(summarizeRoom(inputs.reduce(reduceRoom, EMPTY_ROOM), T0 + 5 * 60_000).lines).toEqual(['Conversation: running a command, same call 3 times, quiet for 5 minutes during a turn'])
  })

  it('is empty when nothing is there', () => {
    expect(summarizeRoom(EMPTY_ROOM, T0)).toEqual({ total: 0, working: 0, waiting: 0, idle: 0, helpers: 0, automations: 0, elsewhere: 0, lines: [] })
  })
})
