import { computed } from 'nanostores'
import { clampPetScale, normalizePetPrefs, type PetInfo, type PetPrefs } from '../../../shared/pet.ts'
import { hostPlatform } from '../../lib/platform-labels.ts'
import { $prefs, updatePrefs } from '../../store/backend.ts'
import { gatewayRequest, isGatewayOpen } from '../../store/gateway.ts'
import { $petInfo, refreshPetInfo } from './info.ts'

/*
 * Changing the pet. Where it sits, what it reacts to and putting it away for a while are Herald's
 * own preferences; which pet, its size and on or off belong to Hermes (`display.pet`), so they go
 * through Hermes's own pet methods and every Hermes surface shows the same pet.
 */

export const $petPrefs = computed($prefs, prefs => normalizePetPrefs(prefs.pet))

/** Change only the fields `patch` names: this window's copy of the rest may be stale (another Herald can share prefs.json). */
export function setPetPrefs(patch: Partial<PetPrefs>): Promise<void> {
  return updatePrefs({ pet: patch })
}

export const hidePet = (): Promise<void> => setPetPrefs({ hidden: true })
export const showPet = (): Promise<void> => setPetPrefs({ hidden: false })
export const togglePet = (): Promise<void> => setPetPrefs({ hidden: !$petPrefs.get().hidden })

/** The shortcut that puts the pet away and brings it back (niri binds the same keys on Linux). */
export const petShortcutLabel = (): string => (hostPlatform() === 'darwin' ? '⌃⌘H' : 'Super+Ctrl+H')

async function throughHermes(work: () => Promise<unknown>): Promise<PetInfo> {
  if (!isGatewayOpen()) {
    throw new Error('Hermes is not reachable right now: try again once it is running')
  }

  await work()

  return refreshPetInfo()
}

/** Make a pet the one Hermes shows; Hermes installs it from the petdex gallery first when it is not here. */
export const selectPet = (slug: string): Promise<PetInfo> => throughHermes(() => gatewayRequest('pet.select', { slug }))

export const setPetScale = (scale: number): Promise<PetInfo> => throughHermes(() => gatewayRequest('pet.scale', { scale: clampPetScale(scale) }))

/** Switch the pet on or off for every Hermes surface. */
export function setPetEnabled(on: boolean): Promise<PetInfo> {
  if (!on) {
    return throughHermes(() => gatewayRequest('pet.disable', {}))
  }

  const slug = $petInfo.get().slug

  if (!slug) {
    return Promise.reject(new Error('No pet is installed yet: pick one in Settings, Pet'))
  }

  return selectPet(slug)
}

/** An installed pet by its folder name or its name, ignoring case. */
export function findInstalledPet(name: string, info: PetInfo = $petInfo.get()): { slug: string; displayName: string } | null {
  const needle = name.trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+pet$/, '')

  if (!needle) {
    return null
  }

  return info.installed.find(pet => pet.slug.toLowerCase() === needle || pet.displayName.toLowerCase() === needle) ?? info.installed.find(pet => pet.displayName.toLowerCase().includes(needle) || pet.slug.toLowerCase().includes(needle)) ?? null
}
