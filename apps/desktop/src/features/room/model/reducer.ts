import type { RoomActivity } from '../../../../shared/room.ts'
import { describeTool } from './areas.ts'
import { automationOf, type RoomCronJob, type RoomCronRun } from './automations.ts'
import { helperUsage, type RoomCostRow, sameUsage, sessionUsage, tokensOf, usageOfRow } from './costs.ts'
import { type DeskPick, deskFor } from './desks.ts'
import { cronRunJob, type RoomElsewhereRow } from './elsewhere.ts'
import type { RoomFrame, RoomHelperRecord, RoomRequest, RoomSessionRow } from './frames.ts'
import { deriveOutside, dropLive, freshEvents, hasLiveDetail, heraldWork, isHeraldWork, keepsLive, outsideAgentId, outsideLane, staleAt, takeActivity } from './outside.ts'
import { stepOf } from './steps.ts'
import type {
  RoomAgent,
  RoomApproval,
  RoomBasis,
  RoomCaps,
  RoomCommand,
  RoomDesk,
  RoomField,
  RoomHandoff,
  RoomKind,
  RoomLiveStatus,
  RoomPhase,
  RoomSessionMeta,
  RoomSource,
  RoomState,
  RoomTrace,
  RoomUsage
} from './types.ts'

/*
 * One reducer folds everything the Room hears into its records. Records (`session.active_list`,
 * `delegation.status`, `open_requests`) carry no seq, so a record only overrides what frames said
 * when it was asked for after the newest frame evidence: the `*At` times on an agent's basis.
 */

/** A finished helper stays for its walk back to the agent that spawned it. */
export const FINISHED_KEEP_MS = 16_000
export const HANDOFF_KEEP_MS = 20_000
export const ANSWERED_KEEP_MS = 15_000
/** Without `session.active_list` nothing says a session ended: an idle one is let go after this long without a frame. */
export const UNLISTED_IDLE_KEEP_MS = 30 * 60_000

export const EMPTY_ROOM: RoomState = {
  epoch: null,
  agents: {},
  seen: {},
  handoffs: [],
  toolProgress: null,
  caps: { activeList: true, eventsSince: true, delegation: true, config: true, automations: true, sessionsDb: true },
  updatedAt: 0
}

export type RoomInput =
  | { type: 'active_list'; rows: RoomSessionRow[]; sentAt: number; at: number }
  | {
      type: 'events'
      sessionId: string
      epoch: string | null
      latestSeq: number
      truncated: boolean
      frames: RoomFrame[]
      /** `open_requests`; null when the answer had none to say. */
      requests: RoomRequest[] | null
      /** A first read of the session's buffer: what happened before the Room looked. */
      backfill: boolean
      sentAt: number
      at: number
    }
  | { type: 'live'; epoch: string | null; frame: RoomFrame; at: number }
  | { type: 'delegation'; records: RoomHelperRecord[]; initial: boolean; sentAt: number; at: number }
  | { type: 'local_requests'; approvals: RoomApproval[]; at: number }
  | { type: 'config'; toolProgress: RoomState['toolProgress']; at: number }
  | { type: 'session_meta'; rows: RoomSessionMeta[]; at: number }
  | { type: 'answered'; requestId: string; at: number }
  | { type: 'answer_failed'; requestId: string; at: number }
  | { type: 'caps'; caps: Partial<RoomCaps>; at: number }
  /** Herald's automations: every job, and the latest run of those whose runs were read this time. */
  | { type: 'automations'; jobs: RoomCronJob[]; runs: Record<string, RoomCronRun | null>; at: number }
  /** The elsewhere lane's rows, already filtered; null when the lane is off. */
  | { type: 'elsewhere'; rows: RoomElsewhereRow[] | null; at: number }
  /** Live activity from Hermes outside Herald, as main hands it over while the person has live detail on. */
  | { type: 'outside'; events: RoomActivity[]; at: number }
  /** Live detail was turned off: work outside Herald goes back to the lane's coarse view. */
  | { type: 'outside_off'; at: number }
  /** Rows of Herald's own sessions from the session database, for cost meters. */
  | { type: 'costs'; rows: RoomCostRow[]; at: number }
  | { type: 'desks'; desks: RoomDesk[]; at: number }
  /** Recent Office and Canvas commands agents ran, newest first. */
  | { type: 'commands'; commands: RoomCommand[]; at: number }
  | { type: 'tick'; now: number }
  | { type: 'reset'; epoch: string | null; at: number }

interface Work {
  agents: Record<string, RoomAgent>
  copied: Set<string>
  created: Set<string>
  handoffs: RoomHandoff[]
  seen: Record<string, number>
  meta: Record<string, RoomSessionMeta>
  answered: Record<string, number>
  local: RoomApproval[]
  desks: Record<string, RoomDesk>
  desksTrace: RoomTrace | null
  commands: RoomCommand[]
}

const FIELDS: readonly RoomField[] = ['kind', 'title', 'parent', 'phase', 'area', 'target', 'step', 'approval', 'asking', 'repeat', 'guardrail', 'result', 'automation', 'elsewhere']

const sessionAgentId = (sessionId: string): string => `s:${sessionId}`
const helperAgentId = (subagentId: string): string => `h:${subagentId}`
const automationAgentId = (jobKey: string): string => `a:${jobKey}`
const elsewhereAgentId = (storedId: string): string => `e:${storedId}`
const isHelper = (agent: RoomAgent): boolean => agent.kind === 'helper'
/** A live session in Herald's own backend: the only agents its session methods describe. */
const isSession = (agent: RoomAgent): boolean => agent.id.startsWith('s:')

function traceOf(source: RoomSource, type: string, at: number, seq?: number | null): RoomTrace {
  return seq === null || seq === undefined ? { source, type, at } : { source, type, seq, at }
}

function emptyBasis(): RoomBasis {
  return {
    status: null,
    statusAt: 0,
    frameAt: 0,
    tools: [],
    toolArea: null,
    toolTarget: null,
    toolStep: null,
    toolFront: false,
    turnArea: null,
    turnTarget: null,
    turnFront: false,
    cwd: null,
    todo: false,
    idleSince: null,
    childSessionId: null,
    listed: false,
    missing: 0,
    approvals: [],
    counts: null,
    turnTokens: null,
    costRow: null
  }
}

