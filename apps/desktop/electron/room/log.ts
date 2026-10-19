import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ROOM_LOG_DAY, ROOM_PREFS_DEFAULTS, type RoomLogDay, type RoomLogEntry, roomLogEntryOf, type RoomPrefs } from '../../shared/room.ts'
import { log } from '../log.ts'

/*
 * The Room's activity log (shared/room.ts): a file a local day, `room-log/YYYY-MM-DD.jsonl` in
 * Herald's data folder. A file's first line names its day and a random salt; every agent id in it
 * is written as an HMAC of the id under that salt, cut to a few hex characters, so a day's ids
 * still pair up while Hermes's session ids never reach the disk.
 */

const EXTENSION = '.jsonl'
/** A day's file stays within this: the entry that would pass it is written as `cap`, and nothing after it. */
const DAY_MAX = 8 * 1024 * 1024
/** Room kept within DAY_MAX for the `cap` line. */
const CAP_RESERVE = 64
/** The whole log stays within this; the oldest days go first, never today's. */
const FOLDER_MAX = 64 * 1024 * 1024
/** Entries stamped longer before now, or later after it, are dropped. */
const PAST_MS = 24 * 60 * 60_000
const FUTURE_MS = 60_000
/** Appends look for days to remove at most this often. */
const PRUNE_MS = 60 * 60_000
const APPEND_MAX = 1000
const READ_MAX = 200_000
/** More than Herald writes in a day: a larger file is read only up to here. */
const READ_BYTES = 2 * DAY_MAX
const ID_LENGTH = 12
const SALT = /^[0-9a-f]{32}$/
/** How much of a file's start holds its header, and of its end its last entry. */
const HEAD_BYTES = 256
const TAIL_BYTES = 4096
const DAY_MS = 24 * 60 * 60_000

type LogPrefs = Pick<RoomPrefs, 'log' | 'logDays'>
type EntryKind = RoomLogEntry['k']

/** A day's file as this run knows it. */
interface DayFile {
  salt: string
  key: Buffer
  bytes: number
  /** Its last entry's kind; null while it holds none. */
  last: EntryKind | null
}

export interface RoomLogOptions {
  /** The log's folder: `room-log` in Herald's data folder. */
  dir: string
  now?: () => number
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** The local date of `t`, as the log names its days. */
export function localDay(t: number): string {
  const date = new Date(t)

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Whole days from one YYYY-MM-DD date to another. */
function daysBetween(from: string, to: string): number {
  const utc = (day: string) => {
    const [year, month, date] = day.split('-').map(Number)

    return Date.UTC(year, month - 1, date)
  }

  return Math.round((utc(to) - utc(from)) / DAY_MS)
}

function dayOfFile(name: string): string | null {
  const day = name.endsWith(EXTENSION) ? name.slice(0, -EXTENSION.length) : ''

  return ROOM_LOG_DAY.test(day) ? day : null
}

function entryOf(line: string): RoomLogEntry | null {
  if (!line.trim()) {
    return null
  }

  try {
    return roomLogEntryOf(JSON.parse(line))
  } catch {
    return null
  }
}

const lineOf = (value: unknown): string => `${JSON.stringify(value)}\n`

/** A day's file can end here: it has entries, and neither ended nor filled up. */
const endable = (file: DayFile): boolean => file.last !== null && file.last !== 'end' && file.last !== 'cap'

/** `entry` with every agent id replaced by its opaque one under the day's key. */
function opaque(entry: RoomLogEntry, key: Buffer): RoomLogEntry {
  const hide = (id: string) => crypto.createHmac('sha256', key).update(id).digest('hex').slice(0, ID_LENGTH)

  switch (entry.k) {
    case 'agent':
      return { ...entry, id: hide(entry.id), parent: entry.parent === null ? null : hide(entry.parent) }
    case 'gone':
      return { ...entry, id: hide(entry.id) }
    case 'handoff':
      return { ...entry, from: hide(entry.from), to: hide(entry.to) }
    default:
      return entry
  }
}

function readAt(fd: number, position: number, length: number): string {
  const buffer = Buffer.alloc(length)
  const read = fs.readSync(fd, buffer, 0, length, position)

  return buffer.toString('utf8', 0, read)
}

/** The salt a file's first line names, when that line is `day`'s header. */
function saltOf(line: string, day: string): string | null {
  try {
    const header = JSON.parse(line) as { v?: unknown; day?: unknown; salt?: unknown } | null

    return header?.v === 1 && header.day === day && typeof header.salt === 'string' && SALT.test(header.salt) ? header.salt : null
  } catch {
    return null
  }
}

function lastKind(lines: string[]): EntryKind | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const entry = entryOf(lines[index])

    if (entry) {
      return entry.k
    }
  }

