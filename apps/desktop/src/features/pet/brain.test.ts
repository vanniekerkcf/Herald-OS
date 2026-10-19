import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatState } from '../../lib/chat-model.ts'
import type { CommandEvent } from '../../store/os-commands.ts'
import { $pendingRequests, type PendingRequest } from '../../store/requests.ts'
import { answerApproval, approvalOf, chatSignals, composePetSnapshot, followAlive, followFrom, handlePetAction, turnStart } from './brain.ts'

// The stores read the preload bridge and the viewport when they load; tests run without a DOM.
vi.hoisted(() => {
  Object.assign(globalThis, { window: { innerWidth: 1440, innerHeight: 900 } })
})

function chat(sessionId: string, messages: ChatMessage[], streaming: boolean, openAssistantId: string | null = null): ChatState {
  return { sessionId, storedSessionId: `stored-${sessionId}`, title: sessionId, messages, streaming, info: {}, openAssistantId, hydrating: false }
}

const user = (id: string, text = 'hi'): ChatMessage => ({ id, role: 'user', text, ts: 1 })
const tool = (id: string, running: boolean): ChatMessage => ({ id, role: 'tool', toolId: id, name: 'terminal', args: {}, running, ts: 2 })
const thinking = (id: string): ChatMessage => ({ id, role: 'assistant', text: '', reasoning: 'Weighing it up', streaming: true, ts: 3 })

function approval(id: string, params: Record<string, unknown> = {}): PendingRequest & { respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn()

  return { kind: 'approval', receivedAt: 1, respond, request: { id, method: 'approval', params: { session_id: 's1', request_id: id, description: 'Delete /tmp/pet-test/a.txt', command: 'rm /tmp/pet-test/a.txt', ...params }, respond } } as never
}

function clarify(id: string): PendingRequest & { respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn()

  return { kind: 'clarify', receivedAt: 1, respond, request: { id, method: 'clarify', params: { session_id: 's1', request_id: id, question: 'Which one?' }, respond } } as never
}

function agentEvent(command: string, args: Record<string, unknown>, extra: Partial<CommandEvent> = {}): CommandEvent {
  return { id: 1, command, args, source: 'agent', result: { ok: true, summary: 'done' }, ts: 1000, session: null, ...extra }
}

describe('the pet answers approvals', () => {
  beforeEach(() => $pendingRequests.set([]))
  afterEach(() => $pendingRequests.set([]))

  it('answers a pending approval with the choice the person picked', () => {
    const entry = approval('r1')
    $pendingRequests.set([entry])

    expect(answerApproval('r1', 'deny')).toBe(true)
    expect(entry.respond).toHaveBeenCalledWith({ choice: 'deny' })
    expect($pendingRequests.get()).toEqual([])
  })

  it('ignores ids that are not pending, and requests that are not approvals', () => {
    const question = clarify('q1')
    $pendingRequests.set([question])

    expect(answerApproval('r9', 'once')).toBe(false)
    expect(answerApproval('q1', 'once')).toBe(false)
    expect(question.respond).not.toHaveBeenCalled()
    expect($pendingRequests.get()).toHaveLength(1)
  })

  it('refuses choices the card does not offer', () => {
    const entry = approval('r1', { choices: ['once', 'session', 'always', 'deny'], allow_permanent: false })
    $pendingRequests.set([entry])

    expect(answerApproval('r1', 'always')).toBe(false)
    expect(answerApproval('r1', 'forever')).toBe(false)
    expect(answerApproval('r1', 7)).toBe(false)
    expect(entry.respond).not.toHaveBeenCalled()
    expect(answerApproval('r1', 'session')).toBe(true)
  })

  it('never answers on its own: working out what to show leaves the request waiting', () => {
    const entry = approval('r1')
    $pendingRequests.set([entry])
    const snapshot = composePetSnapshot(Date.now())

    expect(snapshot.activity).toBe('waiting')
    expect(snapshot.approval?.id).toBe('r1')
    expect(entry.respond).not.toHaveBeenCalled()
    expect($pendingRequests.get()).toHaveLength(1)
  })

  it('takes answers only through a well-formed answer action', () => {
    const entry = approval('r1')
    $pendingRequests.set([entry])

    handlePetAction({ type: 'ask', text: 'yes' } as never)
    handlePetAction({ type: 'answer', id: 'r1' } as never)
    handlePetAction(null as never)
    expect(entry.respond).not.toHaveBeenCalled()

    handlePetAction({ type: 'answer', id: 'r1', choice: 'once' })
    expect(entry.respond).toHaveBeenCalledWith({ choice: 'once' })
  })
})

