import fs, { type FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { digestOfBytes, FileWatcher, stampOf } from './file-watch.ts'

let root = ''
const watchers: FileWatcher[] = []
const digestOf = (text: string) => digestOfBytes(new TextEncoder().encode(text))

async function fixture(content: string): Promise<string> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-watch-'))
  const file = path.join(root, 'Budget.csv')
  await fs.writeFile(file, content)

  return file
}

/** A watcher on `file` that reports into a list; short delays keep the tests quick. */
async function follow(file: string, known: string | null, delayMs = 40, pollMs = 150) {
  const seen: (string | null)[] = []
  const watcher = new FileWatcher(file, known, (digest) => seen.push(digest), delayMs, pollMs)
  watchers.push(watcher)
  watcher.start()

  return { watcher, seen }
}

/** File events arrive later on a busy machine (CI), so wait for the outcome rather than a fixed time. */
const until = async (test: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms

  while (!test() && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Follows the watcher's checks, so a test waits for the one a change causes rather than a fixed time. */
function checksOf(watcher: FileWatcher) {
  const check = vi.spyOn(watcher, 'check')

  return {
    /**
     * The first check to start from now on that could tell whether the file differs from the window's
     * version (one that ran into a change looks again), once it and every check before it have finished.
     */
    async next(): Promise<void> {
      for (let count = check.mock.calls.length; ; count++) {
        await until(() => check.mock.calls.length > count)
        expect(check.mock.calls.length, 'the watcher never checked the file').toBeGreaterThan(count)

        if (await check.mock.results[count]?.value) {
          break
        }
      }

      await Promise.all(check.mock.results.map((result) => result.value))
    }
  }
}

afterEach(async () => {
  watchers.splice(0).forEach((watcher) => watcher.stop())
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

describe('stampOf', () => {
  it('digests the content, the same way as the bytes', async () => {
    const file = await fixture('a,b\n')
    const stamp = await stampOf(file)

    expect(stamp?.digest).toBe(digestOfBytes(new TextEncoder().encode('a,b\n')))
    expect(stamp?.size).toBe(4)
    expect(await stampOf(path.join(root, 'missing.csv'))).toBeNull()
  })
})

describe('FileWatcher', () => {
  it('reports an edit made in place and a save by rename', { timeout: 30_000 }, async () => {
    const file = await fixture('one\n')
    const { seen } = await follow(file, (await stampOf(file))!.digest)

    await fs.writeFile(file, 'two\n')
    await until(() => seen.length === 1)
    expect(seen).toEqual([digestOf('two\n')])

    const temporary = path.join(root, '.Budget.csv.tmp')
    await fs.writeFile(temporary, 'three\n')
    await fs.rename(temporary, file)
    await until(() => seen.length === 2)
    expect(seen[1]).toBe(digestOf('three\n'))
  })

  it('reports a change that landed before it started, against the version the window loaded', { timeout: 30_000 }, async () => {
    const file = await fixture('loaded\n')
    const loaded = (await stampOf(file))!.digest
    await fs.writeFile(file, 'changed meanwhile\n')
    // Another watcher reports the change first, so the next one cannot count on the system replaying the
    // write to it, as macOS does for a write made just before a watch starts.
    const earlier = await follow(file, loaded)
    await until(() => earlier.seen.length > 0)
    earlier.watcher.stop()
    expect(earlier.seen).toEqual([digestOf('changed meanwhile\n')])
    const { seen } = await follow(file, loaded)

    await until(() => seen.length > 0)
    expect(seen).toEqual([digestOf('changed meanwhile\n')])
  })

  it('does not report its own window’s saves, nor a write that changes nothing', { timeout: 30_000 }, async () => {
    const file = await fixture('a\n')
    const { watcher, seen } = await follow(file, (await stampOf(file))!.digest)
    const checks = checksOf(watcher)

    await watcher.ownWrite(async () => {
      await fs.writeFile(file, 'saved by Herald\n')

      return digestOf('saved by Herald\n')
    })
    await checks.next()
    expect(seen).toEqual([])

    await fs.writeFile(file, 'saved by Herald\n')
    await checks.next()
    expect(seen).toEqual([])
  })

  it('does not report a save in place it reads half done, only the version the save leaves', { timeout: 30_000 }, async () => {
    const file = await fixture('saved by Herald\n')
    // Long delays: the only checks are the ones the test runs.
    const { watcher, seen } = await follow(file, digestOf('saved by Herald\n'), 60_000, 60_000)
    const stat = fs.stat
    let saving: FileHandle | undefined
    // Another app saves the same content in place just after the check first looks at the file: opening the
    // file to write empties it, so the check reads it empty.
    vi.spyOn(fs, 'stat').mockImplementationOnce(async (...args) => {
      const stats = await stat(...args)
      saving = await fs.open(file, 'w')

      return stats
    })

    const told = await watcher.check()
    expect(saving, 'the check never looked at the file').toBeDefined()
    await saving!.writeFile('saved by Herald\n')
    await saving!.close()

    expect(seen).toEqual([])
    expect(told).toBe(false)
    expect(await watcher.check()).toBe(true)
    expect(seen).toEqual([])
  })

  it('reports the file going away as null, and coming back', { timeout: 30_000 }, async () => {
    const file = await fixture('a\n')
    const { seen } = await follow(file, (await stampOf(file))!.digest)

    await fs.rm(file)
    await until(() => seen.length === 1)
    expect(seen).toEqual([null])

    await fs.writeFile(file, 'back\n')
    await until(() => seen.length === 2)
    expect(seen[1]).toBe(digestOf('back\n'))
  })
})
