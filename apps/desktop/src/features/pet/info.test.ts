import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PET_OFF, type PetInfo } from '../../../shared/pet.ts'
import { spriteCache } from '../petdex/cache.ts'
import { $petInfo, $petSheet, bindPetSheet } from './info.ts'

// The stores read the preload bridge when they load; tests run without a DOM.
const loader = vi.hoisted(() => {
  Object.assign(globalThis, { window: {} })

  return { loads: [] as string[], disposed: [] as string[], broken: new Set<string>() }
})

vi.mock('../petdex/cache.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../petdex/cache.ts')>()

  return {
    ...actual,
    spriteCache: actual.createSpriteCache({
      cap: 2,
      load: async ref => {
        const key = actual.sheetKey(ref)
        loader.loads.push(key)

        return loader.broken.has(key) ? null : { sheet: { url: `blob:${key}`, width: 192, height: 208, layout: { columns: 1, rows: 1, rowNames: ['idle'], frames: [1] } }, image: {} as CanvasImageSource }
      },
      release: cached => loader.disposed.push(cached.key)
    })
  }
})

const shown = (slug: string, revision: string, extra: Partial<PetInfo> = {}): PetInfo => ({
  ...PET_OFF,
  enabled: true,
  slug,
  displayName: slug,
  revision,
  mime: 'image/webp',
  installed: [{ slug, displayName: slug, revision, mime: 'image/webp' }],
  ...extra
})

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const shownUrl = () => $petSheet.get()?.url ?? null

describe('the shown pet’s spritesheet', () => {
  const holding: string[] = []

  beforeAll(() => bindPetSheet())

  afterEach(async () => {
    $petInfo.set(PET_OFF)
    holding.splice(0).forEach(key => spriteCache.release(key))
    await settle()
    loader.loads.length = 0
    loader.disposed.length = 0
  })

  /** Another view holding a sheet, as the Room or Settings' previews would. */
  async function hold(slug: string): Promise<void> {
    const cached = await spriteCache.acquire({ slug, revision: '1', mime: 'image/webp' })
    expect(cached).not.toBeNull()
    holding.push(cached!.key)
  }

  it('comes from the sprite cache, once per revision, and stays on show until the next one is in', async () => {
    $petInfo.set(shown('boba', '1'))
    await settle()
    expect(shownUrl()).toBe('blob:boba@1')
    expect(spriteCache.find($petSheet.get()!)).toMatchObject({ key: 'boba@1' })

    $petInfo.set(shown('boba', '1', { scale: 0.5 }))
    await settle()
    expect(loader.loads).toEqual(['boba@1'])

    const evicted = loader.disposed.length
    $petInfo.set(shown('boba', '2'))
    expect(shownUrl()).toBe('blob:boba@1')
    await settle()
    expect(shownUrl()).toBe('blob:boba@2')
    expect(loader.loads).toEqual(['boba@1', 'boba@2'])
    expect(loader.disposed.slice(evicted)).toEqual(['boba@1'])
  })

  it('is let go when the pet is turned off, and comes back from the cache without reading it again', async () => {
    $petInfo.set(shown('mochi', '1'))
    await settle()
    const sheet = $petSheet.get()

    $petInfo.set(shown('mochi', '1', { enabled: false }))
    expect($petSheet.get()).toBeNull()
    expect(spriteCache.peek('mochi@1')).not.toBeNull()

    $petInfo.set(shown('mochi', '1'))
    await settle()
    expect($petSheet.get()).toBe(sheet)
    expect(loader.loads).toEqual(['mochi@1'])
  })

  it('ends on the pet shown last when pets change faster than their sheets load', async () => {
    $petInfo.set(shown('alpha', '1'))
    $petInfo.set(shown('zed', '1'))
    $petInfo.set(shown('alpha', '1'))
    await settle()

    expect(shownUrl()).toBe('blob:alpha@1')
    await hold('other')
    expect(spriteCache.peek('zed@1')).toBeNull()

    $petInfo.set(PET_OFF)
    await hold('third')
    expect(spriteCache.peek('alpha@1')).toBeNull()
  })

  it('makes room for a new revision in a full cache by letting go of the one on show', async () => {
    await hold('room')
    $petInfo.set(shown('boba', '3'))
    await settle()
    expect(shownUrl()).toBe('blob:boba@3')

    const evicted = loader.disposed.length
    $petInfo.set(shown('boba', '4'))
    await settle()

    expect(shownUrl()).toBe('blob:boba@4')
    expect(loader.disposed.slice(evicted)).toEqual(['boba@3'])
  })

  it('waits for room when other views hold every sheet, and shows the pet once one lets go', async () => {
    await hold('room')
    await hold('settings')

    $petInfo.set(shown('mochi', '2'))
    await settle()
    expect($petSheet.get()).toBeNull()

    spriteCache.release(holding.shift()!)
    await settle()
    expect(shownUrl()).toBe('blob:mochi@2')
  })

  it('shows nothing when the sheet cannot be read', async () => {
    loader.broken.add('torn@1')
    $petInfo.set(shown('torn', '1'))
    await settle()

    expect($petSheet.get()).toBeNull()
    loader.broken.clear()
  })
})
