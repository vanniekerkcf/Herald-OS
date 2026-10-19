import { PET_FRAME_HEIGHT, PET_FRAME_WIDTH } from '../../../../shared/pet.ts'
import type { RoomAgent, RoomArea, RoomDeskArea, RoomPhase } from '../model/types.ts'

/*
 * The Room's floor plan, for any window size: the Office and Canvas stations along the back wall,
 * with a desk below each for the documents open there, the tool stations on the side walls, the
 * waiting bench by the door to Hermes, the lounge and the Automations corner at the front, and,
 * when the person turns it on, the lane for Hermes work outside Herald along the right edge. Every
 * area is an entry in AREA_DEFS, so a new area (or a lane) is a row there.
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Where a station stands; the front holds furniture pets sit on rather than a tile, desks stand below the back wall, the lane is outside the room. */
export type Wall = 'back' | 'left' | 'right' | 'front' | 'desk' | 'lane'

/** Where a pet stands: its area's station, or a desk there. */
export type RoomSpot = RoomArea | `desk:${string}`

export const deskSpot = (deskId: string): RoomSpot => `desk:${deskId}`

export interface AreaDef {
  id: RoomArea
  /** On the station's tile. */
  label: string
  /** For tooltips and screen readers. */
  name: string
  wall: Wall
  /** Its share of its wall against the other stations there; at the front, its width in room units. */
  span: number
  /** Front furniture: how deep it is, in room units. */
  depth?: number
}

export const AREA_DEFS: readonly AreaDef[] = [
  { id: 'docs', label: 'Docs', name: 'Docs', wall: 'back', span: 1 },
  { id: 'sheets', label: 'Sheets', name: 'Sheets', wall: 'back', span: 1 },
  { id: 'slides', label: 'Slides', name: 'Slides', wall: 'back', span: 1 },
  { id: 'canvas', label: 'Canvas', name: 'Canvas', wall: 'back', span: 1 },
  { id: 'terminal', label: 'Terminal', name: 'Terminal', wall: 'left', span: 1 },
  { id: 'browser', label: 'Browser', name: 'Browser', wall: 'left', span: 1 },
  { id: 'files', label: 'Files', name: 'Files', wall: 'left', span: 1 },
  { id: 'studio', label: 'Studio', name: 'Studio', wall: 'right', span: 1 },
  { id: 'memory', label: 'Memory', name: 'Memory', wall: 'right', span: 1 },
  { id: 'messages', label: 'Messages', name: 'Messages and Connections', wall: 'right', span: 1 },
  { id: 'bench', label: 'Waiting bench', name: 'The waiting bench', wall: 'front', span: 3.3, depth: 0.62 },
  { id: 'lounge', label: 'Lounge', name: 'The lounge', wall: 'front', span: 3.6, depth: 0.85 },
  { id: 'automations', label: 'Automations', name: 'The Automations corner', wall: 'front', span: 2.4, depth: 0.7 },
  { id: 'elsewhere', label: 'Outside Herald', name: 'Hermes work outside Herald', wall: 'lane', span: 1 }
]

/** A desk to lay out: an open document in an area that has desks. */
export interface DeskInput {
  id: string
  area: RoomDeskArea
  name: string
}

export interface PetBox {
  width: number
  height: number
  /** Of a 192x208 sprite frame. */
  scale: number
}

/** Side by side, pets stand this many pet widths apart: a name tag is never wider, so neighbours' tags never meet. */
export const TAG_SPAN = 1.75

/** The widest a name tag or fact under a pet may be. */
export const tagWidth = (pet: PetBox): number => Math.max(84, Math.round(pet.width * TAG_SPAN) - 8)

/** A bubble's bottom sits this many pet heights over the pet's feet; it is about this many pixels tall. */
export const BUBBLE_RISE = 0.84
export const BUBBLE_HEIGHT = 24

/** The wall an area's station stands on. */
export const wallOf = (area: RoomArea, defs: readonly AreaDef[] = AREA_DEFS): Wall => defs.find(def => def.id === area)?.wall ?? 'front'