function newAgent(id: string, kind: RoomKind, sessionId: string, trace: RoomTrace): RoomAgent {
  return {
    id,
    kind,
    sessionId,
    sessionKey: null,
    title: '',
    parentId: null,
    phase: kind === 'helper' ? 'queued' : 'idle',
    area: 'lounge',
    target: null,
    step: null,
    tool: null,
    startedAt: null,
    turnStartedAt: null,
    lastEventAt: trace.at,
    approval: null,
    asking: null,
    repeat: null,
    guardrail: null,
    result: null,
    toolCount: null,
    desk: null,
    automation: null,
    elsewhere: null,
    usage: null,
    trace: {},
    basis: emptyBasis()
  }
}

function begin(state: RoomState): Work {
  return {
    agents: { ...state.agents },
    copied: new Set(),
    created: new Set(),
    handoffs: [...state.handoffs],
    seen: { ...state.seen },
    meta: state.meta ?? {},
    answered: { ...state.answered },
    local: state.local ?? [],
    desks: state.desks ?? {},
    desksTrace: state.desksTrace ?? null,
    commands: state.commands ?? []
  }
}

/** The agent, copied once per input so the previous state stays as it was. */
function edit(work: Work, id: string): RoomAgent | null {
  const agent = work.agents[id]

  if (!agent) {
    return null
  }

  if (!work.copied.has(id)) {
    const basis = agent.basis ?? emptyBasis()
    work.agents[id] = { ...agent, trace: { ...agent.trace }, basis: { ...basis, tools: [...basis.tools], approvals: [...basis.approvals] } }
    work.copied.add(id)
  }

  return work.agents[id]
}

/** The agent's fields as they are before a change, for `settle` to compare with. */
function beforeOf(work: Work, id: string): RoomAgent | undefined {
  const agent = work.agents[id]

  return agent ? { ...agent } : undefined
}

function add(work: Work, agent: RoomAgent): RoomAgent {
  work.agents[agent.id] = agent
  work.copied.add(agent.id)
  work.created.add(agent.id)

  return agent
}

function basisOf(agent: RoomAgent): RoomBasis {
  if (!agent.basis) {
    agent.basis = emptyBasis()
  }

  return agent.basis
}

function fieldValue(agent: RoomAgent, field: RoomField): unknown {
  switch (field) {
    case 'parent':
      return agent.parentId
    case 'approval':
      return agent.approval?.requestId ?? (agent.elsewhere?.approval ? 'elsewhere' : null)
    case 'repeat':
      return agent.repeat ? `${agent.repeat.signature}#${agent.repeat.count}` : null
    case 'guardrail':
      return agent.guardrail ? `${agent.guardrail.tool}:${agent.guardrail.code}:${agent.guardrail.at}` : null
    case 'result':
      return agent.result ? `${agent.result.status}:${agent.result.at}` : null
    case 'automation': {
      const job = agent.automation

      return job ? `${job.paused}:${job.running}:${job.runStartedAt}:${job.lastRunAt}:${job.lastOutcome}` : null
    }
    case 'elsewhere': {
      const lane = agent.elsewhere

      return lane ? `${lane.where}:${lane.active}:${lane.lastActiveAt}:${lane.approval}` : null
    }
    case 'lastEventAt':
      return agent.lastEventAt
    default:
      return agent[field]
  }
}

/** The one place a record's kind is decided. */
export function kindOf(agent: RoomAgent): RoomKind {
  if (agent.id.startsWith('h:')) {
    return 'helper'
  }

  if (agent.id.startsWith('a:')) {
    return 'automation'
  }

  if (agent.id.startsWith('e:')) {
    return 'elsewhere'
  }

  return agent.basis?.todo ? 'mission' : 'conversation'
}

/** Leave the bench for where the turn worked last, or the lounge. */
function workArea(agent: RoomAgent, basis: RoomBasis): RoomAgent['area'] {
  return basis.turnArea ?? (agent.area === 'bench' ? 'lounge' : agent.area)
}

function deriveSession(agent: RoomAgent, basis: RoomBasis): void {
  const status = basis.status ?? 'idle'
  const running = basis.tools.length > 0
  const asks = running && basis.toolArea === 'bench'
  const phase: RoomPhase =
    agent.approval || agent.asking || status === 'waiting' || asks ? 'waiting' : status === 'idle' ? 'idle' : running ? 'tool' : status === 'starting' ? 'starting' : 'thinking'

  agent.phase = phase

  if (!running) {
    agent.tool = null
  }

  switch (phase) {
    case 'waiting':
      agent.area = 'bench'
      agent.target = null
      break
    case 'idle':
      agent.area = 'lounge'
      agent.target = null
      agent.tool = null
      break
    case 'tool':
      agent.area = basis.toolArea ?? workArea(agent, basis)
      agent.target = basis.toolTarget
      break
    default:
      agent.area = workArea(agent, basis)
      agent.target = basis.turnTarget
  }

  agent.step = stepOf(phase, { approval: Boolean(agent.approval), toolStep: basis.toolStep })
}

function deriveHelper(agent: RoomAgent, basis: RoomBasis): void {
  switch (agent.phase) {
    case 'tool':
      agent.area = basis.toolArea ?? workArea(agent, basis)
      agent.target = basis.toolTarget
      break
    case 'thinking':
      agent.area = workArea(agent, basis)
      agent.target = basis.turnTarget
      break
    case 'finished':
      agent.tool = null
      break
  }

  agent.step = stepOf(agent.phase, { approval: false, toolStep: basis.toolStep })
}

/** A job's pet stays in the Automations corner: at work while a run is under way, resting between runs. */
function deriveAutomation(agent: RoomAgent): void {
  const running = agent.automation?.running === true

  agent.phase = running ? 'tool' : 'idle'
  agent.area = 'automations'
  agent.target = null
  agent.tool = null
  agent.startedAt = agent.automation?.runStartedAt ?? null
  agent.step = running ? 'running' : null
}

