import { $commandLog } from '../../store/os-commands.ts'
import { isMainSurface, isPanels, onShellCommand } from '../../store/shell.ts'
import { COMMAND_KEEP_MS, COMMANDS_KEPT, roomCommand } from './model/desks.ts'
import { DESK_AREAS, type RoomCommand, type RoomDeskArea } from './model/types.ts'

/*
 * Which agent ran an Office or Canvas command. Commands run in the Hermes window, and the bridge
 * sends the session whose tool asked; the Room keeps each agent command cut down to its session,
 * app and document name. In panels mode the Room and the screensaver are windows of their own, so
 * the Hermes window relays those (and only those) to them while they are open.
 */

const RELAY = 'room-command'
const RELAY_TARGETS = ['window:room', 'screensaver'] as const

/** A relayed command, checked field by field: it crossed a window boundary. */
export function relayedCommand(payload: unknown): RoomCommand | null {
  const raw = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const area = DESK_AREAS.find(entry => entry === raw.area) as RoomDeskArea | undefined
  const { id, command, sessionId, document, at } = raw

  if (!area || typeof id !== 'number' || typeof command !== 'string' || typeof sessionId !== 'string' || !sessionId || typeof at !== 'number') {
    return null
  }

  return { id, command, sessionId, area, document: typeof document === 'string' && document ? document : null, at }
}

/** The newest commands first, the ones still worth knowing. */
export function keepCommands(commands: readonly RoomCommand[], now: number): RoomCommand[] {
  const seen = new Set<number>()

  return [...commands]
    .sort((a, b) => b.at - a.at || b.id - a.id)
    .filter(command => now - command.at < COMMAND_KEEP_MS && !seen.has(command.id) && seen.add(command.id))
    .slice(0, COMMANDS_KEPT)
}

/** The Hermes window in panels mode: each new agent command goes to the Room's windows that are open, and never opens one. */
export function bindRoomCommandRelay(): () => void {
  if (!isPanels || !isMainSurface) {
    return () => undefined
  }

  let last = $commandLog.get()[0]?.id ?? 0

  return $commandLog.listen(log => {
    const fresh = log.filter(event => event.id > last).reverse()
    last = Math.max(last, log[0]?.id ?? 0)

    for (const event of fresh) {
      const command = roomCommand(event)

      if (command) {
        for (const target of RELAY_TARGETS) {
          void window.heraldOS.shell.relay(target, { type: RELAY, payload: { ...command }, ifOpen: true }).catch(() => undefined)
        }
      }
    }
  })
}

/** The agent commands this window can see, newest first, whenever they change: the shell's own log here, or what the Hermes window relays. */
export function watchRoomCommands(onChange: (commands: RoomCommand[]) => void): () => void {
  if (isMainSurface) {
    return $commandLog.subscribe(log => onChange(keepCommands(log.flatMap(event => roomCommand(event) ?? []), Date.now())))
  }

  let commands: RoomCommand[] = []

  return onShellCommand(shell => {
    const command = shell.type === RELAY ? relayedCommand(shell.payload) : null

    if (command) {
      commands = keepCommands([command, ...commands], Date.now())
      onChange(commands)
    }
  })
}
