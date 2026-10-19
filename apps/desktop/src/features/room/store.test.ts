import type { ServerRequest, SessionActiveItem } from '@herald-os/client'
import { ROOM_PREFS_DEFAULTS, type RoomActivity, type RoomPrefs } from '../../../shared/room.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ROOM_TIMING } from './model/schedule.ts'

/*
 * Hermes, faked behind the gateway: every request is logged and answered from `hermes`, which a
 * test fills with sessions, buffered frames, helpers and open requests. Each test loads the store
 * afresh (its feed keeps module state), with the timers and the clock faked.
 */
const hermes = vi.hoisted(() => {
  type Frame = { type: string; session_id: string; seq: number; payload: Record<string, unknown> }
  const state = {
    open: true,
    calls: [] as Array<{ method: string; params: Record<string, unknown> }>,
    live: [] as Array<(event: unknown) => void>,
    guards: [] as Array<(request: unknown) => boolean | void>,
    sessions: [] as object[],
    buffers: {} as Record<string, Frame[]>,
    requests: {} as Record<string, Array<{ id: string; method: string; params: Record<string, unknown> }>>,
    helpers: [] as Record<string, unknown>[],
    toolProgress: 'all' as string,
    epoch: 'e1',
    missing: new Set<string>(),
    /** Answers to this method wait until `release()`. */
    hold: null as null | { method: string; waiting: Array<() => void> },
    atoms: {} as Record<string, { get: () => unknown; set: (value: unknown) => void }>,
    /** Herald's automations and each job's runs, the session database's rows and what Office and Canvas windows report. */
    jobs: [] as Record<string, unknown>[],
    runs: {} as Record<string, Record<string, unknown>[]>,
    stored: [] as Record<string, unknown>[],
    rest: [] as Array<{ path: string; query?: Record<string, unknown> }>,
    office: [] as unknown[],
    canvas: [] as unknown[],
    reply(method: string, params: Record<string, unknown>): unknown {
      switch (method) {
        case 'session.active_list':
          return { sessions: state.sessions }
        case 'session.events.since': {
          const sid = String(params.session_id)
          const frames = state.buffers[sid] ?? []
          const lastSeen = Number(params.last_seen ?? 0)

          return {
            events: frames.filter(frame => frame.seq > lastSeen),
            latest_seq: frames.at(-1)?.seq ?? 0,
            truncated: false,
            count: 0,
            epoch: state.epoch,
            open_requests: state.requests[sid] ?? []
          }
        }
        case 'delegation.status':
          return { active: state.helpers, paused: false, max_spawn_depth: 1, max_concurrent_children: 3 }
        case 'config.get':
          return { value: 'on', tool_progress: state.toolProgress }
        case 'approval.respond':
          return { resolved: 1 }
        default:
          return {}
      }
    }
  }

  return state
})

/** Main's side of the Room: live activity from Hermes outside Herald, which a test sends to whoever watches. */
const relay = vi.hoisted(() => {
  const state = {
    listeners: new Set<(events: unknown[]) => void>(),
    send(events: unknown[]) {
      for (const listener of state.listeners) {
        listener(events)
      }
    }
  }

  return state
})

const page = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const windowListeners = new Map<string, Set<() => void>>()
  const doc = {
    visibilityState: 'visible',
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener)
  }
  /** What the Room handed main for the activity log, batch by batch. */
  const logged: Array<Array<Record<string, unknown>>> = []
  const room = {
    watchActivity: (listener: (events: unknown[]) => void) => {
      relay.listeners.add(listener)

      return () => {
        relay.listeners.delete(listener)
      }
    },
    appendLog: (entries: Array<Record<string, unknown>>) => {
      logged.push(entries)
    },
    logDays: async () => [],
    readLog: async () => [],
    deleteLog: async () => undefined
  }
  const heraldOS = { office: { presence: async () => hermes.office }, canvas: { presence: async () => hermes.canvas }, room }
  const win = {
    innerWidth: 1440,
    innerHeight: 900,
    heraldOS,
    addEventListener: (type: string, listener: () => void) => {
      const set = windowListeners.get(type) ?? new Set()
      set.add(listener)
      windowListeners.set(type, set)
    },
    removeEventListener: (type: string, listener: () => void) => windowListeners.get(type)?.delete(listener)
  }
  Object.assign(globalThis, { document: doc, window: win })

  return {
    logged,
    hide(hidden: boolean) {
      doc.visibilityState = hidden ? 'hidden' : 'visible'

      for (const listener of listeners) {
        listener()
      }
    },
    leave() {
      for (const listener of windowListeners.get('pagehide') ?? []) {
        listener()
      }
    }
  }
})

const ui = vi.hoisted(() => ({ panels: false, main: true, answerApproval: (_id: unknown, _choice: unknown): boolean => true }))

vi.mock('../../store/gateway.ts', async () => {
  const { atom } = await import('nanostores')
  const { JSON_RPC_METHOD_NOT_FOUND, JsonRpcGatewayError } = await import('@herald-os/client')
  const atoms = { connection: atom('open'), epoch: atom(1), ready: atom({ replay_epoch: 'e1' }) }
  hermes.atoms = atoms as never

  return {
    $connection: atoms.connection,
    $connectionEpoch: atoms.epoch,
    $gatewayReady: atoms.ready,
    isGatewayOpen: () => hermes.open,
    gatewayRequest: (method: string, params: Record<string, unknown>) => {
      hermes.calls.push({ method, params })

      if (hermes.missing.has(method)) {
        return Promise.reject(new JsonRpcGatewayError(`method not found: ${method}`, { code: JSON_RPC_METHOD_NOT_FOUND }))
      }

      if (hermes.hold?.method === method) {
        const answer = hermes.reply(method, params)

        return new Promise(resolve => {
          hermes.hold!.waiting.push(() => resolve(answer))
        })
      }

      return Promise.resolve(hermes.reply(method, params))
    },
    onAnyGatewayEvent: (handler: (event: unknown) => void) => {
      hermes.live.push(handler)

      return () => {
        hermes.live = hermes.live.filter(entry => entry !== handler)
      }
    },
    onServerRequest: (handler: (request: unknown) => boolean | void) => {
      hermes.guards.push(handler)

      return () => {
        hermes.guards = hermes.guards.filter(entry => entry !== handler)
      }
    }
  }
})