  return null
}

/** An existing day file: its size, the salt its header names and its last entry's kind; null when there is none. */
function inspect(file: string, day: string): { bytes: number; salt: string | null; last: EntryKind | null } | null {
  let fd: number

  try {
    fd = fs.openSync(file, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }

  try {
    const bytes = fs.fstatSync(fd).size
    const head = readAt(fd, 0, Math.min(bytes, HEAD_BYTES))
    const tail = readAt(fd, Math.max(0, bytes - TAIL_BYTES), Math.min(bytes, TAIL_BYTES))

    return { bytes, salt: saltOf(head.split('\n')[0], day), last: lastKind(tail.split('\n')) }
  } finally {
    fs.closeSync(fd)
  }
}

/** The start of `file`, at most `max` bytes. */
async function readStart(file: string, max: number): Promise<string> {
  const handle = await fs.promises.open(file, 'r')

  try {
    const buffer = Buffer.alloc(Math.min((await handle.stat()).size, max))
    let filled = 0

    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)

      if (bytesRead === 0) {
        break
      }

      filled += bytesRead
    }

    return buffer.toString('utf8', 0, filled)
  } finally {
    await handle.close()
  }
}

export class RoomLog {
  private readonly dir: string
  private readonly now: () => number
  private on = false
  private keepDays = ROOM_PREFS_DEFAULTS.logDays
  private stopped = false
  private queue: Promise<void> = Promise.resolve()
  private pending = 0
  private ready = false
  private readonly files = new Map<string, DayFile>()
  /** The day files' total size, once a prune has counted it. */
  private total: number | null = null
  private prunedAt = -Infinity

  constructor({ dir, now = Date.now }: RoomLogOptions) {
    this.dir = dir
    this.now = now
  }

  /** Follow the Room preferences: the log on or off, and how many days it keeps. */
  setPrefs(room: LogPrefs): Promise<void> {
    const was = this.on
    const now = this.now()
    this.on = room.log && !this.stopped
    this.keepDays = room.logDays

    if (was && !this.on) {
      void this.enqueue(() => this.end(now))
    }

    return this.enqueue(() => this.prune(now))
  }

  /** Add what the Room showed; nothing is written unless the log is on. */
  append(entries: unknown): Promise<void> {
    if (!this.on || !Array.isArray(entries)) {
      return this.queue
    }

    const now = this.now()
    const byDay = new Map<string, RoomLogEntry[]>()

    for (const raw of entries.slice(0, APPEND_MAX)) {
      const entry = roomLogEntryOf(raw)

      // Only main writes `cap`.
      if (!entry || entry.k === 'cap' || entry.t < now - PAST_MS || entry.t > now + FUTURE_MS) {
        continue
      }

      const day = localDay(entry.t)
      const list = byDay.get(day)

      if (list) {
        list.push(entry)
      } else {
        byDay.set(day, [entry])
      }
    }

    if (byDay.size === 0) {
      return this.queue
    }

    return this.enqueue(async () => {
      for (const [day, list] of byDay) {
        await this.write(day, list)
      }

      if (now - this.prunedAt >= PRUNE_MS || (this.total ?? 0) > FOLDER_MAX) {
        await this.prune(now)
      }
    })
  }

  /** The days the log holds, newest first. */
  async days(): Promise<RoomLogDay[]> {
    let names: string[]

    try {
      names = await fs.promises.readdir(this.dir)
    } catch {
      return []
    }

    const days: RoomLogDay[] = []

    for (const name of names) {
      const day = dayOfFile(name)
      const stat = day ? await fs.promises.stat(path.join(this.dir, name)).catch(() => null) : null

      if (day && stat?.isFile()) {
        days.push({ day, bytes: stat.size })
      }
    }

    return days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
  }

  /** One day's entries, oldest first. */
  async read(day: unknown): Promise<RoomLogEntry[]> {
    if (typeof day !== 'string' || !ROOM_LOG_DAY.test(day)) {
      return []
    }

    let text: string

    try {
      text = await readStart(this.fileOf(day), READ_BYTES)
    } catch {
      return []
    }

    const entries: RoomLogEntry[] = []

    for (const line of text.split('\n')) {
      const entry = entryOf(line)

      if (entry) {
        entries.push(entry)

        if (entries.length >= READ_MAX) {
          break
        }
      }
    }

    return entries.sort((a, b) => a.t - b.t)
  }

