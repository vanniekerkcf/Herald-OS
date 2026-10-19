import { meetingOf } from './desks.ts'
import type { RoomGuardrailCode } from './frames.ts'
import { busyOutside } from './outside.ts'
import type { RoomAgent, RoomElsewhere, RoomFact, RoomPhase, RoomResult, RoomState } from './types.ts'

/** A turn with nothing new for this long is quiet. */
export const QUIET_AFTER_MS = 60_000
/** The same call this many times in a row is worth saying. */
export const REPEAT_AFTER = 3
/** Work elsewhere heard from this recently is active now. */
const ACTIVE_NOW_MS = 2 * 60_000

const TURN_PHASES = new Set<RoomPhase>(['starting', 'thinking', 'tool'])

const GUARDRAIL_TEXT: Record<RoomGuardrailCode, (tool: string) => string> = {
  repeated_exact_failure_block: tool => `Hermes stopped a failing call to ${tool}`,
  same_tool_failure_halt: tool => `Hermes stopped a failing call to ${tool}`,
  idempotent_no_progress_block: tool => `Hermes stopped a repeating call to ${tool}`,
  identical_call_streak_halt: tool => `Hermes stopped a repeating call to ${tool}`,
  identical_cycle_halt: tool => `Hermes stopped a repeating call to ${tool}`,
  loop_web_search_cap: () => 'Hermes hit its web search limit',
  loop_subagent_cap: () => 'Hermes hit its helper limit'
}

const RESULT_TEXT: Record<RoomResult['status'], string> = {
  completed: 'done',
  failed: 'could not finish',
  error: 'could not finish',
  timeout: 'ran out of time',
  interrupted: 'was stopped'
}

/** A span as a fact says it: whole minutes, then whole hours. */
export function spanOf(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000))

  if (minutes < 60) {
    return minutes === 1 ? '1 minute' : `${minutes} minutes`
  }

  const hours = Math.floor(minutes / 60)

  return hours === 1 ? '1 hour' : `${hours} hours`
}

/** A scheduled job's facts: a run under way, else when its last run was and how it ended, and whether it is paused. */
function automationFacts(agent: RoomAgent, now: number): RoomFact[] {
  const job = agent.automation
  const trace = agent.trace.automation ?? null

  if (!job) {
    return []
  }

  const facts: RoomFact[] = []

  if (job.running) {
    const since = job.runStartedAt === null ? 0 : now - job.runStartedAt

    facts.push({ kind: 'running', text: since >= 60_000 ? `running for ${spanOf(since)}` : 'running now', trace })
  } else if (job.lastRunAt !== null) {
    const ago = now - job.lastRunAt
    const when = ago >= 60_000 ? `${spanOf(ago)} ago` : 'just now'

    facts.push({ kind: 'lastRun', text: job.lastOutcome === 'failed' ? `failed ${when}` : `ran ${when}`, trace })
  } else {
    facts.push({ kind: 'lastRun', text: 'not run yet', trace })
  }

  if (job.paused) {
    facts.push({ kind: 'paused', text: 'paused', trace })
  }

  return facts
}

/** The lane's label for work elsewhere, as of `at` (its last read): where it runs and how active it is ('Telegram · active now'). */
export function activityText(lane: RoomElsewhere, at: number): string {
  const since = lane.lastActiveAt === null ? null : Math.max(0, at - lane.lastActiveAt)
  const how = lane.active ? (since === null || since < ACTIVE_NOW_MS ? 'active now' : `active ${spanOf(since)} ago`) : since === null ? 'not active' : `last active ${spanOf(since)} ago`

  return `${lane.where} · ${how}`
}