describe('the approval the pet holds up', () => {
  it('is the oldest approval, with only what the card shows', () => {
    const first = approval('r1', { smart_denied: true, secret: 'never shown' })
    const result = approvalOf([clarify('q1'), first, approval('r2')], { active: false, sessionId: null })

    expect(result.approval?.id).toBe('r1')
    expect(Object.keys(result.approval!.params).sort()).toEqual(['allow_permanent', 'allow_session', 'choices', 'command', 'description', 'tool_name'])
    expect(result.waiting).toBe(1)
  })

  it('says when a spoken yes or no answers it', () => {
    expect(approvalOf([approval('r1')], { active: true, sessionId: 's1' }).approval?.voice).toBe(true)
    expect(approvalOf([approval('r1')], { active: true, sessionId: 'other' }).approval?.voice).toBe(false)
    expect(approvalOf([approval('r1')], { active: false, sessionId: 's1' }).approval?.voice).toBe(false)
  })

  it('is nothing without approvals', () => {
    expect(approvalOf([clarify('q1')], { active: false, sessionId: null })).toEqual({ approval: null, waiting: 0 })
  })
})

describe('what Hermes is doing', () => {
  it('starts a turn at the person’s last message', () => {
    expect(turnStart([user('u1'), tool('t1', false), user('u2'), tool('t2', true)])).toBe(2)
    expect(turnStart([])).toBe(0)
  })

  it('runs while a tool of the current turn runs, and thinks while it reasons', () => {
    const running = chatSignals([chat('a', [user('u1'), tool('t1', true)], true)], [])
    expect(running).toMatchObject({ working: true, toolRunning: true, reasoning: false })

    const reasoning = chatSignals([chat('a', [user('u1'), thinking('m1')], true, 'm1')], [])
    expect(reasoning).toMatchObject({ working: true, toolRunning: false, reasoning: true })

    expect(chatSignals([chat('a', [user('u1'), tool('t1', true)], false)], [])).toMatchObject({ working: false, focus: null })
  })

  it('reports on its own chat first, and counts the turns nobody is looking at', () => {
    const chats = [chat('other', [user('u'), tool('t', true)], true), chat('pet', [user('u')], true), chat('front', [user('u')], true)]
    const signals = chatSignals(chats, ['pet', 'front'])

    expect(signals.focus?.sessionId).toBe('pet')
    expect(signals.toolRunning).toBe(false)
    expect(signals.background).toBe(1)
  })
})

describe('following Hermes to its window', () => {
  it('follows Hermes’s own Office and Canvas commands, with the document they name', () => {
    expect(followFrom(agentEvent('docs.write', { document: '/Users/me/Documents/Q3 report.docx', text: 'x' }))).toEqual({ app: 'docs', document: 'Q3 report.docx', at: 1000 })
    expect(followFrom(agentEvent('canvas.addLayer', {}))).toEqual({ app: 'canvas', document: null, at: 1000 })
    expect(followFrom(agentEvent('slides.addSlide', { presentation: 'Pitch' }))?.document).toBe('Pitch')
  })

  it('ignores the person’s commands, failures, listings and other apps', () => {
    expect(followFrom(agentEvent('docs.write', {}, { source: 'palette' }))).toBeNull()
    expect(followFrom(agentEvent('docs.write', {}, { result: { ok: false, summary: 'no' } }))).toBeNull()
    expect(followFrom(agentEvent('docs.list', {}))).toBeNull()
    expect(followFrom(agentEvent('canvas.status', {}))).toBeNull()
    expect(followFrom(agentEvent('page.open', { name: 'files' }))).toBeNull()
    expect(followFrom(undefined)).toBeNull()
  })

  it('stays a while after the last command, longer while a turn runs', () => {
    const follow = { app: 'docs' as const, document: null, at: 0 }

    expect(followAlive(follow, 10_000, false)).toBe(true)
    expect(followAlive(follow, 30_000, false)).toBe(false)
    expect(followAlive(follow, 30_000, true)).toBe(true)
    expect(followAlive(null, 0, true)).toBe(false)
  })
})
