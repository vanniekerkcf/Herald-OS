import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc.ts'
import { ROOM_ACTIVITY_BATCH, type RoomActivity } from '../../shared/room.ts'

vi.mock('../log.ts', () => ({ log: vi.fn() }))

const { ActivityHub } = await import('./activity.ts')

const LIVE = { elsewhere: true, elsewhereLive: true }
const OFF = { elsewhere: true, elsewhereLive: false }
const PID = 4242
const SOCKET = '/tmp/herald-test/control.sock'
const T0 = 1_760_000_000_000
const REFUSED = { ok: false, error: 'invalid activity token' }

/** A window as the hub sees one, keeping every batch it is sent. */
class FakeWindow extends EventEmitter {
  destroyed = false
  readonly batches: RoomActivity[][] = []

  constructor(readonly id: number) {
    super()
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, events: RoomActivity[]): void {
    expect(channel).toBe(IPC.roomActivity)
    this.batches.push(events)
  }

  close(): void {
    this.destroyed = true
    this.emit('destroyed')
  }

  sessions(): string[][] {
    return this.batches.map(batch => batch.map(event => event.session))
  }
}

const folders: string[] = []

afterEach(() => {
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'room-activity-'))
  folders.push(folder)

  return folder
}

const nthToken = (n: number) => `token-${n}`.padEnd(43, '0')

function setup({ live = true }: { live?: boolean } = {}) {
  const dataDir = tempDir()
  const clock = { now: T0 }
  let tokens = 0
  const hub = new ActivityHub({ dataDir, socket: SOCKET, pid: PID, now: () => clock.now, newToken: () => nthToken(++tokens), alive: () => false })
  hub.start(live ? LIVE : OFF)
  const controlFile = path.join(dataDir, 'observe', `${PID}.json`)
  const control = () => JSON.parse(fs.readFileSync(controlFile, 'utf8')) as Record<string, unknown>

  return { hub, clock, dataDir, controlFile, control, token: () => String(control().token) }
}

const tool = (session: string, extra: Record<string, unknown> = {}) => ({ kind: 'tool.start', session, tool: 'read_file', target: '/Users/someone/Budget.xlsx', call: 'c1', source: 'telegram', ...extra })
const ask = (token: unknown, events: unknown) => ({ cmd: 'activity', token, events })
const tools = (count: number, prefix = 's') => Array.from({ length: count }, (_, index) => tool(`${prefix}${index}`))

