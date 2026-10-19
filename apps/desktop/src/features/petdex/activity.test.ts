import { describe, expect, it } from 'vitest'
import * as petSheet from '../pet/sheet.ts'
import * as petSprite from '../pet/sprite.ts'
import * as petState from '../pet/state.ts'
import * as activity from './activity.ts'
import * as sheet from './sheet.ts'
import * as sprite from './sprite.ts'

describe('the desktop pet’s own modules', () => {
  it('hand out the shared sprite, sheet and activity functions themselves', () => {
    expect(Object.keys(petSprite).sort()).toEqual(Object.keys(sprite).sort())
    Object.entries(sprite).forEach(([name, value]) => expect(petSprite[name as keyof typeof petSprite]).toBe(value))
    Object.entries(sheet).forEach(([name, value]) => expect(petSheet[name as keyof typeof petSheet]).toBe(value))
    expect(Object.keys(petState).sort()).toEqual(['PET_BEATS', 'derivePetActivity', 'nextBeatEnd', 'stepOf', 'turnEndOf', 'turnErrorOf'])
    Object.entries(petState).forEach(([name, value]) => expect(activity[name as keyof typeof activity]).toBe(value))
  })
})

describe('toolStep', () => {
  it('names Hermes’s own tools from a fixed table, whatever their arguments say', () => {
    expect(activity.toolStep('terminal', { command: 'rm -rf /tmp/pet-test' })).toBe('Running a command')
    expect(activity.toolStep('read_file', { path: '/tmp/pet-test/Budget.xlsx' })).toBe('Reading a file')
    expect(activity.toolStep('delegate_task', { goal: 'anything at all' })).toBe('Delegating work')
    expect(Object.values(activity.TOOL_STEPS).every(label => /^[A-Z][a-z]+ [a-z ]+$/.test(label))).toBe(true)
  })

  it('names a tool it does not know by its name, never by a name on the object prototype', () => {
    expect(activity.toolStep('some_new_tool')).toBe('Using some new tool')
    expect(activity.toolStep('constructor')).toBe('Using constructor')
  })
})