vi.mock('../../store/requests.ts', async () => {
  const { atom } = await import('nanostores')

  return { $pendingRequests: atom([]) }
})

vi.mock('../../store/chat.ts', async () => {
  const { atom } = await import('nanostores')

  return { $chats: atom({}), $activeChatId: atom(null), openStoredSession: vi.fn(async () => ({})) }
})

vi.mock('../../store/sessions.ts', async () => {
  const { atom } = await import('nanostores')

  return { $sessions: atom([]) }
})

vi.mock('../../store/shell.ts', () => ({
  get isPanels() {
    return ui.panels
  },
  get isMainSurface() {
    return ui.main
  },
  openSurface: vi.fn(),
  relayToMain: vi.fn(),
  onShellCommand: vi.fn(() => () => undefined)
}))

vi.mock('../automations/api.ts', () => ({
  cronApi: {
    list: vi.fn(async () => {
      hermes.rest.push({ path: '/api/cron/jobs' })

      return hermes.jobs.map(job => ({ ...job }))
    }),
    runs: vi.fn(async (job: { id: string }) => {
      hermes.rest.push({ path: `/api/cron/jobs/${job.id}/runs` })

      return (hermes.runs[job.id] ?? []).map(entry => ({ ...entry }))
    })
  }
}))

vi.mock('../../store/automations.ts', () => ({ eventRuleFor: () => undefined }))

vi.mock('../../lib/rest.ts', () => ({
  rest: {
    get: vi.fn(async (path: string, query?: Record<string, unknown>) => {
      hermes.rest.push({ path, query })

      return { sessions: hermes.stored }
    })
  }
}))

vi.mock('./prefs.ts', async () => {
  const { atom } = await import('nanostores')
  const { ROOM_PREFS_DEFAULTS } = await import('../../../shared/room.ts')

  return { $roomPrefs: atom({ ...ROOM_PREFS_DEFAULTS }) }
})

vi.mock('../../store/windows.ts', () => ({ showPage: vi.fn() }))
vi.mock('../pet/brain.ts', () => ({ answerApproval: vi.fn((id: unknown, choice: unknown) => ui.answerApproval(id, choice)) }))

const ALLOWED = new Set(['session.active_list', 'session.events.since', 'delegation.status', 'config.get', 'approval.respond'])
const T0 = 1_750_000_000_000

function row(id: string, status: SessionActiveItem['status'], title = '', key = `stored-${id}`): SessionActiveItem {
  return { current: false, id, last_active: 1, message_count: 1, model: 'm', preview: 'never kept', session_key: key, started_at: 1_700_000_000, status, title }
}

function buffer(sid: string, ...frames: Array<[string, Record<string, unknown>?]>): void {
  const list = (hermes.buffers[sid] ??= [])

  for (const [type, payload] of frames) {
    list.push({ type, session_id: sid, seq: (list.at(-1)?.seq ?? 0) + 1, payload: payload ?? {} })
  }
}

function approvalRequest(sid: string, requestId = 'apr-1', rpcId = 'srq-1') {
  return { id: rpcId, method: 'approval', params: { session_id: sid, request_id: requestId, command: 'rm a.txt', description: 'Delete a.txt', choices: ['once', 'session', 'deny'] } }
}

const calls = (method?: string) => hermes.calls.filter(call => !method || call.method === method)
const flush = () => vi.advanceTimersByTimeAsync(0)
const releases: Array<() => void> = []

function hold(method: string): void {
  hermes.hold = { method, waiting: [] }
}

function release(): void {
  const waiting = hermes.hold?.waiting ?? []
  hermes.hold = null

  for (const answer of waiting) {
    answer()
  }
}

async function load() {
  vi.resetModules()

  const store = await import('./store.ts')
  const requests = await import('../../store/requests.ts')
  const chat = await import('../../store/chat.ts')
  const shell = await import('../../store/shell.ts')
  const windows = await import('../../store/windows.ts')
  const brain = await import('../pet/brain.ts')
  const prefs = await import('./prefs.ts')
  const commands = await import('../../store/os-commands.ts')

  // The mocked prefs keep one atom across loads.
  const roomPrefs = prefs.$roomPrefs as unknown as { set: (value: RoomPrefs) => void }

  roomPrefs.set({ ...ROOM_PREFS_DEFAULTS })
  requests.$pendingRequests.set([])
  chat.$chats.set({})
  chat.$activeChatId.set(null)
  hermes.atoms.connection.set('open')
  hermes.atoms.epoch.set(1)

  const retain = () => {
    const off = store.retainRoom()
    releases.push(off)

    return off
  }

  return { store, retain, requests, chat, shell, windows, brain, prefs, commands }
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  vi.clearAllMocks()
  Object.assign(hermes, { open: true, calls: [], live: [], guards: [], sessions: [], buffers: {}, requests: {}, helpers: [], toolProgress: 'all', epoch: 'e1', missing: new Set(), hold: null, jobs: [], runs: {}, stored: [], rest: [], office: [], canvas: [] })
  relay.listeners.clear()
  page.logged.splice(0)
  ui.panels = false
  ui.main = true
  ui.answerApproval = () => true
})

afterEach(() => {
  for (const off of releases.splice(0)) {
    off()
  }

  page.hide(false)
  expect(calls().filter(call => !ALLOWED.has(call.method))).toEqual([])
  vi.useRealTimers()
})

