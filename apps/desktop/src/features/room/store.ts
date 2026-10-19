import { type ApprovalChoice, type GatewayEvent, JSON_RPC_METHOD_NOT_FOUND, type ServerRequest, type SessionEventsSinceResult } from '@herald-os/client'
import { atom } from 'nanostores'
import { useEffect } from 'react'
import { liveOutside, type RoomActivity, type RoomPrefs } from '../../../shared/room.ts'
import { approvalFacts } from '../../lib/approval-choices.ts'
import { rest } from '../../lib/rest.ts'
import { eventRuleFor } from '../../store/automations.ts'
import { $activeChatId, $chats, openStoredSession } from '../../store/chat.ts'
import { $connection, $connectionEpoch, $gatewayReady, gatewayRequest, isGatewayOpen, onAnyGatewayEvent, onServerRequest } from '../../store/gateway.ts'
import { runCommand } from '../../store/os-commands.ts'
import { $pendingRequests, type PendingRequest } from '../../store/requests.ts'
import { $sessions } from '../../store/sessions.ts'
import { isMainSurface, isPanels, openSurface, relayToMain } from '../../store/shell.ts'
import { showPage } from '../../store/windows.ts'
import { cronApi } from '../automations/api.ts'
import { answerApproval } from '../pet/brain.ts'
import { roomBridge } from './bridge.ts'
import { watchRoomCommands } from './commands.ts'
import { cronJobSignature, type RoomCronJob, type RoomCronRun, roomCronJob, roomCronRun } from './model/automations.ts'
import { roomCostRow } from './model/costs.ts'
import { roomDesks } from './model/desks.ts'
import { ELSEWHERE_LIMIT, elsewhereRows, HERALD_SOURCES, NOT_ELSEWHERE, roomElsewhereRow } from './model/elsewhere.ts'
import { approvalOf, roomFrame, roomHelperRecord, roomRequest, roomSessionMeta, roomSessionRow } from './model/frames.ts'
import { createRoomLogger } from './model/log.ts'
import { unlisted } from './model/outside.ts'
import { EMPTY_ROOM, nextPruneAt, reduceRoom, type RoomInput } from './model/reducer.ts'
import { earliestDue, emptyClock, ROOM_TIMING, type RoomClock, roomDue, turnEnded } from './model/schedule.ts'
import type { RoomApproval, RoomCaps, RoomState } from './model/types.ts'
import { $roomPrefs } from './prefs.ts'

/*
 * The Room's feed: Hermes's records and frames, read on the schedule in model/schedule.ts while
 * something shows the Room, folded by model/reducer.ts into `$room`. It only ever asks Hermes for
 * session.active_list, session.events.since, delegation.status and config.get, Herald's automations
 * and their latest runs (the Automations page's routes), only while the person has the lane on the
 * session database's list for work elsewhere, and only while cost meters are on the database's
 * rows for Herald's own sessions; it reads the documents Herald's own Office and Canvas windows
 * have open and the commands agents ran there and, only while the person has live detail on, the
 * activity main relays from Herald's bridge plugin in Hermes outside Herald. It never calls the
 * `session.usage` method, which fetches account usage over the network. It answers an approval
 * (approval.respond, or this window's own card) only when the person picks an answer. While the
 * person keeps the activity log, the Hermes window feeds the Room even with nothing showing it and
 * hands what changes to main (model/log.ts).
 */

export { EMPTY_ROOM }

/** A first read of a session takes at most this many of its latest frames. */
const TAIL = 200
/** How many of Herald's own sessions one cost read asks for, most recently active first. */
const COSTS_LIMIT = 40
/** Live frames are folded in together, at most this often. */
const LIVE_BATCH_MS = 150
const MIN_WAKE_MS = 50
const TOOL_PROGRESS = new Set(['all', 'new', 'verbose', 'off'])