/** Work out the derived fields, then trace whatever changed to the input that changed it. */
function settle(agent: RoomAgent, before: RoomAgent | undefined, trace: RoomTrace, isFrame: boolean): void {
  const basis = basisOf(agent)
  agent.kind = kindOf(agent)

  switch (agent.kind) {
    case 'helper':
      deriveHelper(agent, basis)
      break
    case 'automation':
      deriveAutomation(agent)
      break
    case 'elsewhere':
      deriveOutside(agent, basis)
      break
    default:
      deriveSession(agent, basis)
  }

  let changed = isFrame

  for (const field of FIELDS) {
    if (!before || fieldValue(before, field) !== fieldValue(agent, field)) {
      agent.trace[field] = trace
      changed = true
    }
  }

  if (changed && trace.at >= agent.lastEventAt) {
    agent.lastEventAt = trace.at
    agent.trace.lastEventAt = trace
  }
}

function setStatus(agent: RoomAgent, status: RoomLiveStatus, at: number, known: boolean): void {
  const basis = basisOf(agent)

  if (status === 'idle') {
    basis.tools = []
    basis.idleSince = basis.status !== 'idle' ? (known && basis.status !== null ? at : null) : basis.idleSince
  } else {
    basis.idleSince = null
  }

  basis.status = status
  basis.statusAt = Math.max(basis.statusAt, at)
}

function addHandoff(work: Work, kind: RoomHandoff['kind'], from: string | null, to: string | null, trace: RoomTrace): void {
  if (!from || !to) {
    return
  }

  const id = `${kind}:${kind === 'note' ? to : from}`

  if (!work.handoffs.some(handoff => handoff.id === id)) {
    work.handoffs.push({ id, kind, from, to, at: trace.at, trace })
  }
}

/** Usage is traced on its own: a cost read is news about the money, not about what the agent is doing, so it leaves `lastEventAt` alone. */
function setUsage(agent: RoomAgent, usage: RoomUsage | null, trace: RoomTrace): void {
  if (!sameUsage(agent.usage, usage)) {
    agent.usage = usage
    agent.trace.usage = trace
  }
}

function frameTrace(frame: RoomFrame, at: number): RoomTrace {
  return traceOf('frame', frame.event, at, frame.seq)
}

function applySessionFrame(work: Work, frame: Exclude<RoomFrame, { type: 'subagent' }>, trace: RoomTrace, evidenceAt: number, backfill: boolean): void {
  const id = sessionAgentId(frame.sessionId)
  const before = beforeOf(work, id)
  const agent = edit(work, id) ?? add(work, newAgent(id, 'conversation', frame.sessionId, trace))
  const basis = basisOf(agent)
  const fresh = evidenceAt >= basis.statusAt
  const known = !backfill

  basis.frameAt = Math.max(basis.frameAt, evidenceAt)

  switch (frame.type) {
    case 'message.start':
      if (fresh) {
        setStatus(agent, 'working', evidenceAt, known)
      }

      basis.tools = []
      basis.toolArea = null
      basis.toolTarget = null
      basis.toolStep = null
      basis.toolFront = false
      basis.turnArea = null
      basis.turnTarget = null
      basis.turnFront = false
      basis.turnTokens = tokensOf(basis.counts)
      agent.turnStartedAt = backfill ? null : trace.at
      agent.repeat = null
      agent.guardrail = null
      break
    case 'message.complete':
      if (fresh) {
        setStatus(agent, 'idle', evidenceAt, known)
      }

      basis.tools = []
      basis.counts = frame.usage ?? basis.counts
      agent.turnStartedAt = null
      break
    case 'usage':
      if (fresh && basis.status !== 'working' && basis.status !== 'starting') {
        setStatus(agent, 'working', evidenceAt, known)
      }

      basis.counts = frame.usage
      break
    case 'tool.start': {
      const step = describeTool(frame.call, { cwd: basis.cwd, area: agent.area, target: agent.target })
      const key = frame.toolId ?? `${frame.tool}#${frame.seq ?? basis.tools.length}`

      basis.tools = [...basis.tools.filter(tool => tool !== key), key]
      basis.toolArea = step.area
      basis.toolTarget = step.target
      basis.toolStep = step.step
      basis.toolFront = step.front === true

      if (step.area && step.area !== 'bench') {
        basis.turnArea = step.area
        basis.turnTarget = step.target
        basis.turnFront = step.front === true
      }

      if (frame.call.name === 'todo' || frame.call.name === 'todo_list') {
        basis.todo = true
      }

      agent.tool = frame.tool
      agent.repeat = agent.repeat?.signature === frame.signature ? { signature: frame.signature, count: agent.repeat.count + 1 } : { signature: frame.signature, count: 1 }

      if (fresh && basis.status !== 'working' && basis.status !== 'starting') {
        setStatus(agent, 'working', evidenceAt, known)
      }

      break
    }
    case 'tool.complete': {
      const index = frame.toolId ? basis.tools.indexOf(frame.toolId) : basis.tools.findIndex(tool => tool.startsWith(`${frame.tool}#`))

      if (index >= 0) {
        basis.tools = basis.tools.filter((_, at) => at !== index)
      }

      break
    }
    case 'guardrail':
      agent.guardrail = { tool: frame.tool, code: frame.code, at: trace.at }
      break
    case 'todo':
      basis.todo = true
      break
    case 'session.title':
      if (frame.title) {
        agent.title = frame.title
      }

      if (frame.sessionKey && !agent.sessionKey) {
        agent.sessionKey = frame.sessionKey
      }

      break
    case 'session.info':
      if (frame.cwd) {
        basis.cwd = frame.cwd
      }

      if (frame.title) {
        agent.title = frame.title
      }

      if (frame.sessionKey) {
        agent.sessionKey = frame.sessionKey
      }

      if (frame.running !== null && fresh) {
        setStatus(agent, frame.running ? 'working' : 'idle', evidenceAt, known)
        agent.turnStartedAt = frame.running ? (frame.turnStartedAt ?? agent.turnStartedAt) : null
      }

      break
    case 'request.cancel':
      if (agent.approval && frame.rpcId && (agent.approval.rpcId === frame.rpcId || agent.approval.requestId === frame.rpcId)) {
        agent.approval = null
      }

      if (agent.asking && frame.method && askingOf(frame.method) === agent.asking) {
        agent.asking = null
      }

      break
    case 'activity':
      if (frame.turn && fresh && basis.status !== 'working' && basis.status !== 'starting') {
        setStatus(agent, 'working', evidenceAt, known)
      }

      break
  }

  if (frame.type === 'message.start' || frame.type === 'message.complete' || frame.type === 'usage') {
    setUsage(agent, sessionUsage(basis.counts, basis.turnTokens, basis.costRow, trace.at), trace)
  }

  settle(agent, before, trace, true)
}

