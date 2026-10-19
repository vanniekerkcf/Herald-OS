import { describe, expect, it, vi } from 'vitest'
import type { ShellCommand } from '../../shared/ipc.ts'

vi.mock('electron', () => ({ BrowserWindow: class {}, ipcMain: {}, net: {}, screen: {}, session: {}, shell: {}, WebContentsView: class {} }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))

const { relayStep } = await import('./panels.ts')

const whileOpen: ShellCommand = { type: 'attribution', ifOpen: true }
const openApp: ShellCommand = { type: 'open-app', args: ['room'] }

describe('relaying a command to a surface', () => {
  it('drops a command meant only for an open window when that window is not open', () => {
    expect(relayStep(whileOpen, 'missing')).toBe('drop')
  })

  it('queues it for a window that is still loading and sends it to one that has loaded', () => {
    expect(relayStep(whileOpen, 'loading')).toBe('queue')
    expect(relayStep(whileOpen, 'loaded')).toBe('send')
  })

  it('opens the window for any other command', () => {
    expect(relayStep(openApp, 'missing')).toBe('open')
    expect(relayStep({ ...openApp, ifOpen: false }, 'missing')).toBe('open')
    expect(relayStep(openApp, 'loading')).toBe('queue')
    expect(relayStep(openApp, 'loaded')).toBe('send')
  })
})
