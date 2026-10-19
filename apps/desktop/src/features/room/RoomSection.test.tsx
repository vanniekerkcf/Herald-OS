// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ROOM_PREFS_DEFAULTS, type RoomLogDay, type RoomPrefs } from '../../../shared/room.ts'
import { $roomPrefs, setRoomPrefs } from './prefs.ts'
import { RoomSection } from './RoomSection.tsx'

vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

/** Main's side of the Room: the activity log's days on disk, and how often it was deleted. */
const log = vi.hoisted(() => ({ days: [] as RoomLogDay[], deleted: 0 }))

vi.mock('./prefs.ts', async () => {
  const { atom } = await import('nanostores')
  const { ROOM_PREFS_DEFAULTS: defaults, mergeRoomPrefs } = await import('../../../shared/room.ts')
  const prefs = atom({ ...defaults })

  return { $roomPrefs: prefs, setRoomPrefs: vi.fn(async (patch: unknown) => prefs.set(mergeRoomPrefs(prefs.get(), patch))) }
})

vi.mock('./bridge.ts', () => ({
  roomBridge: () => ({
    watchActivity: () => () => undefined,
    appendLog: () => undefined,
    readLog: async () => [],
    logDays: async () => log.days,
    deleteLog: async () => {
      log.deleted += 1
      log.days = []
    }
  })
}))

vi.mock('../pet/info.ts', async () => {
  const { atom } = await import('nanostores')

  return { $petInfo: atom({ installed: [] }) }
})

vi.mock('../pet/hooks.ts', () => ({ useReducedMotion: () => false }))
vi.mock('../petdex/PetFigure.tsx', () => ({ PetFigure: () => null }))
vi.mock('../../store/windows.ts', () => ({ openApp: vi.fn() }))
vi.mock('../../store/i18n.ts', async () => {
  const { atom } = await import('nanostores')

  return { useT: () => (key: string) => key, t: (key: string) => key, $locale: atom('en') }
})

// The mock holds a plain atom where the app derives one from prefs.json.
const prefs = $roomPrefs as unknown as { set: (value: RoomPrefs) => void }

let host: HTMLDivElement
let root: Root

/** Let what main answers (the log's days, a delete) land before looking. */
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)))

async function render(): Promise<void> {
  act(() => root.render(<RoomSection />))
  await settle()
}

const toggle = (label: string) => host.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`)!
const button = (text: string) => [...host.querySelectorAll('button')].find(element => element.textContent?.trim() === text)

beforeEach(() => {
  prefs.set({ ...ROOM_PREFS_DEFAULTS })
  vi.mocked(setRoomPrefs).mockClear()
  log.days = []
  log.deleted = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Settings > Pet Room', () => {
  it('keeps live steps from Hermes outside Herald off and unavailable until the lane is on', async () => {
    await render()

    expect(toggle('Live steps from Hermes outside Herald').disabled).toBe(true)
    expect(toggle('Live steps from Hermes outside Herald').getAttribute('aria-checked')).toBe('false')
    expect(host.textContent).toContain("by name only: never what anyone wrote, a command, a file's content or a result")

    act(() => toggle('Show Hermes work outside Herald').click())
    await settle()

    expect(setRoomPrefs).toHaveBeenLastCalledWith({ elsewhere: true })
    expect(toggle('Live steps from Hermes outside Herald').disabled).toBe(false)

    act(() => toggle('Live steps from Hermes outside Herald').click())
    await settle()

    expect(setRoomPrefs).toHaveBeenLastCalledWith({ elsewhereLive: true })
    expect(toggle('Live steps from Hermes outside Herald').getAttribute('aria-checked')).toBe('true')
  })

  it('shows the activity log’s size and deletes it only on a second click', async () => {
    log.days = [
      { day: '2026-10-15', bytes: 1_024 },
      { day: '2026-10-14', bytes: 1_024 }
    ]
    await render()

    expect(host.textContent).toContain('The log takes 2.0 KB.')

    act(() => button('Delete activity log')!.click())

    expect(log.deleted).toBe(0)
    expect(host.textContent).toContain('Delete the whole log?')

    act(() => button('Cancel')!.click())

    expect(button('Delete activity log')).toBeDefined()
    expect(log.deleted).toBe(0)

    act(() => button('Delete activity log')!.click())
    act(() => button('Delete')!.click())
    await settle()

    expect(log.deleted).toBe(1)
    expect(host.textContent).toContain('The log is empty.')
    expect(button('Delete activity log')?.disabled).toBe(true)
  })

  it('saves the log’s retention and the cost meters, all off by default', async () => {
    await render()

    expect(toggle('Keep an activity log').getAttribute('aria-checked')).toBe('false')
    expect(toggle('Show cost meters').getAttribute('aria-checked')).toBe('false')
    expect(toggle('Show the total').getAttribute('aria-checked')).toBe('false')

    act(() => button('14 days')!.click())
    act(() => toggle('Show cost meters').click())
    act(() => toggle('Show the total').click())
    await settle()

    expect(vi.mocked(setRoomPrefs).mock.calls.map(([patch]) => patch)).toEqual([{ logDays: 14 }, { costs: true }, { costTotal: true }])
  })
})
