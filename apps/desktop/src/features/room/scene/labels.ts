import type { RoomKind } from '../../../../shared/room.ts'
import type { RoomSummary } from '../model/summary.ts'
import type { RoomAgent, RoomCaps, RoomFact, RoomPhase, RoomResult, RoomState } from '../model/types.ts'

/*
 * Every word the Room says, from fixed tables or Hermes's own titles and step labels: never chat
 * text, file content, tool arguments or Hermes's thinking.
 */

const UNTITLED: Record<RoomKind, string> = { conversation: 'A conversation', mission: 'A mission', helper: 'A helper', automation: 'An automation', elsewhere: 'A Hermes session' }

export const KIND_NAMES: Record<RoomKind, string> = { conversation: 'Conversation', mission: 'Mission', helper: 'Helper', automation: 'Automation', elsewhere: 'Outside Herald' }

/** The agent's title, or what it is when Hermes has not named it yet. */
export function agentTitle(agent: Pick<RoomAgent, 'title' | 'kind'> & Partial<Pick<RoomAgent, 'parentId'>>): string {
  return agent.title.trim() || (agent.kind === 'elsewhere' && agent.parentId ? 'A helper outside Herald' : UNTITLED[agent.kind])
}

/** A step label as a bubble shows it: first letter capitalised. */
export function displayStep(step: string | null): string | null {
  const text = step?.trim()

  return text ? text.charAt(0).toUpperCase() + text.slice(1) : null
}

/** About this many characters of a result's summary fit its bubble. */
export const BUBBLE_CHARS = 90

/** Hermes's summary of a result cut to a short bubble: on one line, at a word where it can, with an ellipsis. */
export function bubbleText(text: string | null, max = BUBBLE_CHARS): string | null {
  const flat = text?.replace(/\s+/g, ' ').trim()

  if (!flat) {
    return null
  }

  const chars = Array.from(flat)

  if (chars.length <= max) {
    return flat
  }

  const cut = chars.slice(0, Math.max(1, max - 1)).join('')
  const space = cut.lastIndexOf(' ')
  const words = space > cut.length * 0.6 ? cut.slice(0, space) : cut

  return `${words.replace(/[\s,;:.\u2013\u2014-]+$/, '')}…`
}

const PHASE_DOING: Record<RoomPhase, string> = {
  idle: 'resting',
  starting: 'getting ready',
  thinking: 'thinking',
  tool: 'running a tool',
  waiting: 'waiting for you',
  queued: 'waiting its turn',
  finished: 'finished'
}

const RESULT_DOING: Record<RoomResult['status'], string> = {
  completed: 'finished',
  failed: 'failed',
  error: 'stopped on an error',
  timeout: 'timed out',
  interrupted: 'was interrupted'
}

/** What the agent is doing, in a few words: its step when it has one. */
export function doingText(agent: Pick<RoomAgent, 'phase' | 'step' | 'approval' | 'asking' | 'result'> & Partial<Pick<RoomAgent, 'elsewhere'>>): string {
  if (agent.approval) {
    return 'waiting for your OK'
  }

  if (agent.elsewhere?.approval) {
    return `waiting for your OK in ${agent.elsewhere.where}`
  }

  if (agent.phase === 'finished') {
    return agent.result ? RESULT_DOING[agent.result.status] : PHASE_DOING.finished
  }

  return agent.step?.trim() || PHASE_DOING[agent.phase]
}

/** One line for the screen-reader list: who, what it is doing, and the facts that add to it. */
export function agentLine(agent: RoomAgent, facts: readonly RoomFact[]): string {
  const doing = doingText(agent)
  const said = [`${agentTitle(agent)}: ${doing}`, ...facts.map(fact => fact.text).filter(text => text !== doing)]

  return `${[...new Set(said)].join('. ')}.`
}

/** Facts that read the same, whatever records they rest on. */
export function sameFacts(a: readonly RoomFact[], b: readonly RoomFact[]): boolean {
  return a.length === b.length && a.every((fact, index) => fact.kind === b[index].kind && fact.text === b[index].text)
}

