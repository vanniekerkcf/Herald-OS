import { describe, expect, it } from 'vitest'
import { ROOM_AREAS, type RoomAgent } from '../model/types.ts'
import { AREA_DEFS, type AreaDef, assignSlots, BUBBLE_HEIGHT, BUBBLE_RISE, depthOrder, laneCapacity, layoutRoom, MAX_PETS, METER_LINE, pickShown, type Rect, type SceneLayout, slotPoint, stationOf, tagWidth, wallOf } from './layout.ts'

function agent(id: string, patch: Partial<RoomAgent> = {}): RoomAgent {
  return {
    id,
    kind: 'conversation',
    sessionId: 's1',
    sessionKey: null,
    title: id,
    parentId: null,
    phase: 'idle',
    area: 'lounge',
    target: null,
    step: null,
    tool: null,
    startedAt: 1,
    turnStartedAt: null,
    lastEventAt: 1,
    approval: null,
    asking: null,
    repeat: null,
    guardrail: null,
    result: null,
    toolCount: null,
    desk: null,
    automation: null,
    elsewhere: null,
    usage: null,
    trace: {},
    ...patch
  }
}

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

const inside = (rect: Rect, layout: SceneLayout): boolean => rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= layout.width && rect.y + rect.height <= layout.height

const SIZES: [number, number][] = [
  [1100, 620],
  [1600, 980],
  [720, 460],
  [480, 320],
  [2000, 640]
]

describe('the area table', () => {
  it('has one station for every area the Room knows', () => {
    expect(AREA_DEFS.map(def => def.id).sort()).toEqual([...ROOM_AREAS].sort())
  })
})

describe('layoutRoom', () => {
  it.each(SIZES)('keeps every station inside a %ix%i scene without overlapping another or the door', (width, height) => {
    const layout = layoutRoom(width, height)

    for (const [index, station] of layout.stations.entries()) {
      expect(inside(station.rect, layout)).toBe(true)
      expect(station.rect.width).toBeGreaterThan(0)
      expect(overlaps(station.rect, layout.door)).toBe(false)

      for (const other of layout.stations.slice(index + 1)) {
        expect(overlaps(station.rect, other.rect), `${station.id} and ${other.id}`).toBe(false)
      }
    }
  })

  it('puts the Office and Canvas along the back wall, tools on the sides, the bench by the door and the lounge at the front right', () => {
    const layout = layoutRoom(1100, 620)
    const station = (id: Parameters<typeof stationOf>[1]) => stationOf(layout, id)

    expect(['docs', 'sheets', 'slides', 'canvas'].map(id => station(id as 'docs').wall)).toEqual(['back', 'back', 'back', 'back'])
    expect(station('docs').rect.x).toBeLessThan(station('sheets').rect.x)
    expect(station('slides').rect.x).toBeLessThan(station('canvas').rect.x)
    expect(station('docs').rect.y + station('docs').rect.height).toBeLessThanOrEqual(layout.wall.height)
    expect(['terminal', 'browser', 'files'].map(id => station(id as 'terminal').wall)).toEqual(['left', 'left', 'left'])
    expect(['studio', 'memory', 'messages'].map(id => station(id as 'studio').wall)).toEqual(['right', 'right', 'right'])
    expect(station('terminal').rect.y).toBeLessThan(station('files').rect.y)
    expect(station('studio').rect.x).toBeGreaterThan(layout.width / 2)
    expect(layout.door.x).toBeLessThan(station('bench').rect.x)
    expect(station('bench').rect.x - (layout.door.x + layout.door.width)).toBeLessThan(layout.unit)
    expect(station('lounge').rect.x + station('lounge').rect.width).toBeLessThanOrEqual(layout.width)
    expect(station('lounge').rect.x).toBeGreaterThan(station('bench').rect.x + station('bench').rect.width)
  })

  it('sizes pets to the scene within bounds', () => {
    const small = layoutRoom(480, 320)
    const large = layoutRoom(2400, 1400)

    expect(small.pet.height).toBeGreaterThanOrEqual(46)
    expect(large.pet.height).toBeLessThanOrEqual(88)
    expect(small.pet.height).toBeLessThan(large.pet.height)
    expect(large.pet.width / large.pet.height).toBeCloseTo(192 / 208, 1)
  })

  it('survives a size of nothing', () => {
    const layout = layoutRoom(0, Number.NaN)

    expect(layout.width).toBeGreaterThan(0)
    expect(layout.stations.length).toBe(AREA_DEFS.filter(def => def.wall !== 'lane').length)
  })

  it('lays out whatever the table holds', () => {
    const defs: AreaDef[] = [
      { id: 'docs', label: 'Docs', name: 'Docs', wall: 'back', span: 1 },
      { id: 'canvas', label: 'Canvas', name: 'Canvas', wall: 'back', span: 1 },
      { id: 'lounge', label: 'Lounge', name: 'The lounge', wall: 'front', span: 3.6, depth: 0.85 }
    ]
    const two = layoutRoom(1100, 620, defs)
    const four = layoutRoom(1100, 620)

    expect(two.stations.map(station => station.id)).toEqual(['docs', 'canvas', 'lounge'])
    expect(stationOf(two, 'docs').rect.width).toBeGreaterThanOrEqual(stationOf(four, 'docs').rect.width)
    expect(stationOf(two, 'terminal').id).toBe('lounge')
  })
})

