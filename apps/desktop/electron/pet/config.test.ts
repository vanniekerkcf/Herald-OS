import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PET_DEFAULT_SCALE, petShown } from '../../shared/pet.ts'
import { petSheetPath, readPetInfo, signature } from './config.ts'

describe('the pet Hermes shows', () => {
  const saved = process.env.HERMES_HOME
  let home = ''

  function config(text: string) {
    fs.writeFileSync(path.join(home, 'config.yaml'), text)
  }

  const petConfig = (pet: string) => config(`model:\n  default: some-model\ndisplay:\n  skin: default\n  pet:\n${pet.replace(/^/gm, '    ')}\n`)

  function addPet(slug: string, files: Record<string, string> = { 'spritesheet.webp': 'webp' }) {
    const dir = path.join(home, 'pets', slug)
    fs.mkdirSync(dir, { recursive: true })

    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), contents)
    }

    return dir
  }

  const revisionOf = (file: string) => {
    const stat = fs.statSync(file, { bigint: true })

    return `${stat.mtimeNs}:${stat.size}`
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-pet-'))
    process.env.HERMES_HOME = home
  })

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.HERMES_HOME
    } else {
      process.env.HERMES_HOME = saved
    }

    fs.rmSync(home, { recursive: true, force: true })
  })

  it('shows the configured pet, named by its pet.json, with its spritesheet’s revision and type', () => {
    petConfig('enabled: true\nslug: boba\nscale: 0.5')
    const dir = addPet('boba', { 'pet.json': JSON.stringify({ id: 'boba', displayName: 'Boba', spritesheetPath: 'spritesheet.webp' }), 'spritesheet.webp': 'sheet bytes' })
    const alpha = addPet('alpha')
    const stat = fs.statSync(path.join(dir, 'spritesheet.webp'), { bigint: true })

    const info = readPetInfo(home)

    expect(info).toEqual({
      enabled: true,
      slug: 'boba',
      displayName: 'Boba',
      scale: 0.5,
      revision: `${stat.mtimeNs}:${stat.size}`,
      mime: 'image/webp',
      installed: [
        { slug: 'alpha', displayName: 'alpha', revision: revisionOf(path.join(alpha, 'spritesheet.webp')), mime: 'image/webp' },
        { slug: 'boba', displayName: 'Boba', revision: `${stat.mtimeNs}:${stat.size}`, mime: 'image/webp' }
      ]
    })
    expect(petShown(info)).toBe(true)
  })

  it('is off unless Hermes says on, and takes "true" as on the way Hermes does', () => {
    addPet('boba')

    petConfig('enabled: false\nslug: boba')
    expect(readPetInfo(home)).toMatchObject({ enabled: false, slug: 'boba' })
    expect(petShown(readPetInfo(home))).toBe(false)

    petConfig('slug: boba')
    expect(readPetInfo(home).enabled).toBe(false)

    petConfig('enabled: "true"')
    expect(readPetInfo(home)).toMatchObject({ enabled: true, slug: 'boba', scale: PET_DEFAULT_SCALE })
  })

  it('reads a repeated key the way PyYAML does, the last one winning', () => {
    addPet('boba')
    petConfig('enabled: false\nslug: boba\nenabled: true')

    expect(readPetInfo(home)).toMatchObject({ enabled: true, slug: 'boba' })
  })

  it('shows the first pet by folder name when none is chosen or the chosen one is not installed', () => {
    addPet('zed')
    addPet('mochi')

    petConfig('enabled: true\nslug: ""')
    expect(readPetInfo(home).slug).toBe('mochi')

    petConfig('enabled: true\nslug: ghost')
    expect(readPetInfo(home).slug).toBe('mochi')

    petConfig('enabled: true\nslug: zed')
    expect(readPetInfo(home).slug).toBe('zed')
  })

  it('holds the size to Hermes’s bounds', () => {
    addPet('boba')

    petConfig('enabled: true\nscale: 9')
    expect(readPetInfo(home).scale).toBe(3)

    petConfig('enabled: true\nscale: tiny')
    expect(readPetInfo(home).scale).toBe(PET_DEFAULT_SCALE)
  })

  it('never follows a spritesheetPath out of the pet’s folder', () => {
    addPet('outside', { 'spritesheet.png': 'png' })
    addPet('sneaky', { 'pet.json': JSON.stringify({ spritesheetPath: '../outside/spritesheet.png' }) })
    addPet('nested', { 'pet.json': JSON.stringify({ spritesheetPath: 'art/sheet.png' }), 'spritesheet.png': 'png' })
    addPet('custom', { 'pet.json': JSON.stringify({ spritesheetPath: ' custom.png ' }), 'custom.png': 'png', 'spritesheet.webp': 'webp' })
    petConfig('enabled: true\nslug: nested')

    const info = readPetInfo(home)

    expect(info.installed.map(pet => pet.slug)).toEqual(['custom', 'nested', 'outside'])
    expect(info).toMatchObject({ slug: 'nested', mime: 'image/png' })
    expect(petSheetPath('nested', home)).toBe(path.join(home, 'pets', 'nested', 'spritesheet.png'))
    expect(petSheetPath('custom', home)).toBe(path.join(home, 'pets', 'custom', 'custom.png'))
    expect(petSheetPath('sneaky', home)).toBeNull()
  })

  it('falls back to sprite.webp, reads a pet.json with a byte order mark, and skips .thumbs and loose files', () => {
    addPet('petdex', { 'sprite.webp': 'webp' })
    addPet('bom', { 'pet.json': `\uFEFF${JSON.stringify({ displayName: '  Bom Bom  ' })}`, 'spritesheet.png': 'png' })
    addPet('.thumbs', { 'spritesheet.webp': 'webp', 'boba.png': 'png' })
    addPet('empty', {})
    fs.writeFileSync(path.join(home, 'pets', 'notes.txt'), 'not a pet')
    petConfig('enabled: true\nslug: petdex')

    const info = readPetInfo(home)

    expect(info.installed).toEqual([
      { slug: 'bom', displayName: 'Bom Bom', revision: revisionOf(path.join(home, 'pets', 'bom', 'spritesheet.png')), mime: 'image/png' },
      { slug: 'petdex', displayName: 'petdex', revision: revisionOf(path.join(home, 'pets', 'petdex', 'sprite.webp')), mime: 'image/webp' }
    ])
    expect(info).toMatchObject({ slug: 'petdex', mime: 'image/webp' })
    expect(petSheetPath('petdex', home)).toBe(path.join(home, 'pets', 'petdex', 'sprite.webp'))
  })

  it('is off when config.yaml is broken or missing, without throwing, and lists the pets all the same', () => {
    addPet('boba')

    config('display:\n  pet: [enabled: true\n')
    expect(readPetInfo(home)).toMatchObject({ enabled: false, slug: 'boba', installed: [{ slug: 'boba', displayName: 'boba' }] })

    config('display:\n  pet:\n    enabled: true\n---\nsecond: document\n')
    expect(readPetInfo(home).enabled).toBe(false)

    fs.rmSync(path.join(home, 'config.yaml'))
    expect(readPetInfo(home).enabled).toBe(false)
  })

  it('gives every installed pet its spritesheet’s revision and type, the way it gives the shown one', () => {
    petConfig('enabled: true\nslug: boba')
    const boba = addPet('boba', { 'spritesheet.png': 'png bytes' })
    const mochi = addPet('mochi', { 'pet.json': JSON.stringify({ spritesheetPath: 'Mochi.PNG' }), 'Mochi.PNG': 'upper case png' })
    const zed = addPet('zed', { 'sprite.webp': 'webp bytes' })

    const info = readPetInfo(home)

    expect(info.installed).toEqual([
      { slug: 'boba', displayName: 'boba', revision: revisionOf(path.join(boba, 'spritesheet.png')), mime: 'image/png' },
      { slug: 'mochi', displayName: 'mochi', revision: revisionOf(path.join(mochi, 'Mochi.PNG')), mime: 'image/png' },
      { slug: 'zed', displayName: 'zed', revision: revisionOf(path.join(zed, 'sprite.webp')), mime: 'image/webp' }
    ])
    expect(info).toMatchObject({ slug: 'boba', revision: info.installed[0].revision, mime: 'image/png' })

    const before = info.installed[2].revision
    fs.writeFileSync(path.join(zed, 'sprite.webp'), 'a longer new sheet')

    expect(readPetInfo(home).installed[2].revision).not.toBe(before)
    expect(readPetInfo(home).revision).toBe(info.revision)
  })

  it('has no pet to show when the pets folder is missing', () => {
    petConfig('enabled: true')

    expect(readPetInfo(home)).toEqual({ enabled: true, slug: null, displayName: null, scale: PET_DEFAULT_SCALE, revision: null, mime: null, installed: [] })
  })

  it('serves spritesheets only from a pet’s own folder', () => {
    addPet('boba')

    expect(petSheetPath('boba', home)).toBe(path.join(home, 'pets', 'boba', 'spritesheet.webp'))
    expect(petSheetPath('other/boba', home)).toBe(path.join(home, 'pets', 'boba', 'spritesheet.webp'))
    expect(petSheetPath('..', home)).toBeNull()
    expect(petSheetPath('', home)).toBeNull()
    expect(petSheetPath('.thumbs', home)).toBeNull()
    expect(petSheetPath('ghost', home)).toBeNull()
  })

  it('changes its signature when the settings, the pets or the shown spritesheet change, and only then', () => {
    petConfig('enabled: true')
    const dir = addPet('boba')
    const sheet = path.join(dir, 'spritesheet.webp')
    const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds))
    const settle = () => {
      for (const target of [path.join(home, 'config.yaml'), path.join(home, 'pets'), dir, sheet]) {
        fs.utimesSync(target, at(0), at(0))
      }
    }

    settle()
    const first = signature(home, sheet)
    expect(signature(home, sheet)).toBe(first)

    petConfig('enabled: false')
    const settings = signature(home, sheet)
    expect(settings).not.toBe(first)

    addPet('mochi')
    const added = signature(home, sheet)
    expect(added).not.toBe(settings)

    fs.writeFileSync(sheet, 'a new sheet')
    expect(signature(home, sheet)).not.toBe(added)
  })
})
