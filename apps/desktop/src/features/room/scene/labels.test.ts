import { describe, expect, it } from 'vitest'
import type { RoomAgent, RoomApproval, RoomCaps, RoomFact } from '../model/types.ts'
import { agentLine, agentTitle, BUBBLE_CHARS, bubbleText, capsNotice, countsOf, displayStep, doingText, laneWords, roomNotices, sameFacts, tagFacts } from './labels.ts'

function agent(patch: Partial<RoomAgent> = {}): RoomAgent {
  return {
    id: 's:1',
    kind: 'conversation',
    sessionId: '1',
    sessionKey: null,
    title: '',
    parentId: null,
    phase: 'idle',
    area: 'lounge',
    target: null,
    step: null,
    tool: null,
    startedAt: null,
    turnStartedAt: null,
    lastEventAt: 0,
    approval: null,
    asking: null,
    repeat: null,
    guardrail: null,
    result: null,
    toolCount: null,
    desk: null,
    automation: null,
    elsewhere: null,
    usage: null,
    trace: {},
    ...patch
  }
}

const approval: RoomApproval = {
  requestId: 'r1',
  rpcId: null,
  sessionId: '1',
  params: { description: null, command: null, tool_name: null, choices: null, allow_permanent: null, allow_session: null }
}

const ALL_CAPS: RoomCaps = { activeList: true, eventsSince: true, delegation: true, config: true, automations: true, sessionsDb: true }

describe('agentTitle', () => {
  it('uses the title Hermes gave, trimmed', () => {
    expect(agentTitle(agent({ title: '  Budget review ' }))).toBe('Budget review')
  })

  it('says what it is while Hermes has not named it', () => {
    expect(agentTitle(agent({ kind: 'conversation' }))).toBe('A conversation')
    expect(agentTitle(agent({ kind: 'mission', title: '   ' }))).toBe('A mission')
    expect(agentTitle(agent({ kind: 'helper' }))).toBe('A helper')
  })
})

describe('displayStep', () => {
  it('capitalises the first letter of a step label', () => {
    expect(displayStep('reading Budget.xlsx')).toBe('Reading Budget.xlsx')
    expect(displayStep('  running a command')).toBe('Running a command')
  })

  it('has nothing to say for no step', () => {
    expect(displayStep(null)).toBeNull()
    expect(displayStep('   ')).toBeNull()
  })
})

describe('bubbleText', () => {
  it('keeps a short summary as it is, on one line', () => {
    expect(bubbleText('Found three\n  budget files')).toBe('Found three budget files')
  })

  it('cuts a long one at a word, under the bubble size, with an ellipsis', () => {
    const long = 'Compared the quarterly budget against last year and found that travel and software spending both grew by more than expected'
    const text = bubbleText(long)!

    expect(Array.from(text).length).toBeLessThanOrEqual(BUBBLE_CHARS)
    expect(text.endsWith('…')).toBe(true)
    expect(long.startsWith(text.slice(0, -1))).toBe(true)
    expect(text.slice(0, -1).endsWith(' ')).toBe(false)
  })

  it('cuts one long word where it has to, without splitting a character', () => {
    expect(bubbleText('a'.repeat(200), 10)).toBe(`${'a'.repeat(9)}…`)
    expect(Array.from(bubbleText('🙂'.repeat(100), 10)!)).toHaveLength(10)
  })

  it('has nothing to say for no summary', () => {
    expect(bubbleText(null)).toBeNull()
    expect(bubbleText(' \n ')).toBeNull()
  })
})

describe('doingText', () => {
  it('says the step when there is one, else what the phase is', () => {
    expect(doingText(agent({ phase: 'tool', step: 'reading Budget.xlsx' }))).toBe('reading Budget.xlsx')
    expect(doingText(agent({ phase: 'tool' }))).toBe('running a tool')
    expect(doingText(agent({ phase: 'idle' }))).toBe('resting')
  })

  it('says a pet waits for an OK over anything else', () => {
    expect(doingText(agent({ phase: 'waiting', step: 'running a command', approval }))).toBe('waiting for your OK')
  })

  it('says how a helper finished, from its result', () => {
    const result = { summary: null, durationSeconds: null, filesRead: null, filesWritten: null, inputTokens: null, outputTokens: null, reasoningTokens: null, apiCalls: null, costUsd: null, at: 1 }

    expect(doingText(agent({ phase: 'finished', result: { ...result, status: 'completed' } }))).toBe('finished')
    expect(doingText(agent({ phase: 'finished', result: { ...result, status: 'timeout' } }))).toBe('timed out')
    expect(doingText(agent({ phase: 'finished' }))).toBe('finished')
  })
})

describe('agentLine', () => {
  it('reads who, what and the facts as one line', () => {
    const facts: RoomFact[] = [{ kind: 'quiet', text: 'quiet for 4 minutes during a turn', trace: null }]

    expect(agentLine(agent({ title: 'Budget review', phase: 'thinking' }), facts)).toBe('Budget review: thinking. quiet for 4 minutes during a turn.')
    expect(agentLine(agent({ kind: 'helper' }), [])).toBe('A helper: resting.')
  })

  it('does not say the same thing twice', () => {
    const facts: RoomFact[] = [{ kind: 'waiting', text: 'waiting for your OK', trace: null }]

    expect(agentLine(agent({ title: 'Cleanup', phase: 'waiting', approval }), facts)).toBe('Cleanup: waiting for your OK.')
  })
})

