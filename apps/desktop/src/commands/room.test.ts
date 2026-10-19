import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_APPS as PANEL_WINDOWS } from '../../electron/shell/mode.ts'
import type { WmWindow } from '../../shared/ipc.ts'
import type { RoomSummary } from '../features/room/model/summary.ts'
import type { RoomState } from '../features/room/model/types.ts'
import { matchIntent } from '../lib/voice/intents.ts'
import { appById, LAUNCHABLE_APPS } from '../shell/apps.ts'
import { ourFloatingAppId } from '../shell/surfaces/shell-utils.ts'
import { COMMAND_ID, type CommandContext, defineCommands, resetCommands } from '../store/os-commands.ts'
import { $windows } from '../store/windows.ts'
import { commandGroups } from './index.ts'
import { resolveAppId } from './navigation.ts'
import { describeRoom, roomCommands } from './room.ts'

// The stores read the viewport and the motion setting when they load or open a window; tests run without a DOM.
vi.hoisted(() => {
  Object.assign(globalThis, {
    window: { innerWidth: 1440, innerHeight: 900, matchMedia: () => ({ matches: true }) },
    document: { documentElement: { dataset: {}, style: { setProperty: () => undefined, removeProperty: () => undefined } } }
  })
})

const room = vi.hoisted(() => ({ refresh: vi.fn(), summarize: vi.fn() }))

vi.mock('../features/room/store.ts', () => ({ refreshRoomOnce: room.refresh }))
vi.mock('../features/room/model/summary.ts', () => ({ summarizeRoom: room.summarize }))

const UI: CommandContext = { source: 'ui' }
const STATE: RoomState = { epoch: 'e1', agents: {}, seen: {}, handoffs: [], toolProgress: 'all', caps: { activeList: true, eventsSince: true, delegation: true, config: true, automations: true, sessionsDb: true }, updatedAt: 1 }
const LINES = ['Budget review: reading Budget.xlsx', 'Trip plan: waiting for your OK', 'Find flights: running a command', 'Notes: idle']

const summary = (counts: Partial<RoomSummary>): RoomSummary => ({ total: 0, working: 0, waiting: 0, idle: 0, helpers: 0, automations: 0, elsewhere: 0, lines: [], ...counts })

function command(id: string) {
  const found = roomCommands.find(entry => entry.id === id)

  if (!found) {
    throw new Error(`no command ${id}`)
  }

  return found
}

