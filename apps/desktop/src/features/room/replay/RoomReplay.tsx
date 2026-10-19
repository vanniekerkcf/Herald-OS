import { useStore } from '@nanostores/react'
import { IconArrowBackUp, IconClockPause, IconHistory, IconPaw, IconRefresh } from '@tabler/icons-react'
import { type KeyboardEvent, memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ROOM_LOG_DAY, type RoomLogDay, type RoomLogEntry } from '../../../../shared/room.ts'
import { AppTile } from '../../../components/app-icon.tsx'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { useDocumentVisible, useReducedMotion } from '../../pet/hooks.ts'
import { $petInfo } from '../../pet/info.ts'
import { MenuDropdown } from '../../settings/sections/shared.tsx'
import { roomBridge } from '../bridge.ts'
import type { RoomAgent, RoomFact, RoomHandoff } from '../model/types.ts'
import { $roomPrefs } from '../prefs.ts'
import { useRoomAssignment } from '../assignment.ts'
import { REPLAY_MS } from '../scene/choreography.ts'
import { RoomScene } from '../scene/RoomScene.tsx'
import { dayBounds, dayClockText, dayKey, dayLabel, gapText, REPLAY_LANE, type ReplaySpeed } from './labels.ts'
import { gapAt, handoffsIn, NO_CAST, NO_VIEWS, positionAt, type ReplayCast, replayAgents, replayFacts, replayHandoff, replayIndex, type RoomReplayIndex, sceneStretchAt, stretchAt, viewsAt } from './model.ts'
import { ReplayControls } from './ReplayControls.tsx'

/*
 * The time-lapse: a day of the activity log played back in the Pet Room's window. It only ever
 * reads the log; its pets stand for logged views, not live work, so none of them opens a
 * conversation or answers anything.
 */

type Load<T> = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; value: T }

interface ReplayDay {
  day: string
  index: RoomReplayIndex
  bounds: { start: number; end: number }
}

/** While playing, the clock moves about this often. */
const TICK_MS = 250
const NO_HANDOFFS: readonly RoomHandoff[] = []
const ignore = () => undefined
const ReplayScene = memo(RoomScene)

const factsMade = new WeakMap<RoomAgent, RoomFact[]>()

function factsFor(agent: RoomAgent): RoomFact[] {
  let facts = factsMade.get(agent)

  if (!facts) {
    facts = replayFacts(agent)
    factsMade.set(agent, facts)
  }

  return facts
}

/** A focused control that takes Space itself: a button presses, an option is picked, a field types it. */
function ownsSpace(target: EventTarget): boolean {
  if (target instanceof HTMLInputElement) {
    return target.type !== 'range'
  }

  return target instanceof Element && Boolean(target.closest('button, a[href], select, textarea, [role="option"], [contenteditable="true"]'))
}

const newestFirst = (a: RoomLogDay, b: RoomLogDay) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)

/** A card over the middle of the room: what the replay is waiting for, or why the Room is empty. */
function Notice({ icon = <IconHistory size={20} />, title, detail, onRetry }: { icon?: ReactNode; title: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
      <div className="glass-card pointer-events-auto flex max-w-sm flex-col items-center gap-2.5 rounded-2xl px-6 py-5 text-center">
        <span className="icon-tile size-10">{icon}</span>
        <div className="text-[13px] leading-snug text-fg-2">{title}</div>
        {detail && <div className="text-[12px] leading-snug text-fg-3">{detail}</div>}
        {onRetry && (
          <GlassButton size="sm" onClick={onRetry}>
            <IconRefresh />
            Try again
          </GlassButton>
        )}
      </div>
    </div>
  )
}

/**
 * The time-lapse in place of the live Room: `onExit` goes back to it (the Back to live button, or
 * Escape). `active` is false while its floating window is minimized, which pauses it as a hidden
 * document does.
 */
