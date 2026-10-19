import { IconAlertTriangle, IconBolt, IconCircleCheck, IconHandStop, IconMessageCircle, IconNote, IconSubtask, IconTarget, IconWorld } from '@tabler/icons-react'
import { type ComponentType, type CSSProperties, memo, type ReactNode } from 'react'
import type { RoomKind } from '../../../../shared/room.ts'
import { cn } from '../../../lib/cn.ts'
import { meterOf } from '../model/costs.ts'
import type { RoomAgent, RoomFact } from '../model/types.ts'
import type { CarryKind } from './choreography.ts'
import type { PetMarks } from './engine.ts'
import { agentTitle, displayStep, doingText, KIND_NAMES, tagFacts } from './labels.ts'
import { BUBBLE_RISE, type PetBox, tagWidth, wallOf } from './layout.ts'

type Icon = ComponentType<{ size?: number; className?: string }>

const KIND_ICONS: Record<RoomKind, Icon> = { conversation: IconMessageCircle, mission: IconTarget, helper: IconSubtask, automation: IconBolt, elsewhere: IconWorld }

const CARRY: Record<CarryKind, { icon: Icon; tone: string }> = {
  note: { icon: IconNote, tone: 'text-accent-strong' },
  result: { icon: IconCircleCheck, tone: 'text-ok' },
  failure: { icon: IconAlertTriangle, tone: 'text-warn' }
}

/** Pressing the sign or its card leaves the focus where it was, so no key press can answer them. */
export const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault()

/** How many facts show under a name tag; all of them are in its tooltip and the screen-reader list. */
const TAG_FACTS = 1

/** Pets shorter than this (a small window) get smaller bubbles. */
const COMPACT_PET = 60

/**
 * Where a bubble opens: over its pet, or beside its head toward the room for a pet at a side-wall
 * station, as the stations stacked on a side wall leave no room over a pet for one.
 */
type Lean = 'left' | 'right' | null

const TAILS: Record<'over' | 'left' | 'right', string> = {
  over: 'top-full left-1/2 -mt-1 -translate-x-1/2 border-r border-b group-data-[edge=left]/pet:left-6 group-data-[edge=right]/pet:right-6 group-data-[edge=right]/pet:left-auto group-data-[edge=right]/pet:translate-x-1/2',
  right: 'top-1/2 -left-1 -translate-y-1/2 border-b border-l',
  left: 'top-1/2 -right-1 -translate-y-1/2 border-t border-r'
}

function Bubble({ text, pet, wide, lean, compact, still }: { text: string; pet: PetBox; wide: boolean; lean: Lean; compact: boolean; still: boolean }) {
  const beside = Math.round(pet.width * 0.36)
  const head = Math.round(pet.height * 0.5)
  const place: CSSProperties = lean === 'right' ? { left: beside, bottom: head } : lean === 'left' ? { right: beside, bottom: head } : { bottom: Math.round(pet.height * BUBBLE_RISE) }

  return (
    <div className={cn('absolute', !lean && 'left-0 -translate-x-1/2 group-data-[edge=left]/pet:-left-6 group-data-[edge=left]/pet:translate-x-0 group-data-[edge=right]/pet:-right-6 group-data-[edge=right]/pet:left-auto group-data-[edge=right]/pet:translate-x-0')} style={place}>
      <div
        key={text}
        className={cn('float rounded-xl leading-snug text-fg', compact ? 'px-2 py-0.5 text-[10.5px]' : 'px-2.5 py-1 text-[11.5px]', wide ? 'w-max max-w-[240px]' : 'max-w-[200px] truncate whitespace-nowrap', !still && 'animate-pop')}
      >
        {text}
      </div>
      <span className={cn('absolute size-2 rotate-45 border-line-strong bg-bg-elevated', TAILS[lean ?? 'over'])} />
    </div>
  )
}

export interface AgentOverlayProps {
  agent: RoomAgent
  pet: PetBox
  facts: readonly RoomFact[]
  steps: boolean
  /** The name tag, facts, the words on its sign and Hermes's result summary; off for a screensaver. */
  names?: boolean
  /** Its button opens the conversation and its sign the approval card; off for a screensaver and for work outside Herald. */
  interactive?: boolean
  /** A token and cost meter under the name tag, when Hermes reported any; off unless the person turns meters on. */
  meters?: boolean
  marks: PetMarks | null
  still: boolean
  signOpen: boolean
  rootRef: (element: HTMLDivElement | null) => void
  onOpen: (agentId: string) => void
  onSign: (agentId: string) => void
  /** The approval card, when its sign is open. */
  children?: ReactNode
}