/** The facts a name tag shows: not the approval the sign already shows, nor the words of the bubble over it. */
export function tagFacts(agent: Pick<RoomAgent, 'approval'> & Partial<Pick<RoomAgent, 'elsewhere'>>, facts: readonly RoomFact[], bubble: string | null): RoomFact[] {
  const said = bubble?.toLowerCase() ?? null
  const signed = Boolean(agent.approval || agent.elsewhere?.approval)

  return facts.filter(fact => !(signed && fact.kind === 'waiting') && fact.text.toLowerCase() !== said)
}

export type CountId = 'working' | 'waiting' | 'idle' | 'helpers' | 'automations' | 'elsewhere'

/** The header's counts, leaving out the empty ones. */
export function countsOf(summary: Pick<RoomSummary, CountId>): { id: CountId; text: string }[] {
  const texts: Record<CountId, (count: number) => string> = {
    working: count => `${count} working`,
    waiting: count => `${count} waiting for you`,
    idle: count => `${count} idle`,
    helpers: count => `${count} ${count === 1 ? 'helper' : 'helpers'}`,
    automations: count => `${count} ${count === 1 ? 'automation' : 'automations'} running`,
    elsewhere: count => `${count} active outside Herald`
  }

  return (Object.keys(texts) as CountId[]).filter(id => summary[id] > 0).map(id => ({ id, text: texts[id](summary[id]) }))
}

const CAPS: Record<keyof RoomCaps, string> = {
  activeList: 'its running sessions',
  eventsSince: 'what its sessions did before the Room opened',
  delegation: 'its helpers',
  config: 'its settings',
  automations: 'its automations',
  sessionsDb: 'its sessions outside Herald'
}

function orList(parts: readonly string[]): string {
  return parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`
}

/** What this Hermes cannot tell the Room yet, from the methods it did not know. */
export function capsNotice(caps: RoomCaps): string | null {
  const missing = (Object.keys(CAPS) as (keyof RoomCaps)[]).filter(key => caps[key] === false).map(key => CAPS[key])

  return missing.length ? `This Hermes cannot list ${orList(missing)} yet: update Hermes` : null
}

export type RoomNoticeId = 'offline' | 'toolProgress' | 'caps' | 'noPets'

export interface RoomNotice {
  id: RoomNoticeId
  text: string
}

/** The header's notices, from facts about the connection, Hermes's settings and the installed pets. */
export function roomNotices({ connected, state, pets }: { connected: boolean; state: Pick<RoomState, 'toolProgress' | 'caps'>; pets: number }): RoomNotice[] {
  const caps = capsNotice(state.caps)

  return [
    ...(connected ? [] : [{ id: 'offline' as const, text: 'Hermes is not connected' }]),
    ...(state.toolProgress === 'off' ? [{ id: 'toolProgress' as const, text: "Hermes's tool progress is off, so pets cannot show their tools" }] : []),
    ...(caps ? [{ id: 'caps' as const, text: caps }] : []),
    ...(pets === 0 ? [{ id: 'noPets' as const, text: 'No pets are installed, so the Room shows name tags only. Pick one in Settings > Pet' }] : [])
  ]
}

export const EMPTY_ROOM_TEXT = 'No Hermes work right now. Pets come in when Hermes starts working in Herald.'

export const EMPTY_LANE_TEXT = 'No Hermes work outside Herald in the last hour.'

/** The lane's note under its name, and its tooltip: coarse from the session list, or with live steps while live detail is on. */
export function laneWords(live: boolean): { note: string; about: string } {
  return live
    ? {
        note: 'Live steps from Hermes in each app',
        about:
          "Hermes work outside Herald: titles and activity from Hermes's session list once a minute, and the tool each piece of work uses, the helpers it starts and the approvals it waits on, by name only, from Herald's bridge plugin in each Hermes process. Approvals there are answered there."
      }
    : {
        note: 'Coarse: titles and activity, read once a minute',
        about: "Hermes work outside Herald, from Hermes's session list: titles and whether each is active, read once a minute. The room shows no steps for it."
      }
}

export const moreText = (count: number): string => `+${count} more`