function askingOf(method: string): RoomAgent['asking'] {
  return method === 'clarify' ? 'clarify' : method === 'sudo' || method === 'display.install.sudo' ? 'sudo' : method === 'secret' ? 'secret' : 'other'
}

function sessionIdOf(work: Work, agentId: string | null): string {
  if (!agentId) {
    return ''
  }

  return agentId.startsWith('s:') ? agentId.slice(2) : (work.agents[agentId]?.sessionId ?? '')
}

function applyHelperFrame(work: Work, frame: Extract<RoomFrame, { type: 'subagent' }>, trace: RoomTrace, evidenceAt: number, backfill: boolean): void {
  const facts = frame.helper
  const id = helperAgentId(facts.subagentId)
  const parentId = facts.parentId ? helperAgentId(facts.parentId) : sessionAgentId(frame.sessionId)
  const before = beforeOf(work, id)

  if (backfill && frame.stage === 'complete') {
    // Its work ended before the Room looked: there is no walk back to show.
    delete work.agents[id]

    return
  }

  const agent = edit(work, id) ?? add(work, newAgent(id, 'helper', frame.sessionId, trace))
  const basis = basisOf(agent)

  if (!before && !backfill) {
    addHandoff(work, 'note', parentId, id, trace)
  }

  basis.frameAt = Math.max(basis.frameAt, evidenceAt)
  agent.parentId = parentId
  agent.sessionId = frame.sessionId
  basis.childSessionId = facts.childSessionId ?? basis.childSessionId

  if (facts.goal && !agent.title) {
    agent.title = facts.goal
  }

  if (facts.toolCount !== null) {
    agent.toolCount = Math.max(agent.toolCount ?? 0, facts.toolCount)
  }

  if (frame.stage === 'complete' && !agent.result) {
    agent.phase = 'finished'
    agent.result = facts.status
      ? {
          status: facts.status,
          summary: facts.summary,
          durationSeconds: facts.durationSeconds,
          filesRead: facts.filesRead,
          filesWritten: facts.filesWritten,
          inputTokens: facts.inputTokens,
          outputTokens: facts.outputTokens,
          reasoningTokens: facts.reasoningTokens,
          apiCalls: facts.apiCalls,
          costUsd: facts.costUsd,
          at: trace.at
        }
      : null
    setUsage(agent, agent.result ? helperUsage(agent.result) : null, trace)
    addHandoff(work, 'result', id, agent.parentId, trace)
  } else if (agent.phase !== 'finished') {
    switch (frame.stage) {
      case 'start':
        agent.phase = 'thinking'
        break
      case 'tool':
        if (facts.toolName) {
          useHelperTool(agent, basis, facts.toolName)
        }

        break
      case 'progress':
      case 'thinking':
        if (agent.phase === 'queued') {
          agent.phase = 'thinking'
        }

        break
    }
  }

  settle(agent, before, trace, true)
}

function useHelperTool(agent: RoomAgent, basis: RoomBasis, name: string): void {
  const step = describeTool({ name, target: null, folder: null, action: null, command: null, app: null }, { cwd: null, area: agent.area, target: agent.target })

  basis.toolArea = step.area
  basis.toolTarget = step.target
  basis.toolStep = step.step
  basis.toolFront = false

  if (step.area && step.area !== 'bench') {
    basis.turnArea = step.area
    basis.turnTarget = step.target
    basis.turnFront = false
  }

  agent.tool = name
  agent.phase = 'tool'
}

function applyFrame(work: Work, frame: RoomFrame, trace: RoomTrace, evidenceAt: number, backfill: boolean): void {
  if (frame.type === 'subagent') {
    // A helper's frames come on its conversation's session: the conversation is waiting on it, not quiet.
    applySessionFrame(work, { type: 'activity', turn: false, sessionId: frame.sessionId, seq: frame.seq, event: frame.event }, trace, evidenceAt, backfill)
    applyHelperFrame(work, frame, trace, evidenceAt, backfill)
  } else {
    applySessionFrame(work, frame, trace, evidenceAt, backfill)
  }
}

function clearRequests(agent: RoomAgent, sentAt: number): void {
  if (agent.approval && (agent.trace.approval?.at ?? 0) < sentAt) {
    agent.approval = null
  }

  if (agent.asking && (agent.trace.asking?.at ?? 0) < sentAt) {
    agent.asking = null
  }
}

function applyRequests(work: Work, sessionId: string, requests: RoomRequest[], sentAt: number, at: number): void {
  const id = sessionAgentId(sessionId)
  const before = beforeOf(work, id)
  const agent = edit(work, id)

  if (!agent) {
    return
  }

  const approval = requests.find(request => request.approval && !work.answered[request.approval.requestId])?.approval ?? null
  const other = requests.find(request => request.kind !== 'approval')

  clearRequests(agent, sentAt)

  if (approval && agent.approval?.requestId !== approval.requestId) {
    agent.approval = approval
  }

  if (other && other.kind !== 'approval') {
    agent.asking = other.kind
  }

  const basis = basisOf(agent)

  if (!approval && !other && basis.status === 'waiting' && basis.statusAt < sentAt) {
    setStatus(agent, 'working', sentAt, true)
  }

  settle(agent, before, traceOf('open_request', 'session.events.since', at), false)
}

function applyEvents(work: Work, input: Extract<RoomInput, { type: 'events' }>): void {
  const { sessionId } = input
  let seen: number | undefined = work.seen[sessionId]

  if (seen !== undefined && input.latestSeq < seen) {
    seen = undefined
  }

  for (const frame of input.frames) {
    if (frame.sessionId !== sessionId || (frame.seq !== null && seen !== undefined && frame.seq <= seen)) {
      continue
    }

    applyFrame(work, frame, frameTrace(frame, input.at), input.sentAt, input.backfill)

    if (frame.seq !== null) {
      seen = Math.max(seen ?? 0, frame.seq)
    }
  }

  work.seen[sessionId] = Math.max(seen ?? 0, input.latestSeq)

  if (input.requests) {
    applyRequests(work, sessionId, input.requests, input.sentAt, input.at)
  }
}

