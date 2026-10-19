import {
  IconArmchair2,
  IconBrain,
  IconBroadcast,
  IconBrush,
  IconCode,
  IconFileText,
  IconFolder,
  IconHourglass,
  IconMessages,
  IconPlant2,
  IconPresentation,
  IconRepeat,
  IconTable,
  IconTerminal2,
  IconWorld
} from '@tabler/icons-react'
import { type ComponentType, type CSSProperties, memo } from 'react'
import { HermesMark } from '../../../components/hermes-mark.tsx'
import { cn } from '../../../lib/cn.ts'
import type { RoomArea } from '../model/types.ts'
import { laneWords } from './labels.ts'
import { LANE_HEADER, type Rect, type RoomSpot, type SceneLayout, type Station } from './layout.ts'

type Icon = ComponentType<{ size?: number; className?: string; stroke?: number }>

export const AREA_ICONS: Record<RoomArea, Icon> = {
  docs: IconFileText,
  sheets: IconTable,
  slides: IconPresentation,
  canvas: IconBrush,
  terminal: IconTerminal2,
  browser: IconWorld,
  files: IconFolder,
  studio: IconCode,
  memory: IconBrain,
  messages: IconMessages,
  bench: IconHourglass,
  lounge: IconArmchair2,
  automations: IconRepeat,
  elsewhere: IconBroadcast
}

/** What a desk is called when document names are off. */
const DESK_KINDS: Partial<Record<RoomArea, string>> = {
  docs: 'A document open in Herald Docs',
  sheets: 'A workbook open in Herald Sheets',
  slides: 'A presentation open in Herald Slides',
  canvas: 'A project open in Herald Canvas'
}

export const LANE_TITLE = 'Outside Herald'

const box = (rect: Rect) => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })

/** A station's soft glow in one of the theme's colours; inline, as `.glass-card` sits above Tailwind's utilities. */
const glow = (color: string): CSSProperties => ({
  background: 'var(--color-glass-3)',
  borderColor: `color-mix(in srgb, ${color} 70%, transparent)`,
  boxShadow: `inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 0 0 1px color-mix(in srgb, ${color} 30%, transparent), 0 0 30px color-mix(in srgb, ${color} 34%, transparent)`
})

interface Drawn {
  station: Station
  glowing: boolean
  still: boolean
  /** Words on the furniture; the screensaver draws none. */
  words: boolean
}

function Tile({ station, unit, glowing, still, words }: Drawn & { unit: number }) {
  const Glyph = AREA_ICONS[station.area]
  const tile = Math.round(unit * 0.42)

  return (
    <div
      title={words ? station.name : undefined}
      className="glass-card absolute flex flex-col items-center justify-center gap-1.5 rounded-xl px-2"
      style={{ ...box(station.rect), transitionDuration: still ? '0ms' : '700ms', ...(glowing ? glow('var(--color-progress)') : {}) }}
    >
      <span className="icon-tile shrink-0" style={{ width: tile, height: tile, borderRadius: Math.round(tile * 0.26) }}>
        <Glyph size={Math.round(tile * 0.56)} stroke={1.7} />
      </span>
      {words && <span className={cn('max-w-full truncate text-[11.5px] leading-none font-medium', glowing ? 'text-fg' : 'text-fg-2')}>{station.label}</span>}
    </div>
  )
}

function Bench({ station, glowing, still, words }: Drawn) {
  const { rect } = station
  const leg = Math.max(3, Math.round(rect.height * 0.12))

  return (
    <div className="absolute" style={box(rect)} title={words ? station.name : undefined}>
      <div className="glass-card absolute inset-x-0 top-0 rounded-lg" style={{ height: Math.round(rect.height * 0.62), transitionDuration: still ? '0ms' : '700ms', ...(glowing ? glow('var(--color-warn)') : {}) }} />
      <div className="absolute rounded-b bg-white/10" style={{ left: '8%', width: leg, top: Math.round(rect.height * 0.62), bottom: 0 }} />
      <div className="absolute rounded-b bg-white/10" style={{ right: '8%', width: leg, top: Math.round(rect.height * 0.62), bottom: 0 }} />
      {words && <FurnitureLabel station={station} />}
    </div>
  )
}

