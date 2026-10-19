import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrefsPatch } from '../../../shared/ipc.ts'
import { mergeRoomPrefs, ROOM_PREFS_DEFAULTS, type RoomPrefs } from '../../../shared/room.ts'
import { $prefs } from '../../store/backend.ts'
import { $roomPrefs, setRoomPrefs } from './prefs.ts'

// The stores read the preload bridge and the viewport when they load; tests run without a DOM.
const prefsSet = vi.hoisted(() => {
  const set = vi.fn()
  Object.assign(globalThis, {
    window: { innerWidth: 1440, innerHeight: 900, heraldOS: { prefs: { set } } },
    document: { documentElement: { dataset: {}, style: { setProperty: () => undefined, removeProperty: () => undefined } } }
  })

  return set
})

/** The Room preferences as prefs.json holds them; main merges a write into them as `mergeRoomPrefs` does. */
let saved: RoomPrefs = ROOM_PREFS_DEFAULTS

beforeEach(() => {
  saved = ROOM_PREFS_DEFAULTS
  $prefs.set({ ...$prefs.get(), room: ROOM_PREFS_DEFAULTS })
  prefsSet.mockReset().mockImplementation(async (patch: PrefsPatch) => {
    saved = mergeRoomPrefs(saved, patch.room)

    return { ...$prefs.get(), room: saved }
  })
})

describe('changing the Room preferences', () => {
  it('sends only the fields a change names, so a window with an old copy keeps what another one saved', async () => {
    saved = { ...ROOM_PREFS_DEFAULTS, motion: 'still', pets: { ...ROOM_PREFS_DEFAULTS.pets, conversation: 'boba' } }

    await setRoomPrefs({ pets: { helper: 'mochi' } })
    expect(prefsSet).toHaveBeenLastCalledWith({ room: { pets: { helper: 'mochi' } } })

    await setRoomPrefs({ steps: false })
    expect(prefsSet).toHaveBeenLastCalledWith({ room: { steps: false } })
    expect($roomPrefs.get()).toEqual({ ...ROOM_PREFS_DEFAULTS, motion: 'still', steps: false, pets: { ...ROOM_PREFS_DEFAULTS.pets, conversation: 'boba', helper: 'mochi' } })
  })
})
