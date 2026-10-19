import type { RoomArea, RoomKind, RoomPhase } from '../../../../shared/room.ts'

/*
 * The Room's records: one per agent, folded from what Hermes reports (frames from a session's
 * event buffer or the live stream, `session.active_list` rows, `delegation.status` records, open
 * requests, Herald's automation records and, when the person opts in, Hermes's session database
 * and the activity Herald's bridge plugin reports from Hermes outside Herald) and from what
 * Herald knows itself (the documents its Office and Canvas windows have open, and which agent
 * ran a command there). Every field says where it came from, and nothing here holds
 * chat text, file content, tool arguments or Hermes's thinking: everything is cut down to the
 * facts below on arrival.
 */

export type { RoomArea, RoomKind, RoomPhase }
export { ROOM_AREAS } from '../../../../shared/room.ts'

/** The areas whose open documents stand as desks. */
export type RoomDeskArea = 'docs' | 'sheets' | 'slides' | 'canvas'

export const DESK_AREAS: readonly RoomDeskArea[] = ['docs', 'sheets', 'slides', 'canvas']

/**
 * Where a value came from: a frame (with its seq), a record from one of Hermes's methods or routes
 * (automations' `/api/cron/jobs` and their runs, the session database's `/api/sessions`), the
 * presence Herald's Office and Canvas windows report, a command from the shell's log, or an event
 * Herald's bridge plugin reported from a Hermes process outside Herald (with main's seq).
 */
export type RoomSource = 'frame' | 'active_list' | 'delegation' | 'open_request' | 'local_request' | 'session_list' | 'config' | 'cron_jobs' | 'cron_runs' | 'sessions_db' | 'presence' | 'command' | 'activity'

export interface RoomTrace {
  source: RoomSource
  /** The frame's type (`tool.start`) or the method's name (`session.active_list`). */
  type: string
  /** The frame's per-session seq, for frames. */
  seq?: number
  /** When the Room received it: Hermes's frames carry no time. */
  at: number
}

/** The fields a trace is kept for. */
export type RoomField = 'kind' | 'title' | 'parent' | 'phase' | 'area' | 'target' | 'step' | 'approval' | 'asking' | 'repeat' | 'guardrail' | 'result' | 'desk' | 'automation' | 'elsewhere' | 'usage' | 'lastEventAt'

/** A plain approval waiting on the person, with only what Herald's approval card shows. */
export interface RoomApproval {
  /** The approval's own id (`params.request_id`), which `approval.respond` names. */
  requestId: string
  /** The server request's JSON-RPC id, which the window that holds it answers through. */
  rpcId: string | null
  /** The live session it waits in. */
  sessionId: string
  params: {
    description: string | null
    command: string | null
    tool_name: string | null
    choices: string[] | null
    allow_permanent: boolean | null
    allow_session: boolean | null
  }
}

/** How a helper's work ended, from `subagent.complete`. */
export interface RoomResult {
  status: 'completed' | 'failed' | 'error' | 'timeout' | 'interrupted'
  /** Hermes's own summary of the result, cut to a short bubble. */
  summary: string | null
  durationSeconds: number | null
  filesRead: number | null
  filesWritten: number | null
  /** What the helper's model calls cost, from the same frame; kept for cost meters, not shown yet. */
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  apiCalls: number | null
  costUsd: number | null
  at: number
}

/** A scheduled job's coarse status: cron agents send no gateway events, so this is all Herald's automation records say. */
export interface RoomAutomation {
  jobId: string
  profile: string | null
  paused: boolean
  /** Its latest run is still going: Hermes's own `is_active`, not ended and heard from in the last five minutes. */
  running: boolean
  /** When the run under way started (ms). */
  runStartedAt: number | null
  /** When its last run was and how it ended, from the job's record. */
  lastRunAt: number | null
  lastOutcome: 'ok' | 'failed' | null
}

/** Hermes work in another process, from Hermes's session database (coarse, read at most once a minute) and, with live detail on, from Herald's bridge plugin there. */
export interface RoomElsewhere {
  /** Where it runs, from a fixed table ('Telegram', 'the Hermes CLI'). */
  where: string
  active: boolean
  lastActiveAt: number | null
  /** Live detail: an approval waits in that Hermes app. The Room shows it and never answers it. */
  approval: boolean
  /** Live detail: when the plugin last reported this work; null without live detail. */
  liveAt: number | null
}

