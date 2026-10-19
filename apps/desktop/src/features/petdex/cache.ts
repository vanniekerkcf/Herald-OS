import { petBridge } from '../pet/transport.ts'
import { decodeSheet, type LoadedSheet, releaseSheet } from './sheet.ts'

/*
 * Every pet a window draws comes from one cache of decoded spritesheets, held by reference: views
 * that show the same pet share one sheet, and a sheet someone holds always stays. Up to `cap`
 * sheets nobody holds stay decoded for reuse, the one let go longest ago leaving first, and no
 * more than `max` are decoded at once, held or not.
 */

/** An installed pet's spritesheet as main serves it: by folder name, changing with its revision. */
export interface PetSheetRef {
  slug: string
  revision: string
  mime: 'image/png' | 'image/webp'
}

/** A decoded sheet in the renderer-wide cache. */
export interface CachedSheet {
  /** `slug@revision`. */
  key: string
  slug: string
  sheet: LoadedSheet
  /** Decoded and drawable. */
  image: CanvasImageSource
}

export interface SpriteCache {
  /** Load a pet's sheet or reuse the decoded one; holds a reference until `release`. Null when it cannot be read (see `failed`), or when `max` sheets are held or loading already. */
  acquire(ref: PetSheetRef): Promise<CachedSheet | null>
  release(key: string): void
  /** The decoded sheet when it is in the cache, without loading it. */
  peek(key: string): CachedSheet | null
  /** The cached sheet a loaded sheet belongs to, while it is still in the cache. */
  find(sheet: LoadedSheet): CachedSheet | null
  /** Its last read failed: null for it is not for want of room, so a release will not bring it, and it is not read again for SPRITE_RETRY_MS. */
  failed(key: string): boolean
  /** Called soon after a sheet loses its last holder, when a view that got null for want of room may find some; returns the unsubscribe. */
  onRelease(listener: () => void): () => void
  /** The most sheets kept decoded while nobody holds them. */
  readonly cap: number
  /** The most sheets decoded at once, held or not. */
  readonly max: number
}

/** Sheets a renderer keeps decoded for reuse while no view holds them. */
export const SPRITE_CACHE_CAP = 4
/** The most sheets a renderer decodes at once (each is about 11 MB of pixels), above what its views draw together: a sheet for each kind of work in the Room, the desktop pet and Settings' previews. */
export const SPRITE_CACHE_MAX = 12
/** A sheet that could not be read is not read again for this long, however often it is asked for. */
export const SPRITE_RETRY_MS = 10_000

export const sheetKey = (ref: Pick<PetSheetRef, 'slug' | 'revision'>): string => `${ref.slug}@${ref.revision}`

export interface SpriteCacheOptions {
  /** Sheets kept decoded while nobody holds them. */
  cap: number
  /** The most sheets decoded at once, held or not: at least `cap`, and `cap` when not given. */
  max?: number
  /** Read and decode a sheet; null when it cannot be read. */
  load: (ref: PetSheetRef) => Promise<{ sheet: LoadedSheet; image: CanvasImageSource } | null>
  /** Free what `load` made, once the sheet leaves the cache. */
  release: (cached: CachedSheet) => void
  /** The time now, for the wait before a failed sheet is read again. */
  now?: () => number
}

interface Entry {
  key: string
  slug: string
  refs: number
  cached: CachedSheet | null
  loading: Promise<CachedSheet | null> | null
  /** When it lost its last holder, in release order: of the sheets nobody holds, the earliest leaves first. */
  released: number
}

