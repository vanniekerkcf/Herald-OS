import fs from 'node:fs'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { type InstalledPet, PET_OFF, type PetDisplayConfig, type PetInfo, petDisplayConfig, safePetSlug } from '../../shared/pet.ts'
import { hermesHome } from '../paths.ts'

/*
 * Hermes's pet settings (`display.pet` in config.yaml) and the pets installed in its pets folder,
 * resolved the way Hermes resolves them (agent/pet/store.py), so the pet Herald shows is the one
 * every Hermes surface shows. config.yaml holds credentials: nothing here logs what it read.
 */

/** Where Hermes looks for a spritesheet when pet.json names none it can use, in order. */
const SHEET_NAMES = ['spritesheet.webp', 'spritesheet.png', 'sprite.webp', 'sprite.png']

interface Pet extends InstalledPet {
  sheet: string
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** The pet folders, by name: dot-folders (Hermes keeps its thumbnails in `.thumbs`) are not pets. */
function petFolders(petsDir: string): string[] {
  return listDir(petsDir)
    .filter(name => !name.startsWith('.'))
    .sort()
}

/** Off unless config.yaml says on, and off when it cannot be read or is not valid YAML. */
function readDisplayConfig(home: string): PetDisplayConfig {
  try {
    // `logLevel: 'error'` keeps YAML's warnings, which quote the file, out of the log. Hermes reads
    // config.yaml with PyYAML, where a repeated key is no error and the last one wins.
    const doc = parseDocument(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), { logLevel: 'error', prettyErrors: false, uniqueKeys: false })

    return petDisplayConfig(doc.errors.length ? null : doc.toJS())
  } catch {
    return petDisplayConfig(null)
  }
}

function readPetJson(dir: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8').replace(/^\uFEFF/, ''))

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A spritesheet pet.json may name: a file in the pet's own folder, never a path out of it. */
function sheetName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim() : ''

  return name && !/[\\/]/.test(name) && name !== '.' && name !== '..' ? name : null
}

/** A pet counts only when it has a spritesheet. */
function loadPet(petsDir: string, slug: string): Pet | null {
  const dir = path.join(petsDir, slug)
  const meta = readPetJson(dir)
  const declared = sheetName(meta.spritesheetPath)
  const sheet = [...(declared ? [declared] : []), ...SHEET_NAMES].map(name => path.join(dir, name)).find(isFile)

  if (!sheet) {
    return null
  }

  const displayName = typeof meta.displayName === 'string' && meta.displayName.trim() ? meta.displayName.trim() : slug

  return { slug, displayName, sheet }
}

function installedPets(home: string): Pet[] {
  const petsDir = path.join(home, 'pets')

  return petFolders(petsDir)
    .filter(name => isDirectory(path.join(petsDir, name)))
    .flatMap(slug => loadPet(petsDir, slug) ?? [])
}

/** A file's modification time in nanoseconds and its size, as Hermes writes a spritesheet's revision. */
function stamp(file: string): string | null {
  try {
    const stat = fs.statSync(file, { bigint: true })

    return `${stat.mtimeNs}:${stat.size}`
  } catch {
    return null
  }
}

const sheetMime = (sheet: string): 'image/png' | 'image/webp' => (path.extname(sheet).toLowerCase() === '.png' ? 'image/png' : 'image/webp')

/** The pet Hermes shows and every pet installed; never throws. */
export function readPetInfo(home = hermesHome()): PetInfo {
  try {
    const config = readDisplayConfig(home)
    const pets = installedPets(home)
    const wanted = safePetSlug(config.slug)
    const active = pets.find(pet => pet.slug === wanted) ?? pets[0] ?? null
    const installed = pets.map(({ slug, displayName, sheet }) => ({ slug, displayName, revision: stamp(sheet), mime: sheetMime(sheet) }))
    const shown = active ? installed[pets.indexOf(active)] : null

    return {
      enabled: config.enabled,
      slug: shown?.slug ?? null,
      displayName: shown?.displayName ?? null,
      scale: config.scale,
      revision: shown?.revision ?? null,
      mime: shown?.mime ?? null,
      installed
    }
  } catch {
    return PET_OFF
  }
}

/** An installed pet's spritesheet; null when the slug cannot be a pet's folder or the pet has none. */
export function petSheetPath(slug: string, home = hermesHome()): string | null {
  const safe = safePetSlug(slug)

  if (!safe || safe.startsWith('.')) {
    return null
  }

  try {
    return loadPet(path.join(home, 'pets'), safe)?.sheet ?? null
  } catch {
    return null
  }
}

/**
 * A cheap fingerprint of what `readPetInfo` reads, from file stats only: config.yaml, the pets
 * folder, each pet's folder (a spritesheet added or removed) and `sheet`, the shown pet's
 * spritesheet (replaced in place).
 */
export function signature(home = hermesHome(), sheet: string | null = null): string {
  const petsDir = path.join(home, 'pets')
  const folders = petFolders(petsDir).map(name => `${name}=${stamp(path.join(petsDir, name)) ?? '-'}`)

  return [stamp(path.join(home, 'config.yaml')) ?? '-', stamp(petsDir) ?? '-', ...folders, sheet ? (stamp(sheet) ?? '-') : ''].join('|')
}
