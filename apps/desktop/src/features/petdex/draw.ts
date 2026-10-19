import { PET_FRAME_HEIGHT, PET_FRAME_WIDTH } from '../../../shared/pet.ts'
import type { CachedSheet } from './cache.ts'
import type { SheetLayout } from './sprite.ts'

/**
 * Colour variants for pets that share a sprite: index 0 is the pet's own colours. Each later one
 * turns every hue by the same angle, the most different first, which keeps the pet's lightness and
 * so its contrast on light and dark themes alike.
 */
export const PET_TINTS: readonly { hue: number; label: string }[] = [
  { hue: 0, label: 'own colours' },
  { hue: 180, label: 'tint 1' },
  { hue: 90, label: 'tint 2' },
  { hue: 270, label: 'tint 3' },
  { hue: 45, label: 'tint 4' },
  { hue: 225, label: 'tint 5' },
  { hue: 135, label: 'tint 6' },
  { hue: 315, label: 'tint 7' }
]

/** A turned hue reads paler than the pet's own: a little more saturation keeps the tints apart. */
const TINT_SATURATION = 1.2

const tintHue = (tint: number | null): number | undefined => (tint !== null && Number.isInteger(tint) && tint > 0 ? PET_TINTS[tint]?.hue : undefined)

/** The canvas filter for a PET_TINTS index; null for the pet's own colours or an index there is no tint for. */
export function tintFilter(tint: number | null): string | null {
  const hue = tintHue(tint)

  return hue === undefined ? null : `hue-rotate(${hue}deg) saturate(${TINT_SATURATION})`
}

/** A soft colour of a PET_TINTS index's hue, for a pet drawn without its sheet; null for its own colours or an index there is no tint for. */
export function tintColour(tint: number | null): string | null {
  const hue = tintHue(tint)

  return hue === undefined ? null : `hsl(${hue} 42% 64%)`
}

export interface SpriteCell {
  row: number
  frame: number
  mirror: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const within = (value: number, count: number): number => Math.min(Math.max(0, count - 1), Math.max(0, Math.floor(value) || 0))

/** Where a cell sits on its sheet, held to the sheet's own grid. */
export function cellSource(layout: Pick<SheetLayout, 'columns' | 'rows'>, cell: Pick<SpriteCell, 'row' | 'frame'>): Rect {
  return { x: within(cell.frame, layout.columns) * PET_FRAME_WIDTH, y: within(cell.row, layout.rows) * PET_FRAME_HEIGHT, width: PET_FRAME_WIDTH, height: PET_FRAME_HEIGHT }
}

type CellDrawing = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

let scratch: { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CellDrawing } | null = null

/** One cell-sized canvas every tinted pet draws through, so no window's canvas ever keeps a filter. */
function scratchCell(): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CellDrawing } | null {
  if (scratch) {
    return scratch
  }

  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(PET_FRAME_WIDTH, PET_FRAME_HEIGHT)
    const ctx = canvas.getContext('2d')
    scratch = ctx ? { canvas, ctx } : null
  } else if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = PET_FRAME_WIDTH
    canvas.height = PET_FRAME_HEIGHT
    const ctx = canvas.getContext('2d')
    scratch = ctx ? { canvas, ctx } : null
  }

  return scratch
}

function tintedCell(image: CanvasImageSource, source: Rect, filter: string): OffscreenCanvas | HTMLCanvasElement | null {
  const cell = scratchCell()

  if (!cell) {
    return null
  }

  cell.ctx.filter = 'none'
  cell.ctx.clearRect(0, 0, PET_FRAME_WIDTH, PET_FRAME_HEIGHT)
  cell.ctx.filter = filter
  cell.ctx.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, PET_FRAME_WIDTH, PET_FRAME_HEIGHT)
  cell.ctx.filter = 'none'

  return cell.canvas
}

/** Draw one frame of a sheet into `dest` (CSS pixels of an already scaled context), tinted when `tint` is a PET_TINTS index above 0. */
export function drawPetFrame(ctx: CanvasRenderingContext2D, cached: CachedSheet, cell: SpriteCell, dest: { x: number; y: number; width: number; height: number }, tint: number | null): void {
  const source = cellSource(cached.sheet.layout, cell)
  const filter = tintFilter(tint)
  const tinted = filter ? tintedCell(cached.image, source, filter) : null
  const from = tinted ? { x: 0, y: 0, width: PET_FRAME_WIDTH, height: PET_FRAME_HEIGHT } : source

  ctx.save()
  ctx.imageSmoothingQuality = 'high'

  if (cell.mirror) {
    ctx.translate(dest.x + dest.width, dest.y)
    ctx.scale(-1, 1)
  }

  ctx.drawImage(tinted ?? cached.image, from.x, from.y, from.width, from.height, cell.mirror ? 0 : dest.x, cell.mirror ? 0 : dest.y, dest.width, dest.height)
  ctx.restore()
}
