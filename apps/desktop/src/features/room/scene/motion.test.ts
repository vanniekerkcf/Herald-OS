import { describe, expect, it } from 'vitest'
import { type Body, bodyMoving, FADE_MS, fadeOut, opacityAt, spawnBody, stepBody, WALK_MAX_SPEED, WALK_MIN_SPEED, walkMs, walkSpeed } from './motion.ts'

const standing = (x: number, y: number): Body => ({ x, y, facing: 1, walking: false, opacity: 1, fade: null })

describe('walkSpeed', () => {
  it('strolls short walks and hurries long ones, always between 120 and 160 px/s', () => {
    expect(walkSpeed(10)).toBe(WALK_MIN_SPEED)
    expect(walkSpeed(5000)).toBe(WALK_MAX_SPEED)
    expect(walkSpeed(420)).toBeGreaterThan(WALK_MIN_SPEED)
    expect(walkSpeed(420)).toBeLessThan(WALK_MAX_SPEED)
    expect(walkSpeed(300)).toBeLessThanOrEqual(walkSpeed(450))
  })

  it('times a walk from its length', () => {
    expect(walkMs(0)).toBe(0)
    expect(walkMs(120)).toBeCloseTo(1000)
    expect(walkMs(1600)).toBeCloseTo(10_000)
  })
})

describe('stepBody, full motion', () => {
  it('walks straight toward the target at walking pace and faces the way it goes', () => {
    const body = stepBody(standing(100, 100), { x: 0, y: 100 }, 0.5, 0, 'full')

    expect(body.x).toBeCloseTo(100 - walkSpeed(100) * 0.5)
    expect(body.y).toBe(100)
    expect(body.facing).toBe(-1)
    expect(body.walking).toBe(true)
  })

  it('moves along the line between the two points', () => {
    const body = stepBody(standing(0, 0), { x: 300, y: 400 }, 1, 0, 'full')

    expect(body.y / body.x).toBeCloseTo(400 / 300)
    expect(Math.hypot(body.x, body.y)).toBeCloseTo(walkSpeed(500))
  })

  it('arrives exactly on the target and stops walking', () => {
    const body = stepBody(standing(0, 0), { x: 50, y: 0 }, 1, 0, 'full')

    expect(body).toMatchObject({ x: 50, y: 0, walking: false, facing: 1 })
  })

  it('keeps the way it faced when the walk is straight up or down', () => {
    const body = stepBody({ ...standing(10, 0), facing: -1 }, { x: 10, y: 400 }, 0.1, 0, 'full')

    expect(body.facing).toBe(-1)
    expect(body.walking).toBe(true)
  })

  it('starts walking without moving on a tick with no time passed', () => {
    const body = stepBody(standing(0, 0), { x: 200, y: 0 }, 0, 0, 'full')

    expect(body).toMatchObject({ x: 0, y: 0, walking: true })
  })

  it('ignores a negative step', () => {
    expect(stepBody(standing(0, 0), { x: 200, y: 0 }, -1, 0, 'full').x).toBe(0)
  })
})

describe('stepBody, calm and still motion', () => {
  it('puts a calm pet at its new spot with a short fade instead of a walk', () => {
    const moved = stepBody(standing(0, 0), { x: 300, y: 80 }, 0.016, 1000, 'calm')

    expect(moved).toMatchObject({ x: 300, y: 80, walking: false, opacity: 0 })
    expect(bodyMoving(moved, 1000)).toBe(true)

    const half = stepBody(moved, { x: 300, y: 80 }, 0.016, 1000 + FADE_MS / 2, 'calm')

    expect(half.opacity).toBeCloseTo(0.5)

    const done = stepBody(half, { x: 300, y: 80 }, 0.016, 1000 + FADE_MS, 'calm')

    expect(done).toMatchObject({ opacity: 1, fade: null })
    expect(bodyMoving(done, 1000 + FADE_MS)).toBe(false)
  })

  it('puts a still pet at its new spot with nothing animated', () => {
    const moved = stepBody({ ...standing(0, 0), opacity: 0.2, fade: { from: 0, to: 1, start: 0, ms: FADE_MS } }, { x: 300, y: 80 }, 0.016, 10, 'still')

    expect(moved).toMatchObject({ x: 300, y: 80, walking: false, opacity: 1, fade: null })
    expect(bodyMoving(moved, 10)).toBe(false)
  })

  it('finishes a fade at once when motion goes still', () => {
    const fadingOut = fadeOut(standing(5, 5), 0, 'full')

    expect(stepBody(fadingOut, { x: 5, y: 5 }, 0.016, 10, 'still')).toMatchObject({ opacity: 0, fade: null })
  })
})

describe('spawnBody and fadeOut', () => {
  it('fades a newcomer in unless it was there all along or nothing animates', () => {
    expect(spawnBody({ x: 1, y: 2 }, 0, 'full', true)).toMatchObject({ x: 1, y: 2, opacity: 0, fade: { from: 0, to: 1, start: 0, ms: FADE_MS } })
    expect(spawnBody({ x: 1, y: 2 }, 0, 'full', false)).toMatchObject({ opacity: 1, fade: null })
    expect(spawnBody({ x: 1, y: 2 }, 0, 'still', true)).toMatchObject({ opacity: 1, fade: null })
  })

  it('fades a pet out from where its opacity is, or at once without motion', () => {
    const half = { ...standing(0, 0), opacity: 0.5 }

    expect(fadeOut(half, 100, 'calm').fade).toEqual({ from: 0.5, to: 0, start: 100, ms: FADE_MS })
    expect(fadeOut(half, 100, 'still')).toMatchObject({ opacity: 0, fade: null })
  })

  it('reads a fade at any moment, held at its ends', () => {
    const fade = { from: 0, to: 1, start: 100, ms: 200 }

    expect(opacityAt(fade, 0)).toBe(0)
    expect(opacityAt(fade, 200)).toBeCloseTo(0.5)
    expect(opacityAt(fade, 900)).toBe(1)
    expect(opacityAt({ ...fade, ms: 0 }, 0)).toBe(1)
  })
})

describe('bodyMoving', () => {
  it('needs frames while walking or fading, and none while standing', () => {
    expect(bodyMoving({ ...standing(0, 0), walking: true }, 0)).toBe(true)
    expect(bodyMoving({ ...standing(0, 0), fade: { from: 0, to: 1, start: 0, ms: 100 } }, 50)).toBe(true)
    expect(bodyMoving({ ...standing(0, 0), fade: { from: 0, to: 1, start: 0, ms: 100 } }, 100)).toBe(false)
    expect(bodyMoving(standing(0, 0), 0)).toBe(false)
  })
})
