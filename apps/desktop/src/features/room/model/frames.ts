import { nameOf, roomToolCall, type RoomToolCall, shortName } from './areas.ts'
import type { RoomApproval, RoomLiveStatus, RoomResult, RoomSessionCounts, RoomSessionMeta } from './types.ts'

/*
 * The Room's boundary: what Hermes sends is cut down here, on arrival, to the few facts the Room
 * keeps. Message and reasoning text, tool arguments, previews, results, status text, todo items,
 * helpers' progress text and conversation previews never get past these functions.
 */

export type RoomGuardrailCode =
  | 'repeated_exact_failure_block'
  | 'idempotent_no_progress_block'
  | 'same_tool_failure_halt'
  | 'identical_call_streak_halt'
  | 'identical_cycle_halt'
  | 'loop_web_search_cap'
  | 'loop_subagent_cap'

export const GUARDRAIL_CODES: readonly RoomGuardrailCode[] = [
  'repeated_exact_failure_block',
  'idempotent_no_progress_block',
  'same_tool_failure_halt',
  'identical_call_streak_halt',
  'identical_cycle_halt',
  'loop_web_search_cap',
  'loop_subagent_cap'
]

export type RoomHelperStage = 'spawn_requested' | 'start' | 'tool' | 'progress' | 'thinking' | 'complete'

/** What a `subagent.*` frame says about its helper. */
export interface RoomHelperFacts {
  subagentId: string
  /** The helper that spawned it, when it is nested. */
  parentId: string | null
  /** The helper's own session, once it runs. */
  childSessionId: string | null
  goal: string | null
  toolName: string | null
  toolCount: number | null
  status: RoomResult['status'] | null
  summary: string | null
  durationSeconds: number | null
  filesRead: number | null
  filesWritten: number | null
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  apiCalls: number | null
  costUsd: number | null
}

interface FrameBase {
  /** The live session the frame came on. */
  sessionId: string
  /** Its per-session seq; null on backends that do not stamp frames. */
  seq: number | null
  /** Hermes's own name for the frame (`tool.start`), for traces. */
  event: string
}

export type RoomFrame = FrameBase &
  (
    | { type: 'message.start' }
    | { type: 'message.complete'; status: 'complete' | 'error' | 'interrupted' | null; usage: RoomSessionCounts | null }
    /** `session.usage`: the running totals, ticked while a turn runs. */
    | { type: 'usage'; usage: RoomSessionCounts }
    | { type: 'tool.start'; toolId: string | null; tool: string; call: RoomToolCall; signature: string }
    | { type: 'tool.complete'; toolId: string | null; tool: string | null }
    | { type: 'guardrail'; tool: string; code: RoomGuardrailCode }
    | { type: 'todo' }
    | { type: 'session.title'; title: string; sessionKey: string | null }
    | { type: 'session.info'; running: boolean | null; turnStartedAt: number | null; cwd: string | null; title: string | null; sessionKey: string | null }
    | { type: 'request.cancel'; rpcId: string | null; method: string | null }
    | { type: 'subagent'; stage: RoomHelperStage; helper: RoomHelperFacts }
    /** Anything else: it only says the session is alive. `turn` frames (reply and reasoning deltas) only come while a turn runs. */
    | { type: 'activity'; turn: boolean }
  )

/** A `session.active_list` row, without its preview or model. */
export interface RoomSessionRow {
  id: string
  sessionKey: string | null
  status: RoomLiveStatus | null
  title: string
  startedAt: number | null
}

/** A `delegation.status` record: one running helper. */
export interface RoomHelperRecord {
  subagentId: string
  parentId: string | null
  goal: string | null
  startedAt: number | null
  queued: boolean
  toolCount: number | null
  lastTool: string | null
  /** The stored id of the conversation that owns it (`session_key` in `session.active_list`). */
  ownerSessionKey: string | null
}

/** An unanswered server request from `open_requests`. Pets only ever answer plain approvals. */
export interface RoomRequest {
  rpcId: string
  kind: 'approval' | 'clarify' | 'sudo' | 'secret' | 'other'
  approval: RoomApproval | null
}

const TURN_FRAMES = new Set(['message.delta', 'message.interim', 'reasoning.delta', 'reasoning.available', 'thinking.delta', 'tool.generating'])
const TURN_STATUSES = new Set(['complete', 'error', 'interrupted'])
const HELPER_STATUSES = new Set(['completed', 'failed', 'error', 'timeout', 'interrupted'])
const HELPER_STAGES = new Set<string>(['spawn_requested', 'start', 'tool', 'progress', 'thinking', 'complete'])
/** Requests a desktop answers by itself (reads of its own windows, tours): nobody waits on them. */
const UNATTENDED_REQUESTS = new Set(['preview.act', 'preview.read', 'terminal.read', 'window.read', 'tour'])
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/
const EVENT_NAME = /^[a-z][a-z0-9_.]{0,63}$/
const GUARDRAIL = /Tool guardrail halted ([A-Za-z0-9_.:-]{1,64}): ([a-z_]+)/
const TITLE_MAX = 80
const SUMMARY_MAX = 160

