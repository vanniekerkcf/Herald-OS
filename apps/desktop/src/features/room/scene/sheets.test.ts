import { describe, expect, it, vi } from 'vitest'
import type { InstalledPet } from '../../../../shared/pet.ts'
import type { CachedSheet, PetSheetRef } from '../../petdex/cache.ts'
import { holdSheets, sheetRefOf, sheetRefs } from './sheets.ts'

// The shared cache's module reads the preload bridge when it loads; tests run without a DOM.
vi.hoisted(() => {
  Object.assign(globalThis, { window: { innerWidth: 1440, innerHeight: 900 } })
})

const pet = (slug: string, revision?: string, mime?: string): InstalledPet => ({ slug, displayName: slug, ...(revision ? { revision } : {}), ...(mime ? { mime } : {}) }) as InstalledPet

const ref = (slug: string, revision = '1'): PetSheetRef => ({ slug, revision, mime: 'image/png' })

const cached = (key: string): CachedSheet => ({ key, slug: key.split('@')[0], sheet: { url: '', width: 1, height: 1, layout: { columns: 1, rows: 1, rowNames: ['idle'], frames: [1] } }, image: {} as CanvasImageSource })

/** A cache whose loads finish when the test says so, counting holds per key; keys in `unreadable` fail to read. */
function fakeCache() {
  const loads = new Map<string, (sheet: CachedSheet | null) => void>()
  const holds = new Map<string, number>()
  const listeners = new Set<() => void>()
  const unreadable = new Set<string>()
  const cache = {
    failed: (key: string) => unreadable.has(key),
    onRelease: (listener: () => void) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    acquire: vi.fn(
      (wanted: PetSheetRef) =>
        new Promise<CachedSheet | null>(resolve => {
          const key = `${wanted.slug}@${wanted.revision}`
          loads.set(key, sheet => {
            if (sheet) {
              holds.set(key, (holds.get(key) ?? 0) + 1)
            }

            resolve(sheet)
          })
        })
    ),
    release: vi.fn((key: string) => holds.set(key, (holds.get(key) ?? 0) - 1))
  }
  const finish = async (key: string, sheet: CachedSheet | null = cached(key)) => {
    loads.get(key)?.(sheet)
    await Promise.resolve()
    await Promise.resolve()
  }
  const announce = () => listeners.forEach(listener => listener())

  return { cache, holds, finish, announce, listeners, unreadable }
}

describe('sheetRefOf', () => {
  it('reads a sheet from an installed pet with a revision and a known image type', () => {
    expect(sheetRefOf(pet('boba', '17-2048', 'image/webp'))).toEqual({ slug: 'boba', revision: '17-2048', mime: 'image/webp' })
  })

  it('skips a pet without them', () => {
    expect(sheetRefOf(pet('boba'))).toBeNull()
    expect(sheetRefOf(pet('boba', '1'))).toBeNull()
    expect(sheetRefOf(pet('boba', '1', 'image/gif'))).toBeNull()
  })
})

describe('sheetRefs', () => {
  it('gives one sheet per installed pet, in order, without repeats', () => {
    const installed = [pet('a', '1', 'image/png'), pet('b', '2', 'image/png'), pet('c')]

    expect(sheetRefs(['b', 'a', 'b', 'c', 'missing'], installed).map(entry => entry.slug)).toEqual(['b', 'a'])
  })
})

