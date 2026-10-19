// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import type { RoomLogAgent, RoomLogDay, RoomLogEntry } from '../../../../shared/room.ts'
import { RoomReplay } from './RoomReplay.tsx'

const room = vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const bridge = {
    logDays: vi.fn<() => Promise<RoomLogDay[]>>(),
    readLog: vi.fn<(day: string) => Promise<RoomLogEntry[]>>(),
    appendLog: vi.fn(),
    watchActivity: vi.fn(() => () => undefined),
    deleteLog: vi.fn(async () => undefined)
  }
  Object.assign(window, { heraldOS: { room: bridge } })

  return bridge
})

vi.mock('../assignment.ts', () => {
  const none = {}

  return { useRoomAssignment: () => none }
})

const at = (hours: number, minutes: number, date = 15) => new Date(2026, 9, date, hours, minutes).getTime()
const agent = (t: number, id: string, patch: Partial<RoomLogAgent> = {}): RoomLogAgent => ({ t, k: 'agent', id, kind: 'conversation', phase: 'idle', area: 'lounge', step: null, target: null, wait: false, parent: null, where: null, outcome: null, ...patch })

const TODAY: RoomLogEntry[] = [
  { t: at(9, 0), k: 'begin' },
  agent(at(9, 0), 'c1', { phase: 'tool', area: 'sheets', step: 'reading Budget.xlsx', target: 'Budget.xlsx' }),
  agent(at(9, 0), 'c2', { phase: 'waiting', area: 'bench', wait: true }),
  agent(at(9, 30), 'c1', { phase: 'thinking', area: 'sheets', step: null }),
  { t: at(12, 10), k: 'end' },
  { t: at(13, 45), k: 'begin' },
  agent(at(13, 45), 'c1'),
  agent(at(18, 30), 'c1', { phase: 'tool', area: 'docs', step: 'writing Notes.docx' })
]

const YESTERDAY: RoomLogEntry[] = [{ t: at(10, 0, 14), k: 'begin' }, agent(at(10, 0, 14), 'm1', { kind: 'mission', phase: 'thinking' }), { t: at(15, 42, 14), k: 'cap' }]

let host: HTMLDivElement
let root: Root
let onExit: Mock<() => void>

async function settle() {
  for (let round = 0; round < 6; round++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function open() {
  act(() => root.render(<RoomReplay onExit={onExit} />))
  await settle()
}

const slider = () => host.querySelector<HTMLInputElement>('input[type="range"]')!
const time = () => slider().getAttribute('aria-valuetext')
const button = (name: string) => [...host.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === name || element.textContent?.trim() === name) ?? null
const pets = () => [...host.querySelectorAll('ul[aria-label="What the pets are doing"] li')].map(item => item.textContent)
const press = (target: Element, key: string, init: KeyboardEventInit = {}) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })))

