import { describe, expect, it } from 'vitest'
import { liveOutside, mergeRoomPrefs, normalizeRoomPrefs, ROOM_ACTIVITY_BATCH, ROOM_KINDS, ROOM_PREFS_DEFAULTS, roomActivityOf, roomLabel, roomLogEntryOf } from './room.ts'

describe('normalizeRoomPrefs', () => {
  it('reads the defaults from nothing, or from something that is not an object', () => {
    for (const raw of [undefined, null, 'full', 42, true, ['boba']]) {
      expect(normalizeRoomPrefs(raw)).toEqual(ROOM_PREFS_DEFAULTS)
    }
  })

  it('keeps the pet chosen for each kind of work on its own', () => {
    const prefs = normalizeRoomPrefs({ pets: { conversation: 'boba', helper: ' mochi ' } })

    expect(prefs.pets).toEqual({ conversation: 'boba', mission: null, helper: 'mochi', automation: null, elsewhere: null })
    expect(Object.keys(prefs.pets).sort()).toEqual([...ROOM_KINDS].sort())
  })

  it('drops keys it does not know, at the top and among the pets', () => {
    const prefs = normalizeRoomPrefs({ pets: { mission: 'boba', robot: 'mochi' }, colour: 'red', motion: 'calm' })

    expect(prefs).toEqual({ ...ROOM_PREFS_DEFAULTS, pets: { ...ROOM_PREFS_DEFAULTS.pets, mission: 'boba' }, motion: 'calm' })
    expect(prefs).not.toHaveProperty('colour')
    expect(prefs.pets).not.toHaveProperty('robot')
  })

  it('takes only one folder name for a pet: never a path, a dot-folder, an empty name or anything but text', () => {
    for (const slug of ['../boba', 'pets/boba', 'pets\\boba', '.boba', '..', '', '   ', 42, { slug: 'boba' }, ['boba'], true]) {
      expect(normalizeRoomPrefs({ pets: { conversation: slug } }).pets.conversation, String(slug)).toBeNull()
    }

    expect(normalizeRoomPrefs({ pets: { conversation: 'cosmo-cat_2' } }).pets.conversation).toBe('cosmo-cat_2')
  })

  it('takes only a motion it knows', () => {
    expect(normalizeRoomPrefs({ motion: 'still' }).motion).toBe('still')
    expect(normalizeRoomPrefs({ motion: 'calm' }).motion).toBe('calm')

    for (const motion of ['walk', 'FULL', '', 1, null]) {
      expect(normalizeRoomPrefs({ motion }).motion, String(motion)).toBe('full')
    }
  })

  it('turns tints and step bubbles off only with false', () => {
    expect(normalizeRoomPrefs({ tints: false, steps: false })).toMatchObject({ tints: false, steps: false })
    expect(normalizeRoomPrefs({ tints: 'no', steps: 0 })).toMatchObject({ tints: true, steps: true })
  })

  it('keeps the lane for work outside Herald and the screensaver off unless turned on, and desk names on unless turned off', () => {
    expect(normalizeRoomPrefs({})).toMatchObject({ elsewhere: false, screensaver: false, screensaverSteps: false, deskNames: true })
    expect(normalizeRoomPrefs({ elsewhere: 'yes', screensaver: 1, screensaverSteps: 'true', deskNames: 0 })).toMatchObject({ elsewhere: false, screensaver: false, screensaverSteps: false, deskNames: true })
    expect(normalizeRoomPrefs({ elsewhere: true, screensaver: true, screensaverSteps: true, deskNames: false })).toMatchObject({ elsewhere: true, screensaver: true, screensaverSteps: true, deskNames: false })
  })
})

describe('mergeRoomPrefs', () => {
  const current = { ...ROOM_PREFS_DEFAULTS, pets: { ...ROOM_PREFS_DEFAULTS.pets, conversation: 'boba', helper: 'mochi' }, motion: 'calm' as const }

  it('changes only the fields a patch names', () => {
    expect(mergeRoomPrefs(current, { steps: false })).toEqual({ ...current, steps: false })
    expect(mergeRoomPrefs(current, { motion: 'still', tints: false })).toEqual({ ...current, motion: 'still', tints: false })
  })

  it('changes the pets kind by kind, and null hands a kind back to the Room to pick', () => {
    expect(mergeRoomPrefs(current, { pets: { mission: 'boba' } }).pets).toEqual({ conversation: 'boba', mission: 'boba', helper: 'mochi', automation: null, elsewhere: null })
    expect(mergeRoomPrefs(current, { pets: { helper: null } }).pets).toEqual({ ...current.pets, helper: null })
  })

  it('leaves a field given as undefined as it was', () => {
    expect(mergeRoomPrefs(current, { motion: undefined, pets: { conversation: undefined } })).toEqual(current)
  })

  it('makes the result whole whatever it is given', () => {
    expect(mergeRoomPrefs(undefined, undefined)).toEqual(ROOM_PREFS_DEFAULTS)
    expect(mergeRoomPrefs(current, 'calm')).toEqual(current)
    expect(mergeRoomPrefs({ pets: { conversation: '../boba' }, motion: 'warp' }, { pets: 'boba', extra: 1 })).toEqual(ROOM_PREFS_DEFAULTS)
  })
})

