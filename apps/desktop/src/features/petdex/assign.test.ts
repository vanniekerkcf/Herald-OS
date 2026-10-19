import { describe, expect, it } from 'vitest'
import type { InstalledPet } from '../../../shared/pet.ts'
import { ROOM_KINDS, ROOM_PREFS_DEFAULTS, type RoomKind, type RoomPrefs } from '../../../shared/room.ts'
import { assignPets, kindPets, type PetAssignment, ROOM_SHEET_CAP } from './assign.ts'
import { PET_TINTS } from './draw.ts'

const CAP = 4
const pets = (...slugs: string[]): InstalledPet[] => slugs.map(slug => ({ slug, displayName: slug, revision: '1:1', mime: 'image/webp' }))
const prefs = (choices: Partial<Record<RoomKind, string | null>> = {}, extra: Partial<RoomPrefs> = {}): RoomPrefs => ({ ...ROOM_PREFS_DEFAULTS, ...extra, pets: { ...ROOM_PREFS_DEFAULTS.pets, ...choices } })
const agent = (id: string, kind: RoomKind = 'conversation') => ({ id, kind })
const slugsOf = (assigned: Record<string, PetAssignment>) => Object.fromEntries(Object.entries(assigned).map(([id, pet]) => [id, pet.slug]))
const tintsOf = (assigned: Record<string, PetAssignment>) => Object.values(assigned).map(pet => pet.tint)

describe('kindPets', () => {
  it('has no pet for any kind when none is installed', () => {
    expect(kindPets([], prefs({ conversation: 'boba' }))).toEqual({ conversation: null, mission: null, helper: null, automation: null, elsewhere: null })
  })

  it('gives each kind of work its own pet, in kind order over the installed pets, when there are enough', () => {
    expect(kindPets(pets('a', 'b', 'c', 'd', 'e'), prefs())).toEqual({ conversation: 'a', mission: 'b', helper: 'c', automation: 'd', elsewhere: 'e' })
  })

  it('goes round the installed pets again when there are fewer than kinds', () => {
    expect(kindPets(pets('a', 'b'), prefs())).toEqual({ conversation: 'a', mission: 'b', helper: 'a', automation: 'b', elsewhere: 'a' })
    expect(kindPets(pets('solo'), prefs())).toEqual({ conversation: 'solo', mission: 'solo', helper: 'solo', automation: 'solo', elsewhere: 'solo' })
  })

  it('takes the person’s choice for a kind, and gives the other kinds the pets nobody chose', () => {
    expect(kindPets(pets('a', 'b', 'c', 'd'), prefs({ mission: 'a' }))).toEqual({ conversation: 'b', mission: 'a', helper: 'c', automation: 'd', elsewhere: 'b' })
    expect(kindPets(pets('a', 'b', 'c'), prefs({ conversation: 'c', helper: 'c' }))).toEqual({ conversation: 'c', mission: 'a', helper: 'c', automation: 'b', elsewhere: 'a' })
  })

  it('shares the chosen pets round when the person chose every installed one', () => {
    expect(kindPets(pets('a', 'b'), prefs({ conversation: 'b', mission: 'a' }))).toEqual({ conversation: 'b', mission: 'a', helper: 'a', automation: 'b', elsewhere: 'a' })
  })

  it('ignores a chosen pet that is not installed', () => {
    expect(kindPets(pets('a', 'b', 'c', 'd'), prefs({ conversation: 'ghost' }))).toEqual({ conversation: 'a', mission: 'b', helper: 'c', automation: 'd', elsewhere: 'a' })
  })
})

