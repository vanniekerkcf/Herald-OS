import { drawPetFrame, tintColour } from '../../petdex/draw.ts'
import type { PetFrame } from './engine.ts'
import type { SceneLayout } from './layout.ts'

/** How far down its frame a pet's feet are: the frame's bottom edge sits a little below them. */
export const FEET = 0.92

/** A pet whose sheet cannot be had stands as a plain figure in its tint's colour, or in this tone with its own colours. */
export const FIGURE_TONE = 'hsl(222 12% 68%)'

const SHADOW = 'rgba(0, 8, 40, 0.42)'
const SHADOW_EDGE = 'rgba(0, 8, 40, 0)'

/** Where a pet's frame is drawn, for its feet at (x, y). */
export function spriteRect(frame: Pick<PetFrame, 'x' | 'y'>, pet: SceneLayout['pet']): { x: number; y: number; width: number; height: number } {
  return { x: frame.x - pet.width / 2, y: frame.y - pet.height * FEET, width: pet.width, height: pet.height }
}

/** A plain pet standing in its frame's `rect` as a sprite would: a rounded body and two ears, softened by a stroke of the same colour. */
function drawFigure(ctx: CanvasRenderingContext2D, rect: ReturnType<typeof spriteRect>, colour: string): void {
  const middle = rect.x + rect.width / 2
  const feet = rect.y + rect.height * FEET
  const base = rect.width * 0.27
  const head = rect.width * 0.2
  const top = feet - rect.height * 0.44
  const ear = rect.height * 0.11
  const corner = rect.width * 0.06
  ctx.fillStyle = colour
  ctx.strokeStyle = colour
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(1, rect.width * 0.06)

  ctx.beginPath()
  ctx.moveTo(middle, top)
  ctx.quadraticCurveTo(middle + head, top, middle + head, top + head * 0.7)
  ctx.bezierCurveTo(middle + head, top + head * 1.3, middle + base, feet - rect.height * 0.2, middle + base, feet - corner)
  ctx.quadraticCurveTo(middle + base, feet, middle + base - corner, feet)
  ctx.lineTo(middle - base + corner, feet)
  ctx.quadraticCurveTo(middle - base, feet, middle - base, feet - corner)
  ctx.bezierCurveTo(middle - base, feet - rect.height * 0.2, middle - head, top + head * 1.3, middle - head, top + head * 0.7)
  ctx.quadraticCurveTo(middle - head, top, middle, top)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // The ears fill as a path of their own: the mirrored one winds against the body and would cut a notch in it.
  ctx.beginPath()

  for (const side of [-1, 1]) {
    ctx.moveTo(middle + side * head * 0.95, top + head * 0.75)
    ctx.lineTo(middle + side * head * 0.95, top - ear)
    ctx.lineTo(middle + side * head * 0.2, top + head * 0.12)
    ctx.closePath()
  }

  ctx.fill()
  ctx.stroke()
}

/** Every pet back to front, each on a soft shadow (a plain figure for one whose sheet cannot be had), into a context `ratio` device pixels to a CSS pixel. */
export function paintPets(ctx: CanvasRenderingContext2D, frames: readonly PetFrame[], layout: SceneLayout, ratio: number, draw: typeof drawPetFrame = drawPetFrame): void {
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, layout.width, layout.height)
  const radius = layout.pet.width * 0.32
  const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius)
  shadow.addColorStop(0, SHADOW)
  shadow.addColorStop(1, SHADOW_EDGE)

  for (const frame of frames) {
    if (frame.opacity <= 0) {
      continue
    }

    ctx.save()
    ctx.globalAlpha = Math.min(1, frame.opacity)
    ctx.translate(frame.x, frame.y)
    ctx.scale(1, 0.3)
    ctx.fillStyle = shadow
    ctx.beginPath()
    ctx.arc(0, 0, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    if (frame.sheet && frame.cell) {
      ctx.save()
      ctx.globalAlpha = Math.min(1, frame.opacity)
      draw(ctx, frame.sheet, { row: frame.cell.row, frame: frame.cell.frame, mirror: frame.cell.mirror }, spriteRect(frame, layout.pet), frame.tint)
      ctx.restore()
    } else if (frame.fallback) {
      ctx.save()
      ctx.globalAlpha = Math.min(1, frame.opacity)
      drawFigure(ctx, spriteRect(frame, layout.pet), tintColour(frame.tint) ?? FIGURE_TONE)
      ctx.restore()
    }
  }
}