describe("phase 3's switches", () => {
  it('keeps live detail, the activity log and the cost meters off unless turned on, with a week of log', () => {
    expect(normalizeRoomPrefs({})).toMatchObject({ elsewhereLive: false, log: false, logDays: 7, costs: false, costTotal: false })
    expect(normalizeRoomPrefs({ elsewhereLive: 'yes', log: 1, costs: 'true', costTotal: {} })).toMatchObject({ elsewhereLive: false, log: false, costs: false, costTotal: false })
    expect(normalizeRoomPrefs({ elsewhereLive: true, log: true, costs: true, costTotal: true })).toMatchObject({ elsewhereLive: true, log: true, costs: true, costTotal: true })
  })

  it('keeps the log for one of its offered spans only', () => {
    for (const days of [1, 3, 7, 14, 30]) {
      expect(normalizeRoomPrefs({ logDays: days }).logDays).toBe(days)
    }

    for (const days of [0, 2, 365, -7, 7.5, '7', null]) {
      expect(normalizeRoomPrefs({ logDays: days }).logDays, String(days)).toBe(7)
    }
  })

  it('takes live detail only while the lane is on too', () => {
    expect(liveOutside({ elsewhere: true, elsewhereLive: true })).toBe(true)
    expect(liveOutside({ elsewhere: false, elsewhereLive: true })).toBe(false)
    expect(liveOutside({ elsewhere: true, elsewhereLive: false })).toBe(false)
  })
})

describe('roomLabel', () => {
  it('names a path by its last segment and an address by its host, without credentials', () => {
    expect(roomLabel('/Users/someone/Work/Budget.xlsx')).toBe('Budget.xlsx')
    expect(roomLabel('C:\\Users\\someone\\Report.docx')).toBe('Report.docx')
    expect(roomLabel('~/Projects/site/')).toBe('site')
    expect(roomLabel('file:///Users/someone/notes.md?x=1')).toBe('notes.md?x=1')
    expect(roomLabel('https://user:secret@Example.com:8443/private/path?token=abc#frag')).toBe('example.com:8443')
  })

  it('keeps one short line, and nothing for an empty or relative name', () => {
    expect(roomLabel('Quarterly\nreport\u0000.pdf')).toBe('Quarterly report .pdf')
    expect(roomLabel('x'.repeat(80))).toBe(`${'x'.repeat(39)}…`)

    for (const value of ['', '   ', '.', '..', '~', '/', 42, null, { name: 'a' }]) {
      expect(roomLabel(value), String(value)).toBeNull()
    }
  })
})

