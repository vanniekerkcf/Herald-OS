import { describe, expect, it } from 'vitest'
import { clockText, dayBounds, dayClockText, dayKey, dayLabel, gapText, stretchesText } from './labels.ts'

describe('replay labels', () => {
  it('names the log days by local date', () => {
    expect(dayLabel('2026-10-15', '2026-10-15')).toBe('Today')
    expect(dayLabel('2026-10-14', '2026-10-15')).toBe('Yesterday')
    expect(dayLabel('2026-10-13', '2026-10-15')).toBe('Tue 13 Oct')
    expect(dayLabel('2025-12-30', '2026-01-02')).toBe('Tue 30 Dec 2025')
    expect(dayLabel('2025-12-31', '2026-01-01')).toBe('Yesterday')
  })

  it('reads a day key back as the bounds of that local day', () => {
    const bounds = dayBounds('2026-10-15')

    expect(bounds).toEqual({ start: new Date(2026, 9, 15).getTime(), end: new Date(2026, 9, 16).getTime() })
    expect(dayKey(bounds.start)).toBe('2026-10-15')
    expect(dayKey(bounds.end - 1)).toBe('2026-10-15')
    expect(dayKey(bounds.end)).toBe('2026-10-16')
  })

  it('says times of day on a 24-hour clock, the end of the day as 24:00', () => {
    const bounds = dayBounds('2026-10-15')

    expect(clockText(new Date(2026, 9, 15, 9, 5).getTime())).toBe('09:05')
    expect(dayClockText(bounds.end, bounds)).toBe('24:00')
    expect(dayClockText(bounds.start, bounds)).toBe('00:00')
  })

  it('says what a gap is and which stretches were logged', () => {
    const t = (hours: number, minutes: number) => new Date(2026, 9, 15, hours, minutes).getTime()

    expect(gapText({ from: t(12, 10), to: t(13, 45), after: null })).toBe('Nothing was logged from 12:10 to 13:45')
    expect(gapText({ from: null, to: t(9, 2), after: null })).toBe('Nothing was logged before 09:02')
    expect(gapText({ from: t(18, 30), to: null, after: null })).toBe('Nothing was logged after 18:30')
    expect(gapText({ from: t(15, 42), to: null, after: 'cap' })).toBe('The log was full from 15:42')
    expect(stretchesText([])).toBe('Nothing was logged this day.')
    expect(stretchesText([{ from: t(9, 2), to: t(12, 10), closed: 'end', first: 0, last: 1, elsewhere: false }, { from: t(13, 45), to: t(18, 30), closed: null, first: 2, last: 3, elsewhere: false }])).toBe('Logged from 09:02 to 12:10 and from 13:45 to 18:30.')
  })
})
