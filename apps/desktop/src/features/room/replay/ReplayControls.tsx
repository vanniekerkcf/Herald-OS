import { IconPlayerPause, IconPlayerPlay, IconPlayerSkipBack, IconPlayerSkipForward } from '@tabler/icons-react'
import { type KeyboardEvent, useId } from 'react'
import { Chips, GlassButton } from '../../../components/ui/glass.tsx'
import { dayClockText, REPLAY_SPEEDS, type ReplaySpeed, stretchesText } from './labels.ts'
import { gapAt, type RoomReplayIndex, stretchStartAfter, stretchStartBefore } from './model.ts'

const MINUTE = 60_000

/** Minutes a key moves the scrubber; Shift makes a minute fifteen. */
const KEY_MINUTES: Partial<Record<string, number>> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -60, PageUp: 60 }

const HOURS = ['00:00', '06:00', '12:00', '18:00', '24:00']

export interface ReplayControlsProps {
  index: RoomReplayIndex
  bounds: { start: number; end: number }
  t: number
  playing: boolean
  speed: ReplaySpeed
  onToggle: () => void
  onSeek: (t: number) => void
  onSpeed: (speed: ReplaySpeed) => void
}

/** Play and pause, the speeds, the previous and next stretch, and a scrubber across the day over a bar of what was logged. */
export function ReplayControls({ index, bounds, t, playing, speed, onToggle, onSeek, onSpeed }: ReplayControlsProps) {
  const described = useId()
  const minutes = Math.round((bounds.end - bounds.start) / MINUTE)
  const value = Math.min(minutes, Math.max(0, Math.floor((t - bounds.start) / MINUTE)))
  const clock = dayClockText(t, bounds)
  const before = stretchStartBefore(index, t)
  const after = stretchStartAfter(index, t)
  const share = (time: number) => Math.min(100, Math.max(0, ((time - bounds.start) / (bounds.end - bounds.start)) * 100))
  const speedLabel = REPLAY_SPEEDS.find(entry => entry.id === speed)?.label ?? ''

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const step = KEY_MINUTES[event.key]

    if (step === undefined || event.altKey || event.ctrlKey || event.metaKey) {
      return
    }

    event.preventDefault()
    onSeek(t + (event.shiftKey && Math.abs(step) === 1 ? step * 15 : step) * MINUTE)
  }

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-line px-4 py-2.5">
      <div className="flex flex-col gap-1">
        <input
          type="range"
          min={0}
          max={minutes}
          step={1}
          value={value}
          aria-label="Time of day"
          aria-valuetext={gapAt(index, t) ? `${clock}, nothing logged` : clock}
          aria-describedby={described}
          onChange={event => onSeek(bounds.start + Number(event.target.value) * MINUTE)}
          onKeyDown={onKeyDown}
          className="w-full accent-accent"
        />
        <div aria-hidden="true" className="relative h-1.5 overflow-hidden rounded-full bg-white/6">
          {index.stretches.map(stretch => (
            <span key={stretch.first} className="absolute inset-y-0 rounded-full bg-accent/70" style={{ left: `${share(stretch.from)}%`, width: `${share(stretch.to) - share(stretch.from)}%`, minWidth: 2 }} />
          ))}
        </div>
        <div aria-hidden="true" className="flex justify-between text-[10.5px] text-fg-4 tabular-nums">
          {HOURS.map(hour => (
            <span key={hour}>{hour}</span>
          ))}
        </div>
        <span id={described} className="sr-only">
          {stretchesText(index.stretches)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <GlassButton size="icon" variant="ghost" aria-label="Previous logged stretch" title="Previous logged stretch" disabled={before === null} onClick={() => before !== null && onSeek(before)}>
          <IconPlayerSkipBack />
        </GlassButton>
        <GlassButton size="icon" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'} disabled={!index.stretches.length} onClick={onToggle}>
          {playing ? <IconPlayerPause /> : <IconPlayerPlay />}
        </GlassButton>
        <GlassButton size="icon" variant="ghost" aria-label="Next logged stretch" title="Next logged stretch" disabled={after === null} onClick={() => after !== null && onSeek(after)}>
          <IconPlayerSkipForward />
        </GlassButton>
        <span className="ml-1 min-w-11 text-[13px] font-semibold text-fg tabular-nums">{clock}</span>
        <div role="group" aria-label={`Speed: ${speedLabel}`} className="ml-auto">
          <Chips items={REPLAY_SPEEDS} value={speed} onChange={onSpeed} />
        </div>
      </div>
    </div>
  )
}