describe('roomActivityOf', () => {
  const at = 1_760_000_000_000

  it('keeps the fields the Room knows and nothing else the plugin might send', () => {
    const event = roomActivityOf(
      { kind: 'tool.start', session: '20261015_101010_abcdef', tool: 'read_file', target: '/secret/folder/Budget.xlsx', call: 'a1b2c3d4e5f60718', source: 'telegram', at: at / 1000 - 2, args: { content: 'private text' }, result: 'file content' },
      7,
      at
    )

    expect(event).toEqual({ seq: 7, kind: 'tool.start', session: '20261015_101010_abcdef', child: null, tool: 'read_file', target: 'Budget.xlsx', call: 'a1b2c3d4e5f60718', status: null, source: 'telegram', at: at - 2000 })
    expect(JSON.stringify(event)).not.toMatch(/private text|file content|secret/)
  })

  it('refuses kinds it does not know, bad ids and tool events without a tool', () => {
    expect(roomActivityOf({ kind: 'message.delta', session: 's1' }, 1, at)).toBeNull()
    expect(roomActivityOf({ kind: 'tool.start', session: 'has spaces', tool: 'x' }, 1, at)).toBeNull()
    expect(roomActivityOf({ kind: 'tool.start', session: 's1' }, 1, at)).toBeNull()
    expect(roomActivityOf({ kind: 'tool.end', session: 's1', tool: 'rm -rf /' }, 1, at)).toBeNull()
    expect(roomActivityOf({ kind: 'helper.start', session: 's1' }, 1, at)).toBeNull()
    expect(roomActivityOf('tool.start', 1, at)).toBeNull()
  })

  it("takes a status only from its kind's fixed list, and a target only on a tool's start", () => {
    expect(roomActivityOf({ kind: 'session.end', session: 's1', status: 'interrupted' }, 1, at)?.status).toBe('interrupted')
    expect(roomActivityOf({ kind: 'session.end', session: 's1', status: 'The model said: no' }, 1, at)?.status).toBeNull()
    expect(roomActivityOf({ kind: 'approval.end', session: 's1', status: 'once' }, 1, at)?.status).toBeNull()
    expect(roomActivityOf({ kind: 'tool.end', session: 's1', tool: 'terminal', status: 'cancelled' }, 1, at)?.status).toBe('cancelled')
    expect(roomActivityOf({ kind: 'tool.end', session: 's1', tool: 'read_file', target: 'Budget.xlsx' }, 1, at)?.target).toBeNull()
    expect(roomActivityOf({ kind: 'session.start', session: 's1', source: 'Not A Source!' }, 1, at)?.source).toBeNull()
  })

  it('stamps an event no later than it arrived, and one from long ago as it arrived', () => {
    expect(roomActivityOf({ kind: 'session.start', session: 's1', at: at / 1000 + 60 }, 1, at)?.at).toBe(at)
    expect(roomActivityOf({ kind: 'session.start', session: 's1', at: at / 1000 - 3600 }, 1, at)?.at).toBe(at)
    expect(roomActivityOf({ kind: 'session.start', session: 's1' }, 1, at)?.at).toBe(at)
  })

  it('reads at most a batch of events from one request', () => {
    expect(ROOM_ACTIVITY_BATCH).toBe(100)
  })
})

describe('roomLogEntryOf', () => {
  const agent = { t: 1000, k: 'agent', id: 's:abc', kind: 'conversation', phase: 'tool', area: 'files', step: 'reading Budget.xlsx', target: 'Budget.xlsx', wait: false, parent: null, where: null, outcome: null }

  it('keeps an agent entry to its fields: never a title, a desk or anything else', () => {
    const entry = roomLogEntryOf({ ...agent, title: 'Plans for my surprise party', desk: 'docs:Secret.docx', usage: { input: 1 } })

    expect(entry).toEqual(agent)
    expect(JSON.stringify(entry)).not.toMatch(/surprise|Secret|usage/)
  })

  it('refuses an agent entry with a kind, phase, area or outcome the Room does not have', () => {
    for (const patch of [{ kind: 'robot' }, { phase: 'dancing' }, { area: 'kitchen' }, { outcome: 'great' }, { id: 'has spaces' }, { parent: 'bad id!' }, { t: 'now' }]) {
      expect(roomLogEntryOf({ ...agent, ...patch }), JSON.stringify(patch)).toBeNull()
    }
  })

  it('cuts steps and names to one short line', () => {
    const entry = roomLogEntryOf({ ...agent, step: `reading ${'a'.repeat(200)}`, target: 'line one\nline two' })

    expect(entry && entry.k === 'agent' && entry.step?.length).toBe(80)
    expect(entry && entry.k === 'agent' && entry.target).toBe('line one line two')
  })

  it('reads the markers and hand-offs, and nothing it does not know', () => {
    expect(roomLogEntryOf({ t: 5, k: 'begin', extra: 1 })).toEqual({ t: 5, k: 'begin' })
    expect(roomLogEntryOf({ t: 5, k: 'gone', id: 'h:x' })).toEqual({ t: 5, k: 'gone', id: 'h:x' })
    expect(roomLogEntryOf({ t: 5, k: 'handoff', kind: 'result', from: 'h:x', to: 's:y', failed: 'yes' })).toEqual({ t: 5, k: 'handoff', kind: 'result', from: 'h:x', to: 's:y', failed: false })
    expect(roomLogEntryOf({ t: 5, k: 'handoff', kind: 'gift', from: 'h:x', to: 's:y' })).toBeNull()
    expect(roomLogEntryOf({ t: 5, k: 'message', text: 'hello' })).toBeNull()
  })
})