export function createSpriteCache({ cap, max, load, release: dispose, now = Date.now }: SpriteCacheOptions): SpriteCache {
  const limit = Math.max(1, Math.floor(cap) || 1)
  const ceiling = Math.max(limit, Math.floor(max ?? limit) || limit)
  const entries = new Map<string, Entry>()
  const owners = new WeakMap<LoadedSheet, CachedSheet>()
  /** The revision each pet was last asked for: an older one leaves as soon as nobody holds it. */
  const latest = new Map<string, string>()
  /** When each sheet's last read failed, until a read of it succeeds. */
  const failures = new Map<string, number>()
  const listeners = new Set<() => void>()
  let releases = 0
  let announcing = false

  const outdated = (entry: Entry): boolean => latest.get(entry.slug) !== entry.key
  const idle = (): Entry[] => [...entries.values()].filter(entry => entry.refs === 0 && entry.cached)
  const earliest = (list: Entry[]): Entry => list.reduce((oldest, entry) => (entry.released < oldest.released ? entry : oldest))

  function evict(entry: Entry): void {
    entries.delete(entry.key)

    if (entry.cached) {
      owners.delete(entry.cached.sheet)
      dispose(entry.cached)
    }
  }

  /** Keep no more than `cap` sheets nobody holds. */
  function trim(): void {
    let spare = idle()

    while (spare.length > limit) {
      evict(earliest(spare))
      spare = idle()
    }
  }

  /** Room for one more sheet under the ceiling, made from sheets nobody holds; false when every one is held or loading. */
  function makeRoom(): boolean {
    while (entries.size >= ceiling) {
      const spare = idle()

      if (!spare.length) {
        return false
      }

      evict(earliest(spare))
    }

    return true
  }

  function announce(): void {
    if (announcing || !listeners.size) {
      return
    }

    announcing = true
    queueMicrotask(() => {
      announcing = false

      for (const listener of [...listeners]) {
        listener()
      }
    })
  }

  async function fill(entry: Entry, ref: PetSheetRef): Promise<CachedSheet | null> {
    let decoded: Awaited<ReturnType<SpriteCacheOptions['load']>> = null

    try {
      decoded = await load(ref)
    } catch {
      decoded = null
    }

    if (!decoded) {
      entries.delete(entry.key)
      failures.set(entry.key, now())

      return null
    }

    const cached: CachedSheet = { key: entry.key, slug: entry.slug, sheet: decoded.sheet, image: decoded.image }
    entry.cached = cached
    entry.loading = null
    owners.set(cached.sheet, cached)

    if (entry.refs > 0) {
      return cached
    }

    if (outdated(entry)) {
      evict(entry)
    } else {
      trim()
    }

    return entries.get(entry.key) === entry ? cached : null
  }

  return {
    cap: limit,
    max: ceiling,
    acquire(ref) {
      const key = sheetKey(ref)
      latest.set(ref.slug, key)

      for (const entry of [...entries.values()]) {
        if (entry.slug === ref.slug && entry.key !== key && entry.refs === 0 && entry.cached) {
          evict(entry)
        }
      }

      let entry = entries.get(key)

      if (!entry) {
        const failedAt = failures.get(key)

        if (failedAt !== undefined && now() - failedAt < SPRITE_RETRY_MS) {
          return Promise.resolve(null)
        }

        failures.delete(key)

        if (!makeRoom()) {
          return Promise.resolve(null)
        }

        const created: Entry = { key, slug: ref.slug, refs: 0, cached: null, loading: null, released: 0 }
        entries.set(key, created)
        created.loading = fill(created, ref)
        entry = created
      }

      entry.refs++

      return entry.cached ? Promise.resolve(entry.cached) : (entry.loading ?? Promise.resolve(null))
    },
    release(key) {
      const entry = entries.get(key)

      if (!entry || entry.refs === 0) {
        return
      }

      entry.refs--

      if (entry.refs > 0) {
        return
      }

      entry.released = ++releases

      if (entry.cached && outdated(entry)) {
        evict(entry)
      } else {
        trim()
      }

      announce()
    },
    peek: key => entries.get(key)?.cached ?? null,
    find: sheet => owners.get(sheet) ?? null,
    failed: key => failures.has(key),
    onRelease(listener) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    }
  }
}

async function loadPetSheet(ref: PetSheetRef): Promise<{ sheet: LoadedSheet; image: CanvasImageSource } | null> {
  const bytes = await petBridge()?.sheet(ref.slug)

  return bytes ? decodeSheet(bytes, ref.mime) : null
}

function disposePetSheet(cached: CachedSheet): void {
  releaseSheet(cached.sheet)

  if (typeof ImageBitmap === 'function' && cached.image instanceof ImageBitmap) {
    cached.image.close()
  }
}

/** The renderer's decoded spritesheets, for the desktop pet, the Room and Settings' previews alike. */
export const spriteCache: SpriteCache = createSpriteCache({ cap: SPRITE_CACHE_CAP, max: SPRITE_CACHE_MAX, load: loadPetSheet, release: disposePetSheet })