describe('sameFacts', () => {
  it('compares what facts say, not the records behind them', () => {
    const trace = { source: 'frame' as const, type: 'tool.start', at: 1 }
    const a: RoomFact[] = [{ kind: 'quiet', text: 'quiet for 4 minutes during a turn', trace }]

    expect(sameFacts(a, [{ ...a[0], trace: { ...trace, at: 2 } }])).toBe(true)
    expect(sameFacts(a, [{ ...a[0], text: 'quiet for 5 minutes during a turn' }])).toBe(false)
    expect(sameFacts(a, [])).toBe(false)
  })
})

describe('tagFacts', () => {
  const facts: RoomFact[] = [
    { kind: 'waiting', text: 'waiting for your OK', trace: null },
    { kind: 'repeat', text: 'same call 3 times', trace: null }
  ]

  it('leaves out the approval fact the sign already shows', () => {
    expect(tagFacts({ approval }, facts, null).map(fact => fact.kind)).toEqual(['repeat'])
    expect(tagFacts({ approval: null }, facts, null)).toHaveLength(2)
  })

  it('leaves out a fact the bubble over the pet already says', () => {
    const asking: RoomFact[] = [{ kind: 'asking', text: 'waiting for you in Hermes', trace: null }]

    expect(tagFacts({ approval: null }, asking, 'Waiting for you in Hermes')).toEqual([])
    expect(tagFacts({ approval: null }, asking, null)).toHaveLength(1)
  })
})

describe('countsOf', () => {
  it('counts what is under way, leaving out what is not', () => {
    expect(countsOf({ working: 2, waiting: 1, idle: 3, helpers: 1, automations: 0, elsewhere: 0 })).toEqual([
      { id: 'working', text: '2 working' },
      { id: 'waiting', text: '1 waiting for you' },
      { id: 'idle', text: '3 idle' },
      { id: 'helpers', text: '1 helper' }
    ])
    expect(countsOf({ working: 0, waiting: 0, idle: 4, helpers: 2, automations: 0, elsewhere: 0 })).toEqual([
      { id: 'idle', text: '4 idle' },
      { id: 'helpers', text: '2 helpers' }
    ])
    expect(countsOf({ working: 0, waiting: 0, idle: 0, helpers: 0, automations: 0, elsewhere: 0 })).toEqual([])
  })
})

describe('capsNotice', () => {
  it('says nothing when this Hermes answers everything', () => {
    expect(capsNotice(ALL_CAPS)).toBeNull()
  })

  it('names what this Hermes cannot list yet', () => {
    expect(capsNotice({ ...ALL_CAPS, delegation: false })).toBe('This Hermes cannot list its helpers yet: update Hermes')
    expect(capsNotice({ ...ALL_CAPS, activeList: false, delegation: false, config: false })).toBe('This Hermes cannot list its running sessions, its helpers or its settings yet: update Hermes')
    expect(capsNotice({ ...ALL_CAPS, automations: false, sessionsDb: false })).toBe('This Hermes cannot list its automations or its sessions outside Herald yet: update Hermes')
  })
})

describe('roomNotices', () => {
  it('has none when Hermes is connected, shows tools and pets are installed', () => {
    expect(roomNotices({ connected: true, state: { toolProgress: 'all', caps: ALL_CAPS }, pets: 2 })).toEqual([])
  })

  it('says what keeps the Room from showing everything, in a fixed order', () => {
    const notices = roomNotices({ connected: false, state: { toolProgress: 'off', caps: { ...ALL_CAPS, eventsSince: false } }, pets: 0 })

    expect(notices.map(notice => notice.id)).toEqual(['offline', 'toolProgress', 'caps', 'noPets'])
    expect(notices[0].text).toBe('Hermes is not connected')
    expect(notices[1].text).toBe("Hermes's tool progress is off, so pets cannot show their tools")
    expect(notices[3].text).toContain('Settings > Pet')
  })

  it('does not call an unknown tool progress off', () => {
    expect(roomNotices({ connected: true, state: { toolProgress: null, caps: ALL_CAPS }, pets: 1 })).toEqual([])
  })
})

describe('work outside Herald', () => {
  const waiting = agent({ id: 'e:tg1', kind: 'elsewhere', phase: 'waiting', step: 'waiting for your OK in Telegram', elsewhere: { where: 'Telegram', active: true, lastActiveAt: 1, approval: true, liveAt: 1 } })

  it('names a helper outside Herald that has no title', () => {
    expect(agentTitle(agent({ kind: 'elsewhere', parentId: 'e:tg1' }))).toBe('A helper outside Herald')
    expect(agentTitle(agent({ kind: 'elsewhere' }))).toBe('A Hermes session')
    expect(agentTitle(agent({ kind: 'helper', parentId: 's:1' }))).toBe('A helper')
  })

  it('says where an approval waits, and leaves it off the tag its sign already says', () => {
    const facts: RoomFact[] = [
      { kind: 'waiting', text: 'waiting for your OK in Telegram', trace: null },
      { kind: 'activity', text: 'Telegram · active now', trace: null }
    ]

    expect(doingText(waiting)).toBe('waiting for your OK in Telegram')
    expect(doingText({ ...waiting, step: null })).toBe('waiting for your OK in Telegram')
    expect(tagFacts(waiting, facts, null).map(fact => fact.text)).toEqual(['Telegram · active now'])
  })

  it('says the lane is coarse, or that it shows live steps while live detail is on', () => {
    expect(laneWords(false)).toEqual({ note: 'Coarse: titles and activity, read once a minute', about: "Hermes work outside Herald, from Hermes's session list: titles and whether each is active, read once a minute. The room shows no steps for it." })
    expect(laneWords(true).note).toBe('Live steps from Hermes in each app')
    expect(laneWords(true).about).toContain('by name only')
    expect(laneWords(true).about).toContain('Approvals there are answered there.')
  })
})
