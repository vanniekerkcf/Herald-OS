import type { RoomLogAgent, RoomLogEntry, RoomLogOutcome } from '../../../../shared/room.ts'
import type { RoomAgent, RoomHandoff, RoomState } from './types.ts'

/*
 * The Hermes window's side of the activity log: what the Room shows, cut down to the metadata the
 * log keeps (RoomLogAgent in shared/room.ts) and handed to main in batches. An agent is written
 * when it comes in and whenever that view of it changes; nothing else of it leaves this file.
 */

/** What the log keeps of an agent. */
export type RoomLogView = Omit<RoomLogAgent, 't' | 'k' | 'id'>

export interface RoomLogTimers {
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}

export interface RoomLogger {
  /** The log starts: a `begin`, then every agent the Room holds. */
  start(state: RoomState, at: number): void
  /** What changed since the last call: agents that came in or changed, agents that left, new hand-offs. */
  update(state: RoomState, at: number): void
  /** The log stops: an `end`, sent at once with whatever waits. */
  stop(at: number): void
  /** Send what waits now. */
  flush(): void
}

const TIMERS: RoomLogTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>)
}

/** A helper's end, or how an automation's last run went while no run is under way. */
function outcomeOf(agent: RoomAgent): RoomLogOutcome | null {
  if (agent.kind === 'helper') {
    return agent.result?.status ?? null
  }

  return agent.kind === 'automation' && !agent.automation?.running ? (agent.automation?.lastOutcome ?? null) : null
}

/** An agent as the log keeps it, and nothing else of it. */
export function logViewOf(agent: RoomAgent): RoomLogView {
  return {
    kind: agent.kind,
    phase: agent.phase,
    area: agent.area,
    step: agent.step,
    target: agent.target,
    wait: Boolean(agent.approval || agent.asking || agent.elsewhere?.approval),
    parent: agent.parentId,
    where: agent.kind === 'elsewhere' ? (agent.elsewhere?.where ?? null) : null,
    outcome: outcomeOf(agent)
  }
}

const keyOf = (view: RoomLogView): string => JSON.stringify([view.kind, view.phase, view.area, view.step, view.target, view.wait, view.parent, view.where, view.outcome])

const agentEntry = (id: string, view: RoomLogView, t: number): RoomLogEntry => ({ t, k: 'agent', id, ...view })

function handoffEntry(handoff: RoomHandoff, state: RoomState, t: number): RoomLogEntry {
  const result = handoff.kind === 'result' ? (state.agents[handoff.from]?.result ?? null) : null

  return { t, k: 'handoff', kind: handoff.kind, from: handoff.from, to: handoff.to, failed: result !== null && result.status !== 'completed' }
}

function dayStart(t: number): number {
  const date = new Date(t)

  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function nextDayStart(t: number): number {
  const date = new Date(t)

  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
}

interface Logged {
  agent: RoomAgent
  key: string
  view: RoomLogView
}

/** The activity log's writer: `send` gets the entries in batches, at most every `flushMs`. */
export function createRoomLogger({ send, flushMs = 2000, timers = TIMERS }: { send: (entries: RoomLogEntry[]) => void; flushMs?: number; timers?: RoomLogTimers }): RoomLogger {
  let on = false
  let logged = new Map<string, Logged>()
  let handoffs = new Set<string>()
  let agentsSeen: RoomState['agents'] | null = null
  let handoffsSeen: RoomState['handoffs'] | null = null
  let queue: RoomLogEntry[] = []
  let timer: unknown = null
  let armed = false
  let lastAt = 0

  const flush = () => {
    if (armed) {
      timers.clearTimeout(timer)
      armed = false
      timer = null
    }

    if (!queue.length) {
      return
    }

    const batch = queue
    queue = []
    send(batch)
  }

  const push = (entry: RoomLogEntry) => {
    queue.push(entry)
    lastAt = Math.max(lastAt, entry.t)

    if (!armed) {
      armed = true
      timer = timers.setTimeout(() => {
        armed = false
        timer = null
        flush()
      }, flushMs)
    }
  }

  const note = (agent: RoomAgent, at: number) => {
    const before = logged.get(agent.id)

    if (before?.agent === agent) {
      return
    }

    const view = logViewOf(agent)
    const key = keyOf(view)

    if (before?.key === key) {
      before.agent = agent

      return
    }

    logged.set(agent.id, { agent, key, view })
    push(agentEntry(agent.id, view, at))
  }

  // The time-lapse reads each day on its own and skips what comes before a day's first `begin`, so a
  // stretch that runs past midnight closes the old day and opens the new one with what the Room
  // showed then: nothing changed in between.
  const rollOver = (at: number) => {
    const midnight = nextDayStart(lastAt)

    if (at < midnight) {
      return
    }

    const start = dayStart(at)
    push({ t: midnight - 1, k: 'end' })
    push({ t: start, k: 'begin' })

    for (const [id, { view }] of logged) {
      push(agentEntry(id, view, start))
    }
  }

  return {
    start(state, at) {
      if (on) {
        rollOver(at)
        push({ t: at, k: 'end' })
      }

      on = true
      logged = new Map()
      handoffs = new Set(state.handoffs.map(handoff => handoff.id))
      push({ t: at, k: 'begin' })

      for (const agent of Object.values(state.agents)) {
        note(agent, at)
      }

      agentsSeen = state.agents
      handoffsSeen = state.handoffs
    },
    update(state, at) {
      if (!on || (state.agents === agentsSeen && state.handoffs === handoffsSeen)) {
        return
      }

      rollOver(at)
      const agentsMoved = state.agents !== agentsSeen

      if (agentsMoved) {
        for (const agent of Object.values(state.agents)) {
          note(agent, at)
        }
      }

      if (state.handoffs !== handoffsSeen) {
        for (const handoff of state.handoffs) {
          if (!handoffs.has(handoff.id)) {
            handoffs.add(handoff.id)
            push(handoffEntry(handoff, state, at))
          }
        }

        if (handoffs.size > state.handoffs.length) {
          handoffs = new Set(state.handoffs.map(handoff => handoff.id))
        }
      }

      if (agentsMoved) {
        for (const id of logged.keys()) {
          if (!Object.hasOwn(state.agents, id)) {
            logged.delete(id)
            push({ t: at, k: 'gone', id })
          }
        }
      }

      agentsSeen = state.agents
      handoffsSeen = state.handoffs
    },
    stop(at) {
      if (!on) {
        return
      }

      rollOver(at)
      on = false
      push({ t: at, k: 'end' })
      logged = new Map()
      handoffs = new Set()
      agentsSeen = null
      handoffsSeen = null
      flush()
    },
    flush
  }
}
