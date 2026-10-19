import { useEffect, useId, useRef } from 'react'
import { PET_FRAME_HEIGHT, PET_FRAME_WIDTH } from '../../../shared/pet.ts'
import { spriteCache } from '../petdex/cache.ts'
import { petClock } from '../petdex/clock.ts'
import { drawPetFrame } from '../petdex/draw.ts'
import type { LoadedSheet } from './sheet.ts'
import { animateSprite, type PetPose, poseRow } from './sprite.ts'

/**
 * One frame of the pet at a time, drawn on a canvas. A pose loops at a low frame rate while it
 * lasts; idle plays a couple of loops and then rests on its first frame, so a quiet pet sets no
 * timer at all, and none runs while it is hidden or motion is reduced.
 */
export function PetSprite({ sheet, pose, since, scale, reduced, paused, rest }: { sheet: LoadedSheet; pose: PetPose; since: number; scale: number; reduced: boolean; paused: boolean; rest?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const key = `pet-sprite:${useId()}`
  const width = Math.max(1, Math.round(PET_FRAME_WIDTH * scale))
  const height = Math.max(1, Math.round(PET_FRAME_HEIGHT * scale))
  const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
  const { row, frames, mirror } = poseRow(pose, sheet.layout)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')

    if (!canvas || !ctx) {
      return
    }

    return animateSprite(petClock, key, { pose, frames, since, reduced, paused, rest }, frame => {
      // The sheet can leave the cache a moment before this sprite is handed the next one: keep the last frame meanwhile.
      const cached = spriteCache.find(sheet)

      if (cached) {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        drawPetFrame(ctx, cached, { row, frame, mirror }, { x: 0, y: 0, width: canvas.width, height: canvas.height }, null)
      }
    })
  }, [key, sheet, pose, since, reduced, paused, rest, row, frames, mirror, width, height, ratio])

  return <canvas ref={canvasRef} width={Math.round(width * ratio)} height={Math.round(height * ratio)} style={{ width, height }} aria-hidden="true" className="pointer-events-none block select-none" />
}