/** Every live piece of Hermes work in Herald's backend, as the Room shows it. */
export const $room = atom<RoomState>(EMPTY_ROOM)

let retains = 0
/** The Hermes window keeps the activity log: the Room is fed then with nothing showing it, and while the window is hidden. */
let logging = false
/** The log has begun and not ended: it begins once the Room is fed and ends whenever it is not. */
let logOpen = false
const roomLog = createRoomLogger({ send: entries => roomBridge()?.appendLog(entries) })
let clock: RoomClock = emptyClock()
/** Bumped on every reset: answers to requests sent before it are dropped. */
let generation = 0
let helpersInitial = true
let connectionEpoch: number | null = null
const inflight = { list: false, helpers: false, config: false, sessions: new Set<string>(), automations: false, elsewhere: false, costs: false, desks: false }
/** Each job's record as last read: a job whose record moves has its latest run read again. */
const jobSignatures = new Map<string, string>()
/** Sessions the Room is reading now: their open requests come back re-delivered. */
const reading = new Set<string>()
/** Sessions whose frames reach this window live, and so their requests too. */
const liveHere = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null
let batch: RoomInput[] = []
let batchTimer: ReturnType<typeof setTimeout> | null = null
let unbindFeed: (() => void) | null = null
let unguard: (() => void) | null = null
/** Live activity from Hermes outside Herald, while the Room is fed and the person has live detail on. */
let unwatchActivity: (() => void) | null = null
/** The Room switches as the feed last saw them: they can change while nothing shows the Room. */
let prefsSeen: RoomPrefs | null = null

function heldHere(sessionId: string): boolean {
  return Boolean($chats.get()[sessionId]) || liveHere.has(sessionId)
}

function isRoomReplay(request: ServerRequest): boolean {
  const sessionId = request.params.session_id

  return Boolean(request.replayed) && typeof sessionId === 'string' && reading.has(sessionId) && !heldHere(sessionId)
}

/**
 * A read of a session's buffer answers with the requests still open on it, and the channel
 * re-delivers them to this window's handlers as if they had just arrived. For a session another
 * window holds they are not this window's: Herald's handlers would raise them here (or decline
 * them on the owner's behalf), so they stop here. Bound on import, ahead of `bindServerRequests`,
 * because handlers are tried in the order they were bound.
 */
export function guardRoomReads(): () => void {
  unguard ??= onServerRequest(isRoomReplay)

  return () => {
    unguard?.()
    unguard = null
  }
}

guardRoomReads()

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

function feeding(): boolean {
  return ((retains > 0 && visible()) || logging) && isGatewayOpen()
}

/** Cost meters on a tag or in the header: only then are costs read. */
const metersOn = (prefs: Pick<RoomPrefs, 'costs' | 'costTotal'> = $roomPrefs.get()): boolean => prefs.costs || prefs.costTotal

/** New work outside Herald that live detail brought in and the lane has not listed. */
function newlyUnlisted(before: RoomState, after: RoomState): boolean {
  return Object.values(after.agents).some(agent => unlisted(agent) && !(before.agents[agent.id] && unlisted(before.agents[agent.id])))
}

/** A turn that ended has just changed its conversation's cost; work the lane has not listed wants the lane read soon. */
function wantSoon(before: RoomState, after: RoomState): void {
  const now = Date.now()

  if (metersOn() && turnEnded(before, after)) {
    clock.costsWanted ??= now + ROOM_TIMING.costsSoonMs
  }

  if ($roomPrefs.get().elsewhere && newlyUnlisted(before, after)) {
    clock.elsewhereWanted ??= now + ROOM_TIMING.elsewhereSoonMs
  }
}

function restartRound(): void {
  generation += 1
  clock = emptyClock()
  helpersInitial = true
  liveHere.clear()
  jobSignatures.clear()
  batch = []
}

