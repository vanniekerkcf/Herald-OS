/*
 * The Room: a window where every live piece of Hermes work in Herald's own backend stands as a
 * petdex pet. Shared by Electron main (prefs.json, the `activity` control-socket command and the
 * activity log) and the renderer. Which pets are installed and which one Hermes shows stay Hermes's
 * (`display.pet`); the Room only borrows installed pets.
 */

/** The kinds of work a pet can stand for; `elsewhere` is Hermes work in other processes, shown only when the person opts in. */
export type RoomKind = 'conversation' | 'mission' | 'helper' | 'automation' | 'elsewhere'
export const ROOM_KINDS: readonly RoomKind[] = ['conversation', 'mission', 'helper', 'automation', 'elsewhere']

/**
 * Where a pet stands: a work area for the tool it uses, the bench while it waits on the person, the
 * lounge when it rests, the Automations corner for scheduled jobs, and the lane at the room's edge
 * for Hermes work outside Herald.
 */
export type RoomArea = 'docs' | 'sheets' | 'slides' | 'canvas' | 'terminal' | 'browser' | 'files' | 'studio' | 'memory' | 'messages' | 'bench' | 'lounge' | 'automations' | 'elsewhere'
export const ROOM_AREAS: readonly RoomArea[] = ['docs', 'sheets', 'slides', 'canvas', 'terminal', 'browser', 'files', 'studio', 'memory', 'messages', 'bench', 'lounge', 'automations', 'elsewhere']

/**
 * What an agent is doing. Sessions: idle, starting (Hermes builds its agent), thinking (a turn
 * runs with no tool), tool (a tool runs), waiting (a request waits on the person). Helpers: queued,
 * then thinking or tool, then finished once their result is back.
 */
export type RoomPhase = 'idle' | 'starting' | 'thinking' | 'tool' | 'waiting' | 'queued' | 'finished'
export const ROOM_PHASES: readonly RoomPhase[] = ['idle', 'starting', 'thinking', 'tool', 'waiting', 'queued', 'finished']

/** How much the Room moves: walking and animated, animated in place, or still frames. */
export type RoomMotion = 'full' | 'calm' | 'still'
export const ROOM_MOTIONS: readonly RoomMotion[] = ['full', 'calm', 'still']

/** How many days the activity log keeps. */
export const ROOM_LOG_DAYS: readonly number[] = [1, 3, 7, 14, 30]

/** Herald's own Room preferences in prefs.json. */
export interface RoomPrefs {
  /** The installed pet (its folder name) for each kind of work; null picks one by itself. */
  pets: Record<RoomKind, string | null>
  /** Colour pets that share a sprite, so several agents of one kind tell apart. */
  tints: boolean
  motion: RoomMotion
  /** Bubbles say what each pet is doing; off leaves name tags, signs and facts. */
  steps: boolean
  /** The lane for Hermes work outside Herald (messaging bots, the CLI and TUI, Hermes's own app, cron run by the gateway); off unless the person turns it on. */
  elsewhere: boolean
  /**
   * Live steps for that work: Herald's bridge plugin, loaded in every Hermes process, reports each
   * tool call, helper and approval wait there by name only. Off unless turned on, and only while
   * `elsewhere` is on too.
   */
  elsewhereLive: boolean
  /** Desks show the names of the documents open on them, in the Room's window. */
  deskNames: boolean
  /** Herald's screensaver shows the Room: no names, document names or bubbles. */
  screensaver: boolean
  /** The screensaver's pets say their step labels. */
  screensaverSteps: boolean
  /** Herald keeps a metadata-only log of what the Room shows, for the time-lapse; off unless turned on. */
  log: boolean
  /** Days the log keeps, one of ROOM_LOG_DAYS. */
  logDays: number
  /** A token and cost meter on each pet's name tag. */
  costs: boolean
  /** The meters' total in the Room's header. */
  costTotal: boolean
}

export const ROOM_PREFS_DEFAULTS: RoomPrefs = {
  pets: { conversation: null, mission: null, helper: null, automation: null, elsewhere: null },
  tints: true,
  motion: 'full',
  steps: true,
  elsewhere: false,
  elsewhereLive: false,
  deskNames: true,
  screensaver: false,
  screensaverSteps: false,
  log: false,
  logDays: 7,
  costs: false,
  costTotal: false
}