function applyLive(work: Work, frame: RoomFrame, at: number): void {
  const seen = work.seen[frame.sessionId]

  if (frame.seq !== null && seen !== undefined && frame.seq <= seen) {
    return
  }

  applyFrame(work, frame, frameTrace(frame, at), at, false)

  if (frame.seq !== null) {
    work.seen[frame.sessionId] = Math.max(seen ?? 0, frame.seq)
  }
}

function dropSession(work: Work, id: string): void {
  delete work.agents[id]

  for (const agent of Object.values(work.agents)) {
    if (isHelper(agent) && agent.sessionId === id.slice(2) && !(agent.basis?.listed && agent.basis.missing === 0)) {
      delete work.agents[agent.id]
    }
  }
}

function applyActiveList(work: Work, input: Extract<RoomInput, { type: 'active_list' }>): void {
  const trace = traceOf('active_list', 'session.active_list', input.at)
  const watched = new Set(Object.values(work.agents).flatMap(agent => (isHelper(agent) && agent.basis?.childSessionId ? [agent.basis.childSessionId] : [])))
  const listed = new Set<string>()

  for (const row of input.rows) {
    const id = sessionAgentId(row.id)

    // Someone watches a helper's own session: that row is the helper, which the Room already shows.
    if (row.sessionKey && watched.has(row.sessionKey)) {
      delete work.agents[id]
      continue
    }

    listed.add(id)

    const before = beforeOf(work, id)
    const agent = edit(work, id) ?? add(work, newAgent(id, 'conversation', row.id, trace))
    const basis = basisOf(agent)
    const title = row.title || (row.sessionKey ? work.meta[row.sessionKey]?.title : '') || ''

    agent.sessionKey = row.sessionKey ?? agent.sessionKey
    agent.startedAt = row.startedAt ?? agent.startedAt

    if (title) {
      agent.title = title
    }

    if (row.status && input.sentAt > basis.statusAt) {
      setStatus(agent, row.status, input.sentAt, Boolean(before))

      if (row.status !== 'waiting') {
        clearRequests(agent, input.sentAt)
      }
    }

    settle(agent, before, trace, false)
  }

  for (const [id, agent] of Object.entries(work.agents)) {
    if (isSession(agent) && !listed.has(id) && (agent.basis?.frameAt ?? 0) < input.sentAt) {
      dropSession(work, id)
    }
  }
}

function applyDelegation(work: Work, input: Extract<RoomInput, { type: 'delegation' }>): void {
  const trace = traceOf('delegation', 'delegation.status', input.at)
  const byKey = new Map(Object.values(work.agents).flatMap(agent => (isSession(agent) && agent.sessionKey ? [[agent.sessionKey, agent.id] as const] : [])))
  const listed = new Set<string>()

  for (const entry of input.records) {
    const id = helperAgentId(entry.subagentId)
    const parentId = entry.parentId ? helperAgentId(entry.parentId) : entry.ownerSessionKey ? (byKey.get(entry.ownerSessionKey) ?? null) : null
    const before = beforeOf(work, id)
    const agent = edit(work, id) ?? add(work, newAgent(id, 'helper', sessionIdOf(work, parentId), trace))
    const basis = basisOf(agent)

    listed.add(id)

    if (!before && !input.initial) {
      addHandoff(work, 'note', parentId, id, trace)
    }

    basis.listed = true
    basis.missing = 0
    agent.parentId = agent.parentId ?? parentId
    agent.sessionId = agent.sessionId || sessionIdOf(work, parentId)
    agent.startedAt = agent.startedAt ?? entry.startedAt

    if (entry.goal && !agent.title) {
      agent.title = entry.goal
    }

    if (entry.toolCount !== null) {
      agent.toolCount = Math.max(agent.toolCount ?? 0, entry.toolCount)
    }

    if (agent.phase !== 'finished' && input.sentAt > basis.frameAt) {
      if (entry.lastTool && entry.lastTool !== agent.tool && !entry.queued) {
        useHelperTool(agent, basis, entry.lastTool)
      } else if (agent.phase === 'queued' && !entry.queued) {
        agent.phase = 'thinking'
      }
    }

    settle(agent, before, trace, false)
  }

  for (const [id, agent] of Object.entries(work.agents)) {
    const basis = agent.basis

    if (!isHelper(agent) || listed.has(id) || agent.phase === 'finished' || !basis) {
      continue
    }

    // Absent once may be a race with its start; absent twice in a row, it has ended without a word.
    if (!basis.listed && (agent.phase === 'queued' || basis.frameAt >= input.sentAt)) {
      continue
    }

    const before = beforeOf(work, id)
    const editing = edit(work, id)!
    basisOf(editing).missing += 1

    if (basisOf(editing).missing >= 2) {
      editing.phase = 'finished'
      addHandoff(work, 'result', id, editing.parentId, trace)
    }

    settle(editing, before, trace, false)
  }
}

function localBySession(work: Work): Map<string, RoomApproval> {
  const bySession = new Map<string, RoomApproval>()

  for (const approval of work.local) {
    if (!work.answered[approval.requestId] && !bySession.has(approval.sessionId)) {
      bySession.set(approval.sessionId, approval)
    }
  }

  return bySession
}

function applyLocal(work: Work, approvals: RoomApproval[], at: number, only?: ReadonlySet<string>): void {
  const trace = traceOf('local_request', 'approval', at)

  work.local = approvals

  const bySession = localBySession(work)

  for (const [id, agent] of Object.entries(work.agents)) {
    if (!isSession(agent) || (only && !only.has(id))) {
      continue
    }

    const local = bySession.get(agent.sessionId) ?? null
    const current = agent.approval

    if (local ? current?.requestId === local.requestId && current.rpcId === local.rpcId : current === null || agent.trace.approval?.source !== 'local_request') {
      continue
    }

    const before = beforeOf(work, id)
    const editing = edit(work, id)!
    editing.approval = local ? (current?.requestId === local.requestId ? { ...current, rpcId: local.rpcId } : local) : null
    settle(editing, before, trace, false)
  }
}

function applyMeta(work: Work, rows: RoomSessionMeta[], at: number): void {
  work.meta = Object.fromEntries(rows.map(row => [row.id, row]))

  const trace = traceOf('session_list', 'session.list', at)

  for (const [id, agent] of Object.entries(work.agents)) {
    const title = agent.sessionKey ? work.meta[agent.sessionKey]?.title : ''

    if (isSession(agent) && !agent.title && title) {
      const before = beforeOf(work, id)
      const editing = edit(work, id)!
      editing.title = title
      settle(editing, before, trace, false)
    }
  }
}

