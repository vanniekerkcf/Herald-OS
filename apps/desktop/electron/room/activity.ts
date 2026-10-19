import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../../shared/ipc.ts'
import { liveOutside, ROOM_ACTIVITY_BATCH, type RoomActivity, roomActivityOf, type RoomPrefs } from '../../shared/room.ts'
import { log } from '../log.ts'

/*
 * Live activity from Hermes outside Herald (shared/room.ts). Herald's bridge plugin, loaded in every
 * Hermes process, finds each running Herald through its control file, `observe/<pid>.json` in
 * Herald's data folder, and sends `activity` requests over the socket that file names. The file
 * names the socket and a token only while the person has live detail on; the token lets a process
 * report activity and nothing else.
 */

/** A window that starts watching hears what came in lately: at most RING_MAX events, none older than RING_MS. */
const RING_MAX = 2000
const RING_MS = 10 * 60_000
/** Every Hermes process together, in any second. */
const RATE_EVENTS = 400
const RATE_REQUESTS = 50
const RATE_MS = 1000
/** A control file, and the temporary one it is written as. */
const CONTROL_FILE = /^(\d{1,10})\.json$|^\.(\d{1,10})\.json\.tmp$/

export type ActivityReply = { ok: true; accepted: number } | { ok: false; error: 'invalid activity token' | 'live detail is off' | 'too many events' }

/** A window as the hub sees it: Electron's WebContents, or a stand-in in tests. */
export interface ActivityWatcher {
  readonly id: number
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  send(channel: string, ...args: unknown[]): void
}

export interface ActivityHubOptions {
  /** Herald's own data folder (heraldOsDataDir()). */
  dataDir: string
  /** The control socket main serves, which the control file names. */
  socket: string
  pid?: number
  now?: () => number
  newToken?: () => string
  alive?: (pid: number) => boolean
}

type LivePrefs = Pick<RoomPrefs, 'elsewhere' | 'elsewhereLive'>