/** The Automations corner: a timetable board on a low stand, lit while a run is under way; its pets stand at its left end. */
function Board({ station, glowing, still, words, unit }: Drawn & { unit: number }) {
  const { rect } = station
  const face = Math.round(rect.height * 0.7)

  return (
    <div className="absolute" style={box(rect)} title={words ? station.name : undefined}>
      <div
        className="glass-card absolute inset-x-[6%] top-0 flex items-center justify-end gap-[6%] rounded-lg pr-[9%]"
        style={{ height: face, transitionDuration: still ? '0ms' : '700ms', ...(glowing ? glow('var(--color-progress)') : {}) }}
      >
        <IconRepeat size={Math.round(unit * 0.3)} stroke={1.6} className={glowing ? 'text-progress' : 'text-fg-3'} />
        <span className="flex flex-col gap-[3px]" aria-hidden="true">
          {[0.62, 0.44, 0.54].map(share => (
            <span key={share} className="h-[3px] rounded-full bg-white/18" style={{ width: Math.round(rect.width * share * 0.5) }} />
          ))}
        </span>
      </div>
      <div className="absolute left-1/2 w-1 -translate-x-1/2 rounded-b bg-white/10" style={{ top: face, bottom: 0 }} />
      {words && <FurnitureLabel station={station} />}
    </div>
  )
}

function Sofa({ station, unit, words }: Drawn & { unit: number }) {
  const { rect } = station
  const arm = Math.round(rect.height * 0.32)

  return (
    <>
      <div className="absolute rounded-[50%] bg-accent-soft opacity-40" style={{ left: rect.x - unit * 0.3, width: rect.width + unit * 0.6, top: rect.y + rect.height * 0.45, height: rect.height * 0.9 }} />
      <div className="absolute" style={box(rect)} title={words ? station.name : undefined}>
        <div className="glass-card absolute inset-x-0 top-0 rounded-xl" style={{ height: Math.round(rect.height * 0.62) }} />
        <div className="absolute inset-x-0 bottom-0 rounded-lg bg-glass-3 hairline" style={{ height: Math.round(rect.height * 0.5) }} />
        <div className="absolute bottom-0 left-0 rounded-lg bg-glass-3 hairline" style={{ width: arm, height: Math.round(rect.height * 0.72) }} />
        <div className="absolute right-0 bottom-0 rounded-lg bg-glass-3 hairline" style={{ width: arm, height: Math.round(rect.height * 0.72) }} />
        {words && <FurnitureLabel station={station} />}
      </div>
      <IconPlant2 className="absolute text-ok/50" size={Math.round(unit * 0.62)} stroke={1.4} style={{ left: rect.x - unit * 0.72, top: rect.y + rect.height - unit * 0.62 }} />
    </>
  )
}

/** A desk for an open document: a small table with its app's mark, its name over it when names are on. */
function Desk({ station, unit, glowing, still, words, named }: Drawn & { unit: number; named: boolean }) {
  const Glyph = AREA_ICONS[station.area]
  const { rect } = station

  return (
    <div className="absolute" style={box(rect)} title={words ? (named ? station.name : DESK_KINDS[station.area]) : undefined}>
      <div
        className="glass-card absolute inset-0 flex items-center justify-center rounded-md"
        style={{ transitionDuration: still ? '0ms' : '700ms', ...(glowing ? glow('var(--color-progress)') : {}) }}
      >
        <Glyph size={Math.round(Math.min(rect.height * 0.6, unit * 0.26))} stroke={1.7} className={glowing ? 'text-progress' : 'text-fg-3'} />
      </div>
      {words && named && (
        <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 truncate rounded bg-black/25 px-1.5 py-px text-center text-[10px] leading-tight whitespace-nowrap text-fg-3" style={{ maxWidth: Math.max(84, Math.round(rect.width + unit * 0.5)) }}>
          {station.label}
        </span>
      )}
    </div>
  )
}