describe('assignPets', () => {
  it('has no pets to give when none is installed', () => {
    expect(assignPets([agent('s:1'), agent('h:2', 'helper')], [], prefs(), {}, CAP)).toEqual({})
  })

  it('gives every agent the one installed pet, told apart by tints in order of arrival', () => {
    const agents = ['s:1', 's:2', 'h:3', 'h:4', 's:5', 'h:6', 's:7', 's:8', 'h:9', 's:10'].map(id => agent(id, id.startsWith('h') ? 'helper' : 'conversation'))
    const assigned = assignPets(agents, pets('boba'), prefs(), {}, CAP)

    expect(new Set(Object.values(assigned).map(pet => pet.slug))).toEqual(new Set(['boba']))
    expect(tintsOf(assigned)).toEqual([null, 1, 2, 3, 4, 5, 6, 7, null, 1])
    expect(PET_TINTS).toHaveLength(8)
  })

  it('leaves every pet its own colours when tints are off', () => {
    const assigned = assignPets([agent('s:1'), agent('s:2'), agent('h:3', 'helper')], pets('boba'), prefs({}, { tints: false }), {}, CAP)

    expect(tintsOf(assigned)).toEqual([null, null, null])
  })

  it('gives each kind its pet, tinting only the agents that share one', () => {
    const agents = [agent('s:1'), agent('m:2', 'mission'), agent('h:3', 'helper'), agent('h:4', 'helper'), agent('s:5'), agent('a:6', 'automation')]
    const assigned = assignPets(agents, pets('alpha', 'boba', 'mochi', 'zed'), prefs(), {}, CAP)

    expect(assigned).toEqual({
      's:1': { slug: 'alpha', tint: null },
      'm:2': { slug: 'boba', tint: null },
      'h:3': { slug: 'mochi', tint: null },
      'h:4': { slug: 'mochi', tint: 1 },
      's:5': { slug: 'alpha', tint: 1 },
      'a:6': { slug: 'zed', tint: null }
    })
  })

  it('uses the person’s choice for a kind, and an automatic pet for a chosen one that is not installed', () => {
    const agents = [agent('s:1'), agent('h:2', 'helper')]

    expect(slugsOf(assignPets(agents, pets('alpha', 'boba', 'mochi'), prefs({ helper: 'alpha', conversation: 'mochi' }), {}, CAP))).toEqual({ 's:1': 'mochi', 'h:2': 'alpha' })
    expect(slugsOf(assignPets(agents, pets('alpha', 'boba', 'mochi'), prefs({ helper: 'ghost' }), {}, CAP))).toEqual({ 's:1': 'alpha', 'h:2': 'mochi' })
  })

  it('keeps each agent’s pet and tint while others come and go, and gives a departed agent’s tint to the next one', () => {
    const installed = pets('boba')
    const first = assignPets([agent('a'), agent('b'), agent('c')], installed, prefs(), {}, CAP)
    expect(tintsOf(first)).toEqual([null, 1, 2])

    const second = assignPets([agent('a'), agent('c')], installed, prefs(), first, CAP)
    expect(second).toEqual({ a: { slug: 'boba', tint: null }, c: { slug: 'boba', tint: 2 } })

    const third = assignPets([agent('a'), agent('c'), agent('d'), agent('e')], installed, prefs(), second, CAP)
    expect(third).toEqual({ a: { slug: 'boba', tint: null }, c: { slug: 'boba', tint: 2 }, d: { slug: 'boba', tint: 1 }, e: { slug: 'boba', tint: 3 } })

    const fourth = assignPets([agent('c'), agent('d'), agent('e'), agent('f')], installed, prefs(), third, CAP)
    expect(fourth).toEqual({ c: { slug: 'boba', tint: 2 }, d: { slug: 'boba', tint: 1 }, e: { slug: 'boba', tint: 3 }, f: { slug: 'boba', tint: null } })
  })

  it('keeps an agent on its pet when a newly installed one would now be picked for its kind', () => {
    const before = assignPets([agent('s:1'), agent('m:2', 'mission')], pets('alpha'), prefs(), {}, CAP)
    expect(before).toEqual({ 's:1': { slug: 'alpha', tint: null }, 'm:2': { slug: 'alpha', tint: 1 } })

    const after = assignPets([agent('s:1'), agent('m:2', 'mission'), agent('m:3', 'mission')], pets('alpha', 'boba'), prefs(), before, CAP)
    expect(after).toEqual({ 's:1': { slug: 'alpha', tint: null }, 'm:2': { slug: 'alpha', tint: 1 }, 'm:3': { slug: 'boba', tint: null } })
  })

  it('moves agents to the pet the person picks for their kind', () => {
    const before = assignPets([agent('s:1'), agent('m:2', 'mission'), agent('m:3', 'mission')], pets('alpha'), prefs(), {}, CAP)
    const after = assignPets([agent('s:1'), agent('m:2', 'mission'), agent('m:3', 'mission')], pets('alpha', 'boba'), prefs({ mission: 'boba' }), before, CAP)

    expect(after).toEqual({ 's:1': { slug: 'alpha', tint: null }, 'm:2': { slug: 'boba', tint: null }, 'm:3': { slug: 'boba', tint: 1 } })
  })

  it('moves an agent off a pet that is no longer installed', () => {
    const after = assignPets([agent('s:1'), agent('h:2', 'helper')], pets('alpha', 'boba', 'mochi'), prefs(), { 's:1': { slug: 'gone', tint: 3 }, 'h:2': { slug: 'mochi', tint: null } }, CAP)

    expect(after).toEqual({ 's:1': { slug: 'alpha', tint: null }, 'h:2': { slug: 'mochi', tint: null } })
  })

  it('uses no more than cap distinct pets, sharing those already in use', () => {
    const agents = [agent('s:1'), agent('m:2', 'mission'), agent('h:3', 'helper'), agent('a:4', 'automation'), agent('h:5', 'helper')]
    const installed = pets('alpha', 'boba', 'mochi', 'zed')

    expect(assignPets(agents, installed, prefs(), {}, 2)).toEqual({
      's:1': { slug: 'alpha', tint: null },
      'm:2': { slug: 'boba', tint: null },
      'h:3': { slug: 'alpha', tint: 1 },
      'a:4': { slug: 'alpha', tint: 2 },
      'h:5': { slug: 'alpha', tint: 3 }
    })
    expect(new Set(Object.values(assignPets(agents, installed, prefs(), {}, 1)).map(pet => pet.slug))).toEqual(new Set(['alpha']))
    expect(new Set(Object.values(assignPets(agents, installed, prefs(), {}, 3)).map(pet => pet.slug)).size).toBe(3)
  })

  it('gives five kinds of work five distinct sheets when five pets are installed', () => {
    const agents = ROOM_KINDS.map((kind, index) => agent(`${kind}:${index}`, kind))
    const assigned = assignPets(agents, pets('alpha', 'boba', 'mochi', 'zed', 'kiwi'), prefs(), {}, ROOM_SHEET_CAP)

    expect(ROOM_SHEET_CAP).toBe(5)
    expect(new Set(Object.values(assigned).map(pet => pet.slug))).toEqual(new Set(['alpha', 'boba', 'mochi', 'zed', 'kiwi']))
    expect(tintsOf(assigned)).toEqual([null, null, null, null, null])
  })

  it('keeps the pets that still fit when the cap shrinks, and stays put when it grows again', () => {
    const agents = [agent('s:1'), agent('m:2', 'mission'), agent('h:3', 'helper')]
    const installed = pets('alpha', 'boba', 'mochi')
    const wide = assignPets(agents, installed, prefs(), {}, CAP)
    expect(slugsOf(wide)).toEqual({ 's:1': 'alpha', 'm:2': 'boba', 'h:3': 'mochi' })

    const narrow = assignPets(agents, installed, prefs(), wide, 2)
    expect(narrow).toEqual({ 's:1': { slug: 'alpha', tint: null }, 'm:2': { slug: 'boba', tint: null }, 'h:3': { slug: 'alpha', tint: 1 } })

    expect(assignPets(agents, installed, prefs(), narrow, CAP)).toEqual(narrow)
  })

  it('has no pets to give when the cap leaves no room', () => {
    expect(assignPets([agent('s:1')], pets('alpha'), prefs(), {}, 0)).toEqual({})
    expect(assignPets([agent('s:1')], pets('alpha'), prefs(), {}, Number.NaN)).toEqual({})
  })

  it('colours the agents that share a pet once tints are turned on, the first keeping its own colours', () => {
    const agents = [agent('a'), agent('b'), agent('c')]
    const off = assignPets(agents, pets('boba'), prefs({}, { tints: false }), {}, CAP)
    const on = assignPets(agents, pets('boba'), prefs(), off, CAP)

    expect(tintsOf(on)).toEqual([null, 1, 2])
    expect(tintsOf(assignPets(agents, pets('boba'), prefs({}, { tints: false }), on, CAP))).toEqual([null, null, null])
  })

  it('gives a fresh tint to an agent whose kept tint no longer exists or is taken', () => {
    const assigned = assignPets([agent('a'), agent('b'), agent('c')], pets('boba'), prefs(), { a: { slug: 'boba', tint: 42 }, b: { slug: 'boba', tint: 2 }, c: { slug: 'boba', tint: 2 } }, CAP)

    expect(assigned).toEqual({ a: { slug: 'boba', tint: null }, b: { slug: 'boba', tint: 2 }, c: { slug: 'boba', tint: 1 } })
  })

  it('gives the same answer for the same agents, pets and choices', () => {
    const agents = [agent('s:1'), agent('m:2', 'mission'), agent('s:3'), agent('h:4', 'helper')]
    const installed = pets('alpha', 'boba')

    expect(assignPets(agents, installed, prefs(), {}, CAP)).toEqual(assignPets(agents, installed, prefs(), {}, CAP))
    const once = assignPets(agents, installed, prefs(), {}, CAP)
    expect(assignPets(agents, installed, prefs(), once, CAP)).toEqual(once)
  })
})
