import type { InstalledPet } from '../../../shared/pet.ts'
import { ROOM_KINDS, type RoomKind, type RoomPrefs } from '../../../shared/room.ts'
import { PET_TINTS } from './draw.ts'

/** The pet an agent shows: an installed pet's folder name and a PET_TINTS index (null for its own colours). */
export interface PetAssignment {
  slug: string
  tint: number | null
}

/** The most distinct sheets the Room draws at once: one for each kind of work. */
export const ROOM_SHEET_CAP = ROOM_KINDS.length

/**
 * The pet for each kind of work: the person's choice when that pet is installed; the other kinds
 * take the installed pets nobody chose, in kind order and then round again, so kinds differ while
 * there are pets enough. Null for every kind when no pet is installed.
 */
export function kindPets(installed: readonly InstalledPet[], prefs: RoomPrefs): Record<RoomKind, string | null> {
  const slugs = installed.map(pet => pet.slug)
  const chosen = new Map(ROOM_KINDS.map(kind => [kind, prefs.pets[kind]]).filter((entry): entry is [RoomKind, string] => entry[1] !== null && slugs.includes(entry[1])))
  const free = slugs.filter(slug => ![...chosen.values()].includes(slug))
  const pool = free.length ? free : slugs
  let next = 0

  return Object.fromEntries(ROOM_KINDS.map(kind => [kind, chosen.get(kind) ?? (pool.length ? pool[next++ % pool.length] : null)])) as Record<RoomKind, string | null>
}

/**
 * A pet for every agent: the person's choice for its kind of work, else one picked from the installed
 * pets; agents sharing a sprite get tints (when `prefs.tints` is on). `previous` keeps each agent's pet
 * and tint stable while others come and go; at most `cap` distinct sheets are used.
 */
export function assignPets(agents: readonly { id: string; kind: RoomKind }[], installed: readonly InstalledPet[], prefs: RoomPrefs, previous: Readonly<Record<string, PetAssignment>>, cap: number): Record<string, PetAssignment> {
  const limit = Math.floor(cap) || 0

  if (!installed.length || limit < 1) {
    return {}
  }

  const slugs = new Set(installed.map(pet => pet.slug))
  const wanted = kindPets(installed, prefs)
  const used: string[] = []
  const slugOf = new Map<string, string>()
  const fits = (slug: string): boolean => used.includes(slug) || used.length < limit
  const take = (id: string, slug: string) => {
    slugOf.set(id, slug)

    if (!used.includes(slug)) {
      used.push(slug)
    }
  }

  // An agent keeps its pet while it is installed and fits, unless the person has since chosen another one for its kind.
  for (const agent of agents) {
    const before = previous[agent.id]?.slug
    const chosen = prefs.pets[agent.kind]

    if (before && slugs.has(before) && (chosen === null || !slugs.has(chosen) || chosen === before) && fits(before)) {
      take(agent.id, before)
    }
  }

  for (const agent of agents) {
    if (!slugOf.has(agent.id)) {
      const slug = wanted[agent.kind] ?? installed[0].slug

      take(agent.id, fits(slug) ? slug : used[0])
    }
  }

  const tints = new Map<string, number>()

  if (prefs.tints) {
    const held = new Map<string, number[]>()
    const place = (id: string, wish: number | null) => {
      const slug = slugOf.get(id)!
      const counts = held.get(slug) ?? PET_TINTS.map(() => 0)
      const fewest = Math.min(...counts)
      const tint = wish !== null && counts[wish] === fewest ? wish : counts.indexOf(fewest)
      counts[tint]++
      held.set(slug, counts)
      tints.set(id, tint)
    }
    const stays = (id: string): boolean => previous[id]?.slug === slugOf.get(id)

    for (const agent of agents.filter(agent => stays(agent.id))) {
      place(agent.id, tintIndex(previous[agent.id].tint))
    }

    for (const agent of agents.filter(agent => !stays(agent.id))) {
      place(agent.id, null)
    }
  }

  return Object.fromEntries(agents.map(agent => [agent.id, { slug: slugOf.get(agent.id)!, tint: tints.get(agent.id) || null }]))
}

/** A kept tint as a PET_TINTS index (0 for own colours); null when there is no such tint now. */
function tintIndex(tint: number | null): number | null {
  if (tint === null) {
    return 0
  }

  return Number.isInteger(tint) && tint > 0 && tint < PET_TINTS.length ? tint : null
}
