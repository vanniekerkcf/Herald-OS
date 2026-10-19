import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrefsPatch } from '../../../shared/ipc.ts'
import { PET_PREFS_DEFAULTS, type PetPrefs } from '../../../shared/pet.ts'
import { $prefs } from '../../store/backend.ts'
import { $petPrefs, hidePet, setPetPrefs, togglePet } from './actions.ts'

// The stores read the preload bridge and the viewport when they load; tests run without a DOM.
const prefsSet = vi.hoisted(() => {
  const set = vi.fn()
  Object.assign(globalThis, {
    window: { innerWidth: 1440, innerHeight: 900, heraldOS: { prefs: { set } } },
    document: { documentElement: { dataset: {}, style: { setProperty: () => undefined, removeProperty: () => undefined } } }
  })

  return set
})

/** The pet as prefs.json holds it; main merges a write into it field by field. */
let saved: PetPrefs = PET_PREFS_DEFAULTS

beforeEach(() => {
  saved = PET_PREFS_DEFAULTS
  $prefs.set({ ...$prefs.get(), pet: PET_PREFS_DEFAULTS })
  prefsSet.mockReset().mockImplementation(async (patch: PrefsPatch) => {
    saved = { ...saved, ...patch.pet }

    return { ...$prefs.get(), pet: saved }
  })
})

describe('changing the pet preferences', () => {
  it('sends only the fields a change names, so a window with an old copy cannot bring a put-away pet back', async () => {
    saved = { ...PET_PREFS_DEFAULTS, hidden: true }

    await setPetPrefs({ spot: { x: 0.3, y: 0.7 } })
    expect(prefsSet).toHaveBeenLastCalledWith({ pet: { spot: { x: 0.3, y: 0.7 } } })
    expect($petPrefs.get()).toEqual({ ...PET_PREFS_DEFAULTS, hidden: true, spot: { x: 0.3, y: 0.7 } })

    await setPetPrefs({ followWindows: false })
    expect(prefsSet).toHaveBeenLastCalledWith({ pet: { followWindows: false } })
  })

  it('puts the pet away, and toggles it from what this window shows', async () => {
    await hidePet()
    expect(prefsSet).toHaveBeenLastCalledWith({ pet: { hidden: true } })

    await togglePet()
    expect(prefsSet).toHaveBeenLastCalledWith({ pet: { hidden: false } })

    await togglePet()
    expect(prefsSet).toHaveBeenLastCalledWith({ pet: { hidden: true } })
    expect($petPrefs.get().hidden).toBe(true)
  })
})