/** A helper's summary as its first plain sentence: no code, tables, headings, list marks, emphasis or link targets. */
export function summaryLine(value: string): string | null {
  const prose = value
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .split('\n')
    .filter(line => !/^\s*(\||[-=*_]{3,}\s*$)/.test(line))
    .map(line => line.replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, ''))
    .join(' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|[.,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
  const sentence = /^(.+?[.!?])(\s|$)/.exec(prose)?.[1] ?? prose

  return shortName(sentence, SUMMARY_MAX)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function toolName(value: unknown): string | null {
  return typeof value === 'string' && TOOL_NAME.test(value) ? value : null
}

/** Hermes's times are seconds; the Room's are milliseconds. */
function msOf(value: unknown): number | null {
  const seconds = count(value)

  if (!seconds) {
    return null
  }

  return seconds < 1e12 ? Math.round(seconds * 1000) : seconds
}

function titleOf(value: unknown): string | null {
  return typeof value === 'string' ? shortName(value, TITLE_MAX) : null
}

/** A frame's `usage`: its four counts, never the model's name or anything else it carries. */
function countsOf(value: unknown): RoomSessionCounts | null {
  const usage = record(value)
  const counts = { input: count(usage.input), output: count(usage.output), reasoning: count(usage.reasoning), calls: count(usage.calls) }

  return Object.values(counts).some(entry => entry !== null) ? counts : null
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`
  }

  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)

    return `{${entries.join(',')}}`
  }

  return JSON.stringify(value) ?? 'null'
}

/** A 53-bit hash (cyrb53): tells identical calls apart without keeping what they said. */
function hash(input: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57

  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** The same tool with the same arguments signs the same. */
export function callSignature(name: string, args: unknown): string {
  return `${name}:${hash(stable(args ?? null))}`
}

/** Tool and code of Hermes's tool-loop guardrail halt, from a status line's text; the text itself is never kept. */
export function guardrailOf(statusText: unknown): { tool: string; code: RoomGuardrailCode } | null {
  if (typeof statusText !== 'string') {
    return null
  }

  const match = GUARDRAIL.exec(statusText)
  const code = match?.[2] as RoomGuardrailCode | undefined

  return match && code && GUARDRAIL_CODES.includes(code) ? { tool: match[1], code } : null
}

function helperFacts(sessionId: string, payload: Record<string, unknown>, stage: RoomHelperStage): RoomHelperFacts {
  const complete = stage === 'complete'
  const status = text(payload.status)

  return {
    subagentId: text(payload.subagent_id) ?? `${text(payload.delegation_id) ?? sessionId}:${count(payload.task_index) ?? 0}`,
    parentId: text(payload.parent_id),
    childSessionId: text(payload.child_session_id),
    goal: titleOf(payload.goal),
    toolName: stage === 'tool' ? toolName(payload.tool_name) : null,
    toolCount: count(payload.tool_count),
    status: complete && status && HELPER_STATUSES.has(status) ? (status as RoomResult['status']) : null,
    summary: complete && typeof payload.summary === 'string' ? summaryLine(payload.summary) : null,
    durationSeconds: complete ? count(payload.duration_seconds) : null,
    filesRead: complete && Array.isArray(payload.files_read) ? payload.files_read.length : null,
    filesWritten: complete && Array.isArray(payload.files_written) ? payload.files_written.length : null,
    inputTokens: complete ? count(payload.input_tokens) : null,
    outputTokens: complete ? count(payload.output_tokens) : null,
    reasoningTokens: complete ? count(payload.reasoning_tokens) : null,
    apiCalls: complete ? count(payload.api_calls) : null,
    costUsd: complete ? count(payload.cost_usd) : null
  }
}

/** A frame from a session's event buffer or the live stream, cut down to what the Room keeps; null when it names no session. */
export function roomFrame(raw: unknown): RoomFrame | null {
  const frame = record(raw)
  const sessionId = text(frame.session_id)
  const event = typeof frame.type === 'string' && EVENT_NAME.test(frame.type) ? frame.type : null

  if (!sessionId || !event) {
    return null
  }

  const seq = typeof frame.seq === 'number' && Number.isFinite(frame.seq) ? frame.seq : null
  const base = { sessionId, seq, event }
  const payload = record(frame.payload)

  switch (event) {
    case 'message.start':
      return { ...base, type: 'message.start' }
    case 'message.complete': {
      const status = text(payload.status)

      return { ...base, type: 'message.complete', status: status && TURN_STATUSES.has(status) ? (status as 'complete' | 'error' | 'interrupted') : null, usage: countsOf(payload.usage) }
    }
    case 'session.usage': {
      const usage = countsOf(payload.usage)

      return usage ? { ...base, type: 'usage', usage } : { ...base, type: 'activity', turn: true }
    }
    case 'tool.start': {
      const tool = toolName(payload.name)

      if (!tool) {
        return { ...base, type: 'activity', turn: true }
      }

      return { ...base, type: 'tool.start', toolId: text(payload.tool_id), tool, call: roomToolCall(tool, payload.args, payload.labels), signature: callSignature(tool, payload.args) }
    }
    case 'tool.complete':
      return { ...base, type: 'tool.complete', toolId: text(payload.tool_id), tool: toolName(payload.name) }
    case 'status.update': {
      const halt = guardrailOf(payload.text)

      return halt ? { ...base, type: 'guardrail', ...halt } : { ...base, type: 'activity', turn: false }
    }
    case 'todo.updated':
      return { ...base, type: 'todo' }
    case 'session.title':
      return { ...base, type: 'session.title', title: titleOf(payload.title) ?? '', sessionKey: text(payload.session_id) }
    case 'session.info': {
      const running = flag(payload.running)

      return {
        ...base,
        type: 'session.info',
        running,
        turnStartedAt: running === false ? null : msOf(payload.turn_started_at),
        cwd: nameOf(payload.cwd),
        title: titleOf(payload.title),
        sessionKey: text(payload.stored_session_id)
      }
    }
    case 'request.cancel':
      return { ...base, type: 'request.cancel', rpcId: text(payload.id) ?? text(payload.request_id), method: text(payload.method) }
  }

  if (event.startsWith('subagent.') && HELPER_STAGES.has(event.slice(9))) {
    const stage = event.slice(9) as RoomHelperStage

    return { ...base, type: 'subagent', stage, helper: helperFacts(sessionId, payload, stage) }
  }

  return { ...base, type: 'activity', turn: TURN_FRAMES.has(event) }
}

function liveStatus(value: unknown): RoomLiveStatus | null {
  switch (value) {
    case 'idle':
      return 'idle'
    case 'starting':
    case 'resuming':
      return 'starting'
    case 'waiting':
      return 'waiting'
    case 'working':
    case 'streaming':
      return 'working'
    default:
      return null
  }
}

/** A `session.active_list` row; its preview (the last message) and model stay behind. */
export function roomSessionRow(raw: unknown): RoomSessionRow | null {
  const row = record(raw)
  const id = text(row.id)

  if (!id) {
    return null
  }

  return { id, sessionKey: text(row.session_key), status: liveStatus(row.status), title: titleOf(row.title) ?? '', startedAt: msOf(row.started_at) }
}

/** A `delegation.status` record: names, counts and the last tool's name only. */
export function roomHelperRecord(raw: unknown): RoomHelperRecord | null {
  const entry = record(raw)
  const subagentId = text(entry.subagent_id)

  if (!subagentId) {
    return null
  }

  return {
    subagentId,
    parentId: text(entry.parent_id),
    goal: titleOf(entry.goal),
    startedAt: msOf(entry.started_at),
    queued: entry.status === 'queued',
    toolCount: count(entry.tool_count),
    lastTool: toolName(entry.last_tool),
    ownerSessionKey: text(entry.owner_agent_session_id)
  }
}

function choicesOf(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((choice): choice is string => typeof choice === 'string') : null
}

/** What Herald's approval card shows, and nothing more. */
export function approvalOf(rpcId: string | null, raw: unknown): RoomApproval | null {
  const params = record(raw)
  const sessionId = text(params.session_id)
  const requestId = text(params.request_id) ?? rpcId

  if (!sessionId || !requestId) {
    return null
  }

  return {
    requestId,
    rpcId,
    sessionId,
    params: {
      description: text(params.description),
      command: text(params.command),
      tool_name: text(params.tool_name),
      choices: choicesOf(params.choices),
      allow_permanent: flag(params.allow_permanent),
      allow_session: flag(params.allow_session)
    }
  }
}

/** An `open_requests` entry; requests a desktop answers by itself wait on nobody and are left out. */
export function roomRequest(raw: unknown): RoomRequest | null {
  const entry = record(raw)
  const rpcId = text(entry.id)
  const method = text(entry.method)

  if (!rpcId || !method || UNATTENDED_REQUESTS.has(method)) {
    return null
  }

  if (method === 'approval') {
    const approval = approvalOf(rpcId, entry.params)

    return approval ? { rpcId, kind: 'approval', approval } : null
  }

  const kind = method === 'clarify' ? 'clarify' : method === 'sudo' || method === 'display.install.sudo' ? 'sudo' : method === 'secret' ? 'secret' : 'other'

  return { rpcId, kind, approval: null }
}

/** A stored session row from Herald's list: its title and source, never its preview. */
export function roomSessionMeta(raw: unknown): RoomSessionMeta | null {
  const row = record(raw)
  const id = text(row.id)

  return id ? { id, title: titleOf(row.title) ?? '', source: text(row.source) } : null
}