function applyAnswered(work: Work, requestId: string, at: number): void {
  work.answered[requestId] = at

  const trace = traceOf('local_request', 'approval.answered', at)

  for (const [id, agent] of Object.entries(work.agents)) {
    if (agent.approval?.requestId !== requestId) {
      continue
    }

    const before = beforeOf(work, id)
    const editing = edit(work, id)!
    const basis = basisOf(editing)
    editing.approval = null

    if (basis.status === 'waiting') {
      setStatus(editing, 'working', at, true)
    }

    settle(editing, before, trace, false)
  }
}

function applyAutomations(work: Work, input: Extract<RoomInput, { type: 'automations' }>): void {
  const listed = new Set<string>()

  for (const job of input.jobs) {
    const id = automationAgentId(job.key)
    const read = Object.hasOwn(input.runs, job.key)
    const trace = read ? traceOf('cron_runs', 'GET /api/cron/jobs/{id}/runs', input.at) : traceOf('cron_jobs', 'GET /api/cron/jobs', input.at)
    const before = beforeOf(work, id)
    const agent = edit(work, id) ?? add(work, newAgent(id, 'automation', '', trace))

    listed.add(id)
    agent.title = job.name
    agent.automation = automationOf(job, read ? input.runs[job.key] : undefined, agent.automation)

    if (read) {
      setUsage(agent, usageOfRow(input.runs[job.key]?.usage ?? null, input.at), trace)
    }

    settle(agent, before, trace, false)
  }

  const jobIds = new Set(input.jobs.map(job => job.id))

  for (const [id, agent] of Object.entries(work.agents)) {
    const run = agent.kind === 'elsewhere' && agent.parentId === null && agent.sessionKey ? cronRunJob(agent.sessionKey) : null

    // A lane read that came first could not know these runs were the board's own.
    if ((agent.kind === 'automation' && !listed.has(id)) || (run !== null && jobIds.has(run))) {
      delete work.agents[id]
    }
  }
}

const latest = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b))

/** The lane's read names its work and says how active it is; live detail on it stays, and so does live work the list no longer has. */
function applyElsewhere(work: Work, input: Extract<RoomInput, { type: 'elsewhere' }>): void {
  const trace = traceOf('sessions_db', 'GET /api/sessions', input.at)
  const listed = new Set<string>()

  for (const row of input.rows ?? []) {
    const id = elsewhereAgentId(row.id)
    const before = beforeOf(work, id)
    const agent = edit(work, id) ?? add(work, newAgent(id, 'elsewhere', '', trace))
    const lane = agent.elsewhere

    listed.add(id)
    agent.sessionKey = row.id
    agent.title = row.title
    agent.startedAt = row.startedAt
    agent.elsewhere = { where: row.where, active: row.active, lastActiveAt: latest(row.lastActiveAt, lane?.lastActiveAt ?? null), approval: lane?.approval ?? false, liveAt: lane?.liveAt ?? null }
    setUsage(agent, usageOfRow(row.usage, input.at), trace)
    settle(agent, before, trace, false)
  }

  for (const [id, agent] of Object.entries(work.agents)) {
    if (agent.kind === 'elsewhere' && !listed.has(id) && !(input.rows && keepsLive(agent, input.at))) {
      delete work.agents[id]
    }
  }
}

/** Herald's own sessions' rows from the session database: what each used and cost. */
function applyCosts(work: Work, input: Extract<RoomInput, { type: 'costs' }>): void {
  const trace = traceOf('sessions_db', 'GET /api/sessions', input.at)
  const rows = new Map(input.rows.map(row => [row.id, row]))

  for (const agent of Object.values(work.agents)) {
    const row = isSession(agent) && agent.sessionKey ? rows.get(agent.sessionKey) : undefined
    const known = agent.basis?.costRow

    if (!row || (known && known.input === row.input && known.output === row.output && known.costUsd === row.costUsd && known.costStatus === row.costStatus)) {
      continue
    }

    const editing = edit(work, agent.id)!
    const basis = basisOf(editing)
    basis.costRow = { input: row.input, output: row.output, costUsd: row.costUsd, costStatus: row.costStatus }
    setUsage(editing, sessionUsage(basis.counts, basis.turnTokens, basis.costRow, input.at), trace)
  }
}

function outsideAgent(id: string, event: RoomActivity, trace: RoomTrace): RoomAgent {
  const agent = newAgent(id, 'elsewhere', '', trace)
  agent.elsewhere = outsideLane(event.source, event.at)

  return agent
}

/** helper.start: the helper comes in as work outside Herald of its own, with a note from the agent that started it. */
function startOutsideHelper(work: Work, parent: RoomAgent, event: RoomActivity, child: string, trace: RoomTrace, receivedAt: number): void {
  const id = outsideAgentId(child)
  const before = beforeOf(work, id)
  const known = edit(work, id)
  const helper = known ?? add(work, newAgent(id, 'elsewhere', '', trace))

  helper.parentId = parent.id

  if (!known) {
    const lane = outsideLane(event.source, event.at)
    helper.elsewhere = { ...lane, where: parent.elsewhere?.where ?? lane.where }

    if (receivedAt - event.at < HANDOFF_KEEP_MS) {
      addHandoff(work, 'note', parent.id, id, trace)
    }
  }

  takeActivity(helper, basisOf(helper), event)
  settle(helper, before, trace, true)
}

/** helper.end: the helper finishes and walks its result back, unless it ended before the Room could have shown it. */
function endOutsideHelper(work: Work, event: RoomActivity, child: string, trace: RoomTrace, receivedAt: number): void {
  const id = outsideAgentId(child)
  const known = work.agents[id]

  if (!known || known.phase === 'finished') {
    return
  }

  if (receivedAt - event.at >= FINISHED_KEEP_MS) {
    delete work.agents[id]

    return
  }

  const before = beforeOf(work, id)
  const helper = edit(work, id)!
  takeActivity(helper, basisOf(helper), event)
  settle(helper, before, trace, true)
  addHandoff(work, 'result', id, helper.parentId, trace)
}