/** A change to the Room preferences: only the fields it names change, and the pets kind by kind. */
export type RoomPrefsPatch = Partial<Omit<RoomPrefs, 'pets'>> & { pets?: Partial<Record<RoomKind, string | null>> }

/** Live detail reaches the Room only while both switches are on. */
export const liveOutside = (prefs: Pick<RoomPrefs, 'elsewhere' | 'elsewhereLive'>): boolean => prefs.elsewhere && prefs.elsewhereLive

/** A pet's folder name as prefs.json may hold it: one path segment, never a dot-folder. */
function slugOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const slug = value.trim()

  return slug && !/[\\/]/.test(slug) && !slug.startsWith('.') ? slug : null
}

/** A stored value made whole: unknown keys dropped, missing ones from the defaults. */
export function normalizeRoomPrefs(raw: unknown): RoomPrefs {
  const source = record(raw)
  const pets = record(source.pets)

  return {
    pets: Object.fromEntries(ROOM_KINDS.map(kind => [kind, slugOrNull(pets[kind])])) as Record<RoomKind, string | null>,
    tints: source.tints !== false,
    motion: ROOM_MOTIONS.includes(source.motion as RoomMotion) ? (source.motion as RoomMotion) : ROOM_PREFS_DEFAULTS.motion,
    steps: source.steps !== false,
    elsewhere: source.elsewhere === true,
    elsewhereLive: source.elsewhereLive === true,
    deskNames: source.deskNames !== false,
    screensaver: source.screensaver === true,
    screensaverSteps: source.screensaverSteps === true,
    log: source.log === true,
    logDays: typeof source.logDays === 'number' && ROOM_LOG_DAYS.includes(source.logDays) ? source.logDays : ROOM_PREFS_DEFAULTS.logDays,
    costs: source.costs === true,
    costTotal: source.costTotal === true
  }
}