describe('the feed', () => {
  it('asks Hermes nothing until something retains the Room, and stops when it is released', async () => {
    hermes.sessions = [row('live-1', 'idle')]
    const { retain } = await load()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toEqual([])

    const off = retain()
    await flush()
    expect(new Set(calls().map(call => call.method))).toEqual(new Set(['session.active_list', 'delegation.status', 'config.get', 'session.events.since']))

    off()
    const before = calls().length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls().length).toBe(before)
  })

  it('reads the list first, then a first read of each session takes only the tail of its buffer', async () => {
    hermes.sessions = [row('live-1', 'working', 'Budget review')]
    buffer('live-1', ['message.start'], ['tool.start', { tool_id: 't', name: 'read_file', args: { path: '/x/Budget.xlsx' } }])
    const { store, retain } = await load()

    retain()
    await flush()

    expect(calls()[0].method).toBe('session.active_list')
    expect(calls('session.events.since').map(call => call.params)).toEqual([
      { session_id: 'live-1', last_seen: Number.MAX_SAFE_INTEGER },
      { session_id: 'live-1', last_seen: 0 }
    ])
    expect(store.$room.get().agents['s:live-1']).toMatchObject({ title: 'Budget review', phase: 'tool', area: 'files', step: 'reading Budget.xlsx' })
    expect(JSON.stringify(store.$room.get())).not.toContain('never kept')
  })

  it('polls often while an agent works and rarely when it is quiet', async () => {
    hermes.sessions = [row('live-1', 'working')]
    buffer('live-1', ['message.start'])
    const { retain } = await load()

    retain()
    await flush()
    hermes.calls = []
    await vi.advanceTimersByTimeAsync(30_000)

    expect(calls('session.active_list')).toHaveLength(10)
    expect(calls('session.events.since')).toHaveLength(30)
    expect(calls('delegation.status')).toHaveLength(1)
    expect(calls('config.get')).toHaveLength(0)

    hermes.sessions = [row('live-1', 'idle')]
    buffer('live-1', ['message.complete', { status: 'complete' }])
    await vi.advanceTimersByTimeAsync(3_000)
    hermes.calls = []
    await vi.advanceTimersByTimeAsync(60_000)

    expect(calls('session.active_list')).toHaveLength(4)
    expect(calls('session.events.since')).toHaveLength(6)
    expect(calls('delegation.status')).toHaveLength(3)
    expect(calls('config.get')).toHaveLength(1)
  })

  it('reads the list soon after sessions.changed', async () => {
    const { retain } = await load()

    retain()
    await flush()
    hermes.calls = []
    hermes.live.forEach(handler => handler({ type: 'sessions.changed', payload: {} }))
    await vi.advanceTimersByTimeAsync(499)
    expect(calls('session.active_list')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls('session.active_list')).toHaveLength(1)
  })

  it('pauses while its window is hidden and catches up at once when it shows again', async () => {
    hermes.sessions = [row('live-1', 'working')]
    const { retain } = await load()

    retain()
    await flush()
    page.hide(true)
    hermes.calls = []
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toEqual([])

    page.hide(false)
    await flush()
    expect(calls('session.active_list')).toHaveLength(1)
  })

  it('does nothing while the gateway is closed and starts when it opens', async () => {
    hermes.open = false
    const { retain } = await load()

    retain()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls()).toEqual([])

    hermes.open = true
    hermes.atoms.connection.set('open-again')
    await flush()
    expect(calls('session.active_list')).toHaveLength(1)
  })

  it('keeps going one request per method and session at a time', async () => {
    hermes.sessions = [row('live-1', 'working')]
    hold('session.active_list')
    const { store, retain } = await load()

    retain()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls('session.active_list')).toHaveLength(1)

    release()
    await flush()
    expect(store.$room.get().agents['s:live-1']).toBeDefined()
  })
})

describe('without the methods it needs', () => {
  it('goes on from live frames when there is no session.active_list', async () => {
    hermes.missing.add('session.active_list')
    const { store, retain } = await load()

    retain()
    await flush()
    hermes.live.forEach(handler => handler({ type: 'message.start', session_id: 'live-9', seq: 1, payload: {}, replayEpoch: 'e1' }))
    await vi.advanceTimersByTimeAsync(150)

    expect(store.$room.get().caps.activeList).toBe(false)
    expect(store.$room.get().agents['s:live-9'].phase).toBe('thinking')

    hermes.calls = []
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls('session.active_list')).toEqual([])
    expect(calls('session.events.since').length).toBeGreaterThan(0)
  })

  it('takes live frames only when there is no session.events.since', async () => {
    hermes.missing.add('session.events.since')
    hermes.sessions = [row('live-1', 'working')]
    const { store, retain } = await load()

    retain()
    await flush()
    expect(store.$room.get().caps.eventsSince).toBe(false)

    hermes.calls = []
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls('session.events.since')).toEqual([])

    hermes.live.forEach(handler => handler({ type: 'tool.start', session_id: 'live-1', seq: 4, payload: { tool_id: 't', name: 'web_search', args: {} } }))
    await vi.advanceTimersByTimeAsync(150)
    expect(store.$room.get().agents['s:live-1'].step).toBe('searching the web')
  })

  it('takes helpers from their frames when there is no delegation.status', async () => {
    hermes.missing.add('delegation.status')
    hermes.sessions = [row('live-1', 'working')]
    buffer('live-1', ['message.start'], ['subagent.start', { subagent_id: 'h1', goal: 'Find hotels', task_count: 1, task_index: 0 }])
    const { store, retain } = await load()

    retain()
    await flush()
    hermes.calls = []
    await vi.advanceTimersByTimeAsync(10_000)

    expect(store.$room.get().caps.delegation).toBe(false)
    expect(calls('delegation.status')).toEqual([])
    expect(store.$room.get().agents['h:h1']).toMatchObject({ kind: 'helper', parentId: 's:live-1', phase: 'thinking' })
  })

  it("does without Hermes's tool progress setting when config.get is missing", async () => {
    hermes.missing.add('config.get')
    const { store, retain } = await load()

    retain()
    await flush()
    hermes.calls = []
    await vi.advanceTimersByTimeAsync(180_000)

    expect(store.$room.get()).toMatchObject({ toolProgress: null, caps: { config: false } })
    expect(calls('config.get')).toEqual([])
  })

  it("reads Hermes's tool progress setting when it has one", async () => {
    hermes.toolProgress = 'off'
    const { store, retain } = await load()

    retain()
    await flush()

    expect(store.$room.get().toolProgress).toBe('off')
    expect(calls('config.get')[0].params).toEqual({ key: 'focus' })
  })
})