/** One event from outside Herald; an agent it addresses that the lane does not show yet comes in at once. */
function applyActivity(work: Work, event: RoomActivity, receivedAt: number): void {
  const id = outsideAgentId(event.session)
  const trace = traceOf('activity', event.kind, event.at, event.seq)

  // A helper's own session whose start the Room never saw: nothing says whose it is.
  if (!work.agents[id] && event.source === 'tool') {
    return
  }

  if (event.kind === 'helper.end') {
    if (event.child) {
      endOutsideHelper(work, event, event.child, trace, receivedAt)
    }

    return
  }

  const before = beforeOf(work, id)
  const agent = edit(work, id) ?? add(work, outsideAgent(id, event, trace))
  takeActivity(agent, basisOf(agent), event)
  settle(agent, before, trace, true)

  if (event.kind === 'helper.start' && event.child) {
    startOutsideHelper(work, agent, event, event.child, trace, receivedAt)
  }
}

/** The events not taken in yet, in main's order, leaving out Herald's own work; returns the highest seq taken in. */
function applyOutside(work: Work, input: Extract<RoomInput, { type: 'outside' }>, seen: number): number {
  const herald = heraldWork(work.agents)
  let last = seen

  for (const event of freshEvents(input.events, seen)) {
    last = event.seq

    if (!isHeraldWork(event, herald)) {
      applyActivity(work, event, input.at)
    }
  }

  return last
}

/** Live detail turned off: work outside Herald back to the lane's coarse view, and its helpers gone. */
function dropOutside(work: Work, at: number): boolean {
  const trace = traceOf('activity', 'live.off', at)
  let changed = false

  for (const [id, agent] of Object.entries(work.agents)) {
    if (!hasLiveDetail(agent)) {
      continue
    }

    if (agent.parentId) {
      delete work.agents[id]
    } else {
      const before = beforeOf(work, id)
      const editing = edit(work, id)!
      dropLive(editing, basisOf(editing))
      settle(editing, before, trace, false)
    }

    changed = true
  }

  return changed
}

const sameDesks = (a: Record<string, RoomDesk>, b: readonly RoomDesk[]): boolean => {
  const before = Object.values(a)

  return before.length === b.length && b.every(desk => {
    const known = a[desk.id]

    return known && known.name === desk.name && known.front === desk.front && known.area === desk.area
  })
}

/** Desks that stay keep their places, so none moves when the person brings another document to the front. */
function applyDesks(work: Work, desks: readonly RoomDesk[], at: number): void {
  const next = new Map(desks.map(desk => [desk.id, desk]))
  const kept = Object.keys(work.desks).filter(id => next.has(id))
  const order = [...kept, ...desks.map(desk => desk.id).filter(id => !kept.includes(id))]

  work.desks = Object.fromEntries(order.map(id => [id, next.get(id)!]))
  work.desksTrace = traceOf('presence', 'office.presence', at)
}

/** What moved an agent to its desk or, away from one, the newest of what moved it and what took the desk away. */
function deskTrace(work: Work, agent: RoomAgent, pick: DeskPick | null, at: number): RoomTrace {
  const fallback = traceOf('presence', 'office.presence', at)

  if (pick?.command) {
    return traceOf('command', pick.command.command, pick.command.at)
  }

  if (pick) {
    return (pick.via === 'target' ? agent.trace.target : work.desksTrace) ?? fallback
  }

  const traces = [agent.trace.area, agent.trace.phase, agent.trace.target, work.desksTrace].filter((trace): trace is RoomTrace => Boolean(trace))

  return traces.reduce((newest, trace) => (trace.at > newest.at ? trace : newest), traces[0] ?? fallback)
}

/** Each agent at the desk its target, its session's latest command or its app's front document names. */
function placeAtDesks(work: Work, at: number): void {
  const desks = Object.values(work.desks)

  for (const agent of Object.values(work.agents)) {
    if (!isSession(agent) && !isHelper(agent)) {
      continue
    }

    const basis = agent.basis
    const front = agent.phase === 'tool' ? Boolean(basis?.toolFront) : Boolean(basis?.turnFront)
    const pick = deskFor({ phase: agent.phase, area: agent.area, target: agent.target, sessionId: agent.sessionId, turnStartedAt: agent.turnStartedAt, front }, desks, work.commands, at)
    const desk = pick?.desk.id ?? null

    if (desk !== agent.desk) {
      const editing = edit(work, agent.id)!
      editing.desk = desk
      editing.trace.desk = deskTrace(work, agent, pick, at)
    }
  }
}

/** Helpers report through their root conversation: it is what opens in Hermes. */
function link(work: Work): void {
  for (const agent of Object.values(work.agents)) {
    if (!isHelper(agent)) {
      continue
    }

    let root: RoomAgent | undefined = agent

    for (let hops = 0; root && isHelper(root) && hops < 8; hops++) {
      root = root.parentId ? work.agents[root.parentId] : undefined
    }

    if (root && isSession(root) && (agent.sessionKey !== root.sessionKey || agent.sessionId !== root.sessionId)) {
      const editing = edit(work, agent.id)!
      editing.sessionKey = root.sessionKey
      editing.sessionId = root.sessionId
    }
  }
}

function finish(state: RoomState, work: Work, at: number, heard: boolean): RoomState {
  // A session first seen now takes the approval this window already holds for it.
  if (work.created.size && work.local.length) {
    applyLocal(work, work.local, at, work.created)
  }

  link(work)
  placeAtDesks(work, at)

  return {
    ...state,
    agents: work.agents,
    handoffs: work.handoffs,
    seen: work.seen,
    meta: work.meta,
    answered: work.answered,
    local: work.local,
    desks: work.desks,
    desksTrace: work.desksTrace,
    commands: work.commands,
    updatedAt: heard ? at : state.updatedAt
  }
}

function finishedAt(agent: RoomAgent): number {
  return agent.trace.phase?.at ?? agent.lastEventAt
}

