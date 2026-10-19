import { describe, expect, it } from 'vitest'
import type { RoomHandoff } from '../model/types.ts'
import {
  actorAt,
  actorsOf,
  BUBBLE_MS,
  CARRY_MS,
  HAND_MS,
  type HandoffPlan,
  HELPER_WAIT_MS,
  marksAt,
  nextChangeAt,
  nextHandoffs,
  type PlanInput,
  planHandoff,
  planMoving,
  REPLAY_MS,
  SHOW_MS
} from './choreography.ts'
import { FADE_MS, WALK_MAX_SPEED, WALK_MIN_SPEED } from './motion.ts'

const BOUNDS = { x: 0, y: 0, width: 1200, height: 700 }
const DOORWAY = { x: 100, y: 600 }

function handoff(kind: RoomHandoff['kind'], from: string, to: string, at = 0, id = `${kind}:${from}:${to}`): RoomHandoff {
  return { id, kind, from, to, at, trace: { source: 'frame', type: kind === 'note' ? 'subagent.spawn' : 'subagent.complete', at } }
}

function input(patch: Partial<PlanInput> & Pick<PlanInput, 'handoff'>): PlanInput {
  return { start: 1000, motion: 'full', from: null, to: null, doorway: DOORWAY, gap: 60, bounds: BOUNDS, summary: null, failed: false, arriving: false, ...patch }
}

/** Every walk in a plan, with its pace in px/s. */
function paces(plan: HandoffPlan): number[] {
  return plan.tracks.flatMap(track =>
    track.legs.filter(leg => leg.from.x !== leg.to.x || leg.from.y !== leg.to.y).map(leg => Math.hypot(leg.to.x - leg.from.x, leg.to.y - leg.from.y) / ((leg.end - leg.start) / 1000))
  )
}

function contiguous(plan: HandoffPlan): boolean {
  return plan.tracks.every(track => track.legs.every((leg, index) => index === 0 || leg.start === track.legs[index - 1].end))
}

describe('a note, with full motion', () => {
  const plan = planHandoff(input({ handoff: handoff('note', 'parent', 'helper'), from: { x: 900, y: 200 }, to: DOORWAY }))
  const parentLeg = plan.tracks.find(track => track.actor === 'parent')!.legs
  const meet = parentLeg[parentLeg.length - 1].start

  it('has the parent walk the note over while its helper meets it halfway', () => {
    const parent = actorAt(plan, 'parent', meet)!
    const helper = actorAt(plan, 'helper', meet)!

    expect(Math.hypot(parent.x - helper.x, parent.y - helper.y)).toBeCloseTo(60)
    expect(Math.hypot(parent.x - 900, parent.y - 200)).toBeCloseTo(Math.hypot(helper.x - DOORWAY.x, helper.y - DOORWAY.y))
    expect(actorAt(plan, 'parent', 1000 + 50)).toMatchObject({ walking: true, facing: -1 })
  })

  it('hands it over face to face, then lets both go on', () => {
    const during = meet + HAND_MS / 4

    expect(actorAt(plan, 'parent', during)).toMatchObject({ walking: false, facing: -1 })
    expect(actorAt(plan, 'helper', during)).toMatchObject({ walking: false, facing: 1 })
    expect(actorAt(plan, 'parent', meet + HAND_MS)).toBeNull()
    expect(actorAt(plan, 'helper', meet + HAND_MS)).toBeNull()
  })

  it('moves the note from the parent to the helper at the middle of the hand-over', () => {
    expect(marksAt(plan, 1000).parent).toEqual({ carry: 'note', bubble: null })
    expect(marksAt(plan, meet + HAND_MS * 0.4).parent?.carry).toBe('note')
    expect(marksAt(plan, meet + HAND_MS * 0.6).helper).toEqual({ carry: 'note', bubble: null })
    expect(marksAt(plan, meet + HAND_MS * 0.6).parent).toBeUndefined()
    expect(marksAt(plan, meet + HAND_MS + CARRY_MS)).toEqual({})
    expect(plan.end).toBe(meet + HAND_MS + CARRY_MS)
  })

  it('walks at walking pace, back to back, and stays short', () => {
    expect(contiguous(plan)).toBe(true)

    for (const pace of paces(plan)) {
      expect(pace).toBeGreaterThanOrEqual(WALK_MIN_SPEED - 0.01)
      expect(pace).toBeLessThanOrEqual(WALK_MAX_SPEED + 0.01)
    }

    expect(plan.end - plan.start).toBeLessThan(8000)
  })

  it('fades a helper that is only just coming in before it walks', () => {
    const arriving = planHandoff(input({ handoff: handoff('note', 'parent', 'helper'), from: { x: 900, y: 200 }, to: DOORWAY, arriving: true }))

    expect(actorAt(arriving, 'helper', 1000)).toMatchObject({ x: DOORWAY.x, y: DOORWAY.y, opacity: 0, walking: false })
    expect(actorAt(arriving, 'helper', 1000 + FADE_MS / 2)?.opacity).toBeCloseTo(0.5)
    expect(actorAt(arriving, 'helper', 1000 + FADE_MS + 10)).toMatchObject({ opacity: 1, walking: true })
  })

  it('needs no walk when the two already stand together', () => {
    const near = planHandoff(input({ handoff: handoff('note', 'parent', 'helper'), from: { x: 130, y: 600 }, to: DOORWAY }))

    expect(paces(near)).toEqual([])
    expect(actorAt(near, 'parent', 1000)).toMatchObject({ x: 130, y: 600, walking: false })
  })
})

