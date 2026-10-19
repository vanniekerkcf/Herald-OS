import type { GatewayEvent, SubagentEventPayload } from '@herald-os/client'
import { atom } from 'nanostores'
import { onAnyGatewayEvent } from './gateway.ts'

export interface AgentActivity {
  id: string
  parentSessionId?: string
  goal: string
  /** Running or queued, or how it ended: `failed` is Hermes's failed or error. */
  status: 'running' | 'queued' | 'complete' | 'failed' | 'timeout' | 'interrupted'
  lastEvent: string
  lastText?: string
  toolName?: string
  model?: string
  depth?: number
  apiCalls?: number
  inputTokens?: number
  outputTokens?: number
  startedAt: number
  updatedAt: number
  durationSeconds?: number
  summary?: string
}

/** Finished agents stay this long after their last word, and the list keeps at most this many. */
export const FINISHED_AGENT_KEEP_MS = 10 * 60_000
export const MAX_AGENTS = 50
const PRUNE_EVERY_MS = 60_000

export const $agents = atom<Record<string, AgentActivity>>({})

const SUBAGENT_EVENTS = new Set(['subagent.spawn_requested', 'subagent.start', 'subagent.progress', 'subagent.thinking', 'subagent.tool', 'subagent.complete'])

export function agentFinished(agent: AgentActivity): boolean {
  return agent.status !== 'running' && agent.status !== 'queued'
}

function outcomeOf(status: SubagentEventPayload['status']): AgentActivity['status'] {
  switch (status) {
    case 'failed':
    case 'error':
      return 'failed'
    case 'timeout':
      return 'timeout'
    case 'interrupted':
      return 'interrupted'
    default:
      return 'complete'
  }
}

/** Let finished agents go after ten minutes, and the oldest finished ones once there are more than fifty in all; running ones always stay. */
export function pruneAgents(agents: Record<string, AgentActivity>, now: number): Record<string, AgentActivity> {
  const all = Object.values(agents)
  const active = all.filter(agent => !agentFinished(agent))
  const finished = all
    .filter(agent => agentFinished(agent) && now - agent.updatedAt < FINISHED_AGENT_KEEP_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(0, MAX_AGENTS - active.length))

  if (active.length + finished.length === all.length) {
    return agents
  }

  return Object.fromEntries([...active, ...finished].map(agent => [agent.id, agent]))
}

/** One `subagent.*` frame folded into the list; a finished agent only takes its own completion again. */
export function applyAgentEvent(agents: Record<string, AgentActivity>, event: GatewayEvent, now: number): Record<string, AgentActivity> {
  const payload = event.payload as SubagentEventPayload | undefined

  if (!SUBAGENT_EVENTS.has(event.type) || !payload) {
    return agents
  }

  const id = payload.subagent_id ?? payload.delegation_id ?? `${event.session_id ?? 'root'}:${payload.task_index}`
  const previous = agents[id]
  const complete = event.type === 'subagent.complete'

  if (previous && agentFinished(previous) && !complete) {
    return agents
  }

  const status: AgentActivity['status'] = complete ? outcomeOf(payload.status) : event.type === 'subagent.spawn_requested' ? 'queued' : 'running'

  return pruneAgents(
    {
      ...agents,
      [id]: {
        id,
        parentSessionId: event.session_id ?? previous?.parentSessionId,
        goal: payload.goal || previous?.goal || 'Delegated task',
        status,
        lastEvent: event.type,
        lastText: payload.text ?? payload.tool_preview ?? previous?.lastText,
        toolName: payload.tool_name ?? previous?.toolName,
        model: payload.model ?? previous?.model,
        depth: payload.depth ?? previous?.depth,
        apiCalls: payload.api_calls ?? previous?.apiCalls,
        inputTokens: payload.input_tokens ?? previous?.inputTokens,
        outputTokens: payload.output_tokens ?? previous?.outputTokens,
        startedAt: previous?.startedAt ?? now,
        updatedAt: now,
        durationSeconds: payload.duration_seconds ?? previous?.durationSeconds,
        summary: payload.summary ?? previous?.summary
      }
    },
    now
  )
}

export function bindAgentEvents(): () => void {
  const off = onAnyGatewayEvent(event => {
    const next = applyAgentEvent($agents.get(), event, Date.now())

    if (next !== $agents.get()) {
      $agents.set(next)
    }
  })
  const timer = setInterval(() => {
    const next = pruneAgents($agents.get(), Date.now())

    if (next !== $agents.get()) {
      $agents.set(next)
    }
  }, PRUNE_EVERY_MS)

  return () => {
    off()
    clearInterval(timer)
  }
}

export function clearFinishedAgents(): void {
  const next: Record<string, AgentActivity> = {}

  for (const [id, agent] of Object.entries($agents.get())) {
    if (!agentFinished(agent)) {
      next[id] = agent
    }
  }

  $agents.set(next)
}
