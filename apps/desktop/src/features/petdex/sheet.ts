import { PET_FRAME_HEIGHT, PET_FRAME_WIDTH } from '../../../shared/pet.ts'
import { alphaIsBlank, layoutFromBlanks, type SheetLayout } from './sprite.ts'

export interface LoadedSheet {
  /** An object URL for CSS backgrounds, held until `releaseSheet`. */
  url: string
  width: number
  height: number
  layout: SheetLayout
}

type Drawing = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

function drawingFor(width: number, height: number): Drawing {
  const offscreen = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true }) : null

  if (offscreen) {
    return offscreen
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) {
    throw new Error('This window cannot draw the pet')
  }

  return context
}

/** A sheet read and kept decoded: `image` stays drawable until it is closed, and `sheet.url` until `releaseSheet`. */
export async function decodeSheet(bytes: Uint8Array, mime: string): Promise<{ sheet: LoadedSheet; image: ImageBitmap }> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime })
  const bitmap = await createImageBitmap(blob)

  try {
    const { width, height } = bitmap
    const drawing = drawingFor(width, height)
    drawing.drawImage(bitmap, 0, 0)
    // RGBA bytes: from the first alpha byte on, every fourth one is a pixel's alpha.
    const layout = layoutFromBlanks(width, height, (column, row) => alphaIsBlank(drawing.getImageData(column * PET_FRAME_WIDTH, row * PET_FRAME_HEIGHT, PET_FRAME_WIDTH, PET_FRAME_HEIGHT).data.subarray(3), 4))

    return { sheet: { url: URL.createObjectURL(blob), width, height, layout }, image: bitmap }
  } catch (error) {
    bitmap.close()
    throw error
  }
}

export async function loadSheet(bytes: Uint8Array, mime: string): Promise<LoadedSheet> {
  const { sheet, image } = await decodeSheet(bytes, mime)
  image.close()

  return sheet
}

export function releaseSheet(sheet: LoadedSheet | null): void {
  if (sheet) {
    URL.revokeObjectURL(sheet.url)
  }
}