function commit(next: RoomState): void {
  const current = $room.get()

  if (next === current) {
    return
  }

  if (current.epoch !== null && next.epoch !== current.epoch) {
    restartRound()
  }

  $room.set(next)
  wantSoon(current, next)

  if (logOpen) {
    roomLog.update(next, Date.now())
  }
}

function dispatch(input: RoomInput): void {
  commit(reduceRoom($room.get(), input))
}

function reset(): void {
  restartRound()
  $room.set(reduceRoom($room.get(), { type: 'reset', epoch: null, at: Date.now() }))

  if (logOpen) {
    roomLog.update($room.get(), Date.now())
  }
}

/** The log runs exactly while the Hermes window keeps it and the Room is fed; a gap in between is honest. */
function syncLog(): void {
  const wanted = logging && feeding()

  if (wanted && !logOpen) {
    logOpen = true
    roomLog.start($room.get(), Date.now())
  } else if (!wanted && logOpen) {
    logOpen = false
    roomLog.stop(Date.now())
  }
}

/** A new connection (a reconnect, or a restarted backend) starts the Room over. */
function syncConnection(): void {
  const epoch = $connectionEpoch.get()

  if (connectionEpoch !== null && epoch !== connectionEpoch) {
    reset()
  }

  connectionEpoch = epoch
}

function rowsOf<T>(list: unknown, read: (raw: unknown) => T | null): T[] {
  return (Array.isArray(list) ? list : []).map(read).filter((row): row is T => row !== null)
}

function missingMethod(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === JSON_RPC_METHOD_NOT_FOUND)
}

/** A route this Hermes does not serve: `GET /api/… -> 404`, as Electron main words it. */
function missingRoute(error: unknown): boolean {
  return / -> 404\b/.test(error instanceof Error ? error.message : String(error))
}

/** A Hermes without the method or route: that part of the Room goes without it from now on. */
function fallBack(error: unknown, cap: keyof RoomCaps): void {
  if (missingMethod(error) || missingRoute(error)) {
    dispatch({ type: 'caps', caps: { [cap]: false }, at: Date.now() })
  }
}

function localApprovals(pending: readonly PendingRequest[]): RoomApproval[] {
  return pending.flatMap(entry => {
    const approval = entry.kind === 'approval' ? approvalOf(entry.request.id, entry.request.params) : null

    return approval ? [approval] : []
  })
}

/** Sessions this window holds a request for: their own channel keeps those, and a read now could bring back one just answered. */
function pausedSessions(): Set<string> {
  const paused = new Set<string>()

  for (const entry of $pendingRequests.get()) {
    const sessionId = entry.request.params.session_id

    if (typeof sessionId === 'string' && heldHere(sessionId)) {
      paused.add(sessionId)
    }
  }

  return paused
}

async function readList(): Promise<void> {
  const round = generation
  const sentAt = Date.now()

  inflight.list = true
  clock.listAt = sentAt
  clock.changedAt = null

  try {
    const result = await gatewayRequest('session.active_list', {})

    if (round === generation) {
      dispatch({ type: 'active_list', rows: rowsOf(result?.sessions, roomSessionRow), sentAt, at: Date.now() })
    }
  } catch (error) {
    if (round === generation) {
      fallBack(error, 'activeList')
    }
  } finally {
    inflight.list = false

    if (round === generation) {
      clock.listed = true
    }

    plan()
  }
}

async function readHelpers(): Promise<void> {
  const round = generation
  const sentAt = Date.now()

  inflight.helpers = true
  clock.helpersAt = sentAt

  try {
    const result = await gatewayRequest('delegation.status', {})

    if (round === generation) {
      dispatch({ type: 'delegation', records: rowsOf(result?.active, roomHelperRecord), initial: helpersInitial, sentAt, at: Date.now() })
      helpersInitial = false
    }
  } catch (error) {
    if (round === generation) {
      fallBack(error, 'delegation')
    }
  } finally {
    inflight.helpers = false
    plan()
  }
}