describe('live and polled frames', () => {
  it('applies each frame once, whichever way it came first', async () => {
    hermes.sessions = [row('live-1', 'working')]
    const call = { tool_id: 't1', name: 'read_file', args: { path: 'a.md' } }
    buffer('live-1', ['message.start'], ['tool.start', call])
    const { store, retain } = await load()

    retain()
    await flush()
    hermes.live.forEach(handler => handler({ type: 'tool.start', session_id: 'live-1', seq: 2, payload: call, replayEpoch: 'e1' }))
    buffer('live-1', ['tool.start', { ...call, tool_id: 't2' }])
    await vi.advanceTimersByTimeAsync(150)
    hermes.live.forEach(handler => handler({ type: 'tool.start', session_id: 'live-1', seq: 3, payload: { ...call, tool_id: 't2' }, replayEpoch: 'e1' }))
    await vi.advanceTimersByTimeAsync(3_000)

    expect(store.$room.get().agents['s:live-1'].repeat?.count).toBe(2)
    expect(store.$room.get().seen['live-1']).toBe(3)
  })

  it('starts over when the backend restarts or the connection is new', async () => {
    hermes.sessions = [row('live-1', 'working')]
    buffer('live-1', ['message.start'])
    const { store, retain } = await load()

    retain()
    await flush()
    expect(store.$room.get().epoch).toBe('e1')

    hermes.epoch = 'e2'
    hermes.sessions = [row('live-7', 'idle')]
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.$room.get().agents['s:live-1']).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(Object.keys(store.$room.get().agents)).toEqual(['s:live-7'])
    expect(store.$room.get().epoch).toBe('e2')

    hermes.calls = []
    hermes.atoms.epoch.set(2)
    await flush()
    expect(calls('session.active_list')).toHaveLength(1)
    expect(calls('session.events.since')[0].params).toEqual({ session_id: 'live-7', last_seen: Number.MAX_SAFE_INTEGER })
  })
})

describe('re-delivered requests', () => {
  const request = (sessionId: string, replayed: boolean) => ({ id: 'srq-1', method: 'approval', params: { session_id: sessionId, request_id: 'apr-1' }, replayed, respond: vi.fn(), fail: vi.fn() }) as unknown as ServerRequest

  it("stay out of this window when they come back from the Room's read of a session another window holds", async () => {
    hermes.sessions = [row('live-1', 'waiting'), row('mine', 'waiting')]
    hermes.requests['live-1'] = [approvalRequest('live-1')]
    hold('session.events.since')
    const { retain, chat } = await load()
    const [guard] = hermes.guards

    chat.$chats.set({ mine: {} } as never)
    retain()
    await flush()

    expect(guard(request('live-1', true))).toBe(true)
    expect(guard(request('live-1', false))).toBe(false)
    expect(guard(request('mine', true))).toBe(false)
    expect(guard(request('elsewhere', true))).toBe(false)

    release()
    await flush()
    expect(guard(request('live-1', true))).toBe(false)
  })

  it("are not read again while this window holds one for that session, so an answer cannot bring the card back", async () => {
    hermes.sessions = [row('mine', 'waiting')]
    const { store, retain, chat, requests } = await load()

    chat.$chats.set({ mine: {} } as never)
    requests.$pendingRequests.set([{ kind: 'approval', receivedAt: 1, request: { id: 'srq-1', method: 'approval', params: { session_id: 'mine', request_id: 'apr-1' } } }] as never)
    retain()
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(calls('session.events.since')).toEqual([])
    expect(store.$room.get().agents['s:mine'].approval).toMatchObject({ requestId: 'apr-1', rpcId: 'srq-1' })

    requests.$pendingRequests.set([])
    await flush()
    expect(calls('session.events.since').length).toBeGreaterThan(0)
  })
})