/** When the next record or hand-off is due to be let go; null when nothing waits on the clock. */
export function nextPruneAt(state: RoomState): number | null {
  const times = [
    ...Object.values(state.agents).flatMap(agent => (agent.phase === 'finished' ? [finishedAt(agent) + FINISHED_KEEP_MS] : [])),
    ...Object.values(state.agents).flatMap(agent => {
      const stale = staleAt(agent)

      return stale === null ? [] : [stale]
    }),
    ...state.handoffs.map(handoff => handoff.at + HANDOFF_KEEP_MS),
    ...Object.values(state.answered ?? {}).map(at => at + ANSWERED_KEEP_MS)
  ]

  if (!state.caps.activeList) {
    times.push(...Object.values(state.agents).flatMap(agent => (isSession(agent) && agent.phase === 'idle' ? [agent.lastEventAt + UNLISTED_IDLE_KEEP_MS] : [])))
  }

  return times.length ? Math.min(...times) : null
}

function prune(state: RoomState, now: number): RoomState {
  const work = begin(state)
  let changed = false

  for (const [id, agent] of Object.entries(work.agents)) {
    const silent = staleAt(agent)

    if (silent !== null && now >= silent) {
      if (agent.parentId) {
        delete work.agents[id]
      } else {
        const before = beforeOf(work, id)
        const editing = edit(work, id)!
        dropLive(editing, basisOf(editing))
        settle(editing, before, traceOf('activity', 'live.stale', now), false)
      }

      changed = true
      continue
    }

    const stale = agent.phase === 'finished' ? now - finishedAt(agent) >= FINISHED_KEEP_MS : !state.caps.activeList && isSession(agent) && agent.phase === 'idle' && now - agent.lastEventAt >= UNLISTED_IDLE_KEEP_MS

    if (stale && work.agents[id]) {
      if (isHelper(agent) || agent.kind === 'elsewhere') {
        delete work.agents[id]
      } else {
        dropSession(work, id)
      }

      changed = true
    }
  }

  const handoffs = work.handoffs.filter(handoff => now - handoff.at < HANDOFF_KEEP_MS)
  const answered = Object.fromEntries(Object.entries(work.answered).filter(([, at]) => now - at < ANSWERED_KEEP_MS))

  if (!changed && handoffs.length === state.handoffs.length && Object.keys(answered).length === Object.keys(state.answered ?? {}).length) {
    return state
  }

  return { ...state, agents: work.agents, handoffs, answered }
}

/** Herald's own desks and command log outlast a backend restart; what Hermes listed is read again. */
function reset(state: RoomState, epoch: string | null, at: number): RoomState {
  return { ...EMPTY_ROOM, epoch, meta: state.meta, local: state.local, desks: state.desks, desksTrace: state.desksTrace, commands: state.commands, updatedAt: at }
}

/** Fold one thing the Room heard (or one tick of its clock) into its state; the same state comes back when nothing changed. */
export function reduceRoom(state: RoomState, input: RoomInput): RoomState {
  switch (input.type) {
    case 'reset':
      return reset(state, input.epoch, input.at)
    case 'tick':
      return prune(state, input.now)
    case 'caps':
      return { ...state, caps: { ...state.caps, ...input.caps } }
    case 'config':
      return { ...state, toolProgress: input.toolProgress, toolProgressTrace: traceOf('config', 'config.get', input.at), updatedAt: input.at }
    case 'events':
    case 'live': {
      if (input.epoch && state.epoch && input.epoch !== state.epoch) {
        // A new backend process numbers its frames from 1 again: nothing held here describes it.
        return reset(state, input.epoch, input.at)
      }

      const work = begin(state)

      if (input.type === 'events') {
        applyEvents(work, input)
      } else {
        applyLive(work, input.frame, input.at)
      }

      return { ...finish(state, work, input.at, true), epoch: state.epoch ?? input.epoch }
    }
    case 'active_list': {
      const work = begin(state)
      applyActiveList(work, input)

      return finish(state, work, input.at, true)
    }
    case 'delegation': {
      const work = begin(state)
      applyDelegation(work, input)

      return finish(state, work, input.at, true)
    }
    case 'local_requests': {
      const work = begin(state)
      applyLocal(work, input.approvals, input.at)

      return finish(state, work, input.at, false)
    }
    case 'session_meta': {
      const work = begin(state)
      applyMeta(work, input.rows, input.at)

      return finish(state, work, input.at, false)
    }
    case 'answered': {
      const work = begin(state)
      applyAnswered(work, input.requestId, input.at)

      return finish(state, work, input.at, false)
    }
    case 'answer_failed': {
      const answered = { ...state.answered }
      delete answered[input.requestId]

      return { ...state, answered }
    }
    case 'automations': {
      if (!input.jobs.length && !Object.values(state.agents).some(agent => agent.kind === 'automation')) {
        return state
      }

      const work = begin(state)
      applyAutomations(work, input)

      return finish(state, work, input.at, true)
    }
    case 'elsewhere': {
      if (!input.rows?.length && !Object.values(state.agents).some(agent => agent.kind === 'elsewhere') && Boolean(state.elsewhereOn) === (input.rows !== null)) {
        return input.rows ? { ...state, elsewhereAt: input.at } : state
      }

      const work = begin(state)
      applyElsewhere(work, input)

      return { ...finish(state, work, input.at, input.rows !== null), elsewhereOn: input.rows !== null, elsewhereAt: input.rows ? input.at : undefined }
    }
    case 'outside': {
      const seen = state.outsideSeq ?? 0
      const work = begin(state)
      const last = applyOutside(work, input, seen)

      // `updatedAt` says Herald's own backend has answered, which settles the scene; activity from outside says nothing of that.
      return last === seen ? state : { ...finish(state, work, input.at, false), outsideSeq: last }
    }
    case 'outside_off': {
      const work = begin(state)

      // Turning live detail on again replays what main heard in the last minutes, from the start.
      return dropOutside(work, input.at) || state.outsideSeq !== undefined ? { ...finish(state, work, input.at, false), outsideSeq: undefined } : state
    }
    case 'costs': {
      const work = begin(state)
      applyCosts(work, input)

      return work.copied.size ? finish(state, work, input.at, true) : state
    }
    case 'desks': {
      if (sameDesks(state.desks ?? {}, input.desks)) {
        return state
      }

      const work = begin(state)
      applyDesks(work, input.desks, input.at)

      return finish(state, work, input.at, false)
    }
    case 'commands': {
      if ((state.commands ?? []).map(command => command.id).join() === input.commands.map(command => command.id).join()) {
        return state
      }

      const work = begin(state)
      work.commands = input.commands

      return finish(state, work, input.at, false)
    }
  }
}