async function readConfig(): Promise<void> {
  const round = generation

  inflight.config = true
  clock.configAt = Date.now()

  try {
    const result = await gatewayRequest('config.get', { key: 'focus' })
    const value = result?.tool_progress ?? null

    if (round === generation) {
      dispatch({ type: 'config', toolProgress: value && TOOL_PROGRESS.has(value) ? (value as RoomState['toolProgress']) : null, at: Date.now() })
    }
  } catch (error) {
    if (round === generation) {
      fallBack(error, 'config')
    }
  } finally {
    inflight.config = false
    plan()
  }
}

function eventsInput(sessionId: string, result: Partial<SessionEventsSinceResult> | null | undefined, backfill: boolean, sentAt: number): RoomInput {
  const latest = result?.latest_seq

  return {
    type: 'events',
    sessionId,
    epoch: typeof result?.epoch === 'string' && result.epoch ? result.epoch : null,
    latestSeq: typeof latest === 'number' && Number.isFinite(latest) ? latest : 0,
    truncated: result?.truncated === true,
    frames: rowsOf(result?.events, roomFrame),
    requests: Array.isArray(result?.open_requests) ? rowsOf(result.open_requests, roomRequest) : null,
    backfill,
    sentAt,
    at: Date.now()
  }
}

async function readSession(sessionId: string): Promise<void> {
  const round = generation

  inflight.sessions.add(sessionId)
  reading.add(sessionId)
  clock.polledAt[sessionId] = Date.now()

  try {
    let lastSeen = $room.get().seen[sessionId]
    const backfill = lastSeen === undefined
    let sentAt = Date.now()

    if (lastSeen === undefined) {
      // The latest seq first, so a first read takes the tail of the buffer and never all of it.
      const probe = await gatewayRequest('session.events.since', { session_id: sessionId, last_seen: Number.MAX_SAFE_INTEGER })

      if (!probe?.latest_seq) {
        if (round === generation) {
          dispatch(eventsInput(sessionId, probe, true, sentAt))
        }

        return
      }

      lastSeen = Math.max(0, probe.latest_seq - TAIL)
      sentAt = Date.now()
    }

    const result = await gatewayRequest('session.events.since', { session_id: sessionId, last_seen: lastSeen })

    if (round === generation) {
      dispatch(eventsInput(sessionId, result, backfill, sentAt))
    }
  } catch (error) {
    if (round === generation) {
      fallBack(error, 'eventsSince')
    }
  } finally {
    inflight.sessions.delete(sessionId)
    reading.delete(sessionId)
    plan()
  }
}

/** A job as the Room shows it; one that runs when something happens is paused by design, so it does not count as paused. */
function jobOf(raw: unknown): RoomCronJob | null {
  const job = roomCronJob(raw)

  return job && job.paused && eventRuleFor(job.id) ? { ...job, paused: false } : job
}

/**
 * The job list, then the latest run of each job whose record moved or whose run is due; after
 * `cron.changed` (`all`), of every job, as a run can start without its job's record showing it.
 */
async function readAutomations(dueRuns: readonly string[], all = false): Promise<void> {
  const round = generation
  const sentAt = Date.now()

  inflight.automations = true
  clock.jobsAt = sentAt
  clock.jobsChangedAt = null

  try {
    const jobs = rowsOf(await cronApi.list(), jobOf)

    if (round !== generation) {
      return
    }

    const moved = jobs.filter(job => jobSignatures.get(job.key) !== cronJobSignature(job)).map(job => job.key)
    const reading = jobs.filter(job => all || moved.includes(job.key) || dueRuns.includes(job.key))
    const runs: Record<string, RoomCronRun | null> = {}

    await Promise.all(
      reading.map(async job => {
        try {
          runs[job.key] = rowsOf(await cronApi.runs(job, 1), roomCronRun)[0] ?? null
          clock.runsAt[job.key] = Date.now()
        } catch {
          // The next round reads it again.
        }
      })
    )

    if (round !== generation) {
      return
    }

    for (const job of jobs) {
      if (moved.includes(job.key) || (all && job.key in runs && !runs[job.key]?.active)) {
        // A run's session starts a moment after the scheduler claims it: read once more, soon.
        clock.runsWanted[job.key] = Date.now() + ROOM_TIMING.runsRecheckMs
      } else if (job.key in runs) {
        delete clock.runsWanted[job.key]
      }

      jobSignatures.set(job.key, cronJobSignature(job))
    }

    dispatch({ type: 'automations', jobs, runs, at: Date.now() })
  } catch (error) {
    if (round === generation) {
      fallBack(error, 'automations')
    }
  } finally {
    inflight.automations = false
    plan()
  }
}