const randomToken = (): string => crypto.randomBytes(32).toString('base64url')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class ActivityHub {
  private readonly folder: string
  private readonly file: string
  private readonly temporary: string
  private readonly socket: string
  private readonly pid: number
  private readonly now: () => number
  private readonly newToken: () => string
  private readonly alive: (pid: number) => boolean
  private token: string
  private live = false
  private stopped = false
  private seq = 0
  private ring: RoomActivity[] = []
  /** Requests accepted in the last RATE_MS, oldest first, with how many events each carried. */
  private readonly recent: { at: number; events: number }[] = []
  private recentEvents = 0
  private readonly watchers = new Map<number, ActivityWatcher>()
  /** Windows the hub already hears closing. */
  private readonly hooked = new Set<number>()

  constructor({ dataDir, socket, pid = process.pid, now = Date.now, newToken = randomToken, alive = isAlive }: ActivityHubOptions) {
    this.folder = path.join(dataDir, 'observe')
    this.file = path.join(this.folder, `${pid}.json`)
    // Not `<digits>.json`, so the plugin never reads a file half-written.
    this.temporary = path.join(this.folder, `.${pid}.json.tmp`)
    // The plugin takes only an absolute path, and runs in another folder.
    this.socket = path.resolve(socket)
    this.pid = pid
    this.now = now
    this.newToken = newToken
    this.alive = alive
    this.token = newToken()
  }

  /** Remove what Heralds that are gone left behind, then follow `room`. */
  start(room: LivePrefs): void {
    this.removeStale()
    this.setPrefs(room)
  }

  /** Follow the Room preferences: live detail on or off, in the control file too. */
  setPrefs(room: LivePrefs): void {
    if (this.stopped) {
      return
    }

    const live = liveOutside(room)

    // A process that read the token while live detail was on must not report with it again.
    if (this.live && !live) {
      this.token = this.newToken()
      this.ring = []
    }

    this.live = live
    this.writeControl()
  }

  /** One `activity` request from a Hermes process. */
  handle(request: Record<string, unknown>): ActivityReply {
    if (!this.knows(request.token)) {
      return { ok: false, error: 'invalid activity token' }
    }

    if (!this.live) {
      return { ok: false, error: 'live detail is off' }
    }

    const now = this.now()
    const raw: unknown[] = Array.isArray(request.events) ? request.events.slice(0, ROOM_ACTIVITY_BATCH) : []

    if (!this.admit(raw.length, now)) {
      return { ok: false, error: 'too many events' }
    }

    const events: RoomActivity[] = []

    for (const entry of raw) {
      const event = roomActivityOf(entry, this.seq + 1, now)

      if (event) {
        this.seq = event.seq
        events.push(event)
      }
    }

    if (events.length > 0) {
      this.ring.push(...events)

      if (this.ring.length > RING_MAX) {
        this.ring.splice(0, this.ring.length - RING_MAX)
      }

      for (const watcher of this.watchers.values()) {
        if (!watcher.isDestroyed()) {
          watcher.send(IPC.roomActivity, events)
        }
      }
    }

    return { ok: true, accepted: events.length }
  }

  /** Start or stop sending live activity to a window; one that starts hears what came in lately at once. */
  watch(watcher: ActivityWatcher, on: boolean): void {
    if (!on) {
      this.watchers.delete(watcher.id)

      return
    }

    if (watcher.isDestroyed()) {
      return
    }

    if (!this.hooked.has(watcher.id)) {
      const id = watcher.id
      this.hooked.add(id)
      watcher.once('destroyed', () => {
        this.hooked.delete(id)
        this.watchers.delete(id)
      })
    }

    this.watchers.set(watcher.id, watcher)

    if (this.live) {
      const since = this.now() - RING_MS
      this.ring = this.ring.filter(event => event.at >= since)

      if (this.ring.length > 0) {
        watcher.send(IPC.roomActivity, [...this.ring])
      }
    }
  }

  /** Herald quits: its control file goes with it. */
  stop(): void {
    this.stopped = true
    this.live = false

    try {
      fs.rmSync(this.file, { force: true })
    } catch (error) {
      log('room', `cannot remove ${this.file}: ${(error as Error).message}`)
    }
  }

  private knows(token: unknown): boolean {
    if (typeof token !== 'string') {
      return false
    }

    const given = Buffer.from(token)
    const expected = Buffer.from(this.token)

    return given.length === expected.length && crypto.timingSafeEqual(given, expected)
  }

  /** Whether a request carrying `events` more keeps every Hermes process together within the rate. */
  private admit(events: number, now: number): boolean {
    // Entries stamped after now are from before the clock was set back.
    while (this.recent.length > 0 && (this.recent[0].at <= now - RATE_MS || this.recent[0].at > now)) {
      this.recentEvents -= this.recent[0].events
      this.recent.shift()
    }

    if (this.recent.length >= RATE_REQUESTS || this.recentEvents + events > RATE_EVENTS) {
      return false
    }

    this.recent.push({ at: now, events })
    this.recentEvents += events

    return true
  }

  private writeControl(): void {
    const control = this.live ? { v: 1, pid: this.pid, live: true, socket: this.socket, token: this.token } : { v: 1, pid: this.pid, live: false }

    try {
      fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 })
      fs.chmodSync(this.folder, 0o700)
      fs.rmSync(this.temporary, { force: true })
      fs.writeFileSync(this.temporary, JSON.stringify(control), { mode: 0o600, flag: 'wx' })
      fs.renameSync(this.temporary, this.file)
    } catch (error) {
      log('room', `cannot write ${this.file}: ${(error as Error).message}`)
    }
  }

  /** Control files of Heralds that are gone: a crash skips `stop`. */
  private removeStale(): void {
    let names: string[]

    try {
      names = fs.readdirSync(this.folder)
    } catch {
      return
    }

    for (const name of names) {
      const match = CONTROL_FILE.exec(name)
      const pid = Number(match?.[1] ?? match?.[2])

      if (pid > 0 && pid !== this.pid && !this.alive(pid)) {
        try {
          fs.rmSync(path.join(this.folder, name), { force: true })
        } catch (error) {
          log('room', `cannot remove ${name}: ${(error as Error).message}`)
        }
      }
    }
  }
}
