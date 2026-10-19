import type { InstalledPet } from '../../../../shared/pet.ts'
import type { RoomMotion } from '../../../../shared/room.ts'
import type { PetPose } from '../../pet/sprite.ts'
import type { PetAssignment } from '../../petdex/assign.ts'
import type { CachedSheet } from '../../petdex/cache.ts'
import type { AnimationClock } from '../../petdex/clock.ts'
import type { RoomAgent, RoomHandoff } from '../model/types.ts'
import { type ActorFrame, actorAt, type CarryKind, type HandoffPlan, marksAt, nextChangeAt, nextHandoffs, planHandoff, planMoving, REPLAY_MS } from './choreography.ts'
import { bubbleText } from './labels.ts'
import { assignSlots, deskSpot, depthOrder, type Rect, type RoomSpot, type SceneLayout, type SlotRef, slotPoint } from './layout.ts'
import { type Body, bodyMoving, FADE_MS, fadeOut, spawnBody, stepBody } from './motion.ts'
import { type Cell, cellAt, nextWake, poseOf } from './poses.ts'
import { type SheetHolder, sheetRefOf, sheetRefs } from './sheets.ts'

/*
 * The scene's moving parts on one clock key: where each pet stands, walks and what it carries, the
 * hand-offs under way and the pets leaving. It ticks a frame at a time only while something walks
 * or fades, else once for the earliest next sprite frame, and not at all while every pet rests.
 */

export interface SceneInput {
  /** The agents the room shows, oldest first. */
  agents: readonly RoomAgent[]
  /** Every agent the Room holds, shown or not: one missing from here has gone. */
  known: ReadonlySet<string>
  handoffs: readonly RoomHandoff[]
  assignment: Readonly<Record<string, PetAssignment>>
  installed: readonly InstalledPet[]
  motion: RoomMotion
  /** The Room has heard from Hermes: what it holds at first was there before the scene opened. */
  settled: boolean
}

export interface PetFrame {
  id: string
  agent: RoomAgent
  x: number
  y: number
  opacity: number
  pose: PetPose
  cell: Cell | null
  sheet: CachedSheet | null
  /** Its installed pet has no sheet to be had (missing, unreadable, or no room in the cache): drawn as a plain figure. Never while the sheet is loading. */
  fallback: boolean
  tint: number | null
  /** On its way out: drawn, but no longer an agent in the room. */
  leaving: boolean
}

export interface PetMarks {
  carry: CarryKind | null
  bubble: string | null
}

export interface SceneHooks {
  clock: Pick<AnimationClock, 'schedule' | 'cancel'>
  key: string
  sheets: SheetHolder
  /** Draw a frame: pets back to front. */
  paint: (frames: readonly PetFrame[], layout: SceneLayout) => void
  /** What pets carry or say, and which have left; called when that changes. */
  marks: (marks: Readonly<Record<string, PetMarks>>, gone: ReadonlySet<string>) => void
  now?: () => number
}

export interface RoomEngine {
  setLayout(layout: SceneLayout | null): void
  setInput(input: SceneInput): void
  /** Ticks run only while running (the window is shown). */
  setRunning(running: boolean): void
  /** Something it draws changed outside its input (a sheet finished loading, the canvas was resized): paint again. */
  wake(): void
  dispose(): void
}

interface Pet {
  agent: RoomAgent
  body: Body
  look: PetAssignment | null
  pose: PetPose
  since: number
  /** When it came in at the door, for a hand-off that starts as it arrives. */
  arrivedAt: number | null
}

/** The longest step a walk takes in one tick, in seconds: a late tick slows a walk rather than skipping it. */
const MAX_STEP_S = 0.1

/**
 * After the scene opens, or comes back from a pause longer than a hand-off is replayed, the Room
 * catches up on what happened meanwhile: for this long newcomers simply appear at their spots and
 * hand-offs are not played, so nothing from the past is acted out as if it were happening now.
 */
export const SETTLE_MS = 3000

const NO_CELL = { nextAt: null }

const walkable = (layout: SceneLayout): Rect => {
  const half = layout.pet.width / 2

  return { x: layout.floor.x + half, y: layout.floor.y, width: Math.max(0, layout.floor.width - half * 2), height: layout.floor.height }
}

