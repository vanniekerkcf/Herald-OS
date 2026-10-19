import { beforeEach, describe, expect, it } from 'vitest'
import type { CommandEvent } from '../../../store/os-commands.ts'
import { COMMAND_KEEP_MS, DESKS_PER_AREA, deskFor, type DeskSeeker, meetingOf, roomCommand, roomDesks } from './desks.ts'
import { factsOf } from './facts.ts'
import { type RoomFrame, roomFrame } from './frames.ts'
import { EMPTY_ROOM, reduceRoom, type RoomInput } from './reducer.ts'
import type { RoomCommand, RoomDesk, RoomState } from './types.ts'

const T0 = 1_000_000
let nextSeq = 0

beforeEach(() => {
  nextSeq = 0
})

const f = (type: string, payload: Record<string, unknown>, sessionId: string): RoomFrame => roomFrame({ type, session_id: sessionId, seq: ++nextSeq, payload })!
const live = (frame: RoomFrame, at: number): RoomInput => ({ type: 'live', epoch: 'e1', frame, at })
const run = (state: RoomState, ...inputs: RoomInput[]): RoomState => inputs.reduce(reduceRoom, state)

const office = [
  {
    app: 'docs',
    at: T0,
    active: 'k1',
    documents: [
      { key: 'k1', path: '/Users/someone/Plans/Launch plan.docx', name: 'Launch plan.docx', format: 'docx', modified: true, selection: 'the secret paragraph', detail: 'page 2' },
      { key: 'k2', path: null, name: 'Notes.docx', format: 'docx', modified: false }
    ]
  },
  { app: 'sheets', at: T0 - 50, active: 'w1', documents: [{ key: 'w1', path: '/tmp/Budget.xlsx', name: 'Budget.xlsx', format: 'xlsx', modified: false, selection: 'A1:B9' }] }
]
const canvas = [{ at: T0 - 10, active: 'c1', documents: [{ key: 'c1', path: '/Users/someone/Art/Poster.herald', name: 'Poster', width: 100, height: 100, modified: false, layers: 3 }] }]

const desk = (patch: Partial<RoomDesk> & { id: string }): RoomDesk => ({ area: 'docs', name: 'Launch plan.docx', front: false, usedAt: T0, ...patch })

const seeker = (patch: Partial<DeskSeeker> = {}): DeskSeeker => ({ phase: 'tool', area: 'docs', target: null, sessionId: 'live-1', turnStartedAt: T0, front: true, ...patch })

const event = (patch: Partial<CommandEvent>): CommandEvent => ({ id: 1, command: 'docs.write', args: {}, source: 'agent', result: { ok: true, summary: 'Wrote' }, ts: T0, session: 'live-1', ...patch })

describe('desks from Office and Canvas presence', () => {
  it('stand for each open document by name, never its path, selection or what is in front inside it', () => {
    const desks = roomDesks(office, canvas)

    expect(desks).toEqual([
      { id: 'docs:k1', area: 'docs', name: 'Launch plan.docx', front: true, usedAt: T0 },
      { id: 'docs:k2', area: 'docs', name: 'Notes.docx', front: false, usedAt: T0 },
      { id: 'sheets:w1', area: 'sheets', name: 'Budget.xlsx', front: true, usedAt: T0 - 50 },
      { id: 'canvas:c1', area: 'canvas', name: 'Poster', front: true, usedAt: T0 - 10 }
    ])
    expect(JSON.stringify(desks)).not.toMatch(/someone|secret|page 2|A1:B9|\/tmp/)
  })

  it('marks the front document of the most recently used window only, and keeps a few an area', () => {
    const many = Array.from({ length: DESKS_PER_AREA + 2 }, (_, index) => ({ key: `d${index}`, name: `Doc ${index}.docx` }))
    const desks = roomDesks([{ app: 'docs', at: T0, active: 'd5', documents: many }, { app: 'docs', at: T0 - 1, active: 'x', documents: [{ key: 'x', name: 'Other.docx' }] }], [])

    expect(desks.filter(entry => entry.front).map(entry => entry.id)).toEqual(['docs:d5'])
    expect(desks).toHaveLength(DESKS_PER_AREA)
    expect(desks[0].id).toBe('docs:d0')
    expect(desks.some(entry => entry.id === 'docs:d5')).toBe(true)
  })

  it('ignores what is not an Office app or has no name', () => {
    expect(roomDesks([{ app: 'terminal', at: T0, active: null, documents: [{ key: 'a', name: 'x' }] }, { app: 'docs', at: T0, active: null, documents: [{ key: 'b', name: '' }, { name: 'no key' }] }], [])).toEqual([])
  })
})

describe('which agent ran a command', () => {
  it('keeps an agent’s Office or Canvas command with the session the bridge sent', () => {
    expect(roomCommand(event({ args: { document: '~/Plans/Launch plan.docx' } }))).toEqual({ id: 1, command: 'docs.write', sessionId: 'live-1', area: 'docs', document: 'Launch plan.docx', at: T0 })
    expect(roomCommand(event({ command: 'canvas.addLayer', args: {} }))).toMatchObject({ area: 'canvas', document: null })
  })

  it('leaves out commands with no session, from the person, that failed or only list', () => {
    expect(roomCommand(event({ session: null }))).toBeNull()
    expect(roomCommand(event({ source: 'palette' }))).toBeNull()
    expect(roomCommand(event({ result: { ok: false, summary: 'No', error: 'No' } }))).toBeNull()
    expect(roomCommand(event({ command: 'docs.list' }))).toBeNull()
    expect(roomCommand(event({ command: 'page.open' }))).toBeNull()
  })
})

