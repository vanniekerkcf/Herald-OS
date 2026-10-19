import { describe, expect, it, vi } from 'vitest'
import { type CachedSheet, createSpriteCache, type PetSheetRef, SPRITE_CACHE_CAP, SPRITE_CACHE_MAX, SPRITE_RETRY_MS, sheetKey, spriteCache } from './cache.ts'
import type { LoadedSheet } from './sheet.ts'

// The default loader reads through the preload bridge, which the shell store looks for when it loads.
vi.hoisted(() => {
  Object.assign(globalThis, { window: {} })
})

const ref = (slug: string, revision = '1'): PetSheetRef => ({ slug, revision, mime: 'image/webp' })

const sheetFor = (key: string): LoadedSheet => ({ url: `blob:${key}`, width: 1536, height: 1872, layout: { columns: 8, rows: 9, rowNames: [], frames: [] } })

/** A cache over a fake loader and clock: `held` loads wait for `finish`, `broken` ones read as nothing, `throws` ones fail. */
function harness({ cap = SPRITE_CACHE_CAP, max = SPRITE_CACHE_MAX }: { cap?: number; max?: number } = {}) {
  const loads: string[] = []
  const disposed: string[] = []
  const waiting = new Map<string, () => void>()
  const broken = new Set<string>()
  const throws = new Set<string>()
  const held = new Set<string>()
  let time = 1_000_000
  const cache = createSpriteCache({
    cap,
    max,
    now: () => time,
    load: async next => {
      const key = sheetKey(next)
      loads.push(key)

      if (held.has(key)) {
        await new Promise<void>(resolve => waiting.set(key, resolve))
      }

      if (throws.has(key)) {
        throw new Error('unreadable')
      }

      return broken.has(key) ? null : { sheet: sheetFor(key), image: { key } as unknown as CanvasImageSource }
    },
    release: cached => disposed.push(cached.key)
  })

  return {
    cache,
    loads,
    disposed,
    broken,
    throws,
    held,
    finish: async (key: string) => {
      waiting.get(key)?.()
      await Promise.resolve()
    },
    advance: (ms: number) => {
      time += ms
    }
  }
}

/** Acquire sheets that must load, in order. */
async function take(cache: ReturnType<typeof harness>['cache'], ...slugs: string[]): Promise<CachedSheet[]> {
  const sheets: CachedSheet[] = []

  for (const slug of slugs) {
    const cached = await cache.acquire(ref(slug))
    expect(cached).not.toBeNull()
    sheets.push(cached!)
  }

  return sheets
}