function sameMarks(a: Readonly<Record<string, PetMarks>>, b: Readonly<Record<string, PetMarks>>): boolean {
  const keys = Object.keys(a)

  return keys.length === Object.keys(b).length && keys.every(key => b[key] && a[key].carry === b[key].carry && a[key].bubble === b[key].bubble)
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every(id => b.has(id))

/** What a paint shows, in the whole pixels the overlays are placed at: a tick that would draw the same again draws nothing. */
export function paintKey(frames: readonly PetFrame[], at: Pick<SceneLayout, 'width' | 'height'>): string {
  const cells = frames.map(frame => [frame.id, Math.round(frame.x), Math.round(frame.y), frame.opacity.toFixed(3), frame.cell ? `${frame.cell.row}.${frame.cell.frame}.${frame.cell.mirror ? 1 : 0}` : '-', frame.tint ?? '-', frame.sheet?.key ?? '-', frame.fallback ? 1 : 0, frame.leaving ? 1 : 0].join(':'))

  return `${at.width}x${at.height}|${cells.join('|')}`
}

export function createRoomEngine(hooks: SceneHooks): RoomEngine {
  let layout: SceneLayout | null = null
  let input: SceneInput | null = null
  let motion: RoomMotion = 'full'
  let running = false
  let disposed = false
  let lastTick: number | null = null
  let baseline = false
  let settleUntil = 0
  let stoppedAt: number | null = null
  let resettle = false
  let dirty = true
  let painted = ''
  let snap = false
  let slots: Record<string, SlotRef> = {}
  let plans: HandoffPlan[] = []
  let shownMarks: Record<string, PetMarks> = {}
  let shownGone: ReadonlySet<string> = new Set()
  let heldSheets = ''
  /** Each installed pet: whether main found a sheet for it. */
  let hasSheet = new Map<string, boolean>()
  const pets = new Map<string, Pet>()
  const leavers = new Map<string, Pet>()
  const handled = new Set<string>()
  const departed = new Set<string>()

  /** Where an agent stands: at its desk when the room has one for it, else at its area's station. */
  const spotOf = (agent: RoomAgent): RoomSpot => {
    const desk = agent.desk ? deskSpot(agent.desk) : null

    return desk && layout?.stations.some(station => station.id === desk) ? desk : agent.area
  }

  const targetOf = (id: string, agent: RoomAgent) => {
    const slot = slots[id] ?? { spot: spotOf(agent), slot: 0 }

    return slotPoint(layout!, slot.spot, slot.slot)
  }

  /** A pet on its way out: it walks to the door (full motion), fades where it is (calm) or is gone (still). */
  const retire = (id: string, pet: Pet, now: number) => {
    if (motion !== 'still') {
      leavers.set(id, { ...pet, body: motion === 'calm' ? fadeOut(pet.body, now, motion) : pet.body })
    }
  }

  /** Plans stop short: a helper that was leaving in one leaves now. */
  const dropPlans = (which: (plan: HandoffPlan) => boolean, now: number) => {
    for (const plan of plans.filter(which)) {
      for (const track of plan.tracks) {
        const pet = pets.get(track.actor)

        if (track.leaves) {
          departed.add(track.actor)

          if (pet) {
            pets.delete(track.actor)
            retire(track.actor, pet, now)
          }
        }
      }
    }

    plans = plans.filter(plan => !which(plan))
  }

  const sync = (now: number) => {
    const current = input!
    const shown = new Map(current.agents.map(agent => [agent.id, agent]))

    for (const [id, pet] of pets) {
      if (shown.has(id)) {
        continue
      }

      pets.delete(id)
      dropPlans(plan => plan.tracks.some(track => track.actor === id), now)

      if (!current.known.has(id)) {
        retire(id, pet, now)
      }
    }

    for (const id of departed) {
      if (!current.known.has(id)) {
        departed.delete(id)
      }
    }

    const listed = new Set(current.handoffs.map(handoff => handoff.id))

    for (const id of handled) {
      if (!listed.has(id)) {
        handled.delete(id)
      }
    }

    slots = assignSlots(
      current.agents.filter(agent => !departed.has(agent.id)).map(agent => ({ id: agent.id, spot: spotOf(agent) })),
      slots
    )
    const first = !baseline && (current.settled || current.agents.length > 0)

    if (first) {
      settleUntil = now + SETTLE_MS
    }

    for (const agent of current.agents) {
      const pet = pets.get(agent.id)
      const look = current.assignment[agent.id] ?? null

      if (pet) {
        pet.agent = agent
        pet.look = look ?? pet.look
        continue
      }

      if (departed.has(agent.id)) {
        continue
      }

      const comesIn = baseline && !first
      // Work outside Herald never comes through the room's door: it fades in where it first stands.
      const atDoor = comesIn && motion === 'full' && now >= settleUntil && agent.kind !== 'elsewhere'
      const body = spawnBody(atDoor ? layout!.doorway : targetOf(agent.id, agent), now, motion, comesIn)
      pets.set(agent.id, { agent, body, look, pose: poseOf(agent, 0), since: now, arrivedAt: atDoor ? now : null })
    }

    if (first) {
      baseline = true
      current.handoffs.forEach(handoff => handled.add(handoff.id))
    }
  }

  const startPlans = (now: number) => {
    const current = input!

    if (now < settleUntil) {
      current.handoffs.forEach(handoff => handled.add(handoff.id))

      return
    }

    const present = new Set(pets.keys())
    const busy = new Set(plans.flatMap(plan => plan.tracks.filter(track => track.legs[track.legs.length - 1].end > now).map(track => track.actor)))
    const { start, drop } = nextHandoffs({ handoffs: current.handoffs, handled, busy, present, now })
    drop.forEach(id => handled.add(id))

    for (const handoff of start) {
      handled.add(handoff.id)
      const giver = pets.get(handoff.from)
      const taker = pets.get(handoff.to)
      const helper = handoff.kind === 'note' ? taker : giver
      const result = helper?.agent.result ?? null
      const arrivedAt = helper?.arrivedAt ?? null
      plans.push(
        planHandoff({
          handoff,
          start: now,
          motion,
          from: giver ? { x: giver.body.x, y: giver.body.y } : null,
          to: taker ? { x: taker.body.x, y: taker.body.y } : null,
          doorway: layout!.doorway,
          gap: Math.round(layout!.pet.width * 0.85),
          bounds: walkable(layout!),
          summary: handoff.kind === 'result' ? bubbleText(result?.summary ?? null) : null,
          failed: handoff.kind === 'result' && result !== null && result.status !== 'completed',
          arriving: handoff.kind === 'note' && arrivedAt !== null && now - arrivedAt < FADE_MS
        })
      )
    }
  }

  const heldBy = (id: string, now: number): ActorFrame | null => {
    for (const plan of plans) {
      const frame = actorAt(plan, id, now)

      if (frame) {
        return frame
      }
    }

    return null
  }

  /** An installed pet whose sheet cannot be had: main found none, or the holder could not get it. A pet that is not installed (none at all, or one just removed) gets no figure. */
  const unavailable = (slug: string): boolean => {
    const found = hasSheet.get(slug)

    return found === false || (found === true && hooks.sheets.state(slug) === 'failed')
  }

  const frameOf = (id: string, pet: Pet, now: number, leaving: boolean): PetFrame => {
    const sheet = pet.look ? hooks.sheets.get(pet.look.slug) : null

    return {
      id,
      agent: pet.agent,
      x: pet.body.x,
      y: pet.body.y,
      opacity: pet.body.opacity,
      pose: pet.pose,
      cell: sheet ? cellAt(pet.pose, sheet.sheet.layout, pet.since, now, motion === 'still', Math.min(now, pet.agent.lastEventAt)) : null,
      sheet,
      fallback: !sheet && pet.look !== null && unavailable(pet.look.slug),
      tint: pet.look?.tint ?? null,
      leaving
    }
  }

  const setPose = (pet: Pet, now: number) => {
    const pose = poseOf(pet.agent, pet.body.walking ? pet.body.facing : 0)

    if (pose !== pet.pose) {
      pet.pose = pose
      pet.since = now
    }
  }

  const holdSheets = () => {
    const slugs = [...pets.values(), ...leavers.values()].flatMap(pet => (pet.look ? [pet.look.slug] : []))
    const refs = sheetRefs(slugs, input!.installed)
    const signature = refs.map(ref => `${ref.slug}@${ref.revision}`).join('|')

    if (signature !== heldSheets) {
      heldSheets = signature
      hooks.sheets.hold(refs)
    }
  }

  const tick = (now: number) => {
    if (!running || disposed || !layout || !input) {
      return
    }

    const dt = lastTick === null ? 0 : Math.min(MAX_STEP_S, Math.max(0, (now - lastTick) / 1000))

    if (resettle) {
      resettle = false
      settleUntil = now + SETTLE_MS
    }

    if (dirty) {
      dirty = false
      sync(now)
    }

    if (snap) {
      snap = false
      dropPlans(() => true, now)
      leavers.clear()

      for (const [id, pet] of pets) {
        const target = targetOf(id, pet.agent)
        pet.body = { ...pet.body, x: target.x, y: target.y, walking: false, opacity: 1, fade: null }
      }
    }

    startPlans(now)
    const frames: PetFrame[] = []
    let moving = false

    for (const [id, pet] of pets) {
      const held = heldBy(id, now)

      if (held?.gone) {
        departed.add(id)
        pets.delete(id)
        continue
      }

      pet.body = held
        ? { x: held.x, y: held.y, facing: held.facing === 0 ? pet.body.facing : held.facing, walking: held.walking, opacity: held.opacity, fade: null }
        : stepBody(pet.body, targetOf(id, pet.agent), dt, now, motion)
      moving ||= held ? held.walking || held.opacity < 1 : bodyMoving(pet.body, now)
      setPose(pet, now)
      frames.push(frameOf(id, pet, now, false))
    }

    for (const [id, pet] of leavers) {
      const doorway = layout.doorway
      const atDoor = Math.hypot(pet.body.x - doorway.x, pet.body.y - doorway.y) < 1
      const walksOut = motion === 'full' && !atDoor && pet.agent.kind !== 'elsewhere'
      let body = walksOut ? stepBody(pet.body, doorway, dt, now, motion) : stepBody(pet.body, { x: pet.body.x, y: pet.body.y }, dt, now, motion)

      if (!body.walking && !body.fade && body.opacity > 0) {
        body = fadeOut(body, now, motion)
      }

      if (body.opacity <= 0 && !body.fade) {
        leavers.delete(id)
        continue
      }

      pet.body = body
      moving ||= bodyMoving(body, now)
      setPose(pet, now)
      frames.push(frameOf(id, pet, now, true))
    }

    const marks: Record<string, PetMarks> = {}

    for (const plan of plans) {
      for (const [actor, mark] of Object.entries(marksAt(plan, now))) {
        if (pets.has(actor)) {
          marks[actor] = { carry: mark.carry ?? marks[actor]?.carry ?? null, bubble: mark.bubble ?? marks[actor]?.bubble ?? null }
        }
      }
    }

    const extra = plans.reduce<number | null>((soonest, plan) => {
      const at = nextChangeAt(plan, now)

      return at === null ? soonest : soonest === null ? at : Math.min(soonest, at)
    }, null)
    moving ||= plans.some(plan => planMoving(plan, now))
    plans = plans.filter(plan => plan.end > now)

    if (!sameMarks(marks, shownMarks) || !sameSet(departed, shownGone)) {
      shownMarks = marks
      shownGone = new Set(departed)
      hooks.marks(marks, shownGone)
    }

    holdSheets()
    const ordered = depthOrder(frames)
    const drawn = paintKey(ordered, layout)

    if (drawn !== painted) {
      painted = drawn
      hooks.paint(ordered, layout)
    }

    const at = nextWake(now, moving, frames.map(frame => frame.cell ?? NO_CELL), extra)
    lastTick = moving ? now : null

    if (at === null) {
      hooks.clock.cancel(hooks.key)
    } else {
      hooks.clock.schedule(hooks.key, at, tick)
    }
  }

  const wake = () => {
    if (running && !disposed) {
      hooks.clock.schedule(hooks.key, (hooks.now ?? Date.now)(), tick)
    }
  }

  return {
    setLayout(next) {
      if (layout && next && (layout.width !== next.width || layout.height !== next.height)) {
        snap = true
      }

      layout = next
      dirty = true
      painted = ''
      wake()
    },
    setInput(next) {
      const changed = input !== null && next.motion !== motion
      motion = next.motion

      if (changed) {
        dropPlans(() => true, (hooks.now ?? Date.now)())
      }

      if (next.installed !== input?.installed) {
        hasSheet = new Map(next.installed.map(pet => [pet.slug, sheetRefOf(pet) !== null]))
      }

      input = next
      dirty = true
      wake()
    },
    setRunning(next) {
      if (next === running) {
        return
      }

      running = next
      lastTick = null
      const now = (hooks.now ?? Date.now)()

      if (running) {
        resettle = baseline && stoppedAt !== null && now - stoppedAt > REPLAY_MS
        stoppedAt = null
        wake()
      } else {
        stoppedAt = now
        hooks.clock.cancel(hooks.key)
      }
    },
    wake() {
      painted = ''
      wake()
    },
    dispose() {
      disposed = true
      running = false
      hooks.clock.cancel(hooks.key)
      hooks.sheets.dispose()
    }
  }
}