describe('the desk an agent works at', () => {
  const desks = [desk({ id: 'docs:k1', front: true }), desk({ id: 'docs:k2', name: 'Notes.docx' })]
  const command = (patch: Partial<RoomCommand>): RoomCommand => ({ id: 1, command: 'docs.write', sessionId: 'live-1', area: 'docs', document: null, at: T0 + 10, ...patch })

  it('is the one its target names, with or without the extension, open or not', () => {
    expect(deskFor(seeker({ target: 'notes' }), desks, [], T0)?.desk.id).toBe('docs:k2')
    expect(deskFor(seeker({ target: 'Notes.docx' }), desks, [], T0)?.via).toBe('target')
    expect(deskFor(seeker({ target: 'Closed.docx' }), desks, [], T0)).toBeNull()
  })

  it('follows its own session’s latest command in the app, within its turn', () => {
    expect(deskFor(seeker(), desks, [command({ document: 'Notes.docx' })], T0 + 20)).toMatchObject({ via: 'command', desk: { id: 'docs:k2' } })
    expect(deskFor(seeker({ sessionId: 'live-2' }), desks, [command({ document: 'Notes.docx' })], T0 + 20)).toMatchObject({ via: 'front', desk: { id: 'docs:k1' } })
    expect(deskFor(seeker({ turnStartedAt: T0 + 50 }), desks, [command({ document: 'Notes.docx' })], T0 + 60)?.via).toBe('front')
    expect(deskFor(seeker(), desks, [command({ document: 'Notes.docx' })], T0 + 11 + COMMAND_KEEP_MS)?.via).toBe('front')
  })

  it('takes the front document only for a call on the document in front, and none away from the desks', () => {
    expect(deskFor(seeker({ front: false }), desks, [], T0)).toBeNull()
    expect(deskFor(seeker({ area: 'files' }), desks, [], T0)).toBeNull()
    expect(deskFor(seeker({ phase: 'idle' }), desks, [], T0)).toBeNull()
  })
})

describe('desks and meetings in the room', () => {
  const desks: RoomInput = { type: 'desks', desks: roomDesks(office, canvas), at: T0 }
  const docsCall = (sessionId: string, at: number, args: Record<string, unknown> = { action: 'write' }) => live(f('tool.start', { tool_id: `t-${sessionId}`, name: 'docs', args }, sessionId), at)

  it('puts an agent working on the document in front at its desk, traced to the presence that says so', () => {
    const state = run(EMPTY_ROOM, desks, live(f('message.start', {}, 'live-1'), T0 + 1), docsCall('live-1', T0 + 2))

    expect(state.agents['s:live-1']).toMatchObject({ area: 'docs', target: null, desk: 'docs:k1' })
    expect(state.agents['s:live-1'].trace.desk).toEqual({ source: 'presence', type: 'office.presence', at: T0 })
  })

  it('attributes an unnamed command to the session that ran it, so two agents go to their own desks', () => {
    const commands: RoomInput = { type: 'commands', commands: [{ id: 7, command: 'docs.write', sessionId: 'live-2', area: 'docs', document: 'Notes.docx', at: T0 + 3 }], at: T0 + 3 }
    const state = run(EMPTY_ROOM, desks, live(f('message.start', {}, 'live-1'), T0 + 1), live(f('message.start', {}, 'live-2'), T0 + 1), docsCall('live-1', T0 + 2), docsCall('live-2', T0 + 2), commands)

    expect(state.agents['s:live-1'].desk).toBe('docs:k1')
    expect(state.agents['s:live-2'].desk).toBe('docs:k2')
    expect(state.agents['s:live-2'].trace.desk).toEqual({ source: 'command', type: 'docs.write', at: T0 + 3 })
    expect(meetingOf(state.agents['s:live-1'], Object.values(state.agents))).toEqual([])
  })

  it('meets two agents at one desk, with a gentle fact rather than a verdict', () => {
    const state = run(EMPTY_ROOM, desks, live(f('message.start', {}, 'live-1'), T0 + 1), live(f('message.start', {}, 'live-2'), T0 + 1), docsCall('live-1', T0 + 2), docsCall('live-2', T0 + 2, { action: 'write', document: 'Launch plan.docx' }))

    expect(state.agents['s:live-2'].desk).toBe('docs:k1')
    expect(meetingOf(state.agents['s:live-1'], Object.values(state.agents)).map(agent => agent.id).sort()).toEqual(['s:live-1', 's:live-2'])
    expect(factsOf(state.agents['s:live-1'], state, T0 + 3).map(fact => fact.text)).toContain('2 agents on Launch plan.docx')
    expect(factsOf(state.agents['s:live-2'], state, T0 + 3).find(fact => fact.kind === 'meeting')?.trace).toEqual(state.agents['s:live-2'].trace.desk)
  })

  it('lets the desk go when the agent stops or the document closes', () => {
    let state = run(EMPTY_ROOM, desks, live(f('message.start', {}, 'live-1'), T0 + 1), docsCall('live-1', T0 + 2))

    state = run(state, { type: 'desks', desks: [], at: T0 + 5 })
    expect(state.agents['s:live-1'].desk).toBeNull()
    expect(state.agents['s:live-1'].trace.desk).toEqual({ source: 'presence', type: 'office.presence', at: T0 + 5 })

    state = run(state, desks, live(f('message.complete', { status: 'complete' }, 'live-1'), T0 + 9))
    expect(state.agents['s:live-1']).toMatchObject({ area: 'lounge', desk: null })
  })

  it('returns the same state when presence reports the same desks again', () => {
    const state = run(EMPTY_ROOM, desks)

    expect(reduceRoom(state, { type: 'desks', desks: roomDesks(office, canvas), at: T0 + 2_000 })).toBe(state)
  })
})
