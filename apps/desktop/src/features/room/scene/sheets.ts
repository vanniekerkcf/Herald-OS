import type { InstalledPet } from '../../../../shared/pet.ts'
import { type CachedSheet, type PetSheetRef, sheetKey, type SpriteCache } from '../../petdex/cache.ts'

/** An installed pet's sheet as main serves it; a pet without a revision or a known image type has none to draw. */
export function sheetRefOf(pet: InstalledPet): PetSheetRef | null {
  const { revision, mime } = pet

  return typeof revision === 'string' && revision && (mime === 'image/png' || mime === 'image/webp') ? { slug: pet.slug, revision, mime } : null
}

/** One sheet for each of `slugs` that is installed with a sheet, in order, without repeats. */
export function sheetRefs(slugs: Iterable<string>, installed: readonly InstalledPet[]): PetSheetRef[] {
  const bySlug = new Map(installed.map(pet => [pet.slug, pet]))
  const refs = new Map<string, PetSheetRef>()

  for (const slug of slugs) {
    const pet = bySlug.get(slug)
    const ref = pet && !refs.has(slug) ? sheetRefOf(pet) : null

    if (ref) {
      refs.set(slug, ref)
    }
  }

  return [...refs.values()]
}

/** How a held pet's sheet is doing: still loading, ready to draw, or failed (it cannot be read, or the cache has no room for it). */
export type SheetState = 'loading' | 'ready' | 'failed'

export interface SheetHolder {
  /** Hold exactly these sheets: load the new ones, let go of the others. */
  hold(refs: readonly PetSheetRef[]): void
  /** A held, loaded sheet by the pet's folder name. */
  get(slug: string): CachedSheet | null
  /** How a held sheet is doing, by the pet's folder name; null for a pet it does not hold. */
  state(slug: string): SheetState | null
  /** Let go of everything, now and as loads finish. */
  dispose(): void
}

interface Held {
  ref: PetSheetRef
  sheet: CachedSheet | null
  loading: boolean
  wanted: boolean
  /** Why the cache gave nothing: it had no room, or the sheet cannot be read. */
  failed: 'room' | 'unreadable' | null
}

/**
 * The sheets one scene draws, borrowed from the shared cache: each acquired once and released once.
 * A sheet the cache had no room for is asked for again when another view lets one go; one that
 * cannot be read is not, and is asked for again only when it is held anew. `onChange` runs when a
 * sheet comes in or fails, to paint again.
 */
export function holdSheets(cache: Pick<SpriteCache, 'acquire' | 'release' | 'onRelease' | 'failed'>, onChange: () => void): SheetHolder {
  const held = new Map<string, Held>()
  let disposed = false

  const letGo = (key: string, entry: Held) => {
    if (held.get(key) === entry) {
      held.delete(key)
    }

    if (entry.sheet) {
      entry.sheet = null
      cache.release(key)
    }
  }

  const load = (key: string, entry: Held) => {
    const settle = (sheet: CachedSheet | null, unreadable: boolean) => {
      const failedBefore = entry.failed !== null
      entry.loading = false
      entry.sheet = sheet
      entry.failed = sheet ? null : unreadable ? 'unreadable' : 'room'

      if (disposed || !entry.wanted) {
        letGo(key, entry)

        return
      }

      if (sheet || !failedBefore) {
        onChange()
      }
    }

    entry.loading = true
    void cache.acquire(entry.ref).then(
      sheet => settle(sheet, !sheet && cache.failed(key)),
      () => settle(null, true)
    )
  }

  const stopListening = cache.onRelease(() => {
    if (disposed) {
      return
    }

    for (const [key, entry] of held) {
      if (entry.wanted && !entry.loading && entry.failed === 'room') {
        load(key, entry)
      }
    }
  })

  return {
    hold(refs) {
      if (disposed) {
        return
      }

      const wanted = new Map(refs.map(ref => [sheetKey(ref), ref]))

      for (const [key, entry] of held) {
        if (wanted.has(key)) {
          continue
        }

        entry.wanted = false

        if (!entry.loading) {
          letGo(key, entry)
        }
      }

      for (const [key, ref] of wanted) {
        const entry = held.get(key)

        if (entry) {
          entry.wanted = true
          continue
        }

        const fresh: Held = { ref, sheet: null, loading: true, wanted: true, failed: null }
        held.set(key, fresh)
        load(key, fresh)
      }
    },
    get(slug) {
      for (const entry of held.values()) {
        if (entry.ref.slug === slug && entry.wanted && entry.sheet) {
          return entry.sheet
        }
      }

      return null
    },
    state(slug) {
      for (const entry of held.values()) {
        if (entry.ref.slug === slug && entry.wanted) {
          return entry.sheet ? 'ready' : entry.failed ? 'failed' : 'loading'
        }
      }

      return null
    },
    dispose() {
      disposed = true
      stopListening()

      for (const [key, entry] of [...held]) {
        entry.wanted = false

        if (!entry.loading) {
          letGo(key, entry)
        }
      }
    }
  }
}