describe('slotPoint', () => {
  const layout = layoutRoom(1100, 620)

  it('seats pets along the bench and the sofa from the middle, to either side in turn, toward the middle of the room first', () => {
    const bench = [0, 1, 2].map(slot => slotPoint(layout, 'bench', slot))
    const lounge = [0, 1, 2].map(slot => slotPoint(layout, 'lounge', slot))

    expect(bench[0]).toEqual(stationOf(layout, 'bench').anchor)
    expect(bench[1].x).toBeGreaterThan(bench[0].x)
    expect(bench[2].x).toBeLessThan(bench[0].x)
    expect(lounge[1].x).toBeLessThan(lounge[0].x)
    expect(lounge[2].x).toBeGreaterThan(lounge[0].x)
  })

  it('stands every other pet in a row a little forward, so neighbours keep their name tags apart', () => {
    const station = stationOf(layout, 'lounge')
    const [first, second, third] = [0, 1, 2].map(slot => slotPoint(layout, 'lounge', slot))

    expect(station.stagger).toBeGreaterThan(0)
    expect(second.y - first.y).toBe(station.stagger)
    expect(third.y - first.y).toBe(station.stagger)
    expect(Math.abs(second.x - first.x)).toBeGreaterThan(layout.pet.width)
  })

  it('queues pets forward from a back-wall station, clear of its tile', () => {
    const station = stationOf(layout, 'sheets')
    const [first, second, third] = [0, 1, 2].map(slot => slotPoint(layout, 'sheets', slot))

    expect(first).toEqual(station.anchor)
    expect(first.y - layout.pet.height * 0.92).toBeGreaterThanOrEqual(station.rect.y + station.rect.height)
    expect(second.y).toBeGreaterThan(first.y)
    expect(second.x).toBeGreaterThan(first.x)
    expect(third.y).toBeGreaterThan(second.y)
    expect(third.x).toBe(first.x)
  })

  it('lines pets up into the room from a side wall', () => {
    const left = [0, 1, 2].map(slot => slotPoint(layout, 'terminal', slot))
    const right = [0, 1, 2].map(slot => slotPoint(layout, 'memory', slot))

    expect(left[0].x).toBeGreaterThan(stationOf(layout, 'terminal').rect.x + stationOf(layout, 'terminal').rect.width)
    expect(left[1].x).toBeGreaterThan(left[0].x)
    expect(right[0].x).toBeLessThan(stationOf(layout, 'memory').rect.x)
    expect(right[1].x).toBeLessThan(right[0].x)
  })

  it('fans the overflow out in rows away from the station, half a place across', () => {
    const station = stationOf(layout, 'docs')
    const first = slotPoint(layout, 'docs', 0)
    const nextRow = slotPoint(layout, 'docs', station.perRow)
    const lounge = stationOf(layout, 'lounge')

    expect(nextRow.y).toBeGreaterThan(first.y)
    expect(nextRow.x).not.toBe(first.x)
    expect(slotPoint(layout, 'lounge', lounge.perRow).y).toBeLessThan(slotPoint(layout, 'lounge', 0).y)
  })

  it.each([
    [1100, 620, MAX_PETS],
    [720, 460, 12]
  ])('gives each pet its own place in any area of a %ix%i scene, %i to an area, on the floor', (width, height, count) => {
    const scene = layoutRoom(width, height)

    for (const station of scene.stations) {
      const points = Array.from({ length: count }, (_, slot) => slotPoint(scene, station.id, slot))
      const keys = new Set(points.map(point => `${point.x},${point.y}`))

      expect(keys.size, station.id).toBe(points.length)

      for (const point of points) {
        expect(point.x).toBeGreaterThanOrEqual(scene.floor.x + scene.pet.width / 2)
        expect(point.x).toBeLessThanOrEqual(scene.floor.x + scene.floor.width - scene.pet.width / 2)
        expect(point.y).toBeGreaterThanOrEqual(scene.floor.y)
        expect(point.y).toBeLessThanOrEqual(scene.floor.y + scene.floor.height)
      }
    }
  })

  it('treats a broken slot number as the first', () => {
    expect(slotPoint(layout, 'docs', Number.NaN)).toEqual(slotPoint(layout, 'docs', 0))
    expect(slotPoint(layout, 'docs', -3)).toEqual(slotPoint(layout, 'docs', 0))
  })
})