export interface Station {
  id: RoomSpot
  /** The area it serves: a desk's is its app's. */
  area: RoomArea
  label: string
  name: string
  wall: Wall
  /** The station's tile, or the bench or sofa at the front. */
  rect: Rect
  /** Where the first pet stands (its feet). */
  anchor: Point
  /** The way a row of pets runs; `both` grows it to either side of the anchor in turn, this way first. */
  along: Point
  both: boolean
  /** The way the next row goes when a row is full. */
  away: Point
  spacing: number
  rowStep: number
  perRow: number
  /** How far forward every other place in a row stands, so neighbours' name tags do not meet. */
  stagger: number
  /** At most this many rows before the next column; unset, as many as the floor holds. */
  rows?: number
}

export interface SceneLayout {
  width: number
  height: number
  unit: number
  pet: PetBox
  /** The back wall band. */
  wall: Rect
  /** Where a pet's feet may be. */
  floor: Rect
  /** The door to Hermes, and the spot just inside it where pets come in and leave. */
  door: Rect
  doorway: Point
  stations: Station[]
  /** The lane for work outside Herald, when it is on: a strip along the right edge, outside the room. */
  lane: Rect | null
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

const round = (value: number): number => Math.round(value)

/** Lengths `weights` share of `length`, with `gap` between them; each at most `most`, centred in its share. */
function spread(start: number, length: number, weights: readonly number[], gap: number, most: number): { start: number; length: number }[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1
  let cursor = start

  return weights.map(weight => {
    const share = (length * weight) / total
    const size = Math.max(0, Math.min(most * weight, share - gap))
    const placed = { start: round(cursor + (share - size) / 2), length: round(size) }
    cursor += share

    return placed
  })
}

/** A desk's table, beside the pet that works at it, and its name over it: about this many pet heights apart. */
const DESK_STEP = 1.5

/** The lane for work outside Herald: this share of the scene's width, within these bounds. */
const LANE_SHARE = 0.17
const LANE_MIN = 132
const LANE_MAX = 220
/** The lane's header (its name and that it is coarse) is about this tall. */
export const LANE_HEADER = 52
/** The height of a cost meter's line under a name tag. */
export const METER_LINE = 15

/**
 * The floor plan for a scene of `width` x `height` CSS pixels: with `desks`, a desk for each open
 * document (as many as fit below its app's station), and with `lane`, the strip for work outside
 * Herald along the right edge, which the room gives up its width for.
 */
export function layoutRoom(width: number, height: number, defs: readonly AreaDef[] = AREA_DEFS, extra: { desks?: readonly DeskInput[]; lane?: boolean; meters?: boolean } = {}): SceneLayout {
  // A cost meter is one more line under each name tag: the front row and the lane's rows make room for it.
  const meterLine = extra.meters ? METER_LINE : 0
  const full = Math.max(320, Number.isFinite(width) ? width : 0)
  const laneWidth = extra.lane ? round(clamp(full * LANE_SHARE, LANE_MIN, LANE_MAX)) : 0
  const w = Math.max(320, full - laneWidth)
  const h = Math.max(240, Number.isFinite(height) ? height : 0)
  const unit = clamp(Math.min(w / 12, h / 8), 40, 84)
  const petHeight = round(clamp(unit, 46, 88))
  const scale = petHeight / PET_FRAME_HEIGHT
  const pet: PetBox = { width: round(PET_FRAME_WIDTH * scale), height: petHeight, scale }
  const pad = round(unit * 0.28)
  const gap = round(unit * 0.3)
  const tileHeight = round(unit * 0.95)
  const wallHeight = round(unit * 1.75)
  const sideWidth = round(unit * 1.75)
  const bottom = h - pad - meterLine
  const door: Rect = { x: pad, y: bottom - round(unit * 1.7), width: round(unit * 0.95), height: round(unit * 1.7) }
  const doorway: Point = { x: round(door.x + door.width + pet.width * 0.32), y: bottom - 4 }
  const frontTop = bottom - round(unit * 1.45)
  const floor: Rect = { x: pad, y: wallHeight + round(pet.height * 0.3), width: w - pad * 2, height: bottom - wallHeight - round(pet.height * 0.3) }
  const stations: Station[] = []
  const on = (wall: Wall) => defs.filter(def => def.wall === wall)
  const inward = (rect: Rect): Point => ({ x: rect.x + rect.width / 2 <= w / 2 ? 1 : -1, y: 0 })
  const spacing = round(pet.width * TAG_SPAN)
  const rowStep = round(pet.height * 0.7)
  const stagger = round(pet.height * 0.12)

  const back = on('back')
  const innerStart = pad + sideWidth + gap + round(pet.width * 0.5)
  const backSlots = spread(innerStart, w - innerStart * 2, back.map(def => def.span), gap, round(unit * 2.4))
  // Back-wall pets queue forward into the room: a row along the wall would meet the next station's.
  back.forEach((def, index) => {
    const rect: Rect = { x: backSlots[index].start, y: wallHeight - round(pad * 0.5) - tileHeight, width: backSlots[index].length, height: tileHeight }
    stations.push({
      ...base(def),
      rect,
      anchor: { x: round(rect.x + rect.width / 2), y: round(rect.y + rect.height + Math.max(pet.height * 1.2, pet.height * BUBBLE_RISE + BUBBLE_HEIGHT + 4)) },
      along: inward(rect),
      both: true,
      away: { x: 0, y: 1 },
      spacing,
      rowStep,
      perRow: 1,
      stagger
    })
  })

  const deskStep = round(pet.height * DESK_STEP)

  for (const station of stations.filter(entry => entry.wall === 'back')) {
    const first = station.anchor.y + round(pet.height * 1.05)
    const fit = Math.max(1, Math.floor(Math.max(0, frontTop - pad - first) / deskStep) + 1)
    const here = (extra.desks ?? []).filter(desk => desk.area === station.area).slice(0, fit)
    const table = { width: round(Math.min(station.rect.width * 0.5, pet.width * 0.9)), height: round(unit * 0.42) }
    const centre = station.rect.x + station.rect.width / 2
    // Agents meeting at a desk stand on either side of it, far enough apart that their name tags never meet.
    const across = Math.max(round(table.width + pet.width * 0.9), tagWidth(pet) + 12)

    // The station's own queue keeps to its first row: its desks stand below it.
    if (here.length > 0) {
      station.rows = 1
    }

    here.forEach((desk, index) => {
      const feet = first + index * deskStep

      stations.push({
        id: deskSpot(desk.id),
        area: station.area,
        label: desk.name,
        name: desk.name,
        wall: 'desk',
        rect: { x: round(centre - table.width / 2), y: feet - table.height, width: table.width, height: table.height },
        anchor: { x: round(centre + across / 2), y: feet },
        along: { x: -1, y: 0 },
        both: false,
        away: { x: 0, y: 1 },
        spacing: across,
        rowStep,
        perRow: 2,
        stagger,
        rows: 2
      })
    })
  }

  const sideTop = wallHeight + pad
  const sideBottom = frontTop - pad
  for (const wall of ['left', 'right'] as const) {
    const side = on(wall)
    const slots = spread(sideTop, sideBottom - sideTop, side.map(def => def.span), round(gap * 0.6), tileHeight)
    side.forEach((def, index) => {
      const x = wall === 'left' ? pad : w - pad - sideWidth
      const rect: Rect = { x, y: slots[index].start, width: sideWidth, height: Math.max(round(unit * 0.6), slots[index].length) }
      const direction = wall === 'left' ? 1 : -1
      const edge = wall === 'left' ? rect.x + rect.width : rect.x
      stations.push({
        ...base(def),
        rect,
        anchor: { x: round(edge + direction * pet.width * 0.62), y: round(rect.y + rect.height - pet.height * 0.04) },
        along: { x: direction, y: 0 },
        both: false,
        away: { x: 0, y: 1 },
        spacing,
        rowStep,
        perRow: 3,
        stagger
      })
    })
  }

  const front = on('front')
  const frontStart = door.x + door.width + pad
  const furniture = front.map(def => ({ def, width: round(unit * def.span), height: round(unit * (def.depth ?? 0.7)) }))
  const used = furniture.reduce((sum, item) => sum + item.width, 0)
  const room = w - pad - frontStart
  const squeeze = used > room ? room / used : 1
  const between = furniture.length > 1 ? Math.max(0, room - used * squeeze) / (furniture.length - 1) : 0
  let cursor = frontStart
  furniture.forEach(({ def, width: itemWidth, height: itemHeight }) => {
    const itemW = round(itemWidth * squeeze)
    const rect: Rect = { x: round(cursor), y: bottom - 8 - itemHeight, width: itemW, height: itemHeight }
    // Pets sit along a bench or sofa; at the Automations board they stand at its left end, clear of its face.
    const board = def.id === 'automations'
    cursor += itemW + between
    stations.push({
      ...base(def),
      rect,
      anchor: { x: round(board ? rect.x + pet.width * 0.5 : rect.x + rect.width / 2), y: round(rect.y + rect.height * 0.6) },
      along: inward(rect),
      both: !board,
      away: { x: 0, y: -1 },
      spacing,
      rowStep,
      perRow: board ? 1 : clamp(1 + 2 * Math.floor((rect.width / 2 + pet.width * 0.2) / spacing), 1, 5),
      stagger
    })
  })

  const laneDef = defs.find(def => def.wall === 'lane')
  const lane: Rect | null = laneWidth > 0 && laneDef ? { x: w, y: 0, width: laneWidth, height: h } : null

  if (lane && laneDef) {
    const top = LANE_HEADER + round(pet.height * 1.02)
    const laneRow = round(pet.height + 46) + meterLine

    stations.push({
      ...base(laneDef),
      rect: lane,
      anchor: { x: round(lane.x + lane.width / 2), y: top },
      along: { x: 0, y: 0 },
      both: false,
      away: { x: 0, y: 1 },
      spacing: 0,
      rowStep: laneRow,
      perRow: 1,
      stagger: 0,
      rows: Math.max(1, Math.floor((h - pad - top) / laneRow) + 1)
    })
  }

  return { width: w + laneWidth, height: h, unit, pet, wall: { x: 0, y: 0, width: w, height: wallHeight }, floor, door, doorway, stations, lane }
}

function base(def: AreaDef): Pick<Station, 'id' | 'area' | 'label' | 'name' | 'wall'> {
  return { id: def.id, area: def.id, label: def.label, name: def.name, wall: def.wall }
}

/** The station a spot's pets stand at; an area without one of its own uses the lounge, else the first. */
export function stationOf(layout: SceneLayout, spot: RoomSpot): Station {
  return layout.stations.find(station => station.id === spot) ?? layout.stations.find(station => station.id === 'lounge') ?? layout.stations[0]
}

/** How many pets the lane holds at this size; none while it is off. */
export const laneCapacity = (layout: SceneLayout): number => layout.stations.find(station => station.wall === 'lane')?.rows ?? 0

/** Offsets along a row: the anchor first, then either side in turn starting the `along` way (or that way only). */
const offsetAt = (index: number, both: boolean): number => (both ? (index % 2 === 1 ? (index + 1) / 2 : -index / 2) : index)

/** How many rows fit between a station's first place and the floor's edge, the way its rows go. */
function rowsThatFit(station: Station, floor: Rect): number {
  const { anchor, away, rowStep } = station
  const room = away.y > 0 ? floor.y + floor.height - anchor.y : away.y < 0 ? anchor.y - floor.y : away.x > 0 ? floor.x + floor.width - anchor.x : anchor.x - floor.x

  return Math.max(1, Math.floor(Math.max(0, room) / Math.max(1, rowStep)) + 1)
}

/**
 * Where the pet in `slot` of `spot` stands; past the first row the rows fan out, and once they reach
 * the floor's edge (or the station's last row) they start again in another column beside the
 * first, kept on the floor. The lane is a single file outside the room.
 */
export function slotPoint(layout: SceneLayout, spot: RoomSpot, slot: number): Point {
  const station = stationOf(layout, spot)
  const { floor, pet } = layout
  const index = Math.max(0, Math.floor(slot) || 0)

  if (station.wall === 'lane') {
    return { x: station.anchor.x, y: round(station.anchor.y + Math.min(index, (station.rows ?? 1) - 1) * station.rowStep) }
  }

  const depth = Math.min(rowsThatFit(station, floor), station.rows ?? Infinity)
  const line = Math.floor(index / station.perRow)
  const column = Math.floor(line / depth)
  const row = line % depth
  const place = offsetAt(index % station.perRow, station.both)
  const shift = column === 0 ? 0 : (station.both ? offsetAt(column, true) : column) * station.perRow
  const offset = place + shift + (row % 2 === 1 ? 0.5 : 0)
  const forward = Math.abs(place) % 2 === 1 ? station.stagger : 0
  const x = station.anchor.x + station.along.x * offset * station.spacing + station.away.x * row * station.rowStep
  const y = station.anchor.y + station.along.y * offset * station.spacing + station.away.y * row * station.rowStep + forward

  return {
    x: round(clamp(x, floor.x + pet.width / 2, floor.x + floor.width - pet.width / 2)),
    y: round(clamp(y, floor.y, floor.y + floor.height))
  }
}

export interface SlotRef {
  spot: RoomSpot
  slot: number
}

/**
 * A slot for every agent: one that stays at its spot keeps its slot, a newcomer takes the lowest
 * free one there, in the order given (so the caller decides who comes first).
 */
export function assignSlots(agents: readonly { id: string; spot: RoomSpot }[], previous: Readonly<Record<string, SlotRef>>): Record<string, SlotRef> {
  const next: Record<string, SlotRef> = {}
  const taken = new Map<RoomSpot, Set<number>>()
  const takenIn = (spot: RoomSpot): Set<number> => {
    let set = taken.get(spot)

    if (!set) {
      set = new Set()
      taken.set(spot, set)
    }

    return set
  }

  for (const agent of agents) {
    const before = previous[agent.id]

    if (before && before.spot === agent.spot && !takenIn(agent.spot).has(before.slot)) {
      next[agent.id] = before
      takenIn(agent.spot).add(before.slot)
    }
  }

  for (const agent of agents) {
    if (next[agent.id]) {
      continue
    }

    const used = takenIn(agent.spot)
    let slot = 0

    while (used.has(slot)) {
      slot++
    }

    used.add(slot)
    next[agent.id] = { spot: agent.spot, slot }
  }

  return next
}

/** Back to front: further up the floor is further away; ties left to right, then by id. */
export function depthOrder<T extends { id: string; x: number; y: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** How busy a phase is, for which pets show when there are more agents than the Room draws. */
const BUSY: Record<RoomPhase, number> = { waiting: 0, tool: 1, thinking: 2, starting: 3, queued: 4, finished: 5, idle: 6 }

/** About this many pets fit the room; the rest are a '+N more' chip. */
export const MAX_PETS = 24

/**
 * The busiest `max` agents (waiting on the person first, then working, then the rest); among equals
 * the ones already shown stay, then the most recently heard from. Returned oldest first, which is
 * the order newcomers take slots in.
 */
export function pickShown(agents: readonly RoomAgent[], max: number, shownBefore: ReadonlySet<string>): { shown: RoomAgent[]; more: number } {
  const ranked = [...agents].sort(
    (a, b) =>
      busyOf(a) - busyOf(b) ||
      Number(shownBefore.has(b.id)) - Number(shownBefore.has(a.id)) ||
      b.lastEventAt - a.lastEventAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
  const shown = ranked.slice(0, Math.max(0, max)).sort((a, b) => (a.startedAt ?? a.lastEventAt) - (b.startedAt ?? b.lastEventAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return { shown, more: Math.max(0, agents.length - shown.length) }
}

const busyOf = (agent: RoomAgent): number => (agent.approval || agent.asking ? 0 : BUSY[agent.phase])
