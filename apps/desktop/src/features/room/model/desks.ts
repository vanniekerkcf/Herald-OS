import type { CommandEvent } from '../../../store/os-commands.ts'
import { followFrom } from '../../petdex/activity.ts'
import { nameOf, shortName } from './areas.ts'
import { DESK_AREAS, type RoomAgent, type RoomArea, type RoomCommand, type RoomDesk, type RoomDeskArea, type RoomPhase } from './types.ts'

/*
 * Desks: the documents open in Herald Docs, Sheets and Slides and the Canvas projects, as their
 * windows report them (Office and Canvas presence), each a desk in its area by name only. An agent
 * works at a desk when its target names that document, when the latest Office or Canvas command its
 * session ran there names it (the bridge sends the session with each command), or, for a call on
 * "the document in front", the app's front document. Agents at one desk meet there.
 */

/** At most this many desks stand in an area: the front document's and the most recently used windows' first. */
export const DESKS_PER_AREA = 4
/** A command keeps an agent at its desk for at most this long, within the turn that ran it. */
export const COMMAND_KEEP_MS = 5 * 60_000
/** The Room keeps this many recent commands. */
export const COMMANDS_KEPT = 24

const WORKING = new Set<RoomPhase>(['starting', 'thinking', 'tool'])

export const isDeskArea = (area: RoomArea): area is RoomDeskArea => (DESK_AREAS as readonly RoomArea[]).includes(area)

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

interface PresenceWindow {
  area: RoomDeskArea
  at: number
  active: string | null
  documents: unknown[]
}

function windowOf(raw: unknown, area: RoomDeskArea | null): PresenceWindow | null {
  const entry = record(raw)

  if (!area) {
    return null
  }

  return {
    area,
    at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0,
    active: typeof entry.active === 'string' && entry.active ? entry.active : null,
    documents: Array.isArray(entry.documents) ? entry.documents : []
  }
}

const officeArea = (app: unknown): RoomDeskArea | null => (app === 'docs' || app === 'sheets' || app === 'slides' ? app : null)

/**
 * The desks from Office and Canvas presence: each open document by its key and name (never its
 * path, what is selected in it or what is in front inside it), the one in front of each app's most
 * recently used window marked, at most DESKS_PER_AREA an area.
 */
export function roomDesks(office: readonly unknown[], canvas: readonly unknown[]): RoomDesk[] {
  const windows = [...office.map(raw => windowOf(raw, officeArea(record(raw).app))), ...canvas.map(raw => windowOf(raw, 'canvas'))]
    .filter((window): window is PresenceWindow => window !== null)
    .sort((a, b) => b.at - a.at)
  const desks: RoomDesk[] = []
  const fronted = new Set<RoomDeskArea>()

  for (const window of windows) {
    const keys = new Set<string>()

    for (const raw of window.documents) {
      const doc = record(raw)
      const key = typeof doc.key === 'string' && doc.key ? doc.key : null
      const name = shortName(nameOf(doc.name) ?? '')

      if (!key || !name || keys.has(key)) {
        continue
      }

      keys.add(key)
      const front = !fronted.has(window.area) && key === window.active
      const id = `${window.area}:${key}`

      if (!desks.some(desk => desk.id === id)) {
        desks.push({ id, area: window.area, name, front, usedAt: window.at })
      }
    }

    if (window.active && keys.has(window.active)) {
      fronted.add(window.area)
    }
  }

  return DESK_AREAS.flatMap(area => {
    const here = desks.filter(desk => desk.area === area)
    const kept = here.filter(desk => desk.front).concat(here.filter(desk => !desk.front)).slice(0, DESKS_PER_AREA)

    return here.filter(desk => kept.includes(desk))
  })
}

/** An agent's Office or Canvas command, as the desktop pet follows it, with the session that ran it; null for anything else. */
export function roomCommand(event: CommandEvent): RoomCommand | null {
  const follow = followFrom(event)
  const sessionId = typeof event.session === 'string' && event.session ? event.session : null

  if (!follow || !sessionId) {
    return null
  }

  return { id: event.id, command: event.command, sessionId, area: follow.app, document: follow.document ? shortName(follow.document) : null, at: follow.at }
}

/** Names compared the way a person would: case aside, with or without the extension. */
export const sameName = (a: string, b: string): boolean => plainName(a) === plainName(b)

const plainName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,6}$/, '')

function deskNamed(desks: readonly RoomDesk[], area: RoomDeskArea, name: string): RoomDesk | null {
  const named = desks.filter(desk => desk.area === area && sameName(desk.name, name))

  return named.find(desk => desk.front) ?? named[0] ?? null
}

const frontDesk = (desks: readonly RoomDesk[], area: RoomDeskArea): RoomDesk | null => desks.find(desk => desk.area === area && desk.front) ?? null

export interface DeskPick {
  desk: RoomDesk
  via: 'target' | 'command' | 'front'
  command: RoomCommand | null
}

/** What the Room knows about an agent that decides its desk. */
export interface DeskSeeker {
  phase: RoomPhase
  area: RoomArea
  target: string | null
  sessionId: string
  turnStartedAt: number | null
  /** Its call works on the document in front of its app. */
  front: boolean
}

/** The desk an agent works at, and what says so; null when it works at none. */
export function deskFor(agent: DeskSeeker, desks: readonly RoomDesk[], commands: readonly RoomCommand[], now: number): DeskPick | null {
  if (!WORKING.has(agent.phase) || !isDeskArea(agent.area)) {
    return null
  }

  const area = agent.area

  if (agent.target) {
    const desk = deskNamed(desks, area, agent.target)

    return desk ? { desk, via: 'target', command: null } : null
  }

  const since = Math.max(agent.turnStartedAt ?? 0, now - COMMAND_KEEP_MS)
  const command = agent.sessionId ? (commands.find(entry => entry.sessionId === agent.sessionId && entry.area === area && entry.at >= since) ?? null) : null

  if (command) {
    // A command that names a document works on that one, open or not: a closed file is changed on disk.
    const desk = command.document ? deskNamed(desks, area, command.document) : frontDesk(desks, area)

    return desk ? { desk, via: 'command', command } : null
  }

  const front = agent.front ? frontDesk(desks, area) : null

  return front ? { desk: front, via: 'front', command: null } : null
}

/** What agents meet over: the same desk, or the same target in an area that has desks. */
export function meetingKey(agent: Pick<RoomAgent, 'kind' | 'phase' | 'area' | 'target' | 'desk'>): string | null {
  if (agent.kind === 'automation' || agent.kind === 'elsewhere' || !WORKING.has(agent.phase) || !isDeskArea(agent.area)) {
    return null
  }

  if (agent.desk) {
    return `desk:${agent.desk}`
  }

  return agent.target ? `${agent.area}:${plainName(agent.target)}` : null
}

/** The agents meeting with this one, itself included; empty when it meets nobody. */
export function meetingOf(agent: RoomAgent, agents: readonly RoomAgent[]): RoomAgent[] {
  const key = meetingKey(agent)

  if (!key) {
    return []
  }

  const met = agents.filter(other => meetingKey(other) === key)

  return met.length >= 2 ? met : []
}
