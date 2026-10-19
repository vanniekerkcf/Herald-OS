import type { RoomLogAgent, RoomLogEntry } from '../../../../shared/room.ts'
import type { RoomAgent, RoomApproval, RoomFact, RoomHandoff, RoomResult } from '../model/types.ts'

/*
 * The time-lapse's reading of one day of the activity log. A stretch is a part of the day the log
 * ran: from a `begin` to the next `end`, `cap` or `begin`, or to its last entry when nothing closed
 * it. The rest of the day is a gap, where the replayed Room stays empty. A day is indexed once, with
 * keyframes, so a seek folds at most five minutes or a few hundred entries.
 */

export type RoomLogHandoff = Extract<RoomLogEntry, { k: 'handoff' }>

export interface RoomReplayStretch {
  from: number
  /** Its `end` or `cap`, else its last entry. */
  to: number
  closed: 'end' | 'cap' | null
  /** The indices of its `begin` and of its last entry. */
  first: number
  last: number
  /** It holds Hermes work outside Herald. */
  elsewhere: boolean
}

export interface RoomReplayGap {
  /** Null: nothing was logged that day before `to`. */
  from: number | null
  /** Null: nothing was logged after `from`. */
  to: number | null
  /** The day's file was full from `from`. */
  after: 'cap' | null
}

export type RoomReplayViews = ReadonlyMap<string, RoomLogAgent>

interface Keyframe {
  index: number
  views: RoomReplayViews
}

export interface RoomReplayIndex {
  entries: readonly RoomLogEntry[]
  /** Each entry's time, never earlier than the one before: the file's order is the order things happened. */
  times: readonly number[]
  stretches: readonly RoomReplayStretch[]
  /** The stretch each entry belongs to, or -1. */
  owner: Int32Array
  keyframes: readonly Keyframe[]
}

/** A keyframe at least this often in log time, or every so many entries, whichever comes first. */
const KEYFRAME_MS = 5 * 60_000
const KEYFRAME_ENTRIES = 400

export const NO_VIEWS: RoomReplayViews = new Map()

function timesOf(entries: readonly RoomLogEntry[]): number[] {
  const times: number[] = []
  let latest = Number.NEGATIVE_INFINITY

  for (const entry of entries) {
    latest = Math.max(latest, entry.t)
    times.push(latest)
  }

  return times
}

