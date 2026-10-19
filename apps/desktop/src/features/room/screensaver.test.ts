// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { ROOM_PREFS_DEFAULTS } from '../../../shared/room.ts'
import { presentingIn, roomScreensaverBlock, screensaverView } from './screensaver.ts'

describe('the Room as the screensaver', () => {
  it('is off until the person turns it on', () => {
    expect(ROOM_PREFS_DEFAULTS.screensaver).toBe(false)
    expect(roomScreensaverBlock({ enabled: false, presenting: false, sharing: false })).toBe('off')
    expect(roomScreensaverBlock({ enabled: true, presenting: false, sharing: false })).toBeNull()
  })

  it('gives way to the clock while Herald knows the screen is seen by others', () => {
    expect(roomScreensaverBlock({ enabled: true, presenting: true, sharing: false })).toBe('presenting')
    expect(roomScreensaverBlock({ enabled: true, presenting: false, sharing: true })).toBe('sharing')
  })

  it('shows no names, document names, facts or step labels by default, and never answers or opens', () => {
    expect(screensaverView(ROOM_PREFS_DEFAULTS)).toEqual({ names: false, deskNames: false, interactive: false, steps: false })
    expect(screensaverView({ ...ROOM_PREFS_DEFAULTS, screensaverSteps: true })).toEqual({ names: false, deskNames: false, interactive: false, steps: true })
  })

  it('knows Herald Slides presents from the compositor’s windows', () => {
    expect(presentingIn([{ title: 'Herald OS · Slides', fullscreen: false }])).toBe(false)
    expect(presentingIn([{ title: 'Herald OS · Slides', fullscreen: true }])).toBe(true)
    expect(presentingIn([{ title: 'Herald Slides Audience', fullscreen: false }])).toBe(true)
    expect(presentingIn([{ title: 'Herald OS · Docs', fullscreen: true }])).toBe(false)
  })
})