/** The elsewhere lane, only while the person has it on: Hermes's session list, cut down and filtered; each row's counts only with cost meters on. */
async function readElsewhere(): Promise<void> {
  const round = generation

  inflight.elsewhere = true
  clock.elsewhereAt = Date.now()
  clock.elsewhereWanted = null

  try {
    const result = await rest.get<{ sessions?: unknown[] }>('/api/sessions', { limit: ELSEWHERE_LIMIT, order: 'recent', exclude_sources: NOT_ELSEWHERE.join(',') })

    if (round !== generation || !$roomPrefs.get().elsewhere) {
      return
    }

    const agents = Object.values($room.get().agents)
    const sessionKeys = new Set(agents.flatMap(agent => (agent.id.startsWith('s:') && agent.sessionKey ? [agent.sessionKey] : [])))
    const jobIds = new Set(agents.flatMap(agent => (agent.automation ? [agent.automation.jobId] : [])))
    const counts = metersOn()
    const rows = elsewhereRows(rowsOf(result?.sessions, raw => roomElsewhereRow(raw, counts)), { sessionKeys, jobIds }, Date.now())

    dispatch({ type: 'elsewhere', rows, at: Date.now() })
  } catch (error) {
    if (round === generation) {
      fallBack(error, 'sessionsDb')
    }
  } finally {
    inflight.elsewhere = false
    plan()
  }
}

/** Herald's own sessions' token counts and cost from the session database, only while cost meters are on. */
async function readCosts(): Promise<void> {
  const round = generation

  inflight.costs = true
  clock.costsAt = Date.now()
  clock.costsWanted = null

  try {
    const result = await rest.get<{ sessions?: unknown[] }>('/api/sessions', { limit: COSTS_LIMIT, order: 'recent', sources: HERALD_SOURCES.join(',') })

    if (round === generation && metersOn()) {
      dispatch({ type: 'costs', rows: rowsOf(result?.sessions, roomCostRow), at: Date.now() })
    }
  } catch (error) {
    if (round === generation) {
      fallBack(error, 'sessionsDb')
    }
  } finally {
    inflight.costs = false
    plan()
  }
}

/** What a window reports, or nothing when it cannot say. */
const presenceOf = (read: () => Promise<unknown[]>): Promise<unknown[]> =>
  Promise.resolve()
    .then(read)
    .catch(() => [])

/** The documents Herald's Office and Canvas windows have open, by name. */
async function readDesks(): Promise<void> {
  inflight.desks = true
  clock.desksAt = Date.now()

  try {
    const [office, canvas] = await Promise.all([presenceOf(() => window.heraldOS.office.presence()), presenceOf(() => window.heraldOS.canvas.presence())])

    dispatch({ type: 'desks', desks: roomDesks(office, canvas), at: Date.now() })
  } finally {
    inflight.desks = false
    plan()
  }
}

function flushLive(): void {
  batchTimer = null

  const inputs = batch
  batch = []

  commit(inputs.reduce(reduceRoom, $room.get()))
  plan()
}

