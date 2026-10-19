import type { RoomPhase } from './types.ts'

/** A pet's bubble for its phase, from the fixed table; a running tool says what it does. */
export function stepOf(phase: RoomPhase, details: { approval: boolean; toolStep: string | null }): string | null {
  switch (phase) {
    case 'thinking':
      return 'thinking'
    case 'starting':
      return 'getting ready'
    case 'waiting':
      return details.approval ? 'waiting for your OK' : 'waiting for you in Hermes'
    case 'queued':
      return 'waiting to start'
    case 'tool':
      return details.toolStep ?? 'using a tool'
    case 'idle':
    case 'finished':
      return null
  }
}