export function RoomReplay({ onExit, active = true }: { onExit: () => void; active?: boolean }) {
  const prefs = useStore($roomPrefs)
  const info = useStore($petInfo)
  const reduced = useReducedMotion()
  const visible = useDocumentVisible() && active
  const rootRef = useRef<HTMLDivElement>(null)
  const [days, setDays] = useState<Load<RoomLogDay[]>>({ status: 'loading' })
  const [daysAsked, setDaysAsked] = useState(0)
  const [day, setDay] = useState<string | null>(null)
  const [log, setLog] = useState<Load<ReplayDay>>({ status: 'loading' })
  const [logAsked, setLogAsked] = useState(0)
  const [t, setT] = useState(0)
  const tRef = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<ReplaySpeed>('60')
  const [handoffs, setHandoffs] = useState<readonly RoomHandoff[]>(NO_HANDOFFS)
  const castRef = useRef<ReplayCast>(NO_CAST)
  const today = dayKey(Date.now())

  const moveTo = useCallback((next: number) => {
    tRef.current = next
    setT(next)
  }, [])

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    let live = true
    const bridge = roomBridge()
    const request: Promise<RoomLogDay[]> = bridge ? bridge.logDays() : Promise.resolve([])
    setDays({ status: 'loading' })
    void request.then(
      list => {
        if (!live) {
          return
        }

        const logged = list.filter(entry => ROOM_LOG_DAY.test(entry.day)).sort(newestFirst)
        const now = dayKey(Date.now())
        setDays({ status: 'ready', value: logged })
        setDay(current => (current && logged.some(entry => entry.day === current) ? current : (logged.find(entry => entry.day === now) ?? logged[0])?.day ?? null))
      },
      () => {
        if (live) {
          setDays({ status: 'failed' })
        }
      }
    )

    return () => {
      live = false
    }
  }, [daysAsked])

  useEffect(() => {
    if (!day) {
      return
    }

    let live = true
    const bridge = roomBridge()
    const request: Promise<RoomLogEntry[]> = bridge ? bridge.readLog(day) : Promise.resolve([])
    setLog({ status: 'loading' })
    setPlaying(false)
    setHandoffs(NO_HANDOFFS)
    void request.then(
      entries => {
        if (!live) {
          return
        }

        const now = Date.now()
        // Today's log is still being kept: its last stretch runs until now though nothing changed lately.
        const index = replayIndex(entries, day === dayKey(now) && $roomPrefs.get().log ? now : undefined)
        const bounds = dayBounds(day)
        setLog({ status: 'ready', value: { day, index, bounds } })
        moveTo(Math.min(bounds.end, Math.max(bounds.start, index.stretches[0]?.from ?? bounds.start)))
      },
      () => {
        if (live) {
          setLog({ status: 'failed' })
        }
      }
    )

    return () => {
      live = false
    }
  }, [day, logAsked, moveTo])

  const ready = days.status === 'ready' && log.status === 'ready' ? log.value : null
  const index = ready?.index ?? null
  const end = index?.stretches.at(-1)?.to ?? null
  const position = index ? positionAt(index, t) : -1
  const gap = index ? gapAt(index, t) : null
  const stretch = index ? stretchAt(index, t) : -1
  const views = useMemo(() => (index ? viewsAt(index, position) : NO_VIEWS), [index, position])
  const cast = useMemo(() => {
    const next = replayAgents(views, castRef.current, Date.now())
    castRef.current = next

    return next
  }, [views])
  const facts = useMemo(() => Object.fromEntries(cast.list.map(agent => [agent.id, factsFor(agent)])), [cast])
  const assignment = useRoomAssignment(cast.list)
  const ownWork = cast.list.some(agent => agent.kind !== 'elsewhere' && !(agent.kind === 'automation' && agent.phase === 'idle'))
  const dayItems = useMemo(() => (days.status === 'ready' ? days.value.map(entry => ({ id: entry.day, label: dayLabel(entry.day, today) })) : []), [days, today])

  const seek = useCallback(
    (next: number) => {
      if (!ready) {
        return
      }

      moveTo(Math.min(ready.bounds.end, Math.max(ready.bounds.start, next)))
      setHandoffs(NO_HANDOFFS)
    },
    [ready, moveTo]
  )

  const togglePlay = useCallback(() => {
    if (!index || end === null) {
      return
    }

    if (playing) {
      setPlaying(false)

      return
    }

    if (tRef.current >= end) {
      seek(index.stretches[0].from)
    }

    setPlaying(true)
  }, [index, end, playing, seek])

  useEffect(() => {
    if (!playing || !visible || !index || end === null) {
      return
    }

    const rate = Number(speed)
    let last = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      const from = tRef.current

      if (from >= end) {
        setPlaying(false)

        return
      }

      const to = Math.min(end, from + (now - last) * rate)
      const fresh = handoffsIn(index, from, to).map(found => replayHandoff(found.index, found.entry, now))
      last = now
      setHandoffs(list => {
        const kept = list.filter(handoff => now - handoff.at < REPLAY_MS)

        return fresh.length || kept.length < list.length ? [...kept, ...fresh] : list
      })
      moveTo(to)

      if (to >= end) {
        setPlaying(false)
      }
    }, TICK_MS)

    return () => clearInterval(timer)
  }, [playing, visible, index, end, speed, moveTo])

  const pickDay = (next: string) => {
    if (next === day) {
      setLogAsked(asked => asked + 1)
    } else {
      setDay(next)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // An open day menu takes Escape for itself.
      if (rootRef.current?.querySelector('[role="listbox"]')) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      onExit()
    } else if (event.key === ' ' && !ownsSpace(event.target)) {
      event.preventDefault()

      if (!event.repeat) {
        togglePlay()
      }
    }
  }

  let content: ReactNode

  if (days.status === 'loading') {
    content = <Notice title="Reading the activity log…" />
  } else if (days.status === 'failed') {
    content = <Notice title="Could not read the activity log" onRetry={() => setDaysAsked(asked => asked + 1)} />
  } else if (!days.value.length) {
    content = <Notice title="The activity log has nothing yet" detail="Turn it on in Settings > Pet Room > Keep an activity log, and the time-lapse can play back a day of what the Room showed." />
  } else if (log.status === 'loading') {
    content = <Notice title="Reading the log…" />
  } else if (log.status === 'failed') {
    content = <Notice title="Could not read this day of the log" onRetry={() => setLogAsked(asked => asked + 1)} />
  } else {
    content = (
      <>
        <ReplayScene
          key={`${log.value.day}:${sceneStretchAt(log.value.index, t)}`}
          agents={cast.list}
          handoffs={handoffs}
          assignment={assignment}
          installed={info.installed}
          steps={prefs.steps}
          motion={reduced || !playing ? 'still' : prefs.motion}
          active={visible}
          settled={false}
          facts={facts}
          deskNames={false}
          lane={stretch >= 0 && log.value.index.stretches[stretch].elsewhere}
          laneText={REPLAY_LANE}
          names
          interactive={false}
          chrome={false}
          onOpen={ignore}
          onAnswer={ignore}
        />
        {gap ? <Notice icon={<IconClockPause size={20} />} title={gapText(gap)} /> : !ownWork && <Notice icon={<IconPaw size={20} />} title="No Hermes work in Herald at this time" />}
      </>
    )
  }

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} className="relative flex h-full w-full flex-col overflow-hidden text-fg outline-none">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
        <AppTile id="room" size={30} />
        <h1 className="shrink-0 text-[14px] leading-tight font-semibold text-fg">Time-lapse</h1>
        <Pill tone="accent">
          <IconHistory size={12} />
          Replay
        </Pill>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          {day && dayItems.length > 0 && <MenuDropdown label={dayLabel(day, today)} items={dayItems} value={day} onSelect={pickDay} ariaLabel="Day to replay" />}
          {ready && <span className="text-[13px] font-semibold text-fg tabular-nums">{dayClockText(t, ready.bounds)}</span>}
          <GlassButton size="sm" onClick={onExit}>
            <IconArrowBackUp />
            Back to live
          </GlassButton>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">{content}</div>
      {ready && <ReplayControls index={ready.index} bounds={ready.bounds} t={t} playing={playing} speed={speed} onToggle={togglePlay} onSeek={seek} onSpeed={setSpeed} />}
    </div>
  )
}
