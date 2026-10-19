// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { keepCommands, relayedCommand } from './commands.ts'
import { COMMAND_KEEP_MS, COMMANDS_KEPT } from './model/desks.ts'
import type { RoomCommand } from './model/types.ts'

const T0 = 1_000_000

const command = (patch: Partial<RoomCommand> = {}): RoomCommand => ({ id: 1, command: 'docs.write', sessionId: 'live-1', area: 'docs', document: 'Launch plan.docx', at: T0, ...patch })

describe('a command relayed to the Room’s window', () => {
  it('is checked field by field', () => {
    expect(relayedCommand(command())).toEqual(command())
    expect(relayedCommand({ ...command(), document: 42 })).toEqual(command({ document: null }))
    expect(relayedCommand({ ...command(), area: 'terminal' })).toBeNull()
    expect(relayedCommand({ ...command(), sessionId: '' })).toBeNull()
    expect(relayedCommand({ ...command(), id: '1' })).toBeNull()
    expect(relayedCommand(null)).toBeNull()
  })
})

describe('the commands the Room keeps', () => {
  it('are the newest, recent ones, each once', () => {
    const kept = keepCommands([command({ id: 1, at: T0 }), command({ id: 2, at: T0 + 5 }), command({ id: 2, at: T0 + 5 }), command({ id: 3, at: T0 - COMMAND_KEEP_MS })], T0 + 10)

    expect(kept.map(entry => entry.id)).toEqual([2, 1])
  })

  it('stop at a few', () => {
    const many = Array.from({ length: COMMANDS_KEPT + 5 }, (_, index) => command({ id: index, at: T0 + index }))

    expect(keepCommands(many, T0 + COMMANDS_KEPT + 5)).toHaveLength(COMMANDS_KEPT)
  })
})
