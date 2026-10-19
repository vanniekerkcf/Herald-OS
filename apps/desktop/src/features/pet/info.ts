import { atom } from 'nanostores'
import { PET_OFF, type PetInfo, petShown } from '../../../shared/pet.ts'
import { type CachedSheet, type PetSheetRef, sheetKey, spriteCache } from '../petdex/cache.ts'
import type { LoadedSheet } from './sheet.ts'
import { petBridge } from './transport.ts'

/** The pet Hermes shows, as main reads it from Hermes's config.yaml and pets folder. */
export const $petInfo = atom<PetInfo>(PET_OFF)

/** The shown pet's spritesheet, decoded, in the windows that draw it. */
export const $petSheet = atom<LoadedSheet | null>(null)

let infoBound = false

export function bindPetInfo(): void {
  const bridge = petBridge()

  if (infoBound || !bridge) {
    return
  }

  infoBound = true
  void bridge
    .info()
    .then(info => $petInfo.set(info))
    .catch(() => undefined)
  bridge.onInfo(info => $petInfo.set(info))
}

/** Read Hermes's pet settings again now, after Herald asked Hermes to change them. */
export async function refreshPetInfo(): Promise<PetInfo> {
  const info = (await petBridge()?.refresh()) ?? $petInfo.get()
  $petInfo.set(info)

  return info
}

let sheetBound = false
let shownKey = ''
/** The cached sheet `$petSheet` shows, which this window holds while it does. */
let held: string | null = null
let ticket = 0
let stopWaiting: (() => void) | null = null

function setSheet(next: CachedSheet | null): void {
  const previous = held
  held = next?.key ?? null
  $petSheet.set(next?.sheet ?? null)

  if (previous) {
    spriteCache.release(previous)
  }
}

function loadShown(ref: PetSheetRef): void {
  const mine = ++ticket
  stopWaiting?.()
  stopWaiting = null

  void (async () => {
    const key = sheetKey(ref)
    let cached = await spriteCache.acquire(ref)

    if (!cached && mine === ticket && held && !spriteCache.failed(key)) {
      // Other views hold as many sheets as the cache decodes at once: let go of the one on show to
      // make room (its last frame stays on screen until the new one is in).
      spriteCache.release(held)
      held = null
      cached = await spriteCache.acquire(ref)
    }

    if (mine !== ticket) {
      if (cached) {
        spriteCache.release(cached.key)
      }

      return
    }

    setSheet(cached)

    // Only a sheet refused for want of room waits for a release: one that cannot be read waits for its next revision.
    if (!cached && !spriteCache.failed(key)) {
      stopWaiting = spriteCache.onRelease(() => {
        if (mine === ticket) {
          loadShown(ref)
        }
      })
    }
  })()
}

/** Keep the shown pet's sheet loaded, once per spritesheet revision. */
export function bindPetSheet(): void {
  if (sheetBound) {
    return
  }

  sheetBound = true
  $petInfo.subscribe(info => {
    const key = petShown(info) && info.slug && info.revision ? sheetKey({ slug: info.slug, revision: info.revision }) : ''

    if (key === shownKey) {
      return
    }

    shownKey = key

    if (!key || !info.slug || !info.revision) {
      ticket++
      stopWaiting?.()
      stopWaiting = null
      setSheet(null)

      return
    }

    loadShown({ slug: info.slug, revision: info.revision, mime: info.mime ?? 'image/webp' })
  })
}
