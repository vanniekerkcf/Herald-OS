// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type InstalledPet, PET_OFF } from '../../../shared/pet.ts'
import { $petInfo } from '../pet/info.ts'
import { spriteCache } from './cache.ts'
import { PetFigure } from './PetFigure.tsx'

const loader = vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  return { loads: [] as string[], broken: new Set<string>(), waiting: new Map<string, () => void>(), held: new Set<string>() }
})

vi.mock('./cache.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./cache.ts')>()

  return {
    ...actual,
    spriteCache: actual.createSpriteCache({
      cap: 1,
      max: 1,
      load: async ref => {
        const key = actual.sheetKey(ref)
        loader.loads.push(key)

        if (loader.held.has(key)) {
          await new Promise<void>(resolve => loader.waiting.set(key, resolve))
        }

        return loader.broken.has(key) ? null : { sheet: { url: `blob:${key}`, width: 192, height: 208, layout: { columns: 1, rows: 1, rowNames: ['idle'], frames: [1] } }, image: {} as CanvasImageSource }
      },
      release: () => undefined
    })
  }
})

const pet = (slug: string, revision: string | null = '1'): InstalledPet => ({ slug, displayName: slug, revision, mime: revision ? 'image/webp' : null })

let host: HTMLDivElement
let root: Root
let counter = 0

/** A pet slug no earlier test has used, since the cache lives across tests. */
const fresh = (name: string): string => `${name}-${++counter}`

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function render(slug: string): void {
  act(() => {
    root.render(<PetFigure slug={slug} scale={0.22} />)
  })
}

const paw = () => host.querySelector('span[aria-hidden="true"] svg')

describe('PetFigure', () => {
  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    $petInfo.set(PET_OFF)
  })

  it('shows nothing while the sheet loads, then the pet', async () => {
    const slug = fresh('boba')
    loader.held.add(`${slug}@1`)
    $petInfo.set({ ...PET_OFF, installed: [pet(slug)] })
    render(slug)
    await settle()

    expect(host.innerHTML).toBe('')

    loader.waiting.get(`${slug}@1`)?.()
    await settle()

    expect(host.querySelector('canvas')).not.toBeNull()
    expect(paw()).toBeNull()
  })

  it('shows a muted paw the size of the preview when the sheet cannot be read, and does not read it again on a release', async () => {
    const slug = fresh('torn')
    loader.broken.add(`${slug}@1`)
    $petInfo.set({ ...PET_OFF, installed: [pet(slug)] })
    render(slug)
    await settle()

    const box = host.firstElementChild as HTMLElement
    expect(paw()).not.toBeNull()
    expect(box.className).toContain('text-fg-4')
    expect(box.style.width).toBe('42px')
    expect(box.style.height).toBe('46px')

    const other = await spriteCache.acquire({ slug: fresh('other'), revision: '1', mime: 'image/webp' })
    spriteCache.release(other!.key)
    await settle()

    expect(loader.loads.filter(key => key === `${slug}@1`)).toHaveLength(1)
    expect(paw()).not.toBeNull()
  })

  it('shows the paw for an installed pet main found no sheet for, and nothing for one that is not installed', async () => {
    const slug = fresh('bare')
    $petInfo.set({ ...PET_OFF, installed: [pet(slug, null)] })
    render(slug)
    await settle()

    expect(paw()).not.toBeNull()

    render(fresh('ghost'))
    await settle()

    expect(host.innerHTML).toBe('')
  })

  it('shows the paw while the cache has no room, and the pet once another view lets a sheet go', async () => {
    const slug = fresh('mochi')
    const other = await spriteCache.acquire({ slug: fresh('room'), revision: '1', mime: 'image/webp' })
    $petInfo.set({ ...PET_OFF, installed: [pet(slug)] })
    render(slug)
    await settle()

    expect(paw()).not.toBeNull()

    spriteCache.release(other!.key)
    await settle()

    expect(host.querySelector('canvas')).not.toBeNull()
    expect(paw()).toBeNull()
  })
})
