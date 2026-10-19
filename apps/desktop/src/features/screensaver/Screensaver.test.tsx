// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Screensaver } from './Screensaver.tsx'

vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

const choice = vi.hoisted(() => ({ room: true as boolean | null }))

vi.mock('../../shell/Wallpaper.tsx', () => ({ Wallpaper: () => null }))
vi.mock('../room/screensaver.ts', () => ({ useRoomScreensaver: () => choice.room }))
vi.mock('../room/RoomScreensaver.tsx', () => ({ RoomScreensaver: () => <div data-testid="room-scene" /> }))

let host: HTMLDivElement
let root: Root

async function show(onDismiss: () => void): Promise<void> {
  await act(async () => {
    root.render(<Screensaver onDismiss={onDismiss} />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  choice.room = true
})

describe('the screensaver', () => {
  it('shows the Pet Room, with no clock or words, when the person picked it', async () => {
    await show(vi.fn())

    expect(host.querySelector('[data-screensaver="room"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="room-scene"]')).not.toBeNull()
    expect(host.textContent?.trim()).toBe('')
  })

  it('shows the clock otherwise, and nothing while Herald’s preferences load', async () => {
    choice.room = false
    await show(vi.fn())

    expect(host.querySelector('[data-testid="room-scene"]')).toBeNull()
    expect(host.textContent).toMatch(/\d/)

    choice.room = null
    await show(vi.fn())

    expect(host.querySelector('[data-screensaver="loading"]')).not.toBeNull()
    expect(host.textContent?.trim()).toBe('')
  })

  it('ends on any key, click, pointer move or wheel, but not on the tail of what came before it', async () => {
    const inputs = [() => new KeyboardEvent('keydown', { key: 'a' }), () => new PointerEvent('pointerdown'), () => new PointerEvent('pointermove'), () => new WheelEvent('wheel')]

    for (const input of inputs) {
      const onDismiss = vi.fn()
      vi.setSystemTime(1_000_000)
      await show(onDismiss)

      window.dispatchEvent(input())
      expect(onDismiss).not.toHaveBeenCalled()

      vi.setSystemTime(1_000_000 + 1_500)
      window.dispatchEvent(input())
      expect(onDismiss).toHaveBeenCalledTimes(1)

      act(() => root.render(<div />))
    }
  })
})