/** Work outside Herald: where it runs and how active it is, an approval waiting in that app, how a helper there ended, and a turn gone quiet. */
function outsideFacts(agent: RoomAgent, state: RoomState, now: number): RoomFact[] {
  const lane = agent.elsewhere
  const facts: RoomFact[] = []

  if (lane?.approval) {
    facts.push({ kind: 'waiting', text: `waiting for your OK in ${lane.where}`, trace: agent.trace.approval ?? null })
  }

  if (agent.phase === 'finished') {
    facts.push({ kind: 'result', text: agent.result ? RESULT_TEXT[agent.result.status] : 'finished', trace: agent.trace.result ?? agent.trace.phase ?? null })
  } else if (lane) {
    // Live detail says whether a turn runs now; without it, the label is as of the lane's last read.
    const text = lane.liveAt === null ? activityText(lane, state.elsewhereAt ?? now) : busyOutside(agent) ? `${lane.where} · active now` : activityText({ ...lane, active: false }, now)
    facts.push({ kind: 'activity', text, trace: agent.trace.elsewhere ?? null })
  }

  if (busyOutside(agent) && TURN_PHASES.has(agent.phase) && now - agent.lastEventAt >= QUIET_AFTER_MS) {
    facts.push({ kind: 'quiet', text: `quiet for ${spanOf(now - agent.lastEventAt)} during a turn`, trace: agent.trace.lastEventAt ?? null })
  }

  return facts
}

/** "2 agents on Launch plan.docx": agents at one desk, or on one document in an area with desks. */
function meetingFact(agent: RoomAgent, state: RoomState): RoomFact | null {
  const met = meetingOf(agent, Object.values(state.agents))

  if (!met.length) {
    return null
  }

  const name = (agent.desk ? state.desks?.[agent.desk]?.name : null) ?? agent.target ?? 'one document'

  return { kind: 'meeting', text: `${met.length} agents on ${name}`, trace: agent.trace.desk ?? agent.trace.target ?? null }
}

/** What is true about an agent now, as facts from its records ('quiet for 4 minutes during a turn', 'same call 3 times'). */
export function factsOf(agent: RoomAgent, state: RoomState, now: number): RoomFact[] {
  if (agent.kind === 'automation') {
    return automationFacts(agent, now)
  }

  if (agent.kind === 'elsewhere') {
    return outsideFacts(agent, state, now)
  }

  const facts: RoomFact[] = []
  const { trace } = agent
  const meeting = meetingFact(agent, state)

  if (agent.approval) {
    facts.push({ kind: 'waiting', text: 'waiting for your OK', trace: trace.approval ?? null })
  }

  if (agent.asking) {
    facts.push({ kind: 'asking', text: 'waiting for you in Hermes', trace: trace.asking ?? null })
  } else if (agent.phase === 'waiting' && !agent.approval) {
    facts.push({ kind: 'asking', text: 'waiting for you in Hermes', trace: trace.phase ?? null })
  }

  if (agent.guardrail) {
    facts.push({ kind: 'guardrail', text: GUARDRAIL_TEXT[agent.guardrail.code as RoomGuardrailCode]?.(agent.guardrail.tool) ?? `Hermes stopped a call to ${agent.guardrail.tool}`, trace: trace.guardrail ?? null })
  }

  if (agent.repeat && agent.repeat.count >= REPEAT_AFTER) {
    facts.push({ kind: 'repeat', text: `same call ${agent.repeat.count} times`, trace: trace.repeat ?? null })
  }

  if (TURN_PHASES.has(agent.phase) && now - agent.lastEventAt >= QUIET_AFTER_MS) {
    facts.push({ kind: 'quiet', text: `quiet for ${spanOf(now - agent.lastEventAt)} during a turn`, trace: trace.lastEventAt ?? null })
  }

  if (meeting) {
    facts.push(meeting)
  }

  if (agent.phase === 'idle') {
    const since = agent.basis?.idleSince ?? agent.lastEventAt

    facts.push({ kind: 'idle', text: now - since >= 60_000 ? `idle for ${spanOf(now - since)}` : 'idle', trace: trace.phase ?? null })
  }

  if (agent.phase === 'finished') {
    facts.push({ kind: 'result', text: agent.result ? RESULT_TEXT[agent.result.status] : 'finished', trace: trace.result ?? trace.phase ?? null })
  }

  if (state.toolProgress === 'off' && agent.kind !== 'helper' && (agent.phase === 'thinking' || agent.phase === 'tool')) {
    facts.push({ kind: 'toolsHidden', text: "tool steps hidden: Hermes's tool progress is off", trace: state.toolProgressTrace ?? null })
  }

  return facts
}