/** The last index whose value is at most `t`, or -1. */
function lastAtOrBefore<T>(items: readonly T[], t: number, value: (item: T) => number): number {
  let low = 0
  let high = items.length - 1
  let found = -1

  while (low <= high) {
    const middle = (low + high) >> 1

    if (value(items[middle]) <= t) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return found
}

const timeOf = (t: number) => t
const fromOf = (stretch: RoomReplayStretch) => stretch.from
const indexOf = (keyframe: Keyframe) => keyframe.index

function stretchesIn(entries: readonly RoomLogEntry[], times: readonly number[]): RoomReplayStretch[] {
  const stretches: RoomReplayStretch[] = []
  let first = -1
  let elsewhere = false

  const close = (last: number, closed: RoomReplayStretch['closed']) => {
    stretches.push({ from: times[first], to: times[last], closed, first, last, elsewhere })
    first = -1
    elsewhere = false
  }

  entries.forEach((entry, index) => {
    if (entry.k === 'begin') {
      if (first >= 0) {
        close(index - 1, null)
      }

      first = index
    } else if (first < 0) {
      return
    } else if (entry.k === 'end' || entry.k === 'cap') {
      close(index, entry.k)
    } else if (entry.k === 'agent' && entry.kind === 'elsewhere') {
      elsewhere = true
    }
  })

  if (first >= 0) {
    close(entries.length - 1, null)
  }

  return stretches
}

/** The logged parts of a day; entries before the first `begin`, or between an `end` and the next `begin`, belong to none. */
export function stretchesOf(entries: readonly RoomLogEntry[]): RoomReplayStretch[] {
  return stretchesIn(entries, timesOf(entries))
}

function apply(views: Map<string, RoomLogAgent>, entry: RoomLogEntry): void {
  if (entry.k === 'agent') {
    views.set(entry.id, entry)
  } else if (entry.k === 'gone') {
    views.delete(entry.id)
  } else if (entry.k === 'begin') {
    views.clear()
  }
}

/**
 * One day's entries (oldest first, as main reads them back), indexed for seeking. `openUntil`: the
 * log is still running, so a last stretch nothing has closed lasts until then, not until the last
 * thing that changed.
 */
export function replayIndex(entries: readonly RoomLogEntry[], openUntil?: number): RoomReplayIndex {
  const times = timesOf(entries)
  const stretches = stretchesIn(entries, times)
  const open = stretches.at(-1)

  if (open && open.closed === null && openUntil !== undefined && openUntil > open.to) {
    stretches[stretches.length - 1] = { ...open, to: openUntil }
  }
  const owner = new Int32Array(entries.length).fill(-1)
  const keyframes: Keyframe[] = []

  stretches.forEach((stretch, at) => {
    const views = new Map<string, RoomLogAgent>()
    let markAt = times[stretch.first]
    let markIndex = stretch.first

    for (let index = stretch.first; index <= stretch.last; index++) {
      owner[index] = at
      apply(views, entries[index])

      if (times[index] - markAt >= KEYFRAME_MS || index - markIndex >= KEYFRAME_ENTRIES) {
        keyframes.push({ index, views: new Map(views) })
        markAt = times[index]
        markIndex = index
      }
    }
  })

  return { entries, times, stretches, owner, keyframes }
}

/** The stretch `t` falls in, or -1 in a gap. */
export function stretchAt(index: RoomReplayIndex, t: number): number {
  const found = lastAtOrBefore(index.stretches, t, fromOf)

  return found >= 0 && t <= index.stretches[found].to ? found : -1
}

/** The stretch `t` falls in or, in a gap, the one after it (the count of stretches after the last). */
export function sceneStretchAt(index: RoomReplayIndex, t: number): number {
  const inside = stretchAt(index, t)

  return inside >= 0 ? inside : lastAtOrBefore(index.stretches, t, fromOf) + 1
}

/** The last entry the Room had seen at `t`, or -1 in a gap: the replayed state changes only when this does. */
export function positionAt(index: RoomReplayIndex, t: number): number {
  const stretch = stretchAt(index, t)

  return stretch < 0 ? -1 : Math.min(lastAtOrBefore(index.times, t, timeOf), index.stretches[stretch].last)
}

/** Every agent the Room showed after the entry at `position`, by its logged id. */
export function viewsAt(index: RoomReplayIndex, position: number): RoomReplayViews {
  const stretch = position >= 0 ? index.stretches[index.owner[position]] : undefined

  if (!stretch) {
    return NO_VIEWS
  }

  const found = lastAtOrBefore(index.keyframes, position, indexOf)
  const keyframe = found >= 0 && index.keyframes[found].index >= stretch.first ? index.keyframes[found] : null
  const views = new Map(keyframe?.views)

  for (let at = keyframe ? keyframe.index + 1 : stretch.first; at <= position; at++) {
    apply(views, index.entries[at])
  }

  return views
}

/** The gap `t` falls in, or null inside a stretch. */
export function gapAt(index: RoomReplayIndex, t: number): RoomReplayGap | null {
  if (stretchAt(index, t) >= 0) {
    return null
  }

  const before = lastAtOrBefore(index.stretches, t, fromOf)
  const previous = index.stretches[before] ?? null
  const next = index.stretches[before + 1] ?? null

  return { from: previous?.to ?? null, to: next?.from ?? null, after: previous?.closed === 'cap' ? 'cap' : null }
}

/** Where the stretch before `t` starts (the one `t` is in, once past its start), or null. */
export function stretchStartBefore(index: RoomReplayIndex, t: number): number | null {
  const found = lastAtOrBefore(index.stretches, t, fromOf)
  const stretch = index.stretches[found]

  if (!stretch) {
    return null
  }

  return stretch.from < t ? stretch.from : (index.stretches[found - 1]?.from ?? null)
}

/** Where the next stretch after `t` starts, or null. */
export function stretchStartAfter(index: RoomReplayIndex, t: number): number | null {
  return index.stretches[lastAtOrBefore(index.stretches, t, fromOf) + 1]?.from ?? null
}

/** The hand-offs logged in (after, upTo], with their entries' indices. */
export function handoffsIn(index: RoomReplayIndex, after: number, upTo: number): { index: number; entry: RoomLogHandoff }[] {
  const found: { index: number; entry: RoomLogHandoff }[] = []

  for (let at = lastAtOrBefore(index.times, after, timeOf) + 1; at < index.entries.length && index.times[at] <= upTo; at++) {
    const entry = index.entries[at]

    if (entry.k === 'handoff' && index.owner[at] >= 0) {
      found.push({ index: at, entry })
    }
  }

  return found
}

/*
 * The replayed agents are RoomAgent records the scene can draw and nothing in Herald can act on:
 * their ids carry an `r:` prefix the live Room never uses, they name no session, and a wait shows as
 * an approval with no request behind it.
 */

export const replayId = (id: string): string => `r:${id}`

const NO_PARAMS: RoomApproval['params'] = { description: null, command: null, tool_name: null, choices: null, allow_permanent: null, allow_session: null }

const VIEW_FIELDS = ['kind', 'phase', 'area', 'step', 'target', 'wait', 'parent', 'where', 'outcome'] as const

const sameView = (a: RoomLogAgent, b: RoomLogAgent): boolean => a === b || VIEW_FIELDS.every(field => a[field] === b[field])

/** The view each replayed agent was made from. */
const sources = new WeakMap<RoomAgent, RoomLogAgent>()

function resultOf(view: RoomLogAgent, at: number): RoomResult | null {
  if (view.kind !== 'helper' || view.outcome === null || view.outcome === 'ok') {
    return null
  }

  return { status: view.outcome, summary: null, durationSeconds: null, filesRead: null, filesWritten: null, inputTokens: null, outputTokens: null, reasoningTokens: null, apiCalls: null, costUsd: null, at }
}

/** A logged view as a record the scene draws; `at` is the wall-clock time it is first shown. */
export function replayAgent(view: RoomLogAgent, at: number): RoomAgent {
  const agent: RoomAgent = {
    id: replayId(view.id),
    kind: view.kind,
    sessionId: '',
    sessionKey: null,
    title: '',
    parentId: view.parent === null ? null : replayId(view.parent),
    phase: view.phase,
    area: view.area,
    target: view.target,
    step: view.step,
    tool: null,
    startedAt: null,
    turnStartedAt: null,
    lastEventAt: at,
    approval: view.wait ? { requestId: `replay:${view.id}`, rpcId: null, sessionId: '', params: { ...NO_PARAMS } } : null,
    asking: null,
    repeat: null,
    guardrail: null,
    result: resultOf(view, at),
    toolCount: null,
    desk: null,
    automation:
      view.kind === 'automation'
        ? { jobId: '', profile: null, paused: false, running: view.phase === 'tool', runStartedAt: null, lastRunAt: null, lastOutcome: view.outcome === 'failed' ? 'failed' : view.outcome === 'ok' ? 'ok' : null }
        : null,
    elsewhere: view.kind === 'elsewhere' ? { where: view.where ?? '', active: true, lastActiveAt: null, approval: false, liveAt: null } : null,
    usage: null,
    trace: {}
  }
  sources.set(agent, view)

  return agent
}

export interface ReplayCast {
  /** By logged id. */
  byId: ReadonlyMap<string, RoomAgent>
  list: readonly RoomAgent[]
}

export const NO_CAST: ReplayCast = { byId: new Map(), list: [] }

/** The agents for `views`: an agent whose view did not change stays the same object, and with nothing changed `previous` comes back as it was. */
export function replayAgents(views: RoomReplayViews, previous: ReplayCast, at: number): ReplayCast {
  const byId = new Map<string, RoomAgent>()
  let same = views.size === previous.byId.size

  for (const [id, view] of views) {
    const before = previous.byId.get(id)
    const source = before ? sources.get(before) : undefined
    const kept = before && source && sameView(source, view) ? before : null
    same &&= kept !== null
    byId.set(id, kept ?? replayAgent(view, at))
  }

  return same ? previous : { byId, list: [...byId.values()] }
}

/** A logged hand-off as the scene plays it, `at` being the wall-clock time it is played. */
export function replayHandoff(index: number, entry: RoomLogHandoff, at: number): RoomHandoff {
  return { id: `r:#${String(index).padStart(7, '0')}`, kind: entry.kind, from: replayId(entry.from), to: replayId(entry.to), at, trace: { source: 'frame', type: 'replay', at } }
}

const HELPER_ENDS: Record<RoomResult['status'], string> = {
  completed: 'done',
  failed: 'could not finish',
  error: 'could not finish',
  timeout: 'ran out of time',
  interrupted: 'was stopped'
}

/** What a replayed agent's name tag says, in fixed words only: the live facts rest on records a replay does not have. */
export function replayFacts(agent: RoomAgent): RoomFact[] {
  const facts: RoomFact[] = []

  if (agent.elsewhere?.where) {
    facts.push({ kind: 'activity', text: agent.elsewhere.where, trace: null })
  }

  if (agent.approval) {
    facts.push({ kind: 'waiting', text: 'waited for your OK', trace: null })
  }

  if (agent.kind === 'helper' && agent.result) {
    facts.push({ kind: 'result', text: HELPER_ENDS[agent.result.status], trace: null })
  }

  if (agent.automation?.running) {
    facts.push({ kind: 'running', text: 'running', trace: null })
  } else if (agent.automation?.lastOutcome) {
    facts.push({ kind: 'lastRun', text: agent.automation.lastOutcome === 'failed' ? 'failed' : 'ran', trace: null })
  }

  return facts
}
