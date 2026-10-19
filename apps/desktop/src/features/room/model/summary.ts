import { factsOf } from './facts.ts'
import { busyOutside } from './outside.ts'
import type { RoomAgent, RoomPhase, RoomState } from './types.ts'

export interface RoomSummary {
  /** Agents at work in Herald or waiting on the person, idle conversations and missions, and automations with a run under way. */
  total: number
  working: number
  waiting: number
  idle: number
  helpers: number
  /** Automations with a run under way, counted in `working` too. */
  automations: number
  /** Active work outside Herald (live detail at work counts as active), when the person has the elsewhere lane on; not in `total`. */
  elsewhere: number
  /** One line per agent, from the fixed tables: "Budget review (mission): reading Budget.xlsx". */
  lines: string[]
}

const WORKING = new Set<RoomPhase>(['starting', 'thinking', 'tool', 'queued'])
/** Facts worth reading out after the step, when they are true. */
const SPOKEN_FACTS = new Set(['quiet', 'repeat', 'guardrail', 'meeting'])
const ORDER: Record<RoomPhase, number> = { waiting: 0, tool: 1, thinking: 1, starting: 1, queued: 1, idle: 2, finished: 3 }

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

function kindWords(agent: RoomAgent, state: RoomState): string {
  if (agent.kind === 'elsewhere') {
    return agent.parentId ? 'a helper outside Herald' : 'outside Herald'
  }

  if (agent.kind !== 'helper') {
    return agent.kind
  }

  const parent = agent.parentId ? state.agents[agent.parentId] : undefined

  return `helper of ${parent?.title || (parent ? `a ${parent.kind}` : 'a conversation')}`
}

function lineOf(agent: RoomAgent, state: RoomState, now: number): string {
  const kind = kindWords(agent, state)
  const name = agent.title ? `${agent.title} (${kind})` : capitalized(kind)
  const facts = factsOf(agent, state, now)
  const doing = agent.step ?? facts.find(fact => fact.kind === 'idle' || fact.kind === 'activity')?.text ?? 'idle'
  const notes = facts.filter(fact => SPOKEN_FACTS.has(fact.kind)).map(fact => fact.text)

  return `${name}: ${[doing, ...notes].join(', ')}`
}

/**
 * What the Room shows now, for `room.status`: counts, then a line per agent, waiting first. Finished
 * helpers are on their way out and automations between runs are only waiting for their time, so
 * both are left out; work elsewhere is read out only while active, with its step when live detail
 * gives one.
 */
export function summarizeRoom(state: RoomState, now: number): RoomSummary {
  const present = Object.values(state.agents).filter(agent => agent.phase !== 'finished')
  const counted = present.filter(agent => agent.kind !== 'elsewhere' && !(agent.kind === 'automation' && agent.phase === 'idle'))
  // With live detail, the plugin's word on whether a turn runs is newer than the session list's.
  const away = present.filter(agent => agent.kind === 'elsewhere' && (busyOutside(agent) || ((agent.elsewhere?.liveAt ?? null) === null && agent.elsewhere?.active)))
  const agents = [...counted, ...away].sort(
    (a, b) => Number(a.kind === 'elsewhere') - Number(b.kind === 'elsewhere') || ORDER[a.phase] - ORDER[b.phase] || (a.startedAt ?? a.lastEventAt) - (b.startedAt ?? b.lastEventAt) || a.id.localeCompare(b.id)
  )

  return {
    total: counted.length,
    working: counted.filter(agent => WORKING.has(agent.phase)).length,
    waiting: counted.filter(agent => agent.phase === 'waiting').length,
    idle: counted.filter(agent => agent.phase === 'idle').length,
    helpers: counted.filter(agent => agent.kind === 'helper').length,
    automations: counted.filter(agent => agent.kind === 'automation').length,
    elsewhere: away.length,
    lines: agents.map(agent => lineOf(agent, state, now))
  }
}