describe('a note, reduced', () => {
  it.each(['calm', 'still'] as const)('just shows on the helper with %s motion: nobody walks', motion => {
    const plan = planHandoff(input({ handoff: handoff('note', 'parent', 'helper'), motion, from: { x: 900, y: 200 }, to: { x: 400, y: 300 } }))

    expect(plan.tracks).toEqual([])
    expect(marksAt(plan, 1000)).toEqual({ helper: { carry: 'note', bubble: null } })
    expect(plan.end).toBe(1000 + SHOW_MS)
  })

  it('just shows on the helper when its parent is not in the room', () => {
    const plan = planHandoff(input({ handoff: handoff('note', 'parent', 'helper'), to: DOORWAY }))

    expect(plan.tracks).toEqual([])
    expect(marksAt(plan, 1000 + SHOW_MS - 1).helper?.carry).toBe('note')
  })

  it('has nothing to play when the helper is not in the room', () => {
    const plan = planHandoff(input({ handoff: handoff('note', 'parent', 'helper'), from: { x: 900, y: 200 } }))

    expect(plan).toMatchObject({ tracks: [], marks: [], end: 1000 })
  })
})

describe('a result, with full motion', () => {
  const plan = planHandoff(input({ handoff: handoff('result', 'helper', 'parent'), from: { x: 300, y: 250 }, to: { x: 800, y: 300 }, summary: 'Found three budget files' }))
  const helperLegs = plan.tracks.find(track => track.actor === 'helper')!.legs
  const arrive = helperLegs[0].end
  const said = arrive + BUBBLE_MS
  const handEnd = said + HAND_MS

  it('has the helper walk the result to stand beside its parent, on the side it came from', () => {
    expect(actorAt(plan, 'helper', 1000 + 100)).toMatchObject({ walking: true, facing: 1 })
    expect(actorAt(plan, 'helper', arrive)).toMatchObject({ x: 740, y: 300, walking: false, facing: 1 })
    expect(actorAt(plan, 'parent', arrive)).toMatchObject({ x: 800, y: 300, walking: false, facing: -1 })
  })

  it('says its summary there, then hands the result over', () => {
    expect(marksAt(plan, arrive + 10).helper).toEqual({ carry: 'result', bubble: 'Found three budget files' })
    expect(marksAt(plan, said + HAND_MS * 0.6).parent).toEqual({ carry: 'result', bubble: null })
    expect(marksAt(plan, said + HAND_MS * 0.6).helper).toBeUndefined()
    expect(actorAt(plan, 'parent', handEnd)).toBeNull()
  })

  it('then leaves through the door and is gone', () => {
    const out = helperLegs[2]

    expect(out.to).toEqual(DOORWAY)
    expect(actorAt(plan, 'helper', out.end + FADE_MS / 2)).toMatchObject({ x: DOORWAY.x, y: DOORWAY.y, gone: false })
    expect(actorAt(plan, 'helper', out.end + FADE_MS / 2)?.opacity).toBeCloseTo(0.5)
    expect(actorAt(plan, 'helper', out.end + FADE_MS)).toMatchObject({ gone: true, opacity: 0 })
    expect(actorAt(plan, 'helper', out.end + 60_000)?.gone).toBe(true)
    expect(contiguous(plan)).toBe(true)
  })

  it('carries a result that did not work out as such', () => {
    const failed = planHandoff(input({ handoff: handoff('result', 'helper', 'parent'), from: { x: 300, y: 250 }, to: { x: 800, y: 300 }, failed: true }))

    expect(marksAt(failed, 1000).helper?.carry).toBe('failure')
  })

  it('stands on the other side when it comes from the right, kept on the floor', () => {
    const fromRight = planHandoff(input({ handoff: handoff('result', 'helper', 'parent'), from: { x: 1199, y: 400 }, to: { x: 1170, y: 300 } }))
    const arrived = fromRight.tracks[0].legs[0].end

    expect(actorAt(fromRight, 'helper', arrived)).toMatchObject({ x: 1200, y: 300, facing: -1 })
    expect(actorAt(fromRight, 'parent', arrived)?.facing).toBe(1)
  })

  it('says it where it stands and leaves when its parent is not in the room', () => {
    const alone = planHandoff(input({ handoff: handoff('result', 'helper', 'parent'), from: { x: 300, y: 250 }, summary: 'Done' }))

    expect(actorAt(alone, 'helper', 1000)).toMatchObject({ x: 300, y: 250, walking: false })
    expect(marksAt(alone, 1000).helper).toEqual({ carry: 'result', bubble: 'Done' })
    expect(actorAt(alone, 'helper', alone.end)?.gone).toBe(true)
    expect(actorsOf(alone)).toEqual(['helper'])
  })
})