function scrubTo(hours: number, minutes: number) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!

  act(() => {
    setValue.call(slider(), String(hours * 60 + minutes))
    slider().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 15, 20, 0))
  room.logDays.mockReset().mockResolvedValue([
    { day: '2026-10-14', bytes: 300 },
    { day: '2026-10-15', bytes: 900 }
  ])
  room.readLog.mockReset().mockImplementation(async day => (day === '2026-10-15' ? TODAY : YESTERDAY))
  onExit = vi.fn<() => void>()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('RoomReplay', () => {
  it('is marked as a replay of today, from the start of its log', async () => {
    await open()

    expect(room.readLog).toHaveBeenCalledWith('2026-10-15')
    expect(host.querySelector('h1')?.textContent).toBe('Time-lapse')
    expect(host.textContent).toContain('Replay')
    expect(host.textContent).not.toContain('Pet Room')
    expect(button('Today')).not.toBeNull()
    expect(button('Back to live')).not.toBeNull()
    expect(time()).toBe('09:00')
  })

  it('goes back to live with its button or Escape', async () => {
    await open()
    act(() => button('Back to live')!.click())

    expect(onExit).toHaveBeenCalledTimes(1)

    press(slider(), 'Escape')

    expect(onExit).toHaveBeenCalledTimes(2)
  })

  it('leaves its pets inert: no buttons, no approval card, no titles', async () => {
    await open()

    expect(pets()).toEqual(['A conversation: reading Budget.xlsx.', 'A conversation: waiting for your OK. waited for your OK.'])
    expect(host.querySelectorAll('button[aria-label^="Open "], button[aria-label^="Show "]')).toHaveLength(0)
    expect(host.querySelector('[data-room-sign]')).toBeNull()
    expect(host.textContent).not.toContain('Allow once')
  })

  it('says plainly when nothing was logged, and shows an empty Room then', async () => {
    await open()
    scrubTo(12, 30)

    expect(host.textContent).toContain('Nothing was logged from 12:10 to 13:45')
    expect(pets()).toEqual([])
    expect(time()).toBe('12:30, nothing logged')

    scrubTo(8, 0)

    expect(host.textContent).toContain('Nothing was logged before 09:00')

    scrubTo(19, 0)

    expect(host.textContent).toContain('Nothing was logged after 18:30')

    scrubTo(14, 0)

    expect(host.textContent).not.toContain('Nothing was logged')
    expect(pets()).toEqual(['A conversation: resting.'])
  })

  it('moves by a minute on the arrows, fifteen with Shift, and jumps between stretches', async () => {
    await open()
    press(slider(), 'ArrowRight', { shiftKey: true })

    expect(time()).toBe('09:15')

    press(slider(), 'ArrowLeft')

    expect(time()).toBe('09:14')

    act(() => button('Next logged stretch')!.click())

    expect(time()).toBe('13:45')

    act(() => button('Previous logged stretch')!.click())

    expect(time()).toBe('09:00')
  })

  it('plays the day forward on a timer, toggles on Space and stops at the end of the log', async () => {
    await open()
    act(() => button('Play')!.click())
    act(() => void vi.advanceTimersByTime(1000))

    expect(time()).toBe('09:01')

    press(slider(), ' ')
    act(() => void vi.advanceTimersByTime(5000))

    expect(time()).toBe('09:01')
    expect(button('Play')).not.toBeNull()

    press(slider(), ' ')
    act(() => button('1 h/s')!.click())
    act(() => void vi.advanceTimersByTime(20_000))

    expect(time()).toBe('18:30')
    expect(button('Play')).not.toBeNull()
  })

  it('pauses while the document is hidden', async () => {
    const show = (state: DocumentVisibilityState) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
      act(() => void document.dispatchEvent(new Event('visibilitychange')))
    }

    try {
      await open()
      act(() => button('Play')!.click())
      show('hidden')
      act(() => void vi.advanceTimersByTime(5000))

      expect(time()).toBe('09:00')

      show('visible')
      act(() => void vi.advanceTimersByTime(1000))

      expect(time()).toBe('09:01')
    } finally {
      Reflect.deleteProperty(document, 'visibilityState')
    }
  })

  it('loads another day from the day picker', async () => {
    await open()
    act(() => button('Today')!.click())
    const option = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(element => element.textContent?.includes('Yesterday'))!
    act(() => option.click())
    await settle()

    expect(room.readLog).toHaveBeenLastCalledWith('2026-10-14')
    expect(button('Yesterday')).not.toBeNull()
    expect(time()).toBe('10:00')
    expect(pets()).toEqual(['A mission: thinking.'])

    scrubTo(16, 0)

    expect(host.textContent).toContain('The log was full from 15:42')
  })

  it('says how to turn the log on when it holds nothing yet', async () => {
    room.logDays.mockResolvedValue([])
    await open()

    expect(host.textContent).toContain('The activity log has nothing yet')
    expect(host.textContent).toContain('Settings > Pet Room > Keep an activity log')
    expect(room.readLog).not.toHaveBeenCalled()
  })

  it('offers to try again when the log cannot be read', async () => {
    room.logDays.mockRejectedValueOnce(new Error('unreadable'))
    await open()

    expect(host.textContent).toContain('Could not read the activity log')

    act(() => button('Try again')!.click())
    await settle()

    expect(time()).toBe('09:00')
  })
})