/** The lane for work outside Herald: a strip outside the room, which says how much it shows. */
function Lane({ station, words, live, text }: Drawn & { live: boolean; text?: { note: string; about: string } }) {
  const { note, about } = text ?? laneWords(live)

  return (
    <div className="absolute border-l border-line bg-black/20" style={box(station.rect)}>
      {words && (
        <div className="pointer-events-auto flex flex-col gap-0.5 px-3 pt-2.5" style={{ height: LANE_HEADER }} title={about}>
          <span className="flex items-center gap-1.5 text-[11.5px] leading-tight font-semibold text-fg-2">
            <IconBroadcast size={13} className="shrink-0 text-fg-3" />
            <span className="truncate">{LANE_TITLE}</span>
          </span>
          <span className="line-clamp-2 text-[9.5px] leading-tight text-fg-4">{note}</span>
        </div>
      )}
    </div>
  )
}

function FurnitureLabel({ station }: { station: Station }) {
  const Glyph = AREA_ICONS[station.area]

  return (
    <span className="absolute top-full left-1/2 mt-1 flex -translate-x-1/2 items-center gap-1 text-[10.5px] whitespace-nowrap text-fg-4">
      <Glyph size={11} />
      {station.label}
    </span>
  )
}

function Door({ rect, unit, words }: { rect: Rect; unit: number; words: boolean }) {
  return (
    <div className="absolute flex flex-col items-center gap-1 rounded-t-[999px] rounded-b-md border border-line-strong bg-glass-2 shadow-card" style={{ ...box(rect), paddingTop: Math.round(rect.height * 0.24) }} title={words ? 'The door to Hermes' : undefined}>
      <HermesMark size={Math.round(unit * 0.36)} className="text-accent-strong" />
      {words && <span className="text-[10px] leading-none font-medium text-fg-3">Hermes</span>}
      <span className="absolute top-[62%] right-[14%] size-1.5 rounded-full bg-fg-3" />
    </div>
  )
}

export interface RoomBackdropProps {
  layout: SceneLayout
  glowing: ReadonlySet<RoomSpot>
  still: boolean
  /** Desks show their documents' names. */
  deskNames: boolean
  /** Words on the walls and furniture; off for the screensaver. */
  words?: boolean
  /** The lane shows live steps from Herald's bridge plugin, not only the session list's titles. */
  laneLive?: boolean
  /** What the lane says at its top, for a scene that is not the live Room. */
  laneText?: { note: string; about: string }
}

/** The room drawn once per size: walls, floor, stations, desks and furniture; a station glows while a pet works there. */
export const RoomBackdrop = memo(function RoomBackdrop({ layout, glowing, still, deskNames, words = true, laneLive = false, laneText }: RoomBackdropProps) {
  const { unit } = layout
  const lines = Math.max(18, Math.round(unit * 0.62))
  const roomWidth = layout.wall.width

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden select-none" aria-hidden="true">
      <div
        className="absolute top-0 left-0 border-b border-line"
        style={{ width: roomWidth, height: layout.wall.height, background: 'linear-gradient(180deg, color-mix(in srgb, var(--color-accent) 11%, transparent), color-mix(in srgb, var(--color-accent) 4%, transparent))' }}
      />
      <div className="absolute left-0 bg-white/6" style={{ width: roomWidth, top: layout.wall.height - 4, height: 4 }} />
      <div
        className="absolute bottom-0 left-0"
        style={{
          width: roomWidth,
          top: layout.wall.height,
          background: `radial-gradient(ellipse at 50% 30%, color-mix(in srgb, var(--color-accent) 10%, transparent), transparent 70%), repeating-linear-gradient(180deg, transparent 0 ${lines - 1}px, color-mix(in srgb, var(--color-line) 30%, transparent) ${lines - 1}px ${lines}px)`
        }}
      />
      {layout.stations.map(station => {
        const drawn: Drawn = { station, glowing: glowing.has(station.id), still, words }

        switch (station.wall) {
          case 'lane':
            return <Lane key={station.id} {...drawn} live={laneLive} text={laneText} />
          case 'desk':
            return <Desk key={station.id} {...drawn} unit={unit} named={deskNames} />
          case 'front':
            return station.id === 'lounge' ? (
              <Sofa key={station.id} {...drawn} unit={unit} />
            ) : station.id === 'automations' ? (
              <Board key={station.id} {...drawn} unit={unit} />
            ) : (
              <Bench key={station.id} {...drawn} />
            )
          default:
            return <Tile key={station.id} {...drawn} unit={unit} />
        }
      })}
      <Door rect={layout.door} unit={unit} words={words} />
    </div>
  )
})