describe('holdSheets', () => {
  it('loads each sheet once and hands it out by pet once it is in', async () => {
    const { cache, finish } = fakeCache()
    const onLoad = vi.fn()
    const holder = holdSheets(cache, onLoad)
    holder.hold([ref('a')])
    holder.hold([ref('a')])

    expect(cache.acquire).toHaveBeenCalledTimes(1)
    expect(holder.get('a')).toBeNull()

    await finish('a@1')

    expect(holder.get('a')?.key).toBe('a@1')
    expect(onLoad).toHaveBeenCalledTimes(1)
  })

  it('releases a sheet once when it is no longer drawn', async () => {
    const { cache, holds, finish } = fakeCache()
    const holder = holdSheets(cache, () => undefined)
    holder.hold([ref('a'), ref('b')])
    await finish('a@1')
    await finish('b@1')
    holder.hold([ref('b')])
    holder.hold([ref('b')])

    expect(cache.release).toHaveBeenCalledTimes(1)
    expect(holds.get('a@1')).toBe(0)
    expect(holder.get('a')).toBeNull()
    expect(holder.get('b')).not.toBeNull()
  })

  it('releases a sheet that stopped being drawn while it loaded, as soon as it arrives', async () => {
    const { cache, holds, finish } = fakeCache()
    const onLoad = vi.fn()
    const holder = holdSheets(cache, onLoad)
    holder.hold([ref('a')])
    holder.hold([])
    await finish('a@1')

    expect(holds.get('a@1')).toBe(0)
    expect(onLoad).not.toHaveBeenCalled()
    expect(holder.get('a')).toBeNull()
  })

  it('keeps a sheet wanted again before it arrived, loading it only once', async () => {
    const { cache, holds, finish } = fakeCache()
    const holder = holdSheets(cache, () => undefined)
    holder.hold([ref('a')])
    holder.hold([])
    holder.hold([ref('a')])
    await finish('a@1')

    expect(cache.acquire).toHaveBeenCalledTimes(1)
    expect(holds.get('a@1')).toBe(1)
    expect(holder.get('a')).not.toBeNull()
  })

  it('moves to a new revision of a pet', async () => {
    const { cache, holds, finish } = fakeCache()
    const holder = holdSheets(cache, () => undefined)
    holder.hold([ref('a', '1')])
    await finish('a@1')
    holder.hold([ref('a', '2')])
    await finish('a@2')

    expect(holds.get('a@1')).toBe(0)
    expect(holder.get('a')?.key).toBe('a@2')
  })

  it('lets go of everything on dispose, including loads still under way', async () => {
    const { cache, holds, finish } = fakeCache()
    const holder = holdSheets(cache, () => undefined)
    holder.hold([ref('a'), ref('b')])
    await finish('a@1')
    holder.dispose()
    await finish('b@1')
    holder.hold([ref('c')])

    expect(holds.get('a@1')).toBe(0)
    expect(holds.get('b@1')).toBe(0)
    expect(cache.acquire).toHaveBeenCalledTimes(2)
  })

  it('does not release a sheet that could not be read', async () => {
    const { cache, finish } = fakeCache()
    const holder = holdSheets(cache, () => undefined)
    holder.hold([ref('a')])
    await finish('a@1', null)
    holder.hold([])

    expect(cache.release).not.toHaveBeenCalled()
    expect(holder.get('a')).toBeNull()
  })

  it('says how each held sheet is doing: loading, ready or failed', async () => {
    const { cache, finish, unreadable } = fakeCache()
    const holder = holdSheets(cache, () => undefined)
    holder.hold([ref('a'), ref('b')])

    expect(holder.state('a')).toBe('loading')

    await finish('a@1')
    unreadable.add('b@1')
    await finish('b@1', null)

    expect(holder.state('a')).toBe('ready')
    expect(holder.state('b')).toBe('failed')
    expect(holder.state('ghost')).toBeNull()

    holder.hold([ref('a')])

    expect(holder.state('b')).toBeNull()
  })

  it('asks again for a sheet the full cache had no room for once another view lets one go, failed meanwhile', async () => {
    const { cache, finish, announce } = fakeCache()
    const onChange = vi.fn()
    const holder = holdSheets(cache, onChange)
    holder.hold([ref('a')])
    await finish('a@1', null)

    expect(holder.state('a')).toBe('failed')
    expect(onChange).toHaveBeenCalledTimes(1)

    announce()

    expect(cache.acquire).toHaveBeenCalledTimes(2)
    expect(holder.state('a')).toBe('failed')

    await finish('a@1', null)

    expect(onChange).toHaveBeenCalledTimes(1)

    announce()
    await finish('a@1')

    expect(holder.get('a')).not.toBeNull()
    expect(holder.state('a')).toBe('ready')
    expect(onChange).toHaveBeenCalledTimes(2)

    announce()

    expect(cache.acquire).toHaveBeenCalledTimes(3)
  })

  it('never asks again on a release for a sheet that cannot be read, only once it is held anew', async () => {
    const { cache, finish, announce, unreadable } = fakeCache()
    const onChange = vi.fn()
    const holder = holdSheets(cache, onChange)
    unreadable.add('a@1')
    holder.hold([ref('a')])
    await finish('a@1', null)
    announce()
    announce()

    expect(cache.acquire).toHaveBeenCalledTimes(1)
    expect(holder.state('a')).toBe('failed')
    expect(onChange).toHaveBeenCalledTimes(1)

    holder.hold([ref('a')])

    expect(cache.acquire).toHaveBeenCalledTimes(1)

    holder.hold([])
    holder.hold([ref('a')])

    expect(cache.acquire).toHaveBeenCalledTimes(2)
    expect(holder.state('a')).toBe('loading')

    holder.hold([ref('a', '2')])
    unreadable.clear()
    await finish('a@2')

    expect(holder.get('a')?.key).toBe('a@2')
  })

  it('treats a load that throws as a sheet that cannot be read', async () => {
    const { cache, announce } = fakeCache()
    cache.acquire.mockRejectedValueOnce(new Error('unreadable'))
    const holder = holdSheets(cache, () => undefined)
    holder.hold([ref('a')])
    await Promise.resolve()
    await Promise.resolve()
    announce()

    expect(holder.state('a')).toBe('failed')
    expect(cache.acquire).toHaveBeenCalledTimes(1)
  })

  it('stops listening for room once disposed', () => {
    const { cache, listeners } = fakeCache()
    const holder = holdSheets(cache, () => undefined)

    expect(listeners.size).toBe(1)

    holder.dispose()

    expect(listeners.size).toBe(0)
  })
})