function onLive(event: GatewayEvent): void {
  if (event.type === 'sessions.changed') {
    clock.changedAt = Date.now()
    plan()

    return
  }

  if (event.type === 'cron.changed') {
    clock.jobsChangedAt = Date.now()
    plan()

    return
  }

  const frame = roomFrame(event)

  if (!frame) {
    return
  }

  const at = Date.now()

  liveHere.add(frame.sessionId)
  clock.liveAt[frame.sessionId] = at
  batch.push({ type: 'live', epoch: event.replayEpoch ?? $gatewayReady.get()?.replay_epoch ?? null, frame, at })
  batchTimer ??= setTimeout(flushLive, LIVE_BATCH_MS)
}

function onActivity(events: RoomActivity[]): void {
  if (!events.length || !liveOutside($roomPrefs.get())) {
    return
  }

  batch.push({ type: 'outside', events, at: Date.now() })
  batchTimer ??= setTimeout(flushLive, LIVE_BATCH_MS)
}

/** Activity already batched would bring back what turning live detail or the lane off took away. */
function dropBatchedActivity(): void {
  batch = batch.filter(input => input.type !== 'outside')
}

/** Watch live activity while the Room is fed and both switches are on; main replays the last minutes on each subscribe. */
function syncActivity(): void {
  const wanted = feeding() && liveOutside($roomPrefs.get())

  if (wanted && !unwatchActivity) {
    unwatchActivity = roomBridge()?.watchActivity(onActivity) ?? null
  } else if (!wanted && unwatchActivity) {
    unwatchActivity()
    unwatchActivity = null
  }
}

const dueOptions = () => ({ elsewhere: $roomPrefs.get().elsewhere, costs: metersOn() })

function runDue(now: number): void {
  const prune = nextPruneAt($room.get())

  if (prune !== null && prune <= now) {
    dispatch({ type: 'tick', now })
  }

  const due = roomDue($room.get(), clock, pausedSessions(), dueOptions())
  const dueRuns = Object.entries(due.runs).flatMap(([key, at]) => (at <= now ? [key] : []))

  if (!inflight.list && due.activeList <= now) {
    void readList()
  }

  if (!inflight.automations && (due.automations <= now || dueRuns.length > 0)) {
    void readAutomations(dueRuns, clock.jobsChangedAt !== null && clock.jobsChangedAt + ROOM_TIMING.jobsChangedMs <= now)
  }

  if (!inflight.elsewhere && due.elsewhere <= now) {
    void readElsewhere()
  }

  if (!inflight.costs && due.costs <= now) {
    void readCosts()
  }

  if (!inflight.desks && due.desks <= now) {
    void readDesks()
  }

  if (!inflight.helpers && due.delegation <= now) {
    void readHelpers()
  }

  if (!inflight.config && due.config <= now) {
    void readConfig()
  }

  for (const [sessionId, at] of Object.entries(due.sessions)) {
    if (!inflight.sessions.has(sessionId) && at <= now) {
      void readSession(sessionId)
    }
  }
}

/** Run what is due, then sleep until the next thing is. */
function plan(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }

  syncActivity()
  syncLog()

  if (!feeding()) {
    return
  }

  const now = Date.now()
  runDue(now)

  const state = $room.get()
  const wake = Math.min(earliestDue(roomDue(state, clock, pausedSessions(), dueOptions()), inflight), nextPruneAt(state) ?? Infinity)

  if (Number.isFinite(wake)) {
    timer = setTimeout(plan, Math.max(MIN_WAKE_MS, wake - now))
  }
}

function watchVisibility(): () => void {
  if (typeof document === 'undefined') {
    return () => undefined
  }

  const onChange = () => plan()
  document.addEventListener('visibilitychange', onChange)

  return () => document.removeEventListener('visibilitychange', onChange)
}

