import { describe, expect, it } from 'vitest'
import { factsOf, spanOf } from './facts.ts'
import { roomFrame, roomRequest } from './frames.ts'
import { EMPTY_ROOM, reduceRoom, type RoomInput } from './reducer.ts'
import type { RoomState } from './types.ts'

const T0 = 5_000_000
const MINUTE = 60_000
let seq = 0

const live = (type: string, payload: Record<string, unknown>, at: number, sessionId = 'live-1'): RoomInput => ({ type: 'live', epoch: 'e1', frame: roomFrame({ type, session_id: sessionId, seq: ++seq, payload })!, at })
const fold = (...inputs: RoomInput[]): RoomState => inputs.reduce(reduceRoom, EMPTY_ROOM)
const facts = (state: RoomState, now: number, id = 's:live-1') => factsOf(state.agents[id], state, now).map(fact => fact.text)

describe('facts, not verdicts', () => {
  it('say a plain approval waits for the OK, and other requests wait in Hermes', () => {
    const approval = roomRequest({ id: 'srq-1', method: 'approval', params: { session_id: 'live-1', request_id: 'apr-1' } })!
    const clarify = roomRequest({ id: 'srq-2', method: 'clarify', params: {} })!
    const state = fold(live('message.start', {}, T0), { type: 'events', sessionId: 'live-1', epoch: 'e1', latestSeq: seq, truncated: false, frames: [], requests: [approval, clarify], backfill: false, sentAt: T0 + 1, at: T0 + 2 })
    const found = factsOf(state.agents['s:live-1'], state, T0 + 3)

    expect(found.map(fact => [fact.kind, fact.text])).toEqual([
      ['waiting', 'waiting for your OK'],
      ['asking', 'waiting for you in Hermes']
    ])
    expect(found[0].trace).toEqual({ source: 'open_request', type: 'session.events.since', at: T0 + 2 })
  })

  it('say a session waits in Hermes when only its status says so', () => {
    const state = fold({ type: 'active_list', rows: [{ id: 'live-1', sessionKey: 'k', status: 'waiting', title: '', startedAt: null }], sentAt: T0, at: T0 })

    expect(facts(state, T0)).toEqual(['waiting for you in Hermes'])
  })

  it('count idle time from when the Room saw it go idle', () => {
    const state = fold(live('message.start', {}, T0), live('message.complete', {}, T0 + MINUTE))

    expect(facts(state, T0 + MINUTE + 30_000)).toEqual(['idle'])
    expect(facts(state, T0 + 13 * MINUTE)).toEqual(['idle for 12 minutes'])
    expect(factsOf(state.agents['s:live-1'], state, T0 + 13 * MINUTE)[0].trace).toMatchObject({ source: 'frame', type: 'message.complete' })
  })

  it('count from the last record for a session that was idle when the Room first saw it', () => {
    const state = fold(
      { type: 'active_list', rows: [{ id: 'live-1', sessionKey: 'k', status: 'idle', title: '', startedAt: null }], sentAt: T0, at: T0 },
      { type: 'active_list', rows: [{ id: 'live-1', sessionKey: 'k', status: 'idle', title: '', startedAt: null }], sentAt: T0 + 30 * MINUTE, at: T0 + 30 * MINUTE }
    )

    expect(facts(state, T0 + 30_000)).toEqual(['idle'])
    expect(facts(state, T0 + 90 * MINUTE)).toEqual(['idle for 1 hour'])
  })

  it('say a turn has been quiet once nothing arrived for a minute', () => {
    const state = fold(live('message.start', {}, T0), live('tool.start', { tool_id: 't', name: 'terminal', args: { command: 'sleep 999' } }, T0 + 1))

    expect(facts(state, T0 + 59_000)).toEqual([])
    expect(facts(state, T0 + 1 + MINUTE)).toEqual(['quiet for 1 minute during a turn'])
    expect(facts(state, T0 + 1 + 4 * MINUTE + 59_000)).toEqual(['quiet for 4 minutes during a turn'])
    expect(facts(state, T0 + 1 + 125 * MINUTE)).toEqual(['quiet for 2 hours during a turn'])
  })

  it('do not call a conversation quiet while its helper reports', () => {
    const helper = { subagent_id: 'h1', goal: 'g', task_count: 1, task_index: 0 }
    const state = fold(live('message.start', {}, T0), live('subagent.start', helper, T0 + 1), live('subagent.progress', helper, T0 + 50_000))

    expect(facts(state, T0 + 80_000)).toEqual([])
  })

  it('say how often the same call came, from three in a row', () => {
    const call = { tool_id: 't', name: 'read_file', args: { path: 'a.md' } }
    const twice = fold(live('message.start', {}, T0), live('tool.start', call, T0 + 1), live('tool.start', call, T0 + 2))

    expect(facts(twice, T0 + 3)).toEqual([])
    expect(facts(reduceRoom(twice, live('tool.start', call, T0 + 3)), T0 + 4)).toEqual(['same call 3 times'])
  })

  it("say what Hermes's guardrail stopped, from a fixed table", () => {
    const halted = (code: string, tool = 'web_search') => facts(fold(live('message.start', {}, T0), live('status.update', { kind: 'lifecycle', text: `⚠️ Tool guardrail halted ${tool}: ${code}` }, T0 + 1)), T0 + 2)

    expect(halted('identical_call_streak_halt', 'read_file')).toEqual(['Hermes stopped a repeating call to read_file'])
    expect(halted('identical_cycle_halt', 'patch')).toEqual(['Hermes stopped a repeating call to patch'])
    expect(halted('idempotent_no_progress_block', 'terminal')).toEqual(['Hermes stopped a repeating call to terminal'])
    expect(halted('repeated_exact_failure_block', 'terminal')).toEqual(['Hermes stopped a failing call to terminal'])
    expect(halted('same_tool_failure_halt', 'browser_click')).toEqual(['Hermes stopped a failing call to browser_click'])
    expect(halted('loop_web_search_cap')).toEqual(['Hermes hit its web search limit'])
    expect(halted('loop_subagent_cap', 'delegate_task')).toEqual(['Hermes hit its helper limit'])
  })

  it('say how a helper ended', () => {
    const ended = (status?: string) => {
      const helper = { subagent_id: 'h1', goal: 'g', task_count: 1, task_index: 0 }
      const state = fold(live('subagent.start', helper, T0), live('subagent.complete', status ? { ...helper, status } : helper, T0 + 1))

      return facts(state, T0 + 2, 'h:h1')
    }

    expect(ended('completed')).toEqual(['done'])
    expect(ended('failed')).toEqual(['could not finish'])
    expect(ended('error')).toEqual(['could not finish'])
    expect(ended('timeout')).toEqual(['ran out of time'])
    expect(ended('interrupted')).toEqual(['was stopped'])
    expect(ended()).toEqual(['finished'])
  })

  it("say tool steps are hidden while a turn runs and Hermes's tool progress is off", () => {
    const state = fold({ type: 'config', toolProgress: 'off', at: T0 }, live('message.start', {}, T0 + 1))
    const [fact] = factsOf(state.agents['s:live-1'], state, T0 + 2)

    expect(fact).toEqual({ kind: 'toolsHidden', text: "tool steps hidden: Hermes's tool progress is off", trace: { source: 'config', type: 'config.get', at: T0 } })
    expect(facts(reduceRoom(state, live('message.complete', {}, T0 + 3)), T0 + 4)).toEqual(['idle'])
    expect(facts({ ...state, toolProgress: 'all' }, T0 + 2)).toEqual([])
  })
})

describe('spans', () => {
  it('are whole minutes, then whole hours', () => {
    expect(spanOf(60_000)).toBe('1 minute')
    expect(spanOf(2 * MINUTE + 59_000)).toBe('2 minutes')
    expect(spanOf(59 * MINUTE)).toBe('59 minutes')
    expect(spanOf(60 * MINUTE)).toBe('1 hour')
    expect(spanOf(181 * MINUTE)).toBe('3 hours')
  })
})