describe('the activity token', () => {
  it('lets through its own token only', () => {
    const { hub, token } = setup()
    const right = token()

    expect(hub.handle(ask(right, [tool('s1')]))).toEqual({ ok: true, accepted: 1 })
    expect(hub.handle(ask(`${right.slice(0, -1)}x`, [tool('s1')]))).toEqual(REFUSED)
    expect(hub.handle(ask(right.slice(0, 20), [tool('s1')]))).toEqual(REFUSED)
    expect(hub.handle(ask(`${right}0`, [tool('s1')]))).toEqual(REFUSED)
    expect(hub.handle(ask('', [tool('s1')]))).toEqual(REFUSED)
    expect(hub.handle(ask(42, [tool('s1')]))).toEqual(REFUSED)
    expect(hub.handle({ cmd: 'activity', events: [tool('s1')] })).toEqual(REFUSED)
  })

  it('refuses events while live detail is off, and hands a window none of them', () => {
    const { hub, control } = setup({ live: false })
    const window = new FakeWindow(1)
    hub.watch(window, true)

    expect(control()).toEqual({ v: 1, pid: PID, live: false })
    // The hub's first token, which no control file named.
    expect(hub.handle(ask(nthToken(1), [tool('s1')]))).toEqual({ ok: false, error: 'live detail is off' })
    expect(hub.handle(ask(nthToken(2), [tool('s1')]))).toEqual(REFUSED)
    expect(window.batches).toEqual([])
  })

  it('turns the token over when live detail goes off, so the old one never works again', () => {
    const { hub, token } = setup()
    const first = token()

    expect(hub.handle(ask(first, [tool('s1')]))).toEqual({ ok: true, accepted: 1 })

    hub.setPrefs(OFF)
    expect(hub.handle(ask(first, [tool('s1')]))).toEqual(REFUSED)

    hub.setPrefs(LIVE)
    const second = token()

    expect(second).not.toBe(first)
    expect(hub.handle(ask(first, [tool('s1')]))).toEqual(REFUSED)
    expect(hub.handle(ask(second, [tool('s1')]))).toEqual({ ok: true, accepted: 1 })

    // The lane off turns live detail off too.
    hub.setPrefs({ elsewhere: false, elsewhereLive: true })
    expect(hub.handle(ask(second, [tool('s1')]))).toEqual(REFUSED)
  })

  it('keeps the token while live detail stays on', () => {
    const { hub, token } = setup()
    const first = token()
    hub.setPrefs(LIVE)

    expect(token()).toBe(first)
    expect(hub.handle(ask(first, [tool('s1')]))).toEqual({ ok: true, accepted: 1 })
  })

  it('is 32 random bytes in base64url unless a test picks it', () => {
    const dataDir = tempDir()
    new ActivityHub({ dataDir, socket: SOCKET, pid: PID }).start(LIVE)
    const { token } = JSON.parse(fs.readFileSync(path.join(dataDir, 'observe', `${PID}.json`), 'utf8')) as { token: string }

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe('activity events', () => {
  it('drops what is not an event and numbers the rest in the order they came', () => {
    const { hub, token } = setup()
    const window = new FakeWindow(1)
    hub.watch(window, true)

    const first = [tool('s1'), { kind: 'tool.start', session: 's1' }, 'tool.start', null, { kind: 'chat.message', session: 's1', text: 'hello' }, { kind: 'session.start', session: 's2', at: (T0 - 5000) / 1000 }]

    expect(hub.handle(ask(token(), first))).toEqual({ ok: true, accepted: 2 })
    expect(hub.handle(ask(token(), [{ kind: 'tool.end', session: 's1', tool: 'read_file', call: 'c1', status: 'ok' }]))).toEqual({ ok: true, accepted: 1 })
    expect(window.batches.flat().map(event => [event.seq, event.kind, event.session])).toEqual([
      [1, 'tool.start', 's1'],
      [2, 'session.start', 's2'],
      [3, 'tool.end', 's1']
    ])
    expect(window.batches[0][0]).toEqual({ seq: 1, kind: 'tool.start', session: 's1', child: null, tool: 'read_file', target: 'Budget.xlsx', call: 'c1', status: null, source: 'telegram', at: T0 })
    expect(window.batches[0][1].at).toBe(T0 - 5000)
  })

  it('counts anything but a list of events as none', () => {
    const { hub, token } = setup()
    const window = new FakeWindow(1)
    hub.watch(window, true)

    expect(hub.handle({ cmd: 'activity', token: token() })).toEqual({ ok: true, accepted: 0 })
    expect(hub.handle(ask(token(), { 0: tool('s1') }))).toEqual({ ok: true, accepted: 0 })
    expect(hub.handle(ask(token(), 'tool.start'))).toEqual({ ok: true, accepted: 0 })
    expect(window.batches).toEqual([])
  })

  it('reads no more than a batch of one request', () => {
    const { hub, token } = setup()

    expect(hub.handle(ask(token(), tools(ROOM_ACTIVITY_BATCH + 50)))).toEqual({ ok: true, accepted: ROOM_ACTIVITY_BATCH })
  })

  it('sends each batch to the windows that watch, until they stop or close', () => {
    const { hub, token } = setup()
    const first = new FakeWindow(1)
    const second = new FakeWindow(2)
    hub.watch(first, true)
    hub.watch(second, true)

    hub.handle(ask(token(), [tool('s1')]))
    hub.watch(first, false)
    hub.handle(ask(token(), [tool('s2')]))
    second.close()
    hub.handle(ask(token(), [tool('s3')]))

    expect(first.sessions()).toEqual([['s1']])
    expect(second.sessions()).toEqual([['s1'], ['s2']])
    expect(second.listenerCount('destroyed')).toBe(0)
  })

  it('hears a window close once, however often it starts watching', () => {
    const { hub } = setup()
    const window = new FakeWindow(1)

    for (let round = 0; round < 12; round++) {
      hub.watch(window, true)
      hub.watch(window, false)
    }

    hub.watch(window, true)
    expect(window.listenerCount('destroyed')).toBe(1)
  })

  it('reaches a window that watched while live detail was off once it comes on', () => {
    const { hub, token } = setup({ live: false })
    const window = new FakeWindow(1)
    hub.watch(window, true)

    hub.setPrefs(LIVE)
    hub.handle(ask(token(), [tool('s1')]))

    expect(window.sessions()).toEqual([['s1']])
  })
})

describe('what a window that starts watching hears at once', () => {
  it('is what came in during the last ten minutes, as one batch', () => {
    const { hub, token, clock } = setup()
    hub.handle(ask(token(), [tool('early')]))
    clock.now += 6 * 60_000
    hub.handle(ask(token(), [tool('later'), tool('later-too')]))
    clock.now += 5 * 60_000

    const window = new FakeWindow(1)
    hub.watch(window, true)

    expect(window.sessions()).toEqual([['later', 'later-too']])
  })

  it('holds no more than 2000 events, the latest', () => {
    const { hub, token, clock } = setup()

    for (let round = 0; round < 25; round++) {
      clock.now += 1001
      expect(hub.handle(ask(token(), tools(100, `r${round}-`)))).toEqual({ ok: true, accepted: 100 })
    }

    const window = new FakeWindow(1)
    hub.watch(window, true)

    expect(window.batches).toHaveLength(1)
    expect(window.batches[0]).toHaveLength(2000)
    expect(window.batches[0][0].seq).toBe(501)
    expect(window.batches[0].at(-1)?.seq).toBe(2500)
  })

  it('is nothing while live detail is off, nor what came in before it went off', () => {
    const { hub, token } = setup()
    hub.handle(ask(token(), [tool('s1')]))
    hub.setPrefs(OFF)

    const offWindow = new FakeWindow(1)
    hub.watch(offWindow, true)
    hub.setPrefs(LIVE)
    const onWindow = new FakeWindow(2)
    hub.watch(onWindow, true)

    expect(offWindow.batches).toEqual([])
    expect(onWindow.batches).toEqual([])
  })

  it('comes again when a window that reloaded starts watching again', () => {
    const { hub, token } = setup()
    const window = new FakeWindow(1)
    hub.watch(window, true)
    hub.handle(ask(token(), [tool('s1')]))
    hub.watch(window, true)

    expect(window.sessions()).toEqual([['s1'], ['s1']])
  })
})

describe('the rate limit', () => {
  it('takes at most 400 events a second from every Hermes process together', () => {
    const { hub, token, clock } = setup()

    for (let round = 0; round < 4; round++) {
      expect(hub.handle(ask(token(), tools(100)))).toEqual({ ok: true, accepted: 100 })
      clock.now += 100
    }

    expect(hub.handle(ask(token(), [tool('s1')]))).toEqual({ ok: false, error: 'too many events' })

    // A second after the first two requests: room for two more.
    clock.now += 700
    expect(hub.handle(ask(token(), tools(100)))).toEqual({ ok: true, accepted: 100 })
    expect(hub.handle(ask(token(), tools(100)))).toEqual({ ok: true, accepted: 100 })
    expect(hub.handle(ask(token(), [tool('s1')]))).toEqual({ ok: false, error: 'too many events' })
  })

  it('takes at most 50 requests a second', () => {
    const { hub, token, clock } = setup()

    for (let round = 0; round < 50; round++) {
      expect(hub.handle(ask(token(), []))).toEqual({ ok: true, accepted: 0 })
    }

    expect(hub.handle(ask(token(), []))).toEqual({ ok: false, error: 'too many events' })

    clock.now += 1000
    expect(hub.handle(ask(token(), []))).toEqual({ ok: true, accepted: 0 })
  })

  it('does not hold requests back for long when the clock is set back', () => {
    const { hub, token, clock } = setup()

    for (let round = 0; round < 50; round++) {
      hub.handle(ask(token(), []))
    }

    clock.now -= 60 * 60_000
    expect(hub.handle(ask(token(), [tool('s1')]))).toEqual({ ok: true, accepted: 1 })
  })

  it('hands a window nothing from a refused request', () => {
    const { hub, token } = setup()
    const window = new FakeWindow(1)
    hub.watch(window, true)

    for (let round = 0; round < 4; round++) {
      hub.handle(ask(token(), tools(100)))
    }

    hub.handle(ask(token(), [tool('refused')]))

    expect(window.batches).toHaveLength(4)
    expect(window.batches.flat().some(event => event.session === 'refused')).toBe(false)
  })
})

describe('the control file', () => {
  it('names the socket and the token only while live detail is on, for this user alone', () => {
    const { hub, control, controlFile, dataDir } = setup()
    const observe = path.join(dataDir, 'observe')

    expect(control()).toEqual({ v: 1, pid: PID, live: true, socket: SOCKET, token: nthToken(1) })
    expect(fs.statSync(controlFile).mode & 0o777).toBe(0o600)
    expect(fs.statSync(observe).mode & 0o777).toBe(0o700)

    hub.setPrefs(OFF)
    expect(control()).toEqual({ v: 1, pid: PID, live: false })
    expect(fs.statSync(controlFile).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(observe)).toEqual([`${PID}.json`])

    hub.stop()
    expect(fs.existsSync(controlFile)).toBe(false)

    hub.setPrefs(LIVE)
    expect(fs.existsSync(controlFile)).toBe(false)
  })

  it('makes an observe folder that others could read this user’s alone', () => {
    const dataDir = tempDir()
    const observe = path.join(dataDir, 'observe')
    fs.mkdirSync(observe, { mode: 0o755 })
    fs.chmodSync(observe, 0o755)

    new ActivityHub({ dataDir, socket: SOCKET, pid: PID, alive: () => false }).start(OFF)

    expect(fs.statSync(observe).mode & 0o777).toBe(0o700)
  })

  it('removes the files of Heralds that are gone and leaves those of the ones still running', () => {
    const dataDir = tempDir()
    const observe = path.join(dataDir, 'observe')
    fs.mkdirSync(observe, { recursive: true })

    for (const name of ['111.json', '.111.json.tmp', '222.json', '.222.json.tmp', 'notes.txt', '333.json.bak', `${PID}.json`]) {
      fs.writeFileSync(path.join(observe, name), '{}')
    }

    const alive = vi.fn((pid: number) => pid === 222)
    new ActivityHub({ dataDir, socket: SOCKET, pid: PID, alive }).start(LIVE)

    expect(fs.readdirSync(observe).sort()).toEqual(['.222.json.tmp', `${PID}.json`, '222.json', '333.json.bak', 'notes.txt'].sort())
    expect(alive).not.toHaveBeenCalledWith(PID)
    expect(JSON.parse(fs.readFileSync(path.join(observe, `${PID}.json`), 'utf8'))).toMatchObject({ v: 1, pid: PID, live: true })
  })
})