  /** Delete the whole log; a day written after this starts a new file with a new salt. */
  remove(): Promise<void> {
    return this.enqueue(async () => {
      await fs.promises.rm(this.dir, { recursive: true, force: true })
      this.files.clear()
      this.total = 0
      this.ready = false
    })
  }

  /** Herald quits: a log that is on ends here. */
  stop(): void {
    if (this.stopped) {
      return
    }

    this.stopped = true

    if (!this.on) {
      return
    }

    this.on = false
    const t = this.now()

    // Entries still queued would land after a line written now.
    if (this.pending > 0) {
      void this.enqueue(() => this.end(t))

      return
    }

    try {
      const day = localDay(t)
      const file = this.dayFile(day)
      const line = lineOf({ t, k: 'end' })

      if (endable(file) && file.bytes + Buffer.byteLength(line) <= DAY_MAX) {
        fs.appendFileSync(this.fileOf(day), line, { mode: 0o600 })
        file.bytes += Buffer.byteLength(line)
        file.last = 'end'
      }
    } catch (error) {
      log('room', `cannot end the activity log: ${(error as Error).message}`)
    }
  }

  /** Run `task` after every task before it; the queue goes on when one fails. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.pending++
    const run = this.queue.then(task).finally(() => {
      this.pending--
    })
    this.queue = run.catch(error => log('room', `activity log: ${error instanceof Error ? error.message : String(error)}`))

    return run
  }

  private fileOf(day: string): string {
    return path.join(this.dir, `${day}${EXTENSION}`)
  }

  private dayFile(day: string): DayFile {
    const known = this.files.get(day)

    if (known) {
      return known
    }

    const found = inspect(this.fileOf(day), day)
    const salt = found?.salt ?? crypto.randomBytes(16).toString('hex')
    const file: DayFile = { salt, key: Buffer.from(salt, 'hex'), bytes: found?.bytes ?? 0, last: found?.last ?? null }
    this.files.set(day, file)

    return file
  }

  private async write(day: string, entries: RoomLogEntry[]): Promise<void> {
    const file = this.dayFile(day)

    if (file.last === 'cap') {
      return
    }

    let text = file.bytes === 0 ? lineOf({ v: 1, day, salt: file.salt }) : ''
    let bytes = file.bytes + Buffer.byteLength(text)
    let last: EntryKind | null = file.last

    for (const entry of entries) {
      const line = lineOf(opaque(entry, file.key))
      const size = Buffer.byteLength(line)

      if (bytes + size + CAP_RESERVE > DAY_MAX) {
        const cap = lineOf({ t: entry.t, k: 'cap' })
        text += cap
        bytes += Buffer.byteLength(cap)
        last = 'cap'

        break
      }

      text += line
      bytes += size
      last = entry.k
    }

    if (!this.ready) {
      await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 })
      await fs.promises.chmod(this.dir, 0o700)
      this.ready = true
    }

    await fs.promises.appendFile(this.fileOf(day), text, { mode: 0o600 })

    if (this.total !== null) {
      this.total += bytes - file.bytes
    }

    file.bytes = bytes
    file.last = last
  }

  private async end(t: number): Promise<void> {
    const day = localDay(t)

    if (endable(this.dayFile(day))) {
      await this.write(day, [{ t, k: 'end' }])
    }
  }

  /**
   * Remove the days the log no longer keeps, then the oldest ones while the log is too large. A day
   * goes once its date is more than `logDays` days before today, so the log always covers at least
   * the last `logDays` times 24 hours.
   */
  private async prune(now: number): Promise<void> {
    this.prunedAt = now
    const today = localDay(now)
    const kept: RoomLogDay[] = []
    let total = 0

    for (const entry of (await this.days()).reverse()) {
      if (entry.day !== today && daysBetween(entry.day, today) > this.keepDays) {
        await this.drop(entry.day)
      } else {
        kept.push(entry)
        total += entry.bytes
      }
    }

    for (const entry of kept) {
      if (total <= FOLDER_MAX) {
        break
      }

      if (entry.day !== today) {
        await this.drop(entry.day)
        total -= entry.bytes
      }
    }

    this.total = total
  }

  private async drop(day: string): Promise<void> {
    await fs.promises.rm(this.fileOf(day), { force: true })
    this.files.delete(day)
  }
}