describe('approvals', () => {
  it('are answered in the window that holds them, through its own card', async () => {
    hermes.sessions = [row('mine', 'waiting')]
    const { store, retain, chat, requests, brain } = await load()

    chat.$chats.set({ mine: {} } as never)
    requests.$pendingRequests.set([{ kind: 'approval', receivedAt: 1, request: { id: 'srq-1', method: 'approval', params: { session_id: 'mine', request_id: 'apr-1', choices: ['once', 'deny'] } } }] as never)
    retain()
    await flush()

    expect(await store.answerRoomApproval('s:mine', 'once')).toBe(true)
    expect(brain.answerApproval).toHaveBeenCalledWith('srq-1', 'once')
    expect(calls('approval.respond')).toEqual([])
    expect(store.$room.get().agents['s:mine'].approval).toBeNull()
  })

  it('are answered through approval.respond from a window that does not hold them', async () => {
    hermes.sessions = [row('live-1', 'waiting')]
    hermes.requests['live-1'] = [approvalRequest('live-1')]
    const { store, retain, brain } = await load()

    retain()
    await flush()
    expect(store.$room.get().agents['s:live-1'].step).toBe('waiting for your OK')

    expect(await store.answerRoomApproval('s:live-1', 'session')).toBe(true)
    expect(calls('approval.respond').map(call => call.params)).toEqual([{ session_id: 'live-1', request_id: 'apr-1', choice: 'session' }])
    expect(brain.answerApproval).not.toHaveBeenCalled()
    expect(store.$room.get().agents['s:live-1'].approval).toBeNull()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.$room.get().agents['s:live-1'].approval).toBeNull()
  })

  it('take only an answer the card offers, and only for a sign that is up', async () => {
    hermes.sessions = [row('live-1', 'waiting')]
    hermes.requests['live-1'] = [{ ...approvalRequest('live-1'), params: { ...approvalRequest('live-1').params, choices: ['once', 'always', 'deny'], allow_permanent: false } }]
    const { store, retain } = await load()

    retain()
    await flush()

    expect(await store.answerRoomApproval('s:live-1', 'always')).toBe(false)
    expect(await store.answerRoomApproval('s:nobody', 'once')).toBe(false)
    expect(calls('approval.respond')).toEqual([])
    expect(store.$room.get().agents['s:live-1'].approval).not.toBeNull()
  })

  it('are never answered by the Room on its own', async () => {
    hermes.sessions = [row('live-1', 'waiting'), row('mine', 'waiting')]
    hermes.requests['live-1'] = [approvalRequest('live-1')]
    const { store, retain, chat, requests, brain } = await load()

    chat.$chats.set({ mine: {} } as never)
    requests.$pendingRequests.set([{ kind: 'approval', receivedAt: 1, request: { id: 'srq-2', method: 'approval', params: { session_id: 'mine', request_id: 'apr-2' } } }] as never)
    retain()
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(calls('approval.respond')).toEqual([])
    expect(brain.answerApproval).not.toHaveBeenCalled()
    expect(store.$room.get().agents['s:live-1'].approval?.requestId).toBe('apr-1')
    expect(store.$room.get().agents['s:mine'].approval?.requestId).toBe('apr-2')
  })

  it('come back when approval.respond could not be sent', async () => {
    hermes.sessions = [row('live-1', 'waiting')]
    hermes.requests['live-1'] = [approvalRequest('live-1')]
    const { store, retain } = await load()

    retain()
    await flush()
    hermes.missing.add('approval.respond')

    expect(await store.answerRoomApproval('s:live-1', 'deny')).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.$room.get().agents['s:live-1'].approval?.requestId).toBe('apr-1')
  })
})

describe('one look for room.status', () => {
  it('reads the list, the helpers and each session once, then leaves Hermes alone', async () => {
    hermes.sessions = [row('live-1', 'working', 'Trip plan', 'stored-T')]
    buffer('live-1', ['message.start'], ['tool.start', { tool_id: 't', name: 'web_search', args: { query: 'hotels' } }])
    hermes.helpers = [{ subagent_id: 'h1', goal: 'Find hotels', status: 'running', tool_count: 1, last_tool: 'browser_navigate', owner_agent_session_id: 'stored-T' }]
    const { store } = await load()
    const state = await store.refreshRoomOnce()

    expect(calls().map(call => call.method)).toEqual(['session.active_list', 'delegation.status', 'session.events.since', 'session.events.since'])
    expect(state.agents['s:live-1'].step).toBe('searching the web')
    expect(state.agents['h:h1']).toMatchObject({ parentId: 's:live-1', step: 'browsing the web' })

    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls()).toHaveLength(4)
  })

  it('answers with what it has when the gateway is closed', async () => {
    hermes.open = false
    const { store } = await load()

    expect(await store.refreshRoomOnce()).toBe(store.$room.get())
    expect(calls()).toEqual([])
  })
})

describe('opening an agent in Hermes', () => {
  async function withAgents() {
    hermes.sessions = [row('live-1', 'working', 'Trip plan', 'stored-T')]
    hermes.helpers = [{ subagent_id: 'h1', goal: 'Find hotels', status: 'running', owner_agent_session_id: 'stored-T' }]
    const loaded = await load()
    await loaded.store.refreshRoomOnce()

    return loaded
  }

  it('selects the chat this window has open', async () => {
    const { store, chat, windows } = await withAgents()

    chat.$chats.set({ 'live-1': { sessionId: 'live-1', storedSessionId: 'stored-T' } } as never)
    store.openRoomAgent('h:h1')

    expect(chat.$activeChatId.get()).toBe('live-1')
    expect(chat.openStoredSession).not.toHaveBeenCalled()
    expect(windows.showPage).toHaveBeenCalledWith('hermes')
  })

  it("opens the stored conversation when it is not open here, a helper's being its parent's", async () => {
    const { store, chat, windows } = await withAgents()

    store.openRoomAgent('h:h1')

    expect(chat.openStoredSession).toHaveBeenCalledWith('stored-T')
    expect(windows.showPage).toHaveBeenCalledWith('hermes')
  })

  it('asks the Hermes window to open it in panels mode', async () => {
    ui.panels = true
    const { store, shell, windows } = await withAgents()

    store.openRoomAgent('s:live-1')

    expect(shell.openSurface).toHaveBeenCalledWith('main', { type: 'open-session', args: ['stored-T'] })
    expect(windows.showPage).not.toHaveBeenCalled()
  })
})

