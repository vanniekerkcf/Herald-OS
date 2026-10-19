import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import type { WmWindow } from '../../../shared/ipc.ts'
import { $prefsLoaded } from '../../store/backend.ts'
import { $wm, isPanels } from '../../store/shell.ts'
import { $petPrefs } from '../pet/actions.ts'
import { heraldPresenting } from '../pet/brain.ts'
import { $roomPrefs } from './prefs.ts'

/*
 * The Pet Room as Herald's screensaver, when the person picks it: the scene with no header, names,
 * document names or bubbles (a setting brings back step labels), that only ever shows. It gives way
 * to the plain clock whenever Herald knows the screen is seen by others: Herald Slides presenting,
 * or the desktop pet put away for a screen share.
 */

const SLIDES_TITLE = 'Herald OS · Slides'
const AUDIENCE_TITLE = 'Herald Slides Audience'

/** Herald Slides presenting, as the compositor's windows show it: its audience window open, or Slides full screen. */
export function presentingIn(windows: readonly Pick<WmWindow, 'title' | 'fullscreen'>[]): boolean {
  return windows.some(win => win.title === AUDIENCE_TITLE || (win.title === SLIDES_TITLE && win.fullscreen === true))
}

/** Why the screensaver shows the clock rather than the Room; null when the Room may show. */
export type RoomScreensaverBlock = 'off' | 'presenting' | 'sharing'

export function roomScreensaverBlock(input: { enabled: boolean; presenting: boolean; sharing: boolean }): RoomScreensaverBlock | null {
  if (!input.enabled) {
    return 'off'
  }

  if (input.presenting) {
    return 'presenting'
  }

  return input.sharing ? 'sharing' : null
}

/** What the screensaver's scene shows: never names, document names, facts or a way to answer; step labels only when the person asks. */
export function screensaverView(prefs: { screensaverSteps: boolean }): { names: false; deskNames: false; interactive: false; steps: boolean } {
  return { names: false, deskNames: false, interactive: false, steps: prefs.screensaverSteps }
}

/**
 * Whether the screensaver shows the Room: decided once Herald's preferences have loaded (null until
 * then), so the clock never turns into the Room under the person; the Room gives way to the clock
 * at once if Herald learns of a presentation or a screen share while it shows.
 */
export function useRoomScreensaver(): boolean | null {
  const loaded = useStore($prefsLoaded)
  const prefs = useStore($roomPrefs)
  const petPrefs = useStore($petPrefs)
  const wm = useStore($wm)
  const presenting = isPanels ? presentingIn(wm.windows) : heraldPresenting()
  const allowed = roomScreensaverBlock({ enabled: prefs.screensaver, presenting, sharing: petPrefs.hidden }) === null
  const [decision, setDecision] = useState<boolean | null>(null)

  useEffect(() => {
    if (decision === null && loaded) {
      setDecision(allowed)
    }
  }, [decision, loaded, allowed])

  return decision === null ? null : decision && allowed
}
