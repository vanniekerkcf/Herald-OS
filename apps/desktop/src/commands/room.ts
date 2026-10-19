import { type RoomSummary, summarizeRoom } from '../features/room/model/summary.ts'
import { refreshRoomOnce } from '../features/room/store.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { openApp } from '../store/windows.ts'

/* The Pet Room: opening it, and what it shows now, read out from the Room's own fixed labels. */

const QUIET = 'Nothing is at work in the Pet Room right now'
/** More agents than this are counted, not read out one by one. */
const MAX_LINES = 6

const counted = (n: number, one: string, other: string): string => `${n} ${n === 1 ? one : other}`

const listed = (parts: string[]): string => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? ''))

/** Work outside Herald, when the elsewhere lane is on: read out after the Room's own, apart from it. */
function elsewhereText(lines: readonly string[]): string {
  const shown = lines.slice(0, MAX_LINES)
  const text = `Outside Herald: ${shown.join('. ')}`

  return lines.length > shown.length ? `${text}, and ${lines.length - shown.length} more` : text
}

/** What the Room shows, as sentences Hermes can read out: the counts, then a line per agent. */
export function describeRoom(summary: RoomSummary): string {
  const own = summary.lines.slice(0, summary.total)
  const away = summary.lines.slice(summary.total)

  if (summary.working + summary.waiting === 0) {
    return away.length ? `${QUIET}. ${elsewhereText(away)}` : QUIET
  }

  const helpers = summary.helpers ? `, ${counted(summary.helpers, 'of them a helper', 'of them helpers')}` : ''
  const automations = summary.automations ? `, ${counted(summary.automations, 'of them an automation', 'of them automations')}` : ''
  const counts = [summary.working && `${summary.working} at work`, summary.waiting && `${summary.waiting} waiting for you`, summary.idle && `${summary.idle} idle`].filter((part): part is string => Boolean(part))
  const shown = own.slice(0, MAX_LINES)
  const text = [`${counted(summary.total, 'agent', 'agents')} in the Pet Room${helpers}${automations}: ${listed(counts)}`, ...shown].join('. ')
  const room = own.length > shown.length ? `${text}, and ${own.length - shown.length} more` : text

  return away.length ? `${room}. ${elsewhereText(away)}` : room
}

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const roomCommands: readonly OsCommand[] = [
  {
    id: 'room.open',
    title: 'Open the Pet Room',
    description: 'Open the Pet Room: every conversation, mission, helper and automation Hermes is working on stands there as a pet, at the tool it uses, holding up what waits for the person.',
    tier: 'read',
    args: [],
    phrases: ['open the pet room', 'show the pet room', 'show me the pet room', 'open the room', 'show the room', 'show what hermes is doing', 'show me what hermes is doing'],
    run: () => {
      const id = openApp('room')

      return ok('Opened the Pet Room', { spoken: 'Opening the Pet Room.', highlight: { kind: 'window', id } })
    }
  },
  {
    id: 'room.status',
    title: 'What the Pet Room shows',
    description:
      'What the Pet Room shows now: how many agents are at work, waiting for the person or idle, and a line for each from the Room’s fixed labels ("Budget review (mission): reading Budget.xlsx"). Titles and step labels only, never what a conversation says.',
    tier: 'read',
    args: [],
    phrases: ['what is hermes doing', 'what is in the pet room', 'whats in the pet room', 'what is happening in the pet room', 'pet room status'],
    run: async () => {
      let summary: RoomSummary

      try {
        summary = summarizeRoom(await refreshRoomOnce(), Date.now())
      } catch (error) {
        return fail(`Could not look at Hermes's work: ${errorOf(error)}`)
      }

      const { total, working, waiting, idle, helpers, automations, elsewhere, lines } = summary

      return ok(describeRoom(summary), { data: { total, working, waiting, idle, helpers, automations, elsewhere, lines } })
    }
  }
]
