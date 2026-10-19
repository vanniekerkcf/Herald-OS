import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../log.ts', () => ({ log: vi.fn() }))

const { localDay, RoomLog } = await import('./log.ts')

const NOON = new Date(2026, 9, 15, 12, 0).getTime()
const TODAY = localDay(NOON)
const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const MIB = 1024 * 1024
const ON = { log: true, logDays: 7 }
const OFF = { log: false, logDays: 7 }

const folders: string[] = []

afterEach(() => {
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

type Line = Record<string, unknown>

function setup(start = NOON) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-log-'))
  folders.push(root)
  const dir = path.join(root, 'room-log')
  const clock = { now: start }
  const store = new RoomLog({ dir, now: () => clock.now })
  const file = (day: string) => path.join(dir, `${day}.jsonl`)
  const lines = (day: string): Line[] =>
    fs
      .readFileSync(file(day), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Line)

  return { store, clock, dir, file, lines }
}

const agent = (t: number, id: string, extra: Record<string, unknown> = {}) => ({
  t,
  k: 'agent',
  id,
  kind: 'conversation',
  phase: 'tool',
  area: 'docs',
  step: 'reading Budget.xlsx',
  target: 'Budget.xlsx',
  wait: false,
  parent: null,
  where: null,
  outcome: null,
  ...extra
})

/** About 350 bytes on disk each. */
const longAgents = (t: number, count: number, offset = 0) => Array.from({ length: count }, (_, index) => agent(t, `session-${offset + index}`, { step: 'x'.repeat(80), target: 'y'.repeat(40), where: 'z'.repeat(40) }))

const ago = (days: number) => localDay(NOON - days * DAY)

describe('the activity log', () => {
  it('writes nothing while it is off', async () => {
    const { store, dir } = setup()

    await store.append([agent(NOON, 'session-1')])
    await store.setPrefs(OFF)
    await store.append([agent(NOON, 'session-1')])

    expect(fs.existsSync(dir)).toBe(false)
    expect(await store.days()).toEqual([])
  })

  it('keeps valid entries only, and writes every agent id as an opaque one of the day', async () => {
    const { store, dir, file, lines } = setup()
    const conversation = '20261015_120000_ab12cd'
    const helper = 'helper:20261015_120500_ef34gh'
    await store.setPrefs(ON)

    await store.append([
      agent(NOON, conversation),
      agent(NOON + 1, helper, { kind: 'helper', phase: 'thinking', area: 'studio', parent: conversation }),
      { t: NOON + 2, k: 'handoff', kind: 'note', from: conversation, to: helper, failed: false },
      { t: NOON + 3, k: 'gone', id: helper },
      { t: NOON + 4, k: 'agent', id: conversation, kind: 'conversation' },
      { t: NOON + 5, k: 'cap' },
      { t: NOON + 6, k: 'chat', text: 'hello' },
      'begin',
      null,
      agent(NOON - 25 * HOUR, conversation),
      agent(NOON + 2 * 60_000, conversation)
    ])
    await store.append('not a list')

    const text = fs.readFileSync(file(TODAY), 'utf8')

    expect(text).not.toContain(conversation)
    expect(text).not.toContain(helper)

    const [header, ...entries] = lines(TODAY)
    const [main, child, handoff, gone] = entries

    expect(header).toEqual({ v: 1, day: TODAY, salt: expect.stringMatching(/^[0-9a-f]{32}$/) })
    expect(entries.map(entry => entry.k)).toEqual(['agent', 'agent', 'handoff', 'gone'])
    expect(main).toEqual(agent(NOON, String(main.id)))
    expect(main.id).toMatch(/^[0-9a-f]{12}$/)
    expect(child.id).toMatch(/^[0-9a-f]{12}$/)
    expect(child.id).not.toBe(main.id)
    expect(child.parent).toBe(main.id)
    expect(handoff).toEqual({ t: NOON + 2, k: 'handoff', kind: 'note', from: main.id, to: child.id, failed: false })
    expect(gone).toEqual({ t: NOON + 3, k: 'gone', id: child.id })
    expect(fs.statSync(file(TODAY)).mode & 0o777).toBe(0o600)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('writes each entry to the file of its local day, every day with a salt of its own', async () => {
    const { store, lines } = setup(new Date(2026, 9, 15, 0, 30).getTime())
    const late = new Date(2026, 9, 14, 23, 50).getTime()
    const early = new Date(2026, 9, 15, 0, 10).getTime()
    await store.setPrefs(ON)

    await store.append([agent(late, 'session-1'), agent(early, 'session-1')])

    const [lateHeader, lateEntry, ...lateRest] = lines('2026-10-14')
    const [earlyHeader, earlyEntry, ...earlyRest] = lines('2026-10-15')

    expect([lateHeader.day, earlyHeader.day]).toEqual(['2026-10-14', '2026-10-15'])
    expect(lateHeader.salt).not.toBe(earlyHeader.salt)
    expect([lateEntry.t, earlyEntry.t]).toEqual([late, early])
    expect(lateEntry.id).not.toBe(earlyEntry.id)
    expect([lateRest, earlyRest]).toEqual([[], []])
    expect((await store.days()).map(day => day.day)).toEqual(['2026-10-15', '2026-10-14'])
  })

  it('keeps a day’s ids after Herald starts again', async () => {
    const { store, dir, lines } = setup()
    await store.setPrefs(ON)
    await store.append([agent(NOON, 'session-1')])

    const again = new RoomLog({ dir, now: () => NOON + HOUR })
    await again.setPrefs(ON)
    await again.append([agent(NOON + HOUR, 'session-1')])

    const [header, first, second, ...rest] = lines(TODAY)

    expect(header.salt).toMatch(/^[0-9a-f]{32}$/)
    expect(second.id).toBe(first.id)
    expect(rest).toEqual([])
  })

  it('ends the day’s file when it is switched off, once', async () => {
    const { store, clock, lines } = setup()
    await store.setPrefs(ON)
    await store.append([{ t: NOON, k: 'begin' }, agent(NOON, 'session-1')])

    clock.now = NOON + 1000
    await store.setPrefs(OFF)
    await store.setPrefs(OFF)
    await store.setPrefs(ON)
    await store.setPrefs(OFF)

    expect(lines(TODAY).slice(1)).toEqual([{ t: NOON, k: 'begin' }, agent(NOON, String(lines(TODAY)[2].id)), { t: NOON + 1000, k: 'end' }])
  })

  it('adds no end after one the Room wrote, nor a file for a day it wrote nothing in', async () => {
    const { store, clock, dir, lines } = setup()
    await store.setPrefs(ON)
    await store.setPrefs(OFF)

    expect(fs.existsSync(dir)).toBe(false)

    await store.setPrefs(ON)
    await store.append([agent(NOON, 'session-1'), { t: NOON + 1, k: 'end' }])
    clock.now = NOON + 1000
    await store.setPrefs(OFF)

    expect(lines(TODAY).map(line => line.k)).toEqual([undefined, 'agent', 'end'])
  })

  it('ends the log when Herald quits while it is on, and takes nothing after', async () => {
    const { store, clock, dir, lines } = setup()
    await store.setPrefs(ON)
    await store.append([agent(NOON, 'session-1')])

    clock.now = NOON + 5000
    store.stop()
    await store.append([agent(NOON + 6000, 'session-1')])

    expect(lines(TODAY).slice(-2).map(line => line.k)).toEqual(['agent', 'end'])
    expect(lines(TODAY).at(-1)).toEqual({ t: NOON + 5000, k: 'end' })

    // Started again, the log finds today's last entry in the file.
    const again = new RoomLog({ dir, now: () => NOON + 9000 })
    await again.setPrefs(ON)
    again.stop()

    expect(lines(TODAY).filter(line => line.k === 'end')).toHaveLength(1)

    const third = new RoomLog({ dir, now: () => NOON + 9000 })
    await third.setPrefs(ON)
    await third.append([agent(NOON + 8000, 'session-1')])
    third.stop()

    expect(lines(TODAY).slice(-2)).toEqual([expect.objectContaining({ k: 'agent', t: NOON + 8000 }), { t: NOON + 9000, k: 'end' }])
  })

  it('caps a day at 8 MiB with one cap entry, and writes nothing more that day', async () => {
    const { store, dir, file } = setup()
    await store.setPrefs(ON)

    for (let round = 0; round < 26; round++) {
      await store.append(longAgents(NOON, 1000, round * 1000))
    }

    const size = fs.statSync(file(TODAY)).size
    const text = fs.readFileSync(file(TODAY), 'utf8')
    const last = text.trimEnd().split('\n').at(-1)

    expect(size).toBeLessThanOrEqual(8 * MIB)
    expect(size).toBeGreaterThan(8 * MIB - 1024)
    expect(text.match(/"k":"cap"/g)).toHaveLength(1)
    expect(JSON.parse(last ?? '')).toEqual({ t: NOON, k: 'cap' })

    await store.append([agent(NOON, 'session-1')])
    await store.setPrefs(OFF)

    const again = new RoomLog({ dir, now: () => NOON + 1000 })
    await again.setPrefs(ON)
    await again.append([agent(NOON + 1000, 'session-1')])
    again.stop()

    expect(fs.statSync(file(TODAY)).size).toBe(size)
  })

  it('keeps the whole log within 64 MiB by removing the oldest days, never today’s', async () => {
    const { store, dir, file } = setup()
    fs.mkdirSync(dir, { recursive: true })
    const old = Array.from({ length: 10 }, (_, index) => ago(index + 1))

    for (const day of old) {
      fs.writeFileSync(file(day), '')
      fs.truncateSync(file(day), 7 * MIB)
    }

    await store.setPrefs({ log: true, logDays: 30 })

    expect((await store.days()).map(day => day.day)).toEqual(old.slice(0, 9))

    // Today's entries take it past 64 MiB again: the oldest day left goes.
    for (let round = 0; round < 4; round++) {
      await store.append(longAgents(NOON, 1000, round * 1000))
    }

    expect((await store.days()).map(day => day.day)).toEqual([TODAY, ...old.slice(0, 8)])
  })

  it('never removes today’s file for the size of the log', async () => {
    const { store, dir, file } = setup()
    fs.mkdirSync(dir, { recursive: true })

    for (const day of [TODAY, ago(1), ago(2)]) {
      fs.writeFileSync(file(day), '')
      fs.truncateSync(file(day), day === TODAY ? 70 * MIB : MIB)
    }

    await store.setPrefs(ON)

    expect(await store.days()).toEqual([{ day: TODAY, bytes: 70 * MIB }])
  })

  it('removes the days older than it keeps: at start, on a change and at most hourly as it writes', async () => {
    const { store, clock, dir, file } = setup()
    fs.mkdirSync(dir, { recursive: true })

    for (const days of [0, 1, 3, 7, 8, 30]) {
      fs.writeFileSync(file(ago(days)), '')
    }

    fs.writeFileSync(path.join(dir, 'notes.txt'), '')
    fs.writeFileSync(path.join(dir, `${ago(40)}.jsonl.bak`), '')

    await store.setPrefs(OFF)
    expect((await store.days()).map(day => day.day)).toEqual([ago(0), ago(1), ago(3), ago(7)])

    await store.setPrefs({ log: true, logDays: 1 })
    expect((await store.days()).map(day => day.day)).toEqual([ago(0), ago(1)])
    expect(fs.readdirSync(dir)).toEqual(expect.arrayContaining(['notes.txt', `${ago(40)}.jsonl.bak`]))

    fs.writeFileSync(file(ago(5)), '')
    clock.now = NOON + 10 * 60_000
    await store.append([agent(clock.now, 'session-1')])
    expect(fs.existsSync(file(ago(5)))).toBe(true)

    clock.now = NOON + HOUR
    await store.append([agent(clock.now, 'session-1')])
    expect(fs.existsSync(file(ago(5)))).toBe(false)
  })

  it('lists its days newest first, with their sizes', async () => {
    const { store, dir, file } = setup()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file('2026-10-13'), 'abc')
    fs.writeFileSync(file('2026-10-15'), 'abcdef')
    fs.mkdirSync(file('2026-10-14'))
    fs.writeFileSync(path.join(dir, '2026-10-1.jsonl'), '')

    expect(await store.days()).toEqual([
      { day: '2026-10-15', bytes: 6 },
      { day: '2026-10-13', bytes: 3 }
    ])
  })

  it('reads a day oldest first, skipping its header and anything that is not an entry', async () => {
    const { store, dir, file } = setup()
    fs.mkdirSync(dir, { recursive: true })
    const id = 'abc123abc123'
    const lines = [
      JSON.stringify({ v: 1, day: '2026-10-14', salt: 'a'.repeat(32) }),
      JSON.stringify({ t: 3000, k: 'gone', id }),
      'not json',
      JSON.stringify({ t: 1000, k: 'begin' }),
      JSON.stringify({ t: 2000, k: 'agent', id, kind: 'conversation' }),
      JSON.stringify(agent(2000, id)),
      JSON.stringify({ t: 2500, k: 'gone', id: '../../etc' }),
      '{"t": 4000, "k": "end"',
      '',
      '[1, 2]',
      JSON.stringify({ t: 5000, k: 'end' })
    ]
    fs.writeFileSync(file('2026-10-14'), lines.join('\n'))

    expect(await store.read('2026-10-14')).toEqual([{ t: 1000, k: 'begin' }, agent(2000, id), { t: 3000, k: 'gone', id }, { t: 5000, k: 'end' }])
    expect(await store.read('2026-10-13')).toEqual([])
    expect(await store.read('../room-log/2026-10-14')).toEqual([])
    expect(await store.read('2026-10-14.jsonl')).toEqual([])
    expect(await store.read(20261014)).toEqual([])
  })

  it('reads at most 200,000 entries of a day', async () => {
    const { store, dir, file } = setup()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file('2026-10-14'), Array.from({ length: 200_010 }, (_, index) => JSON.stringify({ t: index + 1, k: 'begin' })).join('\n'))

    const entries = await store.read('2026-10-14')

    expect(entries).toHaveLength(200_000)
    expect(entries.at(-1)).toEqual({ t: 200_000, k: 'begin' })
  })

  it('deletes the whole log, and a day written after that gets a new salt', async () => {
    const { store, dir, lines } = setup()
    await store.setPrefs(ON)
    await store.append([agent(NOON, 'session-1')])
    const [before, beforeEntry] = lines(TODAY)

    await store.remove()

    expect(fs.existsSync(dir)).toBe(false)
    expect(await store.days()).toEqual([])
    expect(await store.read(TODAY)).toEqual([])

    await store.append([agent(NOON, 'session-1')])
    const [after, afterEntry, ...rest] = lines(TODAY)

    expect(after.salt).not.toBe(before.salt)
    expect(afterEntry.id).not.toBe(beforeEntry.id)
    expect(rest).toEqual([])
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })
})
