import type { RoomMotion } from '../../../../shared/room.ts'
import type { RoomHandoff } from '../model/types.ts'
import type { Point, Rect } from './layout.ts'
import { FADE_MS, walkMs } from './motion.ts'

/*
 * A hand-off as a short timeline, worked out once from the hand-off record and where its two pets
 * stand when it starts. A note: the parent walks it over to its new helper (they meet halfway, so
 * it stays short), hands it, and both go on. A result: the helper walks it back to its parent, says
 * its summary, hands it over and leaves through the door. Without motion the note or the result
 * simply shows where the pets are.
 */

/** How long two pets stand together while one hands the other something. */
export const HAND_MS = 700
/** How long a result's summary shows before the helper hands it over. */
export const BUBBLE_MS = 3600
/** How long the note or result stays in view after the hand-over. */
export const CARRY_MS = 1400
/** Without walking: how long the note or result shows where the pets stand. */
export const SHOW_MS = 3200
/** A hand-off received longer ago than this has already happened: it is not played. */
export const REPLAY_MS = 12_000
/** How long a hand-off waits for its helper to come into the room before it is let go. */
export const HELPER_WAIT_MS = 4000

/** What a pet carries: a note, a result, or a result that did not work out. */
export type CarryKind = 'note' | 'result' | 'failure'

export interface Leg {
  start: number
  end: number
  from: Point
  to: Point
  /** Which way it faces while it stands; 0 keeps the way it faced. */
  facing: -1 | 0 | 1
  fade?: 'in' | 'out'
}

export interface Track {
  actor: string
  /** Back to back, in time order. */
  legs: Leg[]
  /** Gone through the door after its last leg. */
  leaves: boolean
}

export interface Mark {
  actor: string
  start: number
  end: number
  carry?: CarryKind
  bubble?: string
}

export interface HandoffPlan {
  id: string
  kind: RoomHandoff['kind']
  start: number
  /** When its last leg and mark are over. */
  end: number
  tracks: Track[]
  marks: Mark[]
}

export interface PlanInput {
  handoff: Pick<RoomHandoff, 'id' | 'kind' | 'from' | 'to'>
  start: number
  motion: RoomMotion
  /** Where the hand-off's `from` and `to` pets stand when it starts; null for one not in the room. */
  from: Point | null
  to: Point | null
  doorway: Point
  /** How far apart two pets stand to hand something over. */
  gap: number
  /** Where a pet's feet may be. */
  bounds: Rect
  /** A result's summary, already cut to a bubble. */
  summary: string | null
  /** How a result's work ended. */
  failed: boolean
  /** The helper has only just come in: it fades in where it stands first. */
  arriving: boolean
}

const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y)

const facingTo = (from: Point, to: Point): -1 | 1 => (to.x < from.x ? -1 : 1)

const within = (point: Point, bounds: Rect): Point => ({
  x: Math.min(bounds.x + bounds.width, Math.max(bounds.x, point.x)),
  y: Math.min(bounds.y + bounds.height, Math.max(bounds.y, point.y))
})

const stand = (at: Point, start: number, end: number, facing: -1 | 0 | 1, fade?: 'in' | 'out'): Leg => ({ start, end, from: at, to: at, facing, ...(fade ? { fade } : {}) })

const walk = (from: Point, to: Point, start: number): Leg => ({ start, end: start + walkMs(distance(from, to)), from, to, facing: facingTo(from, to) })

function finish(id: string, kind: RoomHandoff['kind'], start: number, tracks: Track[], marks: Mark[]): HandoffPlan {
  const ends = [start, ...tracks.flatMap(track => track.legs.map(leg => leg.end)), ...marks.map(mark => mark.end)]

  return { id, kind, start, end: Math.max(...ends), tracks: tracks.filter(track => track.legs.length > 0), marks }
}

/** The timeline for a hand-off starting at `input.start`. */
export function planHandoff(input: PlanInput): HandoffPlan {
  return input.handoff.kind === 'note' ? planNote(input) : planResult(input)
}