/** `patch` over `current`, field by field and the pets kind by kind; a field left undefined keeps its value. */
export function mergeRoomPrefs(current: unknown, patch: unknown): RoomPrefs {
  const base = record(current)
  const change = defined(record(patch))

  return normalizeRoomPrefs({ ...base, ...change, pets: { ...record(base.pets), ...defined(record(change.pets)) } })
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function defined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

/*
 * Live detail from Hermes outside Herald. Herald's bridge plugin registers Hermes's observer hooks
 * in every Hermes process that loads it; while the person has live detail on, each hook queues a
 * compact record and a thread sends batches over Herald's control socket:
 *
 *   {"cmd": "activity", "token": "<activity token>", "events": [{"kind": "tool.start", "session": "…", "tool": "read_file", "target": "Budget.xlsx", "call": "…", "source": "telegram", "at": 1760000000.5}]}
 *
 * The token is not the per-launch UI token: it lets a process report activity and nothing else.
 * Main checks each event against the rules below and hands the Room only what passes.
 */

export type RoomActivityKind = 'session.start' | 'session.end' | 'tool.start' | 'tool.end' | 'helper.start' | 'helper.end' | 'approval.start' | 'approval.end'
export const ROOM_ACTIVITY_KINDS: readonly RoomActivityKind[] = ['session.start', 'session.end', 'tool.start', 'tool.end', 'helper.start', 'helper.end', 'approval.start', 'approval.end']

/** How each kind of event may end, from fixed lists: facts, never Hermes's text. */
export const ROOM_ACTIVITY_STATUSES: Readonly<Partial<Record<RoomActivityKind, readonly string[]>>> = {
  'session.end': ['completed', 'failed', 'interrupted'],
  'tool.end': ['ok', 'error', 'blocked', 'cancelled', 'timeout'],
  'helper.end': ['completed', 'failed', 'error', 'timeout', 'interrupted'],
  'approval.end': ['answered', 'timeout', 'cancelled']
}

/** One event as main hands it to the Room. */
export interface RoomActivity {
  /** Main's own count, in the order events arrived. */
  seq: number
  kind: RoomActivityKind
  /** The Hermes session it belongs to (its stored id); for a helper, the session that started it. */
  session: string
  /** Helpers: the helper's own session. */
  child: string | null
  /** Tools: the tool's name, as Hermes names it. */
  tool: string | null
  /** tool.start: what the call works on, by name only: a file's last path segment, a web host, a folder's name. */
  target: string | null
  /** Pairs a start with its end: an opaque id the plugin derives from Hermes's call id. */
  call: string | null
  /** How it ended, from ROOM_ACTIVITY_STATUSES. */
  status: string | null
  /** Where the session runs, as Hermes names its source or platform ('telegram', 'cli'). */
  source: string | null
  /** When the hook fired (ms), never later than when main received it. */
  at: number
}

/** Main reads at most this many events from one request. */
export const ROOM_ACTIVITY_BATCH = 100
/** An event stamped longer ago than this counts as stamped when it arrived. */
const ACTIVITY_PAST_MS = 10 * 60_000
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/
const CALL_ID = /^[A-Za-z0-9_-]{1,40}$/
const SOURCE = /^[a-z][a-z0-9_]{0,31}$/
const LABEL_MAX = 40
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

const matching = (value: unknown, pattern: RegExp): string | null => (typeof value === 'string' && pattern.test(value) ? value : null)

/** A label as one short line of a name: control characters out, a web address cut to its host, a path to its last segment. */
export function roomLabel(value: unknown, max = LABEL_MAX): string | null {
  if (typeof value !== 'string') {
    return null
  }

  let text = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  const address = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(text)

  if (address && !/^file:/i.test(text)) {
    text = address[1].replace(/^[^@]*@/, '').toLowerCase()
  } else {
    text = text.replace(/^file:\/\/[^/]*/i, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  }

  text = text.trim()

  if (!text || text === '.' || text === '..' || text === '~') {
    return null
  }

  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** Hermes stamps seconds; the Room's times are milliseconds, and an event cannot have happened after it arrived. */
function stampOf(value: unknown, receivedAt: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return receivedAt
  }

  const ms = value < 1e12 ? Math.round(value * 1000) : Math.round(value)

  return ms > receivedAt || ms < receivedAt - ACTIVITY_PAST_MS ? receivedAt : ms
}

/** One event from the plugin, checked field by field; null when it is not one the Room knows. */
export function roomActivityOf(raw: unknown, seq: number, receivedAt: number): RoomActivity | null {
  const event = record(raw)
  const kind = ROOM_ACTIVITY_KINDS.find(entry => entry === event.kind)
  const session = matching(event.session, SESSION_ID)

  if (!kind || !session) {
    return null
  }

  const tools = kind === 'tool.start' || kind === 'tool.end'
  const helpers = kind === 'helper.start' || kind === 'helper.end'
  const tool = tools ? matching(event.tool, TOOL_NAME) : null
  const child = helpers ? matching(event.child, SESSION_ID) : null

  if ((tools && !tool) || (helpers && !child)) {
    return null
  }

  const statuses = ROOM_ACTIVITY_STATUSES[kind]
  const status = statuses && typeof event.status === 'string' && statuses.includes(event.status) ? event.status : null

  return {
    seq,
    kind,
    session,
    child,
    tool,
    target: kind === 'tool.start' ? roomLabel(event.target) : null,
    call: tools || kind.startsWith('approval.') ? matching(event.call, CALL_ID) : null,
    status,
    source: matching(event.source, SOURCE),
    at: stampOf(event.at, receivedAt)
  }
}

/*
 * The activity log: what the Room showed, for the time-lapse. Metadata only, under the same rules
 * as the Room: an agent's kind, phase, area, step label and target label, where outside work ran,
 * hand-offs, approval waits (never their text) and how a helper or a run ended. Never a title, a
 * document's name on a desk, chat or file content, tool arguments or Hermes's thinking. The Hermes
 * window sends entries with the Room's agent ids; main writes them one JSON line each, a file a
 * day in Herald's data folder, with each id replaced by an opaque one of that day.
 */

export type RoomLogOutcome = 'completed' | 'failed' | 'error' | 'timeout' | 'interrupted' | 'ok'
export const ROOM_LOG_OUTCOMES: readonly RoomLogOutcome[] = ['completed', 'failed', 'error', 'timeout', 'interrupted', 'ok']

/** An agent as the Room showed it, written when it comes in and whenever any of this changes. */
export interface RoomLogAgent {
  t: number
  k: 'agent'
  id: string
  kind: RoomKind
  phase: RoomPhase
  area: RoomArea
  /** The step label from the Room's fixed tables ('reading Budget.xlsx'). */
  step: string | null
  /** What the step works on, by name only. */
  target: string | null
  /** An approval or a question waits on the person: never what it asks. */
  wait: boolean
  /** Helpers: the agent that started it. */
  parent: string | null
  /** Outside Herald: where it runs, from the Room's fixed table ('Telegram'). */
  where: string | null
  /** A helper's end, or how an automation's last run went. */
  outcome: RoomLogOutcome | null
}

export type RoomLogEntry =
  /** The log starts (or starts again) here, followed by every agent the Room shows at that moment. */
  | { t: number; k: 'begin' }
  /** The log stops here: what follows until the next `begin` was not logged. */
  | { t: number; k: 'end' }
  /** The day's file is full: nothing more is logged that day. Main writes it. */
  | { t: number; k: 'cap' }
  | RoomLogAgent
  /** The agent left the Room. */
  | { t: number; k: 'gone'; id: string }
  /** A note walked to a helper, or a result walked back. */
  | { t: number; k: 'handoff'; kind: 'note' | 'result'; from: string; to: string; failed: boolean }

/** A day in the log: its local date (YYYY-MM-DD) and its size on disk. */
export interface RoomLogDay {
  day: string
  bytes: number
}

export const ROOM_LOG_DAY = /^\d{4}-\d{2}-\d{2}$/
const LOG_ID = /^[A-Za-z0-9_.:@-]{1,160}$/
const STEP_MAX = 80

const time = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null)
const logId = (value: unknown): string | null => matching(value, LOG_ID)
const optionalLabel = (value: unknown, max: number): string | null | undefined => (value === null || value === undefined ? null : (roomLabelLine(value, max) ?? undefined))

/** A step label or a fixed name as one line: control characters out and cut to `max`, but never split on a slash. */
function roomLabelLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const text = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()

  return text ? (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text) : null
}