describe('wallOf', () => {
  it('names the wall an area stands on, and the front for one the table does not hold', () => {
    expect(wallOf('terminal')).toBe('left')
    expect(wallOf('memory')).toBe('right')
    expect(wallOf('canvas')).toBe('back')
    expect(wallOf('bench')).toBe('front')
    expect(wallOf('docs', [])).toBe('front')
  })

  it('leaves room for a bubble between a back-wall station and the pet in front of it, at any size', () => {
    for (const [width, height] of SIZES) {
      const scene = layoutRoom(width, height)
      const station = stationOf(scene, 'docs')

      expect(station.anchor.y - scene.pet.height * BUBBLE_RISE - BUBBLE_HEIGHT).toBeGreaterThanOrEqual(station.rect.y + station.rect.height)
    }
  })
})

describe('assignSlots', () => {
  it('gives newcomers the lowest free slot of their area, in the order given', () => {
    expect(assignSlots([{ id: 'a', spot: 'docs' }, { id: 'b', spot: 'docs' }, { id: 'c', spot: 'terminal' }], {})).toEqual({
      a: { spot: 'docs', slot: 0 },
      b: { spot: 'docs', slot: 1 },
      c: { spot: 'terminal', slot: 0 }
    })
  })

  it('keeps a staying agent in its slot when others come and go', () => {
    const before = assignSlots([{ id: 'a', spot: 'docs' }, { id: 'b', spot: 'docs' }, { id: 'c', spot: 'docs' }], {})
    const after = assignSlots([{ id: 'd', spot: 'docs' }, { id: 'c', spot: 'docs' }], before)

    expect(after.c).toEqual({ spot: 'docs', slot: 2 })
    expect(after.d).toEqual({ spot: 'docs', slot: 0 })
  })

  it('finds a new slot for an agent that moved spot', () => {
    const before = assignSlots([{ id: 'a', spot: 'docs' }, { id: 'b', spot: 'docs' }], {})
    const after = assignSlots([{ id: 'a', spot: 'docs' }, { id: 'b', spot: 'bench' }], before)

    expect(after.b).toEqual({ spot: 'bench', slot: 0 })
    expect(after.a).toEqual({ spot: 'docs', slot: 0 })
  })

  it('never puts two agents in one slot', () => {
    const after = assignSlots([{ id: 'a', spot: 'docs' }, { id: 'b', spot: 'docs' }], { a: { spot: 'docs', slot: 1 }, b: { spot: 'docs', slot: 1 } })

    expect(after.a.slot).toBe(1)
    expect(after.b.slot).toBe(0)
  })
})

describe('depthOrder', () => {
  it('draws further up the floor first, then left to right, then by id', () => {
    const items = [
      { id: 'c', x: 5, y: 20 },
      { id: 'a', x: 5, y: 10 },
      { id: 'b', x: 1, y: 20 },
      { id: 'd', x: 1, y: 20 }
    ]

    expect(depthOrder(items).map(item => item.id)).toEqual(['a', 'b', 'd', 'c'])
    expect(items[0].id).toBe('c')
  })
})

describe('pickShown', () => {
  it('shows everyone when they fit, oldest first', () => {
    const { shown, more } = pickShown([agent('b', { startedAt: 20 }), agent('a', { startedAt: 10 })], MAX_PETS, new Set())

    expect(shown.map(entry => entry.id)).toEqual(['a', 'b'])
    expect(more).toBe(0)
  })

  it('keeps the busiest: waiting on the person, then working, and counts the rest', () => {
    const agents = [
      agent('idle-1'),
      agent('idle-2'),
      agent('tool', { phase: 'tool', area: 'terminal' }),
      agent('asks', { phase: 'waiting', area: 'bench', asking: 'clarify' }),
      agent('thinks', { phase: 'thinking' })
    ]
    const { shown, more } = pickShown(agents, 3, new Set())

    expect(shown.map(entry => entry.id).sort()).toEqual(['asks', 'thinks', 'tool'])
    expect(more).toBe(2)
  })

  it('prefers the pets already in the room among equals, then the most recently heard from', () => {
    const agents = [agent('a', { lastEventAt: 50 }), agent('b', { lastEventAt: 10 }), agent('c', { lastEventAt: 30 })]

    expect(pickShown(agents, 1, new Set(['b'])).shown.map(entry => entry.id)).toEqual(['b'])
    expect(pickShown(agents, 2, new Set()).shown.map(entry => entry.id).sort()).toEqual(['a', 'c'])
  })
})