function planNote({ handoff, start, motion, from, to, gap, arriving }: PlanInput): HandoffPlan {
  const parent = handoff.from
  const helper = handoff.to

  if (!to) {
    return finish(handoff.id, 'note', start, [], [])
  }

  if (motion !== 'full' || !from) {
    return finish(handoff.id, 'note', start, [], [{ actor: helper, start, end: start + SHOW_MS, carry: 'note' }])
  }

  const apart = distance(from, to)
  const each = Math.max(0, (apart - gap) / 2)
  const toward = apart > 0 ? { x: (to.x - from.x) / apart, y: (to.y - from.y) / apart } : { x: 1, y: 0 }
  const parentStop = { x: from.x + toward.x * each, y: from.y + toward.y * each }
  const helperStop = { x: to.x - toward.x * each, y: to.y - toward.y * each }
  const parentWalk = walk(from, parentStop, start)
  const helperStart = start + (arriving ? FADE_MS : 0)
  const helperWalk = walk(to, helperStop, helperStart)
  const meet = Math.max(parentWalk.end, helperWalk.end)
  const handEnd = meet + HAND_MS
  const handMid = meet + HAND_MS / 2
  const parentFacing = apart > 0 ? facingTo(parentStop, helperStop) : 1
  const helperFacing = parentFacing === 1 ? -1 : 1

  return finish(
    handoff.id,
    'note',
    start,
    [
      { actor: parent, legs: [parentWalk, stand(parentStop, parentWalk.end, handEnd, parentFacing)], leaves: false },
      { actor: helper, legs: [...(arriving ? [stand(to, start, helperStart, 0, 'in')] : []), helperWalk, stand(helperStop, helperWalk.end, handEnd, helperFacing)], leaves: false }
    ],
    [
      { actor: parent, start, end: handMid, carry: 'note' },
      { actor: helper, start: handMid, end: handEnd + CARRY_MS, carry: 'note' }
    ]
  )
}

function planResult({ handoff, start, motion, from, to, doorway, gap, bounds, summary, failed }: PlanInput): HandoffPlan {
  const helper = handoff.from
  const parent = handoff.to
  const carry: CarryKind = failed ? 'failure' : 'result'
  const say = summary ? BUBBLE_MS : 0

  if (!from) {
    return finish(handoff.id, 'result', start, [], [])
  }

  if (motion !== 'full') {
    const shown = start + Math.max(say, SHOW_MS)
    const legs = [stand(from, start, shown, 0), ...(motion === 'calm' ? [stand(from, shown, shown + FADE_MS, 0, 'out')] : [])]
    const marks: Mark[] = [...(summary ? [{ actor: helper, start, end: shown, bubble: summary }] : []), { actor: to ? parent : helper, start, end: shown, carry }]

    return finish(handoff.id, 'result', start, [{ actor: helper, legs, leaves: true }], marks)
  }

  if (!to) {
    const said = start + Math.max(say, HAND_MS)
    const out = walk(from, doorway, said)

    return finish(
      handoff.id,
      'result',
      start,
      [{ actor: helper, legs: [stand(from, start, said, 0), out, stand(doorway, out.end, out.end + FADE_MS, 0, 'out')], leaves: true }],
      [...(summary ? [{ actor: helper, start, end: said, bubble: summary }] : []), { actor: helper, start, end: said, carry }]
    )
  }

  const side = from.x >= to.x ? 1 : -1
  const stop = within({ x: to.x + side * gap, y: to.y }, bounds)
  const walkIn = walk(from, stop, start)
  const said = walkIn.end + say
  const handMid = said + HAND_MS / 2
  const handEnd = said + HAND_MS
  const out = walk(stop, doorway, handEnd)
  const towardParent = facingTo(stop, to)

  return finish(
    handoff.id,
    'result',
    start,
    [
      { actor: helper, legs: [walkIn, stand(stop, walkIn.end, handEnd, towardParent), out, stand(doorway, out.end, out.end + FADE_MS, 0, 'out')], leaves: true },
      { actor: parent, legs: [stand(to, start, handEnd, towardParent === 1 ? -1 : 1)], leaves: false }
    ],
    [
      { actor: helper, start, end: handMid, carry },
      ...(summary ? [{ actor: helper, start: walkIn.end, end: said, bubble: summary }] : []),
      { actor: parent, start: handMid, end: handEnd + CARRY_MS, carry }
    ]
  )
}

export interface ActorFrame {
  x: number
  y: number
  facing: -1 | 0 | 1
  walking: boolean
  opacity: number
  /** Left through the door: no longer in the room. */
  gone: boolean
}