/** What stands with a pet: its button, name tag and facts, and above it a step bubble or a sign. */
export const AgentOverlay = memo(function AgentOverlay({ agent, pet, facts, steps, names = true, interactive = true, meters = false, marks, still, signOpen, rootRef, onOpen, onSign, children }: AgentOverlayProps) {
  const title = agentTitle(agent)
  const KindIcon = KIND_ICONS[agent.kind]
  const step = steps ? displayStep(agent.step) : null
  const said = names ? (marks?.bubble ?? null) : null
  const meter = meters && names ? meterOf(agent) : null
  // An approval waiting in a Hermes app outside Herald is answered there: its sign is never a button.
  const waitsThere = agent.kind === 'elsewhere' && agent.elsewhere?.approval ? agent.elsewhere.where : null
  const carried = marks?.carry ? CARRY[marks.carry] : null
  const hit = { width: Math.round(pet.width * 0.66), height: Math.round(pet.height * 0.8) }
  const overhead = Math.round(pet.height * BUBBLE_RISE)
  const widest = tagWidth(pet)
  const wall = wallOf(agent.area)
  const lean: Lean = wall === 'left' ? 'right' : wall === 'right' ? 'left' : null
  const compact = pet.height < COMPACT_PET
  const tooltip = [title, `${KIND_NAMES[agent.kind]} · ${doingText(agent)}`, ...facts.map(fact => fact.text)].join('\n')

  return (
    <div ref={rootRef} className="group/pet pointer-events-none absolute top-0 left-0">
      {interactive && (
        <button
          type="button"
          aria-label={agent.kind === 'automation' ? `Show ${title} in Automations` : `Open ${title} in Hermes`}
          title={tooltip}
          onClick={() => onOpen(agent.id)}
          className="pointer-events-auto absolute rounded-2xl transition-colors duration-150 hover:bg-white/6"
          style={{ left: -hit.width / 2, top: -hit.height - Math.round(pet.height * 0.04), width: hit.width, height: hit.height }}
        />
      )}
      {names && (
        <div className={cn('absolute top-1.5 left-0 flex -translate-x-1/2 flex-col items-center gap-0.5', !interactive && 'pointer-events-auto')} title={interactive ? undefined : tooltip}>
          <span className="flex items-center gap-1 rounded-full bg-bg-elevated px-2 py-0.5 text-[11px] leading-tight text-fg-2 hairline" style={{ maxWidth: widest }}>
            <KindIcon size={11} className="shrink-0 text-fg-3" />
            <span className="truncate">{title}</span>
          </span>
          {meter && (
            <span className="pointer-events-auto truncate rounded-md bg-bg-elevated/90 px-1.5 py-px text-[10px] leading-tight text-fg-3 tabular-nums" style={{ maxWidth: widest + 24 }} title={meter.title}>
              {meter.text}
            </span>
          )}
          {tagFacts(agent, facts, agent.approval || waitsThere ? null : (said ?? step)).slice(0, TAG_FACTS).map(fact => (
            <span key={`${fact.kind}:${fact.text}`} className="line-clamp-2 w-max rounded-md bg-black/25 px-1.5 py-px text-center text-[10.5px] leading-tight text-fg-3" style={{ maxWidth: widest + 24 }}>
              {fact.text}
            </span>
          ))}
        </div>
      )}
      {agent.approval ? (
        <div className="absolute left-0 flex -translate-x-1/2 flex-col items-center" style={{ bottom: overhead - 6 }}>
          {interactive ? (
            <button
              type="button"
              tabIndex={-1}
              data-room-sign={agent.id}
              aria-expanded={signOpen}
              aria-label={`${title} needs your OK`}
              onMouseDown={keepFocus}
              onClick={() => onSign(agent.id)}
              className={cn('pointer-events-auto flex items-center gap-1.5 rounded-lg border border-warn/50 bg-bg-elevated px-2.5 py-1 text-[11.5px] font-medium whitespace-nowrap text-warn shadow-float hover:bg-surface-3', !still && 'animate-pop')}
            >
              <IconHandStop size={13} />
              {names && 'Needs your OK'}
            </button>
          ) : (
            <span aria-hidden="true" className="flex items-center rounded-lg border border-warn/50 bg-bg-elevated px-1.5 py-1 text-warn shadow-float">
              <IconHandStop size={13} />
            </span>
          )}
          <span className="h-2 w-0.5 rounded-b bg-warn/50" />
        </div>
      ) : waitsThere ? (
        <div className="absolute left-0 flex -translate-x-1/2 flex-col items-center" style={{ bottom: overhead - 6 }}>
          <span
            aria-hidden={names ? undefined : true}
            title={names ? `Answer it in ${waitsThere}` : undefined}
            className={cn('flex items-center gap-1.5 rounded-lg border border-warn/50 bg-bg-elevated py-1 text-[11.5px] font-medium whitespace-nowrap text-warn shadow-float', names ? 'pointer-events-auto px-2.5' : 'px-1.5', !still && 'animate-pop')}
          >
            <IconHandStop size={13} />
            {names && `Needs your OK in ${waitsThere}`}
          </span>
          <span className="h-2 w-0.5 rounded-b bg-warn/50" />
        </div>
      ) : said ? (
        <Bubble text={said} pet={pet} wide lean={lean} compact={compact} still={still} />
      ) : step ? (
        <Bubble text={step} pet={pet} wide={false} lean={lean} compact={compact} still={still} />
      ) : null}
      {carried && (
        <span
          aria-hidden="true"
          className={cn('float absolute flex size-6 items-center justify-center rounded-full', carried.tone, !still && 'animate-pop')}
          style={{ left: Math.round(pet.width * 0.14), bottom: Math.round(pet.height * 0.4) }}
        >
          <carried.icon size={14} />
        </span>
      )}
      {children}
    </div>
  )
})