/** One log entry, checked field by field on its way to the file and back; null when it is not one. */
export function roomLogEntryOf(raw: unknown): RoomLogEntry | null {
  const entry = record(raw)
  const t = time(entry.t)

  if (t === null) {
    return null
  }

  switch (entry.k) {
    case 'begin':
    case 'end':
    case 'cap':
      return { t, k: entry.k }
    case 'gone': {
      const id = logId(entry.id)

      return id ? { t, k: 'gone', id } : null
    }
    case 'handoff': {
      const from = logId(entry.from)
      const to = logId(entry.to)

      return from && to && (entry.kind === 'note' || entry.kind === 'result') ? { t, k: 'handoff', kind: entry.kind, from, to, failed: entry.failed === true } : null
    }
    case 'agent': {
      const id = logId(entry.id)
      const kind = ROOM_KINDS.find(value => value === entry.kind)
      const phase = ROOM_PHASES.find(value => value === entry.phase)
      const area = ROOM_AREAS.find(value => value === entry.area)
      const step = optionalLabel(entry.step, STEP_MAX)
      const target = optionalLabel(entry.target, LABEL_MAX)
      const where = optionalLabel(entry.where, LABEL_MAX)
      const parent = entry.parent === null || entry.parent === undefined ? null : (logId(entry.parent) ?? undefined)
      const outcome = entry.outcome === null || entry.outcome === undefined ? null : (ROOM_LOG_OUTCOMES.find(value => value === entry.outcome) ?? undefined)

      if (!id || !kind || !phase || !area || step === undefined || target === undefined || where === undefined || parent === undefined || outcome === undefined) {
        return null
      }

      return { t, k: 'agent', id, kind, phase, area, step, target, wait: entry.wait === true, parent, where, outcome }
    }
    default:
      return null
  }
}

/** What main gives the renderers for the Room: live activity from Hermes outside Herald, and the activity log. */
export interface RoomBridge {
  /** Live activity while the person has live detail on: what main heard in the last few minutes at once, then each batch as it arrives. */
  watchActivity(listener: (events: RoomActivity[]) => void): () => void
  /** Add what the Room shows to the activity log; main drops it unless the log is on. */
  appendLog(entries: RoomLogEntry[]): void
  /** The days the log holds, newest first. */
  logDays(): Promise<RoomLogDay[]>
  /** One day's entries, oldest first, ids made opaque. */
  readLog(day: string): Promise<RoomLogEntry[]>
  /** Delete the whole log. */
  deleteLog(): Promise<void>
}