/** Where the plan has `actor` at `t`; null while the plan does not hold it (before its part, or after it, unless it left). */
export function actorAt(plan: HandoffPlan, actor: string, t: number): ActorFrame | null {
  const track = plan.tracks.find(entry => entry.actor === actor)

  if (!track || t < track.legs[0].start) {
    return null
  }

  const last = track.legs[track.legs.length - 1]

  if (t >= last.end) {
    return track.leaves ? { x: last.to.x, y: last.to.y, facing: last.facing, walking: false, opacity: 0, gone: true } : null
  }

  const leg = track.legs.find(entry => t < entry.end) ?? last
  const span = leg.end - leg.start
  const progress = span > 0 ? Math.min(1, Math.max(0, (t - leg.start) / span)) : 1
  const moving = leg.from.x !== leg.to.x || leg.from.y !== leg.to.y

  return {
    x: leg.from.x + (leg.to.x - leg.from.x) * progress,
    y: leg.from.y + (leg.to.y - leg.from.y) * progress,
    facing: moving ? facingTo(leg.from, leg.to) : leg.facing,
    walking: moving,
    opacity: leg.fade === 'in' ? progress : leg.fade === 'out' ? 1 - progress : 1,
    gone: false
  }
}

export interface ActorMarks {
  carry: CarryKind | null
  bubble: string | null
}

/** What each pet in the plan carries or says at `t`. */
export function marksAt(plan: HandoffPlan, t: number): Record<string, ActorMarks> {
  const out: Record<string, ActorMarks> = {}

  for (const mark of plan.marks) {
    if (t < mark.start || t >= mark.end) {
      continue
    }

    const entry = (out[mark.actor] ??= { carry: null, bubble: null })

    if (mark.carry) {
      entry.carry = mark.carry
    }

    if (mark.bubble) {
      entry.bubble = mark.bubble
    }
  }

  return out
}

/** The pets a plan moves or marks. */
export function actorsOf(plan: HandoffPlan): string[] {
  return [...new Set([...plan.tracks.map(track => track.actor), ...plan.marks.map(mark => mark.actor)])]
}

/** The plan's next moment after `t` when what it shows changes; null once it is over. */
export function nextChangeAt(plan: HandoffPlan, t: number): number | null {
  const moments = [...plan.tracks.flatMap(track => track.legs.flatMap(leg => [leg.start, leg.end])), ...plan.marks.flatMap(mark => [mark.start, mark.end]), plan.end].filter(moment => moment > t)

  return moments.length ? Math.min(...moments) : null
}

/** Whether the plan has something walking or fading at `t`. */
export function planMoving(plan: HandoffPlan, t: number): boolean {
  return plan.tracks.some(track => track.legs.some(leg => t >= leg.start && t < leg.end && (leg.fade !== undefined || leg.from.x !== leg.to.x || leg.from.y !== leg.to.y)))
}

export interface QueueInput {
  handoffs: readonly RoomHandoff[]
  handled: ReadonlySet<string>
  /** Pets an unfinished plan holds. */
  busy: ReadonlySet<string>
  /** Pets in the room now. */
  present: ReadonlySet<string>
  now: number
}

/** The waiting hand-offs that start now, and those let go: too old, or their helper never came in. */
export function nextHandoffs({ handoffs, handled, busy, present, now }: QueueInput): { start: RoomHandoff[]; drop: string[] } {
  const start: RoomHandoff[] = []
  const drop: string[] = []
  const claimed = new Set(busy)
  const waiting = handoffs.filter(handoff => !handled.has(handoff.id)).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  for (const handoff of waiting) {
    const age = now - handoff.at
    const helper = handoff.kind === 'note' ? handoff.to : handoff.from

    if (age > REPLAY_MS) {
      drop.push(handoff.id)
      continue
    }

    if (!present.has(helper)) {
      if (age > HELPER_WAIT_MS) {
        drop.push(handoff.id)
      }

      continue
    }

    const actors = [handoff.from, handoff.to].filter(actor => present.has(actor))

    if (actors.some(actor => claimed.has(actor))) {
      continue
    }

    actors.forEach(actor => claimed.add(actor))
    start.push(handoff)
  }

  return { start, drop }
}