/** How Hermes counts an amount of money: what the provider billed, its own estimate, part of a plan, or not known. */
export type RoomCostStatus = 'actual' | 'estimated' | 'included' | 'unknown'

/** A session's running token and model-call totals from `message.complete` and `session.usage` frames: the numbers only, never the model's name. */
export interface RoomSessionCounts {
  input: number | null
  output: number | null
  /** Part of `output`: Hermes reads it from the provider's output details. */
  reasoning: number | null
  calls: number | null
}

/** What a row of Hermes's session database (`/api/sessions`, a job's runs) says a session used: its token counts and cost, nothing else. */
export interface RoomRowUsage {
  input: number | null
  output: number | null
  costUsd: number | null
  costStatus: RoomCostStatus | null
}

/** Tokens, model calls and cost, where Hermes reports them; for cost meters, shown only when the person turns them on. */
export interface RoomUsage {
  /** Running totals for a session (`message.complete` and `session.usage` frames), the whole job for a helper (`subagent.complete`) or a run, or the session database's. */
  input: number | null
  output: number | null
  reasoning: number | null
  calls: number | null
  /** The turn under way or last finished: the session's tokens now less what they were when the turn began. */
  turn: number | null
  costUsd: number | null
  costStatus: RoomCostStatus | null
  at: number
}

/** A document open in Herald Docs, Sheets or Slides, or a Canvas project, standing as a desk in its area. */
export interface RoomDesk {
  /** `<area>:<the window's key for the document>`. */
  id: string
  area: RoomDeskArea
  /** The document's name, its last path segment: never its path, selection or content. */
  name: string
  /** The document in front in its app's most recently used window. */
  front: boolean
  /** When its window was last used. */
  usedAt: number
}

/** An Office or Canvas command an agent ran, cut down from the shell's command log: whose session, which app, and the document's name when the command named one. */
export interface RoomCommand {
  id: number
  /** The command's id (`docs.write`), for traces. */
  command: string
  sessionId: string
  area: RoomDeskArea
  document: string | null
  at: number
}

export interface RoomAgent {
  /** `s:<live session id>` for sessions, `h:<subagent id>` for helpers. */
  id: string
  kind: RoomKind
  /** The live session it is (sessions) or reports through (helpers: its parent conversation's). */
  sessionId: string
  /** The stored session id (`session_key`), which opens the conversation in Hermes. */
  sessionKey: string | null
  /** The session's title or the helper's goal, trimmed; empty when Hermes has none yet. */
  title: string
  /** Helpers: the agent that spawned it (a session or another helper). */
  parentId: string | null
  phase: RoomPhase
  area: RoomArea
  /** What the step works on: a file or document name, a web host, an app; never content. */
  target: string | null
  /** A label from the Room's fixed tables ('reading Budget.xlsx'); null when there is nothing to say. */
  step: string | null
  /** The running tool's name, as Hermes names it. */
  tool: string | null
  /** When the work started (ms), from Hermes's records. */
  startedAt: number | null
  /** When the turn under way started (ms); null between turns. */
  turnStartedAt: number | null
  /** When the Room last received a frame or record that touched this agent. */
  lastEventAt: number
  approval: RoomApproval | null
  /** A request other than a plain approval waits on the person in Hermes; pets never answer these. */
  asking: 'clarify' | 'sudo' | 'secret' | 'other' | null
  /** The same tool call (same name and arguments, compared by a hash) in a row. */
  repeat: { signature: string; count: number } | null
  /** Hermes's tool-loop guardrail stopped a call. */
  guardrail: { tool: string; code: string; at: number } | null
  /** Helpers: how their work ended. */
  result: RoomResult | null
  /** Helpers: tools used so far, from `delegation.status` or `subagent.*` frames. */
  toolCount: number | null
  /** The desk it works at: the open document in its area that its target, its latest command or the app's front document names. */
  desk: string | null
  /** Automations: the job's coarse status. */
  automation: RoomAutomation | null
  /** The elsewhere lane: where the work runs and how active it is. */
  elsewhere: RoomElsewhere | null
  /** Tokens and cost Hermes reported for it. */
  usage: RoomUsage | null
  trace: Partial<Record<RoomField, RoomTrace>>
  /** What the Room works the phase, area and step out from; nothing to draw. */
  basis?: RoomBasis
}

/** Hermes's word for a session: `session.active_list`'s status, or what a turn's frames say. */
export type RoomLiveStatus = 'idle' | 'starting' | 'working' | 'waiting'