describe('the Pet Room commands', () => {
  beforeEach(() => {
    room.refresh.mockReset().mockResolvedValue(STATE)
    room.summarize.mockReset().mockReturnValue(summary({}))
  })

  it('use ids the registry accepts and take no arguments', () => {
    for (const entry of roomCommands) {
      expect(COMMAND_ID.test(entry.id), entry.id).toBe(true)
      expect(entry.args, entry.id).toEqual([])
    }
  })

  it('open one Pet Room, and bring it to the front rather than opening a second', async () => {
    const first = await command('room.open').run({}, UI)
    const again = await command('room.open').run({}, UI)
    const rooms = Object.values($windows.get()).filter(win => win.appId === 'room')

    expect(first).toMatchObject({ ok: true, summary: 'Opened the Pet Room' })
    expect(rooms).toHaveLength(1)
    expect(first.highlight).toEqual({ kind: 'window', id: rooms[0].id })
    expect(again.highlight).toEqual(first.highlight)
  })

  it('read out what the Room shows from a fresh look: the counts, then a line per agent', async () => {
    room.summarize.mockReturnValue(summary({ total: 4, working: 2, waiting: 1, idle: 1, helpers: 1, lines: LINES }))

    const result = await command('room.status').run({}, UI)

    expect(room.summarize).toHaveBeenCalledWith(STATE, expect.any(Number))
    expect(result).toMatchObject({ ok: true, data: { total: 4, working: 2, waiting: 1, idle: 1, helpers: 1, lines: LINES } })
    expect(result.summary).toBe(
      '4 agents in the Pet Room, 1 of them a helper: 2 at work, 1 waiting for you and 1 idle. Budget review: reading Budget.xlsx. Trip plan: waiting for your OK. Find flights: running a command. Notes: idle'
    )
  })

  it('say a plain fixed sentence when nothing is at work, idle conversations or not', async () => {
    room.summarize.mockReturnValue(summary({ total: 2, idle: 2, lines: ['Notes: idle', 'Recipes: idle'] }))
    const result = await command('room.status').run({}, UI)

    expect(result).toMatchObject({ ok: true, summary: 'Nothing is at work in the Pet Room right now', data: { total: 2, idle: 2 } })
    expect(describeRoom(summary({}))).toBe('Nothing is at work in the Pet Room right now')
  })

  it('count the agents past six instead of reading each one out', () => {
    const lines = Array.from({ length: 8 }, (_, index) => `Task ${index + 1}: thinking`)
    const text = describeRoom(summary({ total: 8, working: 8, helpers: 2, lines }))

    expect(text.startsWith('8 agents in the Pet Room, 2 of them helpers: 8 at work. Task 1: thinking.')).toBe(true)
    expect(text.endsWith('Task 6: thinking, and 2 more')).toBe(true)
    expect(describeRoom(summary({ total: 1, waiting: 1, lines: ['Trip plan: waiting for your OK'] }))).toBe('1 agent in the Pet Room: 1 waiting for you. Trip plan: waiting for your OK')
  })

  it('read out work outside Herald after the Room’s own, with the steps live detail brings', () => {
    const lines = ['Trip plan (mission): reading Budget.xlsx', 'Support bot (outside Herald): running a command']

    expect(describeRoom(summary({ total: 1, working: 1, elsewhere: 1, lines }))).toBe('1 agent in the Pet Room: 1 at work. Trip plan (mission): reading Budget.xlsx. Outside Herald: Support bot (outside Herald): running a command')
    expect(describeRoom(summary({ elsewhere: 1, lines: lines.slice(1) }))).toBe('Nothing is at work in the Pet Room right now. Outside Herald: Support bot (outside Herald): running a command')
  })

  it('say plainly when Hermes cannot be asked', async () => {
    room.refresh.mockRejectedValue(new Error('the gateway is closed'))

    expect(await command('room.status').run({}, UI)).toMatchObject({ ok: false, summary: "Could not look at Hermes's work: the gateway is closed" })
    expect(room.summarize).not.toHaveBeenCalled()
  })
})

describe('the Pet Room as an app', () => {
  it('is offered by the launcher and the command bar, and found by its English name', () => {
    expect(LAUNCHABLE_APPS.map(app => app.id)).toContain('room')
    expect(appById('room')).toMatchObject({ name: 'Pet Room', kind: 'window', icon: 'room' })
    expect(resolveAppId('the Pet Room')).toBe('room')
    expect(resolveAppId('room')).toBe('room')
  })

  it('has a window of its own in panels mode whose title the Dock maps back to it', () => {
    const win: WmWindow = { id: 7, title: PANEL_WINDOWS.room.title, appId: 'herald-os', pid: null, workspaceId: null, focused: false, floating: false, urgent: false, ours: true }

    expect(PANEL_WINDOWS.room.title).toBe('Herald OS · Pet Room')
    expect(ourFloatingAppId(win)).toBe('room')
    expect(ourFloatingAppId({ ...win, title: 'Herald OS · Pet' })).toBeNull()
  })
})

describe('the Pet Room on the voice fast path', () => {
  beforeEach(() => {
    resetCommands()
    defineCommands(Object.values(commandGroups).flat())
  })

  it('opens the Pet Room for the room, and still shows the pet for the pet', () => {
    expect(matchIntent('show the pet room')).toMatchObject({ command: 'room.open' })
    expect(matchIntent('Hey Hermes, show me the pet room')).toMatchObject({ command: 'room.open' })
    expect(matchIntent('open the room')).toMatchObject({ command: 'room.open' })
    expect(matchIntent('show what Hermes is doing')).toMatchObject({ command: 'room.open' })
    expect(matchIntent('show the pet')).toMatchObject({ command: 'pet.show' })
    expect(matchIntent('show me what you are doing')).toMatchObject({ command: 'studio.open' })
  })

  it('answers what Hermes is doing from the Room, and what the pet is doing from the pet', () => {
    expect(matchIntent('what is Hermes doing')).toMatchObject({ command: 'room.status' })
    expect(matchIntent("what's in the pet room")).toMatchObject({ command: 'room.status' })
    expect(matchIntent('what is the pet doing')).toMatchObject({ command: 'pet.status' })
  })
})
