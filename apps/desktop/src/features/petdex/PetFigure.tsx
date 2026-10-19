import { useStore } from '@nanostores/react'
import { IconPaw } from '@tabler/icons-react'
import { useEffect, useId, useRef, useState } from 'react'
import { PET_FRAME_HEIGHT, PET_FRAME_WIDTH } from '../../../shared/pet.ts'
import { cn } from '../../lib/cn.ts'
import { useDocumentVisible, useReducedMotion, useSince } from '../pet/hooks.ts'
import { $petInfo } from '../pet/info.ts'
import { type CachedSheet, sheetKey, spriteCache } from './cache.ts'
import { petClock } from './clock.ts'
import { drawPetFrame } from './draw.ts'
import { animateSprite, type PetPose, poseRow } from './sprite.ts'

/** A light pet view: one installed pet in a small canvas, from the shared sprite cache and clock (Settings' previews); a paw when its sheet cannot be had. */
export function PetFigure({ slug, pose = 'idle', scale = 0.4, tint = null, still = false, className }: { slug: string; pose?: PetPose; scale?: number; tint?: number | null; still?: boolean; className?: string }) {
  const pet = useStore($petInfo).installed.find(entry => entry.slug === slug)
  const revision = pet?.revision ?? null
  const mime = pet?.mime ?? 'image/webp'
  const wanted = revision ? sheetKey({ slug, revision }) : null
  const [cached, setCached] = useState<CachedSheet | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const sheet = cached && cached.key === wanted ? cached : null
  // An installed pet without a revision has no spritesheet main could find.
  const unavailable = pet !== undefined && (wanted === null || failed === wanted)
  const reduced = useReducedMotion()
  const visible = useDocumentVisible()
  const since = useSince(sheet ? `${sheet.key}|${pose}` : null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const key = `pet-figure:${useId()}`
  const width = Math.max(1, Math.round(PET_FRAME_WIDTH * scale))
  const height = Math.max(1, Math.round(PET_FRAME_HEIGHT * scale))
  const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
  const { row, frames, mirror } = sheet ? poseRow(pose, sheet.sheet.layout) : { row: 0, frames: 1, mirror: false }

  useEffect(() => {
    if (!revision) {
      return
    }

    let live = true
    let held: string | null = null
    let stopWaiting: (() => void) | null = null
    const asked = sheetKey({ slug, revision })
    const load = () => {
      void spriteCache.acquire({ slug, revision, mime }).then(next => {
        if (!live) {
          if (next) {
            spriteCache.release(next.key)
          }

          return
        }

        if (!next) {
          setFailed(asked)

          // Other views may hold as many sheets as the cache decodes at once: try again when one
          // lets go. A sheet that cannot be read waits for its next revision instead.
          if (!spriteCache.failed(asked)) {
            stopWaiting = spriteCache.onRelease(() => {
              stopWaiting?.()
              stopWaiting = null
              load()
            })
          }

          return
        }

        held = next.key
        setFailed(null)
        setCached(next)
      })
    }

    load()

    return () => {
      live = false
      stopWaiting?.()
      setCached(null)

      if (held) {
        spriteCache.release(held)
      }
    }
  }, [slug, revision, mime])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')

    if (!sheet || !canvas || !ctx) {
      return
    }

    return animateSprite(petClock, key, { pose, frames, since, reduced: still || reduced, paused: !visible }, frame => {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      drawPetFrame(ctx, sheet, { row, frame, mirror }, { x: 0, y: 0, width: canvas.width, height: canvas.height }, tint)
    })
  }, [key, sheet, pose, since, still, reduced, visible, tint, row, frames, mirror, width, height, ratio])

  if (!sheet) {
    return unavailable ? (
      <span style={{ width, height }} aria-hidden="true" className={cn('pointer-events-none flex items-center justify-center text-fg-4 select-none', className)}>
        <IconPaw size={Math.max(8, Math.round(Math.min(width, height) * 0.45))} />
      </span>
    ) : null
  }

  return <canvas ref={canvasRef} width={Math.round(width * ratio)} height={Math.round(height * ratio)} style={{ width, height }} aria-hidden="true" className={cn('pointer-events-none block select-none', className)} />
}