/** What the person's Room switches change for the feed: live detail and the lane going away, and cost meters wanting their reads now. */
function onPrefs(before: RoomPrefs, prefs: RoomPrefs): void {
  const state = $room.get()
  const lane = state.elsewhereOn === true || Object.values(state.agents).some(agent => agent.kind === 'elsewhere')

  if (liveOutside(before) && !liveOutside(prefs)) {
    dropBatchedActivity()
    dispatch({ type: 'outside_off', at: Date.now() })
  }

  if (lane && !prefs.elsewhere) {
    dispatch({ type: 'elsewhere', rows: null, at: Date.now() })
  } else if (!lane && prefs.elsewhere) {
    clock.elsewhereAt = null
  }

  if (!metersOn(before) && metersOn(prefs)) {
    clock.costsAt = null

    if (prefs.elsewhere) {
      clock.elsewhereWanted = Date.now()
    }
  }
}

function seePrefs(prefs: RoomPrefs): void {
  onPrefs(prefsSeen ?? prefs, prefs)
  prefsSeen = prefs
}

function start(): void {
  syncConnection()
  seePrefs($roomPrefs.get())

  const offs = [
    onAnyGatewayEvent(onLive),
    $pendingRequests.subscribe(pending => {
      dispatch({ type: 'local_requests', approvals: localApprovals(pending), at: Date.now() })
      plan()
    }),
    $sessions.subscribe(rows => dispatch({ type: 'session_meta', rows: rowsOf(rows, roomSessionMeta), at: Date.now() })),
    watchRoomCommands(commands => dispatch({ type: 'commands', commands, at: Date.now() })),
    $roomPrefs.listen(prefs => {
      seePrefs(prefs)
      plan()
    }),
    $connectionEpoch.listen(() => {
      syncConnection()
      plan()
    }),
    $connection.listen(() => plan()),
    watchVisibility()
  ]

  unbindFeed = () => {
    for (const off of offs) {
      off()
    }
  }

  plan()
}

function stop(): void {
  unbindFeed?.()
  unbindFeed = null
  unwatchActivity?.()
  unwatchActivity = null

  for (const pending of [timer, batchTimer]) {
    if (pending) {
      clearTimeout(pending)
    }
  }

  timer = null
  batchTimer = null
  batch = []
  liveHere.clear()
  syncLog()
}

/** Feed the Room while something shows it or the log is kept, and not otherwise. */
function follow(): void {
  if ((retains > 0 || logging) && !unbindFeed) {
    start()
  } else if (retains === 0 && !logging && unbindFeed) {
    stop()
  }
}

/** Keep the Room fed (polling and live frames) while something shows it; returns the release. */
export function retainRoom(): () => void {
  retains += 1
  follow()

  let released = false

  return () => {
    if (released) {
      return
    }

    released = true
    retains -= 1
    follow()
  }
}

/**
 * The Hermes window keeps the activity log while the person has it on (Settings > Pet Room): the
 * Room is fed then even with nothing showing it, at its usual pace, and what it shows goes to main.
 */
export function bindRoomLog(): () => void {
  if (!isMainSurface) {
    return () => undefined
  }

  const keep = (on: boolean) => {
    if (on !== logging) {
      logging = on
      follow()
      plan()
    }
  }
  const leave = () => {
    if (logOpen) {
      logOpen = false
      roomLog.stop(Date.now())
    }
  }

  keep($roomPrefs.get().log)
  const off = $roomPrefs.listen(prefs => keep(prefs.log))
  window.addEventListener('pagehide', leave)

  return () => {
    off()
    window.removeEventListener('pagehide', leave)
    keep(false)
  }
}

/** After the log was deleted: begin it again with what the Room shows now, so the new file starts whole. */
export function restartRoomLog(): void {
  if (logOpen) {
    roomLog.start($room.get(), Date.now())
  }
}

/** React: keep the Room fed while the component is mounted and `active` (false while its window is minimized). */
export function useRoomFeed(active = true): void {
  useEffect(() => (active ? retainRoom() : undefined), [active])
}

