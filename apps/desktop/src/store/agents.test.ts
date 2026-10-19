import type { GatewayEvent } from '@herald-os/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The gateway's event stream, faked: a test plays subagent frames into the store.
const gateway = vi.hoisted(() => ({ any: [] as Array<(event: unknown) => void> }))

vi.mock('./gateway.ts', () => ({
  onAnyGatewayEvent: (handler: (event: unknown) => void) => {
    gateway.any.push(handler)

    return () => {
      gateway.any = gateway.any.filter(entry => entry !== handler)
    }
  }
}))

const { $agents, applyAgentEvent, bindAgentEvents, clearFinishedAgents, FINISHED_AGENT_KEEP_MS, MAX_AGENTS, pruneAgents } = await import('./agents.ts')
type Agents = ReturnType<typeof $agents.get>

const T0 = 2_000_000
const frame = (type: string, payload: Record<string, unknown> = {}, sessionId = 'live-1'): GatewayEvent => ({ type, session_id: sessionId, payload: { goal: 'Find hotels', task_count: 1, task_index: 0, subagent_id: 'a1', ...payload } }) as GatewayEvent
const play = (agents: Agents, ...events: GatewayEvent[]): Agents => events.reduce((next, event, index) => applyAgentEvent(next, event, T0 + index), agents)

function finished(id: string, updatedAt: number): Agents[string] {
  return { id, goal: id, status: 'complete', lastEvent: 'subagent.complete', startedAt: updatedAt, updatedAt }
}

describe('agent outcomes', () => {
  it('queue, run and end the way Hermes says they ended', () => {
    const outcome = (status?: string) => play({}, frame('subagent.start'), frame('subagent.complete', status ? { status } : {})).a1.status

    expect(play({}, frame('subagent.spawn_requested')).a1.status).toBe('queued')
    expect(play({}, frame('subagent.spawn_requested'), frame('subagent.tool', { tool_name: 'web_search' })).a1).toMatchObject({ status: 'running', toolName: 'web_search', parentSessionId: 'live-1' })
    expect(outcome('completed')).toBe('complete')
    expect(outcome('failed')).toBe('failed')
    expect(outcome('error')).toBe('failed')
    expect(outcome('timeout')).toBe('timeout')
    expect(outcome('interrupted')).toBe('interrupted')
    expect(outcome()).toBe('complete')
  })

  it('stay ended when a late frame comes for a finished agent', () => {
    const agents = play({}, frame('subagent.start'), frame('subagent.complete', { status: 'timeout', summary: 'Out of time' }))

    expect(applyAgentEvent(agents, frame('subagent.progress', { text: 'still going' }), T0 + 9)).toBe(agents)
    expect(applyAgentEvent(agents, frame('subagent.complete', { status: 'timeout', summary: 'Out of time, again' }), T0 + 9).a1.summary).toBe('Out of time, again')
  })

  it('ignore frames that are not about agents', () => {
    const agents = {}

    expect(applyAgentEvent(agents, { type: 'message.start', session_id: 's', payload: {} } as GatewayEvent, T0)).toBe(agents)
  })
})

describe('pruning finished agents', () => {
  it('lets finished ones go after ten minutes and keeps running ones however old', () => {
    const running: Agents[string] = { ...finished('r', T0), status: 'running' }
    const agents = { old: finished('old', T0), recent: finished('recent', T0 + FINISHED_AGENT_KEEP_MS - 1), r: running }

    expect(Object.keys(pruneAgents(agents, T0 + FINISHED_AGENT_KEEP_MS)).sort()).toEqual(['r', 'recent'])
  })

  it('keeps at most fifty in all, dropping the oldest finished ones first', () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`f${index}`, finished(`f${index}`, T0 + index)]))
    const kept = pruneAgents(many, T0 + 100)

    expect(Object.keys(kept)).toHaveLength(MAX_AGENTS)
    expect(kept.f0).toBeUndefined()
    expect(kept.f59).toBeDefined()

    const busy = Object.fromEntries(Array.from({ length: 48 }, (_, index) => [`r${index}`, { ...finished(`r${index}`, T0), status: 'running' as const }]))
    const mixed = pruneAgents({ ...busy, a: finished('a', T0 + 1), b: finished('b', T0 + 2), c: finished('c', T0 + 3) }, T0 + 10)

    expect(Object.keys(mixed)).toHaveLength(50)
    expect(mixed.a).toBeUndefined()
  })

  it('leaves the list as it was when nothing is due to go', () => {
    const agents = { a: finished('a', T0) }

    expect(pruneAgents(agents, T0 + 1)).toBe(agents)
  })
})

describe('the bound store', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
    $agents.set({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('follows the live frames and lets finished agents go on its own', () => {
    const unbind = bindAgentEvents()

    for (const handler of gateway.any) {
      handler(frame('subagent.start'))
      handler(frame('subagent.complete', { status: 'interrupted' }))
    }

    expect($agents.get().a1.status).toBe('interrupted')

    vi.advanceTimersByTime(FINISHED_AGENT_KEEP_MS + 60_000)
    expect($agents.get()).toEqual({})

    unbind()
    expect(gateway.any).toEqual([])
  })

  it('clears every finished agent on request', () => {
    $agents.set({ done: finished('done', T0), live: { ...finished('live', T0), status: 'queued' } })
    clearFinishedAgents()

    expect(Object.keys($agents.get())).toEqual(['live'])
  })
})