describe('the sprite cache', () => {
  it('keys a sheet by pet and revision; the renderer keeps four sheets nobody holds and decodes twelve at most', () => {
    expect(sheetKey({ slug: 'boba', revision: '17:2048' })).toBe('boba@17:2048')
    expect(SPRITE_CACHE_CAP).toBe(4)
    expect(SPRITE_CACHE_MAX).toBe(12)
    expect(spriteCache.cap).toBe(SPRITE_CACHE_CAP)
    expect(spriteCache.max).toBe(SPRITE_CACHE_MAX)
  })

  it('loads a sheet once and shares it between its holders, even while it is still loading', async () => {
    const { cache, loads, disposed, held, finish } = harness()
    held.add('boba@1')

    const first = cache.acquire(ref('boba'))
    const second = cache.acquire(ref('boba'))
    expect(loads).toEqual(['boba@1'])
    expect(cache.peek('boba@1')).toBeNull()

    await finish('boba@1')
    const [a, b] = await Promise.all([first, second])

    expect(a).toBe(b)
    expect(a).toMatchObject({ key: 'boba@1', slug: 'boba', sheet: { url: 'blob:boba@1' } })
    expect(cache.peek('boba@1')).toBe(a)

    cache.release('boba@1')
    cache.release('boba@1')
    expect(cache.peek('boba@1')).toBe(a)
    expect(disposed).toEqual([])

    expect(await cache.acquire(ref('boba'))).toBe(a)
    expect(loads).toEqual(['boba@1'])
  })

  it('finds the cached sheet a loaded sheet belongs to, until it leaves the cache', async () => {
    const { cache } = harness({ cap: 1 })
    const [boba] = await take(cache, 'boba')

    expect(cache.find(boba.sheet)).toBe(boba)
    expect(cache.find(sheetFor('boba@1'))).toBeNull()

    cache.release(boba.key)
    const [mochi] = await take(cache, 'mochi')
    cache.release(mochi.key)

    expect(cache.find(boba.sheet)).toBeNull()
    expect(cache.peek(boba.key)).toBeNull()
  })

  it('never refuses a sheet for want of room below its ceiling: six pets held at once all load', async () => {
    const { cache, loads, disposed } = harness()
    const slugs = ['a', 'b', 'c', 'd', 'e', 'f']
    const sheets = await Promise.all(slugs.map(slug => cache.acquire(ref(slug))))

    expect(sheets.map(sheet => sheet?.key)).toEqual(slugs.map(slug => `${slug}@1`))
    expect(loads).toHaveLength(6)
    expect(disposed).toEqual([])
    expect(slugs.every(slug => cache.peek(`${slug}@1`) !== null)).toBe(true)
  })

  it('keeps up to its cap of sheets nobody holds, letting go of the one released longest ago first and never of a held one', async () => {
    const { cache, loads, disposed } = harness({ cap: 2 })
    await take(cache, 'a', 'b', 'c', 'd', 'e')
    cache.release('b@1')
    cache.release('a@1')
    expect(disposed).toEqual([])

    cache.release('d@1')
    expect(disposed).toEqual(['b@1'])
    cache.release('c@1')
    expect(disposed).toEqual(['b@1', 'a@1'])

    expect(await cache.acquire(ref('d'))).toMatchObject({ key: 'd@1' })
    cache.release('e@1')
    expect(disposed).toEqual(['b@1', 'a@1'])
    cache.release('d@1')
    expect(disposed).toEqual(['b@1', 'a@1', 'c@1'])
    expect(cache.peek('e@1')).not.toBeNull()
    expect(cache.peek('d@1')).not.toBeNull()
    expect(loads).toEqual(['a@1', 'b@1', 'c@1', 'd@1', 'e@1'])
  })

  it('counts a sheet that finished loading after its holders let go among the ones nobody holds', async () => {
    const { cache, disposed, held, finish } = harness({ cap: 1 })
    await take(cache, 'a')
    cache.release('a@1')
    held.add('b@1')
    const pending = cache.acquire(ref('b'))
    cache.release('b@1')
    await finish('b@1')

    expect(await pending).toMatchObject({ key: 'b@1' })
    expect(disposed).toEqual(['a@1'])
  })

  it('refuses a new sheet past its ceiling without loading it, after making room from the sheets nobody holds', async () => {
    const { cache, loads, disposed } = harness({ cap: 2, max: 3 })
    await take(cache, 'a', 'b')
    cache.release('a@1')
    await take(cache, 'c', 'd')

    expect(disposed).toEqual(['a@1'])
    expect(await cache.acquire(ref('e'))).toBeNull()
    expect(cache.failed('e@1')).toBe(false)
    expect(loads).toEqual(['a@1', 'b@1', 'c@1', 'd@1'])
  })

  it('counts sheets still loading toward its ceiling', async () => {
    const { cache, loads, held, finish } = harness({ cap: 1, max: 1 })
    held.add('a@1')
    const pending = cache.acquire(ref('a'))

    expect(await cache.acquire(ref('b'))).toBeNull()
    expect(loads).toEqual(['a@1'])

    await finish('a@1')
    expect(await pending).toMatchObject({ key: 'a@1' })
  })

  it('lets a view refused at the ceiling load once another view lets a sheet go', async () => {
    const { cache, disposed } = harness({ cap: 1, max: 2 })
    await take(cache, 'a', 'b')
    expect(await cache.acquire(ref('c'))).toBeNull()

    const retried = new Promise<CachedSheet | null>(resolve => {
      const off = cache.onRelease(() => {
        off()
        resolve(cache.acquire(ref('c')))
      })
    })
    cache.release('a@1')

    expect(await retried).toMatchObject({ key: 'c@1' })
    expect(disposed).toEqual(['a@1'])
  })

  it('replaces an old revision of a pet as soon as nobody holds it', async () => {
    const { cache, disposed } = harness()
    const old = await cache.acquire(ref('boba', '1'))
    const next = await cache.acquire(ref('boba', '2'))

    expect(old).not.toBe(next)
    expect(cache.peek('boba@1')).toBe(old)

    cache.release('boba@1')
    expect(disposed).toEqual(['boba@1'])
    expect(cache.peek('boba@1')).toBeNull()

    await take(cache, 'mochi')
    cache.release('mochi@1')
    expect(cache.peek('mochi@1')).not.toBeNull()

    await cache.acquire(ref('mochi', '2'))
    expect(disposed).toEqual(['boba@1', 'mochi@1'])
  })

  it('ignores a release of a key it does not hold, and never counts below none', async () => {
    const { cache, disposed } = harness({ cap: 1, max: 1 })
    cache.release('ghost@1')

    await take(cache, 'a')
    cache.release('a@1')
    cache.release('a@1')
    await take(cache, 'a')

    expect(await cache.acquire(ref('b'))).toBeNull()
    expect(disposed).toEqual([])
  })

  it('gives null for a sheet it cannot read, says so, and keeps no room for it', async () => {
    const { cache, loads, disposed, broken, throws } = harness({ cap: 1, max: 1 })
    broken.add('torn@1')
    throws.add('bad@1')

    expect(await cache.acquire(ref('torn'))).toBeNull()
    expect(await cache.acquire(ref('bad'))).toBeNull()
    expect(cache.failed('torn@1')).toBe(true)
    expect(cache.failed('bad@1')).toBe(true)
    expect(cache.peek('torn@1')).toBeNull()

    expect(await cache.acquire(ref('a'))).toMatchObject({ key: 'a@1' })
    expect(loads).toEqual(['torn@1', 'bad@1', 'a@1'])
    expect(disposed).toEqual([])
  })

  it('reads a failed sheet again only after a short wait, or at once for a new revision', async () => {
    const { cache, loads, broken, advance } = harness()
    broken.add('torn@1')
    expect(await cache.acquire(ref('torn'))).toBeNull()

    broken.clear()
    advance(SPRITE_RETRY_MS - 1)
    expect(await cache.acquire(ref('torn'))).toBeNull()
    expect(cache.failed('torn@1')).toBe(true)
    expect(loads).toEqual(['torn@1'])

    advance(1)
    expect(await cache.acquire(ref('torn'))).toMatchObject({ key: 'torn@1' })
    expect(cache.failed('torn@1')).toBe(false)
    expect(loads).toEqual(['torn@1', 'torn@1'])

    broken.add('rip@1')
    expect(await cache.acquire(ref('rip'))).toBeNull()
    expect(await cache.acquire(ref('rip', '2'))).toMatchObject({ key: 'rip@2' })
    expect(loads).toEqual(['torn@1', 'torn@1', 'rip@1', 'rip@2'])
  })

  it('drops a sheet that finished loading for nobody once a newer revision was asked for', async () => {
    const { cache, disposed, held, finish } = harness()
    held.add('boba@1')
    const old = cache.acquire(ref('boba', '1'))
    cache.release('boba@1')
    expect(await cache.acquire(ref('boba', '2'))).toMatchObject({ key: 'boba@2' })

    await finish('boba@1')
    expect(await old).toBeNull()
    expect(disposed).toEqual(['boba@1'])
  })

  it('tells its listeners soon after a sheet loses its last holder, once for several, and not for failed reads', async () => {
    const { cache, broken } = harness()
    const listener = vi.fn()
    const off = cache.onRelease(listener)
    await take(cache, 'a', 'b')

    cache.release('a@1')
    cache.release('b@1')
    expect(listener).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)

    broken.add('torn@1')
    await cache.acquire(ref('torn'))
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)

    off()
    await take(cache, 'a')
    cache.release('a@1')
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps at least one sheet whatever cap it is given, and a ceiling no lower than its cap', () => {
    expect(harness({ cap: 0 }).cache.cap).toBe(1)
    expect(harness({ cap: Number.NaN }).cache.cap).toBe(1)
    expect(harness({ cap: 2.7 }).cache.cap).toBe(2)
    expect(harness({ cap: 3, max: 2 }).cache.max).toBe(3)
    expect(harness({ cap: 2, max: Number.NaN }).cache.max).toBe(2)
    expect(createSpriteCache({ cap: 2, load: async () => null, release: () => undefined }).max).toBe(2)
  })
})
