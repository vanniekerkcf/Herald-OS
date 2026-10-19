import type { RoomReplayGap, RoomReplayStretch } from './model.ts'

/*
 * Every word the time-lapse says about time, from fixed tables. The log's days are local dates, and
 * times are said on a 24-hour clock.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad = (value: number): string => String(value).padStart(2, '0')

/** The local date `t` falls on, as the log names its days (YYYY-MM-DD). */
export function dayKey(t: number): string {
  const date = new Date(t)

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** When a day of the log starts and ends, local time: a day with a clock change runs 23 or 25 hours. */
export function dayBounds(day: string): { start: number; end: number } {
  const [year, month, date] = day.split('-').map(Number)

  return { start: new Date(year, month - 1, date).getTime(), end: new Date(year, month - 1, date + 1).getTime() }
}

/** 'Today', 'Yesterday' or 'Tue 14 Oct', with the year when it is not this year's. */
export function dayLabel(day: string, today: string): string {
  if (day === today) {
    return 'Today'
  }

  if (day === dayKey(dayBounds(today).start - 1)) {
    return 'Yesterday'
  }

  const date = new Date(dayBounds(day).start)
  const label = `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`

  return day.slice(0, 4) === today.slice(0, 4) ? label : `${label} ${date.getFullYear()}`
}

/** A time of day as the time-lapse says it: 14:05. */
export function clockText(t: number): string {
  const date = new Date(t)

  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The replayed time within its day, the day's own end being 24:00. */
export const dayClockText = (t: number, bounds: { end: number }): string => (t >= bounds.end ? '24:00' : clockText(t))

/** What a gap says: plainly that nothing was logged, and when. */
export function gapText(gap: RoomReplayGap): string {
  if (gap.after === 'cap' && gap.from !== null) {
    return gap.to === null ? `The log was full from ${clockText(gap.from)}` : `The log was full from ${clockText(gap.from)} to ${clockText(gap.to)}`
  }

  if (gap.from === null) {
    return gap.to === null ? 'Nothing was logged this day' : `Nothing was logged before ${clockText(gap.to)}`
  }

  return gap.to === null ? `Nothing was logged after ${clockText(gap.from)}` : `Nothing was logged from ${clockText(gap.from)} to ${clockText(gap.to)}`
}

/** The logged stretches of a day in one sentence, for screen readers. */
export function stretchesText(stretches: readonly RoomReplayStretch[]): string {
  if (!stretches.length) {
    return 'Nothing was logged this day.'
  }

  const spans = stretches.map(stretch => `from ${clockText(stretch.from)} to ${clockText(stretch.to)}`)
  const list = spans.length < 2 ? spans[0] : `${spans.slice(0, -1).join(', ')} and ${spans[spans.length - 1]}`

  return `Logged ${list}.`
}

/** The lane in a replay shows what the log kept of work outside Herald, not what Hermes reports now. */
export const REPLAY_LANE = {
  note: 'As the Room showed it then',
  about: 'Hermes work outside Herald as the Room showed it at this time, from the activity log: where it ran and its steps, never titles.',
  empty: 'No Hermes work outside Herald at this time.'
}

export type ReplaySpeed = '60' | '300' | '900' | '3600'

/** Log time per second of watching. */
export const REPLAY_SPEEDS: readonly { id: ReplaySpeed; label: string }[] = [
  { id: '60', label: '1 min/s' },
  { id: '300', label: '5 min/s' },
  { id: '900', label: '15 min/s' },
  { id: '3600', label: '1 h/s' }
]