export interface RoomBasis {
  status: RoomLiveStatus | null
  /** When the status was true: a record's request time, a polled frame's request time, a live frame's receipt. */
  statusAt: number
  /** The newest frame evidence for the agent, on the same clock as `statusAt`. */
  frameAt: number
  /** Tools running now, by Hermes's tool id. */
  tools: string[]
  /** The running tool's area, target and step from the fixed tables. */
  toolArea: RoomArea | null
  toolTarget: string | null
  toolStep: string | null
  /** The running tool works on the document in front of its app, which it does not name. */
  toolFront: boolean
  /** The area and target of the turn's last tool, where the agent thinks between tools. */
  turnArea: RoomArea | null
  turnTarget: string | null
  turnFront: boolean
  /** The session's working folder, by name. */
  cwd: string | null
  /** The session keeps a todo list (a mission). */
  todo: boolean
  /** When the Room saw the agent go idle; null when it was idle when the Room first saw it. */
  idleSince: number | null
  /** Helpers: their own session, which `session.active_list` lists while someone watches it. */
  childSessionId: string | null
  /** Helpers: `delegation.status` listed it at least once. */
  listed: boolean
  /** Helpers: `delegation.status` polls in a row that did not list it. */
  missing: number
  /** Work outside Herald: the approvals waiting in that Hermes app, by the plugin's call id. */
  approvals: string[]
  /** Sessions: the running totals the latest frame reported. */
  counts: RoomSessionCounts | null
  /** Sessions: input and output tokens when the turn under way began. */
  turnTokens: number | null
  /** Sessions: what Hermes's session database says the session used and cost. */
  costRow: RoomRowUsage | null
}

/** A stored session row from Herald's session list: its title and where it came from, never its preview. */
export interface RoomSessionMeta {
  id: string
  title: string
  source: string | null
}

/** Something true about an agent, said as a fact rather than a verdict ('quiet for 4 minutes during a turn'). */
export interface RoomFact {
  kind: 'waiting' | 'asking' | 'idle' | 'quiet' | 'repeat' | 'guardrail' | 'result' | 'toolsHidden' | 'running' | 'lastRun' | 'paused' | 'activity' | 'meeting'
  text: string
  /** The record or frame the fact rests on. */
  trace: RoomTrace | null
}

/** A note walked from a parent to a helper it spawned, or a result walked back. */
export interface RoomHandoff {
  id: string
  kind: 'note' | 'result'
  from: string
  to: string
  at: number
  trace: RoomTrace
}

/** Which of Hermes's methods answered; a method-not-found turns its part of the Room off. */
export interface RoomCaps {
  activeList: boolean
  eventsSince: boolean
  delegation: boolean
  config: boolean
  /** Herald's automations (`/api/cron/jobs`). */
  automations: boolean
  /** Hermes's session database (`/api/sessions`), for the elsewhere lane. */
  sessionsDb: boolean
}

export interface RoomState {
  /** The backend process's replay epoch the watermarks belong to. */
  epoch: string | null
  agents: Record<string, RoomAgent>
  /** The highest seq applied, per live session, in `epoch`. */
  seen: Record<string, number>
  handoffs: RoomHandoff[]
  /** Hermes's `display.tool_progress` (from `config.get`); 'off' means tool frames do not come. */
  toolProgress: 'all' | 'new' | 'verbose' | 'off' | null
  caps: RoomCaps
  /** When the Room last heard from Hermes at all. */
  updatedAt: number
  /** Stored session rows by stored id, for titles and kinds. */
  meta?: Record<string, RoomSessionMeta>
  /** Approvals answered from here, by request id, so a poll that raced the answer does not raise the sign again. */
  answered?: Record<string, number>
  /** Approvals this window holds (its own cards), for sessions the Room has yet to see. */
  local?: RoomApproval[]
  /** Where `toolProgress` came from. */
  toolProgressTrace?: RoomTrace | null
  /** The open documents and Canvas projects, by desk id, from Office and Canvas presence. */
  desks?: Record<string, RoomDesk>
  /** When the desks were last read. */
  desksTrace?: RoomTrace | null
  /** Recent Office and Canvas commands agents ran, newest first. */
  commands?: RoomCommand[]
  /** The elsewhere lane is on and has been read at least once. */
  elsewhereOn?: boolean
  /** When the elsewhere lane was last read: its labels are as of then. */
  elsewhereAt?: number
  /** The highest seq of live activity from outside Herald taken in, as main numbers it. */
  outsideSeq?: number
}