describe('a result, reduced', () => {
  it('shows with calm motion where the pets stand, then the helper fades away', () => {
    const plan = planHandoff(input({ handoff: handoff('result', 'helper', 'parent'), motion: 'calm', from: { x: 300, y: 250 }, to: { x: 800, y: 300 }, summary: 'Done' }))
    const shown = 1000 + Math.max(BUBBLE_MS, SHOW_MS)

    expect(paces(plan)).toEqual([])
    expect(marksAt(plan, 1000)).toEqual({ helper: { carry: null, bubble: 'Done' }, parent: { carry: 'result', bubble: null } })
    expect(actorAt(plan, 'helper', shown + FADE_MS / 2)?.opacity).toBeCloseTo(0.5)
    expect(actorAt(plan, 'helper', shown + FADE_MS)?.gone).toBe(true)
  })

  it('shows with still motion and the helper is gone at the end, without a fade', () => {
    const plan = planHandoff(input({ handoff: handoff('result', 'helper', 'parent'), motion: 'still', from: { x: 300, y: 250 }, to: { x: 800, y: 300 } }))

    expect(plan.tracks[0].legs.every(leg => leg.fade === undefined)).toBe(true)
    expect(actorAt(plan, 'helper', plan.end - 1)).toMatchObject({ opacity: 1, gone: false })
    expect(actorAt(plan, 'helper', plan.end)?.gone).toBe(true)
  })

  it('has nothing to play when the helper is not in the room', () => {
    expect(planHandoff(input({ handoff: handoff('result', 'helper', 'parent'), to: { x: 1, y: 1 } })).tracks).toEqual([])
  })
})

describe('reading a plan', () => {
  const plan = planHandoff(input({ handoff: handoff('note', 'parent', 'helper'), from: { x: 900, y: 200 }, to: DOORWAY }))

  it('does not hold a pet before its part starts or one the plan does not name', () => {
    expect(actorAt(plan, 'parent', 999)).toBeNull()
    expect(actorAt(plan, 'someone', 1500)).toBeNull()
  })

  it('names its next change, and nothing once over', () => {
    const next = nextChangeAt(plan, 1000)

    expect(next).toBeGreaterThan(1000)
    expect(nextChangeAt(plan, plan.end)).toBeNull()
  })

  it('says whether something walks at a moment', () => {
    expect(planMoving(plan, 1010)).toBe(true)
    expect(planMoving(plan, plan.end - 1)).toBe(false)
  })
})

describe('nextHandoffs', () => {
  const present = new Set(['parent', 'helper', 'other'])

  it('starts waiting hand-offs oldest first, once their helper is in the room', () => {
    const queue = [handoff('note', 'parent', 'helper', 200, 'b'), handoff('note', 'other', 'helper2', 100, 'a')]

    expect(nextHandoffs({ handoffs: queue, handled: new Set(), busy: new Set(), present: new Set([...present, 'helper2']), now: 1000 }).start.map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('lets go of hand-offs that happened too long ago', () => {
    const step = nextHandoffs({ handoffs: [handoff('note', 'parent', 'helper', 0)], handled: new Set(), busy: new Set(), present, now: REPLAY_MS + 1 })

    expect(step).toEqual({ start: [], drop: ['note:parent:helper'] })
  })

  it('waits a little for a helper to come in, then lets go', () => {
    const early = nextHandoffs({ handoffs: [handoff('note', 'parent', 'late', 0)], handled: new Set(), busy: new Set(), present, now: HELPER_WAIT_MS - 1 })
    const late = nextHandoffs({ handoffs: [handoff('note', 'parent', 'late', 0)], handled: new Set(), busy: new Set(), present, now: HELPER_WAIT_MS + 1 })

    expect(early).toEqual({ start: [], drop: [] })
    expect(late.drop).toEqual(['note:parent:late'])
  })

  it('waits while a pet is in another hand-off, and never starts two with one pet', () => {
    const queue = [handoff('note', 'parent', 'helper', 10, 'first'), handoff('note', 'parent', 'other', 20, 'second')]

    expect(nextHandoffs({ handoffs: queue, handled: new Set(), busy: new Set(['parent']), present, now: 100 }).start).toEqual([])
    expect(nextHandoffs({ handoffs: queue, handled: new Set(), busy: new Set(), present, now: 100 }).start.map(entry => entry.id)).toEqual(['first'])
  })

  it('starts a hand-off whose other pet is not in the room, and skips the ones already handled', () => {
    const queue = [handoff('result', 'helper', 'gone-parent', 10, 'r'), handoff('note', 'parent', 'helper', 5, 'done')]

    expect(nextHandoffs({ handoffs: queue, handled: new Set(['done']), busy: new Set(), present, now: 100 }).start.map(entry => entry.id)).toEqual(['r'])
  })
})
