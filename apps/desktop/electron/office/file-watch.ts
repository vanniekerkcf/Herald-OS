import crypto from 'node:crypto'
import { createReadStream, type FSWatcher, watch } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

/*
 * Following one open Office file for changes made elsewhere (Hermes, another app, a sync client).
 * The folder is watched rather than the file: apps save by writing a new file and renaming it over
 * the old one, which ends a watch on the file itself. A poll of the file's size and time covers file
 * systems that report nothing. Only a change of content counts, compared by digest with the version
 * the window has, and Herald's own saves are not reported back to the window that made them.
 */

export interface FileStamp {
  digest: string
  size: number
  modifiedAt: number
}

/** A file's content digest, size and time; null when there is no file. */
export async function stampOf(file: string): Promise<FileStamp | null> {
  const stat = await fs.stat(file).catch(() => null)

  if (!stat?.isFile()) {
    return null
  }

  const hash = crypto.createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject)
  })

  return { digest: hash.digest('hex').slice(0, 32), size: stat.size, modifiedAt: stat.mtimeMs }
}

export const digestOfBytes = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)

export class FileWatcher {
  private watcher: FSWatcher | null = null
  private poll: NodeJS.Timeout | null = null
  private timer: NodeJS.Timeout | null = null
  private stamp = ''
  private writing = 0
  private running = false

  constructor(
    private readonly file: string,
    private known: string | null,
    private readonly onChange: (digest: string | null) => void,
    private readonly delayMs = 300,
    private readonly pollMs = 2000
  ) {}

  start(): void {
    this.running = true
    this.watchFolder()
    void this.statStamp().then((stamp) => {
      this.stamp ||= stamp
    })
    this.poll = setInterval(() => void this.probe(), this.pollMs)
    this.poll.unref()
    // A folder watch reports nothing until the system has set it up (on macOS, a moment after `watch` returns):
    // one check after starting finds what changed before then.
    this.schedule()
  }

  stop(): void {
    this.running = false
    this.watcher?.close()
    this.watcher = null

    if (this.poll) {
      clearInterval(this.poll)
      this.poll = null
    }

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Herald's own save: checks wait while it writes, and what it wrote is the version the window has. */
  async ownWrite(write: () => Promise<string>): Promise<string> {
    this.writing++

    try {
      const digest = await write()
      this.known = digest
      this.stamp = await this.statStamp()

      return digest
    } finally {
      this.writing--
    }
  }

  private watchFolder(): void {
    if (this.watcher) {
      return
    }

    const name = path.basename(this.file)

    try {
      const watcher = watch(path.dirname(this.file), (_event, entry) => {
        // Some platforms leave the name out; then any change in the folder is checked.
        if (!entry || entry.toString() === name) {
          this.schedule()
        }
      })
      watcher.on('error', () => {
        watcher.close()

        if (this.watcher === watcher) {
          this.watcher = null
        }
      })
      this.watcher = watcher
    } catch {
      // The folder is gone or unreadable: the poll still notices the file coming back.
    }
  }

  private async statStamp(): Promise<string> {
    const stat = await fs.stat(this.file).catch(() => null)

    return stat ? `${stat.mtimeMs}:${stat.size}:${stat.ino}` : ''
  }

  private async probe(): Promise<void> {
    const stamp = await this.statStamp()

    if (stamp !== this.stamp) {
      this.stamp = stamp
      this.schedule()
    }
  }

  private schedule(): void {
    if (!this.running) {
      return
    }

    if (this.timer) {
      clearTimeout(this.timer)
    }

    this.timer = setTimeout(() => {
      this.timer = null
      void this.check()
    }, this.delayMs)
  }

  /**
   * Compares the file with the version the window has and reports it when they differ. Resolves to
   * false when it could not tell (Herald saving, the file changing while it was read, or unreadable).
   */
  async check(): Promise<boolean> {
    if (this.writing) {
      this.schedule()

      return false
    }

    if (this.running) {
      this.watchFolder()
    }

    try {
      const before = await this.statStamp()
      const stamp = await stampOf(this.file)
      const digest = stamp?.digest ?? null

      // A check can run into a save, Herald's or another app's, before that save's events arrive: what it read
      // of a file that changed meanwhile (a save in place empties it before filling it again) is no version to
      // report, so it looks again.
      if ((await this.statStamp()) !== before || this.writing) {
        this.schedule()

        return false
      }

      if (this.running && digest !== this.known) {
        this.known = digest
        this.onChange(digest)
      }

      return true
    } catch {
      // Unreadable mid-write: the next change or poll checks again.
      return false
    }
  }
}