/** One look at Hermes now, for `room.status` when the Room is not open. */
export async function refreshRoomOnce(): Promise<RoomState> {
  if (!isGatewayOpen()) {
    return $room.get()
  }

  syncConnection()

  if (feeding()) {
    return $room.get()
  }

  if ($room.get().caps.activeList && !inflight.list) {
    await readList()
  }

  const state = $room.get()
  const paused = pausedSessions()
  const reads: Promise<void>[] = []

  if (state.caps.delegation && !inflight.helpers) {
    reads.push(readHelpers())
  }

  if (state.caps.automations && !inflight.automations) {
    reads.push(readAutomations([]))
  }

  if ($roomPrefs.get().elsewhere && state.caps.sessionsDb && !inflight.elsewhere) {
    reads.push(readElsewhere())
  }

  if (state.caps.eventsSince) {
    for (const agent of Object.values(state.agents)) {
      if (agent.id.startsWith('s:') && agent.sessionId && !inflight.sessions.has(agent.sessionId) && !paused.has(agent.sessionId)) {
        reads.push(readSession(agent.sessionId))
      }
    }
  }

  await Promise.all(reads)
  dispatch({ type: 'tick', now: Date.now() })

  return $room.get()
}

/** Answer the plain approval an agent holds up, through Herald's own approval flow; false when it is not pending. */
export async function answerRoomApproval(agentId: string, choice: ApprovalChoice): Promise<boolean> {
  const approval = $room.get().agents[agentId]?.approval

  if (!approval || !approvalFacts(approval.params).choices.includes(choice)) {
    return false
  }

  const held = $pendingRequests
    .get()
    .find(entry => entry.kind === 'approval' && (entry.request.id === approval.rpcId || entry.request.id === approval.requestId || entry.request.params.request_id === approval.requestId))

  dispatch({ type: 'answered', requestId: approval.requestId, at: Date.now() })

  if (held) {
    if (answerApproval(held.request.id, choice)) {
      return true
    }

    dispatch({ type: 'answer_failed', requestId: approval.requestId, at: Date.now() })
    dispatch({ type: 'local_requests', approvals: localApprovals($pendingRequests.get()), at: Date.now() })

    return false
  }

  try {
    const result = await gatewayRequest('approval.respond', { session_id: approval.sessionId, request_id: approval.requestId, choice })

    return (result?.resolved ?? 0) > 0
  } catch {
    dispatch({ type: 'answer_failed', requestId: approval.requestId, at: Date.now() })

    return false
  }
}

/** Automations, focused on the job, in the Hermes window (its own window in panels mode). */
function showAutomation(name: string): void {
  if (isMainSurface) {
    void runCommand('automation.show', { name }, { source: 'ui' })

    return
  }

  relayToMain({ type: 'os', args: ['automation.show'], payload: { name } })
  openSurface('main')
}

/**
 * Open the agent's conversation in Hermes (a helper opens its parent's), or an automation's job.
 * Work elsewhere opens nothing: it belongs to another Hermes process.
 */
export function openRoomAgent(agentId: string): void {
  const agent = $room.get().agents[agentId]

  if (!agent || agent.kind === 'elsewhere') {
    return
  }

  if (agent.kind === 'automation') {
    showAutomation(agent.title)

    return
  }

  const { sessionId, sessionKey } = agent

  if (isPanels) {
    openSurface('main', sessionKey ? { type: 'open-session', args: [sessionKey] } : undefined)

    return
  }

  const chats = $chats.get()
  const chat = chats[sessionId] ?? (sessionKey ? Object.values(chats).find(entry => entry.storedSessionId === sessionKey) : undefined)

  if (chat) {
    $activeChatId.set(chat.sessionId)
  } else if (sessionKey) {
    void openStoredSession(sessionKey).catch(() => undefined)
  }

  showPage('hermes')
}