describe('phase 2 feeds', () => {
  // The mock holds a plain atom where the app derives one from prefs.json.
  const roomPrefs = (prefs: { $roomPrefs: unknown }) => prefs.$roomPrefs as { set: (value: RoomPrefs) => void }
  const restCalls = (path: string) => hermes.rest.filter(call => call.path === path)

  it('reads Herald’s automations and the latest run of each job that moved, and again soon after cron.changed', async () => {
    hermes.jobs = [{ id: 'j1', name: 'Morning digest', prompt: 'never kept', state: 'scheduled', enabled: true, last_run_at: null, last_status: null, next_run_at: 1_750_000_100 }]
    hermes.runs = { j1: [{ id: 'cron_j1_20260101_000000', started_at: T0 / 1000, ended_at: null, is_active: true, title: 'never kept' }] }
    const { store, retain } = await load()

    retain()
    await flush()

    expect(restCalls('/api/cron/jobs')).toHaveLength(1)
    expect(restCalls('/api/cron/jobs/j1/runs')).toHaveLength(1)
    expect(store.$room.get().agents['a::j1']).toMatchObject({ kind: 'automation', title: 'Morning digest', phase: 'tool', area: 'automations', step: 'running' })
    expect(JSON.stringify(store.$room.get())).not.toContain('never kept')

    hermes.jobs = [{ ...hermes.jobs[0], last_run_at: (T0 + 30_000) / 1000, last_status: 'ok', next_run_at: 1_750_086_400 }]
    hermes.runs = { j1: [{ id: 'cron_j1_20260101_000000', started_at: T0 / 1000, ended_at: (T0 + 30_000) / 1000, is_active: false }] }
    await vi.advanceTimersByTimeAsync(30_000)

    for (const handler of hermes.live) {
      handler({ type: 'cron.changed', payload: {} })
    }

    await vi.advanceTimersByTimeAsync(1_000)

    expect(store.$room.get().agents['a::j1']).toMatchObject({ phase: 'idle', area: 'automations', step: null })
    expect(store.$room.get().agents['a::j1'].automation).toMatchObject({ running: false, lastOutcome: 'ok' })
  })

  it('reads every job’s latest run after cron.changed, as a run can start without its job’s record showing it', async () => {
    hermes.jobs = [{ id: 'j1', name: 'Morning digest', state: 'scheduled', enabled: true, next_run_at: 1_750_000_100 }, { id: 'j2', name: 'Weekly report', state: 'scheduled', enabled: true, next_run_at: 1_750_500_000 }]
    const { store, retain } = await load()

    retain()
    await vi.advanceTimersByTimeAsync(6_000)
    hermes.rest = []
    hermes.runs = { j2: [{ id: 'cron_j2_20260101_000000', started_at: Date.now() / 1000, ended_at: null, is_active: true }] }

    for (const handler of hermes.live) {
      handler({ type: 'cron.changed', payload: {} })
    }

    await vi.advanceTimersByTimeAsync(1_000)

    expect(restCalls('/api/cron/jobs/j1/runs')).toHaveLength(1)
    expect(restCalls('/api/cron/jobs/j2/runs')).toHaveLength(1)
    expect(store.$room.get().agents['a::j2']).toMatchObject({ phase: 'tool', step: 'running' })
    expect(store.$room.get().agents['a::j1']).toMatchObject({ phase: 'idle' })
  })

  it('never reads the session database until the lane is on, reads it at most once a minute, and empties the lane when it is turned off', async () => {
    hermes.stored = [
      { id: 'tg1', source: 'telegram', title: 'Support bot', preview: 'never kept', is_active: true, last_active: T0 / 1000, started_at: T0 / 1000 - 60 },
      { id: 'own', source: 'herald_os', title: 'Herald chat', is_active: true, last_active: T0 / 1000 }
    ]
    const { store, retain, prefs } = await load()

    retain()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(restCalls('/api/sessions')).toHaveLength(0)

    roomPrefs(prefs).set({ ...prefs.$roomPrefs.get(), elsewhere: true })
    await flush()

    expect(restCalls('/api/sessions')).toEqual([{ path: '/api/sessions', query: { limit: 40, order: 'recent', exclude_sources: 'herald_os,hermes_os,tool' } }])
    expect(store.$room.get().agents['e:tg1']).toMatchObject({ kind: 'elsewhere', area: 'elsewhere', title: 'Support bot' })
    expect(store.$room.get().agents['e:own']).toBeUndefined()
    expect(JSON.stringify(store.$room.get())).not.toContain('never kept')

    await vi.advanceTimersByTimeAsync(59_000)
    expect(restCalls('/api/sessions')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(restCalls('/api/sessions')).toHaveLength(2)

    roomPrefs(prefs).set({ ...prefs.$roomPrefs.get(), elsewhere: false })
    await flush()

    expect(store.$room.get().agents['e:tg1']).toBeUndefined()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(restCalls('/api/sessions')).toHaveLength(2)
  })

  it('puts open documents on desks, and an agent’s command with its session moves that agent to the document it named', async () => {
    hermes.office = [{ app: 'docs', at: T0, active: 'k1', documents: [{ key: 'k1', name: 'Launch plan.docx', selection: 'never kept' }, { key: 'k2', name: 'Notes.docx' }] }]
    hermes.sessions = [row('live-1', 'working', 'Launch'), row('live-2', 'working', 'Notes')]
    buffer('live-1', ['message.start'], ['tool.start', { tool_id: 't1', name: 'docs', args: { action: 'write' } }])
    buffer('live-2', ['message.start'], ['tool.start', { tool_id: 't2', name: 'docs', args: { action: 'write' } }])
    const { store, retain, commands } = await load()

    retain()
    await flush()
    await vi.advanceTimersByTimeAsync(10)

    expect(store.$room.get().desks).toMatchObject({ 'docs:k1': { name: 'Launch plan.docx', front: true }, 'docs:k2': { name: 'Notes.docx' } })
    expect(store.$room.get().agents['s:live-1'].desk).toBe('docs:k1')
    expect(store.$room.get().agents['s:live-2'].desk).toBe('docs:k1')
    expect(JSON.stringify(store.$room.get())).not.toContain('never kept')

    commands.$commandLog.set([{ id: 9, command: 'docs.write', args: { document: '~/Notes.docx', text: 'never kept' }, source: 'agent', result: { ok: true, summary: 'Wrote' }, ts: Date.now(), session: 'live-2' }])
    await flush()

    expect(store.$room.get().agents['s:live-1'].desk).toBe('docs:k1')
    expect(store.$room.get().agents['s:live-2'].desk).toBe('docs:k2')
    expect(store.$room.get().agents['s:live-2'].trace.desk).toMatchObject({ source: 'command', type: 'docs.write' })
    expect(JSON.stringify(store.$room.get())).not.toContain('never kept')
  })
})

describe('phase 3 feeds', () => {
  // The mock holds a plain atom where the app derives one from prefs.json.
  const roomPrefs = (prefs: { $roomPrefs: unknown }) => prefs.$roomPrefs as { get: () => RoomPrefs; set: (value: RoomPrefs) => void }
  const change = (prefs: { $roomPrefs: unknown }, patch: Partial<RoomPrefs>) => roomPrefs(prefs).set({ ...roomPrefs(prefs).get(), ...patch })
  const restCalls = (path: string) => hermes.rest.filter(call => call.path === path)
  const activity = (patch: Partial<RoomActivity> & Pick<RoomActivity, 'seq' | 'kind'>): RoomActivity => ({ session: 'tg1', child: null, tool: null, target: null, call: null, status: null, source: 'telegram', at: Date.now(), ...patch })
  const outside = (state: { agents: Record<string, unknown> }) => Object.keys(state.agents).filter(id => id.startsWith('e:'))

  it('watches live activity only while the Room is fed and both switches are on, and drops live detail when either goes off', async () => {
    const { store, retain, prefs } = await load()
    const off = retain()

    await flush()
    change(prefs, { elsewhereLive: true })
    await flush()
    expect(relay.listeners.size).toBe(0)

    change(prefs, { elsewhere: true })
    await flush()
    expect(relay.listeners.size).toBe(1)

    relay.send([activity({ seq: 1, kind: 'session.start' }), activity({ seq: 2, kind: 'tool.start', tool: 'read_file', target: 'Budget.xlsx', call: 'c1' })])
    await vi.advanceTimersByTimeAsync(200)
    expect(store.$room.get().agents['e:tg1']).toMatchObject({ kind: 'elsewhere', phase: 'tool', area: 'files', step: 'reading Budget.xlsx' })

    relay.send([activity({ seq: 3, kind: 'tool.end', tool: 'read_file', call: 'c1' })])
    change(prefs, { elsewhereLive: false })
    await vi.advanceTimersByTimeAsync(200)
    expect(relay.listeners.size).toBe(0)
    expect(store.$room.get().agents['e:tg1']).toMatchObject({ area: 'elsewhere', step: null, tool: null })
    expect(store.$room.get().agents['e:tg1'].elsewhere?.liveAt).toBeNull()

    change(prefs, { elsewhereLive: true })
    await flush()
    expect(relay.listeners.size).toBe(1)

    page.hide(true)
    expect(relay.listeners.size).toBe(0)
    page.hide(false)
    expect(relay.listeners.size).toBe(1)

    change(prefs, { elsewhere: false })
    await flush()
    expect(relay.listeners.size).toBe(0)
    expect(outside(store.$room.get())).toEqual([])

    change(prefs, { elsewhere: true })
    await flush()
    expect(relay.listeners.size).toBe(1)

    off()
    expect(relay.listeners.size).toBe(0)
  })

  it('brings in work outside Herald the moment live detail names it, and reads the lane early to name it', async () => {
    const { store, retain, prefs } = await load()

    change(prefs, { elsewhere: true, elsewhereLive: true })
    retain()
    await flush()
    expect(restCalls('/api/sessions')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(20_000)
    hermes.stored = [{ id: 'tg1', source: 'telegram', title: 'Support bot', is_active: true, last_active: Date.now() / 1000 }]
    relay.send([activity({ seq: 1, kind: 'session.start' })])
    await vi.advanceTimersByTimeAsync(200)

    expect(store.$room.get().agents['e:tg1']).toMatchObject({ title: '', phase: 'thinking', step: 'thinking' })
    expect(restCalls('/api/sessions')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(ROOM_TIMING.elsewhereSoonMs)
    expect(restCalls('/api/sessions')).toHaveLength(2)
    expect(store.$room.get().agents['e:tg1']).toMatchObject({ title: 'Support bot', phase: 'thinking', step: 'thinking' })
  })

  it("reads Herald's own sessions' costs only while a meter is on: once a minute, and soon after a turn ends", async () => {
    hermes.sessions = [row('live-1', 'idle', 'Budget review', 'stored-1')]
    hermes.stored = [{ id: 'stored-1', source: 'herald_os', title: 'never kept', preview: 'never kept', input_tokens: 900, output_tokens: 100, estimated_cost_usd: 0.02, actual_cost_usd: null, cost_status: 'estimated' }]
    const { store, retain, prefs } = await load()

    retain()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(restCalls('/api/sessions')).toHaveLength(0)

    change(prefs, { costs: true })
    await flush()
    expect(restCalls('/api/sessions')).toEqual([{ path: '/api/sessions', query: { limit: 40, order: 'recent', sources: 'herald_os,hermes_os' } }])
    expect(store.$room.get().agents['s:live-1'].usage).toMatchObject({ input: 900, output: 100, costUsd: 0.02, costStatus: 'estimated' })
    expect(JSON.stringify(store.$room.get())).not.toContain('never kept')

    await vi.advanceTimersByTimeAsync(20_000)
    hermes.sessions = [row('live-1', 'working', 'Budget review', 'stored-1')]
    buffer('live-1', ['message.start'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.$room.get().agents['s:live-1'].phase).toBe('thinking')

    hermes.sessions = [row('live-1', 'idle', 'Budget review', 'stored-1')]
    buffer('live-1', ['message.complete', { status: 'complete', usage: { input: 1_200, output: 150 } }])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.$room.get().agents['s:live-1'].phase).toBe('idle')
    expect(restCalls('/api/sessions')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(ROOM_TIMING.costsSoonMs)
    expect(restCalls('/api/sessions')).toHaveLength(2)
    expect(store.$room.get().agents['s:live-1'].usage).toMatchObject({ input: 1_200, output: 150, costUsd: 0.02 })

    change(prefs, { costs: false, costTotal: true })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(restCalls('/api/sessions').length).toBeGreaterThan(2)

    change(prefs, { costTotal: false })
    const before = restCalls('/api/sessions').length
    await vi.advanceTimersByTimeAsync(180_000)
    expect(restCalls('/api/sessions')).toHaveLength(before)
  })

  it('never calls the session.usage method, and takes usage from the frames of that name', async () => {
    hermes.sessions = [row('live-1', 'working', 'Budget review', 'stored-1')]
    buffer('live-1', ['message.start'], ['session.usage', { usage: { input: 100, output: 20, calls: 1, model: 'never kept' } }])
    const { store, retain, prefs } = await load()

    change(prefs, { costs: true, costTotal: true, elsewhere: true, elsewhereLive: true })
    retain()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.$room.get().agents['s:live-1'].usage).toMatchObject({ input: 100, output: 20, calls: 1 })

    buffer('live-1', ['session.usage', { usage: { input: 300, output: 40, calls: 2 } }])
    await vi.advanceTimersByTimeAsync(120_000)

    expect(store.$room.get().agents['s:live-1'].usage).toMatchObject({ input: 300, output: 40, calls: 2 })
    expect(store.$room.get().agents['s:live-1'].phase).toBe('thinking')
    expect(calls('session.usage')).toEqual([])
    expect(JSON.stringify(store.$room.get())).not.toContain('never kept')
  })

  it('keeps the lane’s token counts and cost only while a meter is on', async () => {
    hermes.stored = [{ id: 'tg1', source: 'telegram', title: 'Support bot', is_active: true, last_active: T0 / 1000, input_tokens: 4_321, output_tokens: 765, estimated_cost_usd: 0.0123, cost_status: 'estimated' }]
    const { store, retain, prefs } = await load()

    change(prefs, { elsewhere: true })
    retain()
    await flush()
    expect(store.$room.get().agents['e:tg1']).toMatchObject({ title: 'Support bot', usage: null })
    expect(JSON.stringify(store.$room.get())).not.toMatch(/4321|765|0\.0123/)

    change(prefs, { costs: true })
    await vi.advanceTimersByTimeAsync(ROOM_TIMING.elsewhereFloorMs)
    expect(store.$room.get().agents['e:tg1'].usage).toMatchObject({ input: 4_321, output: 765, costUsd: 0.0123, costStatus: 'estimated' })

    change(prefs, { costs: false })
    await vi.advanceTimersByTimeAsync(ROOM_TIMING.elsewhereMs)
    expect(store.$room.get().agents['e:tg1'].usage).toBeNull()
  })
})

describe('the activity log', () => {
  const roomPrefs = (prefs: { $roomPrefs: unknown }) => prefs.$roomPrefs as { get: () => RoomPrefs; set: (value: RoomPrefs) => void }
  const change = (prefs: { $roomPrefs: unknown }, patch: Partial<RoomPrefs>) => roomPrefs(prefs).set({ ...roomPrefs(prefs).get(), ...patch })
  const sent = () => page.logged.flat()
  const kinds = () => sent().map(entry => entry.k)
  const unbinds: Array<() => void> = []

  afterEach(() => {
    for (const off of unbinds.splice(0)) {
      off()
    }
  })

  async function logging() {
    const loaded = await load()
    unbinds.push(loaded.store.bindRoomLog())

    return loaded
  }

  it('feeds the Room for the log with nothing showing it, and only while the person keeps the log', async () => {
    hermes.sessions = [row('live-1', 'working', 'Budget review')]
    buffer('live-1', ['message.start'], ['tool.start', { tool_id: 't1', name: 'read_file', args: { path: '/Users/someone/Budget.xlsx', content: 'private text' } }])
    const { store, prefs } = await logging()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls()).toEqual([])
    expect(sent()).toEqual([])

    change(prefs, { log: true })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(calls('session.active_list').length).toBeGreaterThan(0)
    expect(kinds()[0]).toBe('begin')
    expect(sent()).toContainEqual(expect.objectContaining({ k: 'agent', id: 's:live-1', kind: 'conversation', phase: 'tool', area: 'files', step: 'reading Budget.xlsx', target: 'Budget.xlsx' }))
    expect(JSON.stringify(sent())).not.toMatch(/Budget review|private text|someone/)
    expect(store.$room.get().agents['s:live-1']).toBeTruthy()

    change(prefs, { log: false })
    await flush()
    expect(kinds().at(-1)).toBe('end')

    const before = calls().length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls().length).toBe(before)
  })

  it('logs while the Hermes window is hidden, and leaves the log ended when the page goes away', async () => {
    hermes.sessions = [row('live-1', 'idle')]
    const { prefs } = await logging()

    page.hide(true)
    change(prefs, { log: true })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(kinds()[0]).toBe('begin')
    expect(calls('session.active_list').length).toBeGreaterThan(0)

    page.leave()
    expect(kinds().at(-1)).toBe('end')
  })

  it('ends the log while Hermes is not connected and begins it again with what the Room shows', async () => {
    hermes.sessions = [row('live-1', 'idle')]
    const { prefs } = await logging()

    change(prefs, { log: true })
    await vi.advanceTimersByTimeAsync(3_000)
    hermes.open = false
    hermes.atoms.connection.set('closed')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(kinds().at(-1)).toBe('end')

    hermes.open = true
    hermes.atoms.connection.set('open')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(kinds().filter(kind => kind === 'begin')).toHaveLength(2)
  })

  it('begins again after the log was deleted, so the new file starts with what the Room shows', async () => {
    hermes.sessions = [row('live-1', 'idle')]
    const { store, prefs } = await logging()

    change(prefs, { log: true })
    await vi.advanceTimersByTimeAsync(3_000)
    page.logged.splice(0)

    store.restartRoomLog()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(kinds()).toEqual(['end', 'begin', 'agent'])
    expect(sent()[2]).toMatchObject({ id: 's:live-1', phase: 'idle' })
  })

  it('leaves the log to the Hermes window: another window of the Room logs nothing', async () => {
    ui.main = false
    const { store, prefs } = await load()

    unbinds.push(store.bindRoomLog())
    change(prefs, { log: true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls()).toEqual([])
    expect(sent()).toEqual([])
  })
})
