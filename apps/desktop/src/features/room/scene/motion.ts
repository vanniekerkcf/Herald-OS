import type { RoomMotion } from '../../../../shared/room.ts'
import type { Point } from './layout.ts'

/*
 * How a pet gets where it should stand. Full motion walks in straight lines; calm motion puts it
 * there with a short fade; still motion (and Reduce Motion) puts it there and nothing animates.
 */

export interface Fade {
  from: number
  to: number
  start: number
  ms: number
}

export interface Body {
  x: number
  y: number
  facing: -1 | 1
  walking: boolean
  /** 0 to 1. */
  opacity: number
  fade: Fade | null
}

export const FADE_MS = 260
export const WALK_MIN_SPEED = 120
export const WALK_MAX_SPEED = 160

/** Closer than this (px) is there. */
const ARRIVED = 0.5

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

/** Pixels a second for a walk of `distance`: a short walk strolls, a long one hurries a little. */
export function walkSpeed(distance: number): number {
  return clamp(distance / 3, WALK_MIN_SPEED, WALK_MAX_SPEED)
}

/** How long a walk of `distance` takes, in ms. */
export function walkMs(distance: number): number {
  return distance > 0 ? (distance / walkSpeed(distance)) * 1000 : 0
}

export function opacityAt(fade: Fade, now: number): number {
  const progress = fade.ms > 0 ? clamp((now - fade.start) / fade.ms, 0, 1) : 1

  return fade.from + (fade.to - fade.from) * progress
}

const fadeDone = (fade: Fade, now: number): boolean => now >= fade.start + fade.ms

/** A pet coming into the room at `at`: it fades in unless nothing animates or it was there all along. */
export function spawnBody(at: Point, now: number, motion: RoomMotion, fadeIn: boolean): Body {
  const fades = fadeIn && motion !== 'still'

  return { x: at.x, y: at.y, facing: 1, walking: false, opacity: fades ? 0 : 1, fade: fades ? { from: 0, to: 1, start: now, ms: FADE_MS } : null }
}

/** Start fading a pet out where it stands (at once without motion). */
export function fadeOut(body: Body, now: number, motion: RoomMotion): Body {
  if (motion === 'still') {
    return { ...body, walking: false, opacity: 0, fade: null }
  }

  return { ...body, walking: false, fade: { from: body.opacity, to: 0, start: now, ms: FADE_MS } }
}

function settleFade(body: Body, now: number, motion: RoomMotion): Pick<Body, 'opacity' | 'fade'> {
  if (!body.fade) {
    return { opacity: body.opacity, fade: null }
  }

  if (motion === 'still' || fadeDone(body.fade, now)) {
    return { opacity: motion === 'still' && body.fade.to > 0 ? 1 : body.fade.to, fade: null }
  }

  return { opacity: opacityAt(body.fade, now), fade: body.fade }
}

/** The pet `dt` seconds on, heading for `target`. */
export function stepBody(body: Body, target: Point, dt: number, now: number, motion: RoomMotion): Body {
  const faded = settleFade(body, now, motion)
  const dx = target.x - body.x
  const dy = target.y - body.y
  const distance = Math.hypot(dx, dy)

  if (distance <= ARRIVED) {
    return { ...body, ...faded, x: target.x, y: target.y, walking: false }
  }

  if (motion === 'still') {
    return { ...body, x: target.x, y: target.y, walking: false, opacity: 1, fade: null }
  }

  if (motion === 'calm') {
    return { ...body, x: target.x, y: target.y, walking: false, opacity: 0, fade: { from: 0, to: 1, start: now, ms: FADE_MS } }
  }

  const facing: -1 | 1 = Math.abs(dx) > ARRIVED ? (dx < 0 ? -1 : 1) : body.facing
  const reach = walkSpeed(distance) * Math.max(0, dt)

  if (reach >= distance) {
    return { ...body, ...faded, x: target.x, y: target.y, facing, walking: false }
  }

  return { ...body, ...faded, x: body.x + (dx / distance) * reach, y: body.y + (dy / distance) * reach, facing, walking: true }
}

/** Whether the body still needs frames: walking, or a fade under way. */
export function bodyMoving(body: Body, now: number): boolean {
  return body.walking || (body.fade !== null && !fadeDone(body.fade, now))
}