describe('desks, the lane and the Automations board', () => {
  const desks = [
    { id: 'docs:a', area: 'docs' as const, name: 'Launch plan' },
    { id: 'docs:b', area: 'docs' as const, name: 'Notes' },
    { id: 'canvas:c', area: 'canvas' as const, name: 'Poster' }
  ]

  it('stands each open document as a desk below its app, with a place on either side for agents meeting there', () => {
    const layout = layoutRoom(1100, 720, AREA_DEFS, { desks })
    const docs = stationOf(layout, 'docs')
    const first = stationOf(layout, 'desk:docs:a')
    const second = stationOf(layout, 'desk:docs:b')
    const [right, left, front] = [0, 1, 2].map(slot => slotPoint(layout, 'desk:docs:a', slot))

    expect(first).toMatchObject({ wall: 'desk', area: 'docs', label: 'Launch plan' })
    expect(stationOf(layout, 'desk:canvas:c')).toMatchObject({ wall: 'desk', area: 'canvas' })
    expect(first.rect.y).toBeGreaterThan(docs.anchor.y)
    expect(second.rect.y).toBeGreaterThan(first.rect.y)
    expect(Math.abs(first.rect.x + first.rect.width / 2 - (docs.rect.x + docs.rect.width / 2))).toBeLessThanOrEqual(1)
    expect(right.x).toBeGreaterThan(first.rect.x + first.rect.width)
    expect(left.x).toBeLessThan(first.rect.x)
    expect(right.x - left.x).toBeGreaterThanOrEqual(tagWidth(layout.pet))
    expect(front.y).toBeGreaterThan(right.y)
    expect(docs.rows).toBe(1)
    expect(stationOf(layout, 'sheets').rows).toBeUndefined()
  })

  it('stands only as many desks as fit between the station and the front of the room', () => {
    const many = Array.from({ length: 6 }, (_, index) => ({ id: `docs:${index}`, area: 'docs' as const, name: `Doc ${index}` }))
    const short = layoutRoom(1100, 520, AREA_DEFS, { desks: many })
    const tall = layoutRoom(1100, 1400, AREA_DEFS, { desks: many })
    const count = (layout: SceneLayout) => layout.stations.filter(station => station.wall === 'desk').length

    expect(count(short)).toBeGreaterThanOrEqual(1)
    expect(count(short)).toBeLessThan(count(tall))
    expect(stationOf(short, 'desk:docs:5').id).toBe('lounge')
  })

  it('gives the lane the right edge, outside the room, only while it is on', () => {
    const off = layoutRoom(1100, 620)
    const on = layoutRoom(1100, 620, AREA_DEFS, { lane: true })
    const points = [0, 1, 2].map(slot => slotPoint(on, 'elsewhere', slot))

    expect(off.lane).toBeNull()
    expect(laneCapacity(off)).toBe(0)
    expect(on.lane).toMatchObject({ x: on.wall.width, y: 0, height: 620 })
    expect(on.width).toBe(1100)
    expect(on.wall.width).toBeLessThan(off.wall.width)
    expect(laneCapacity(on)).toBeGreaterThan(0)
    expect(points.every(point => point.x > on.wall.width && point.x < on.width)).toBe(true)
    expect(points[1].y).toBeGreaterThan(points[0].y)
  })

  it('leaves a line more under the front row and between the lane’s rows while cost meters show', () => {
    const plain = layoutRoom(1100, 620, AREA_DEFS, { lane: true })
    const metered = layoutRoom(1100, 620, AREA_DEFS, { lane: true, meters: true })

    for (const id of ['bench', 'lounge', 'automations'] as const) {
      expect(stationOf(plain, id).rect.y - stationOf(metered, id).rect.y, id).toBe(METER_LINE)
    }

    expect(slotPoint(metered, 'elsewhere', 1).y - slotPoint(metered, 'elsewhere', 0).y).toBe(slotPoint(plain, 'elsewhere', 1).y - slotPoint(plain, 'elsewhere', 0).y + METER_LINE)
  })

  it('stands automations at the left end of their board, clear of its face', () => {
    const layout = layoutRoom(1100, 620)
    const board = stationOf(layout, 'automations')

    expect(board.wall).toBe('front')
    expect(slotPoint(layout, 'automations', 0).x).toBeLessThan(board.rect.x + board.rect.width / 2)
  })
})
