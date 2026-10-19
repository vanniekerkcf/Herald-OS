import { describe, expect, it } from 'vitest'
import type { RoomLogAgent, RoomLogEntry } from '../../../../shared/room.ts'
import { gapText } from './labels.ts'
import {
  gapAt,
  handoffsIn,
  NO_CAST,
  positionAt,
  replayAgents,
  replayFacts,
  replayHandoff,
  replayIndex,
  type RoomLogHandoff,
  sceneStretchAt,
  stretchAt,
  stretchesOf,
  stretchStartAfter,
  stretchStartBefore,
  viewsAt
} from './model.ts'

const at = (hours: number, minutes: number, seconds = 0) => new Date(2026, 9, 15, hours, minutes, seconds).getTime()
const begin = (t: number): RoomLogEntry => ({ t, k: 'begin' })
const end = (t: number): RoomLogEntry => ({ t, k: 'end' })
const cap = (t: number): RoomLogEntry => ({ t, k: 'cap' })
const gone = (t: number, id: string): RoomLogEntry => ({ t, k: 'gone', id })
const view = (t: number, id: string, patch: Partial<RoomLogAgent> = {}): RoomLogAgent => ({ t, k: 'agent', id, kind: 'conversation', phase: 'idle', area: 'lounge', step: null, target: null, wait: false, parent: null, where: null, outcome: null, ...patch })
const handoff = (t: number, kind: RoomLogHandoff['kind'], from: string, to: string, failed = false): RoomLogHandoff => ({ t, k: 'handoff', kind, from, to, failed })

const DAY: RoomLogEntry[] = [
  view(at(8, 0), 'early'),
  begin(at(9, 2)),
  view(at(9, 2), 'a', { phase: 'thinking' }),
  view(at(10, 0), 'a', { phase: 'tool', area: 'sheets', step: 'reading Budget.xlsx', target: 'Budget.xlsx' }),
  view(at(11, 0), 'h', { kind: 'helper', parent: 'a', phase: 'tool' }),
  handoff(at(11, 0), 'note', 'a', 'h'),
  view(at(11, 20), 'h', { kind: 'helper', parent: 'a', phase: 'finished', outcome: 'completed' }),
  handoff(at(11, 20), 'result', 'h', 'a'),
  gone(at(11, 30), 'h'),
  end(at(12, 10)),
  view(at(12, 30), 'stray'),
  begin(at(13, 45)),
  view(at(13, 45), 'b'),
  view(at(15, 0), 'b', { phase: 'waiting', area: 'bench', wait: true }),
  begin(at(16, 0)),
  view(at(16, 0), 'e', { kind: 'elsewhere', area: 'elsewhere', phase: 'thinking', where: 'Telegram' }),
  cap(at(17, 30))
]

const idsAt = (index: ReturnType<typeof replayIndex>, t: number) => [...viewsAt(index, positionAt(index, t)).keys()]

describe('stretches and gaps', () => {
  it('runs a stretch from each begin to the next end, cap or begin, and leaves out what came before the first begin', () => {
    expect(stretchesOf(DAY)).toEqual([
      { from: at(9, 2), to: at(12, 10), closed: 'end', first: 1, last: 9, elsewhere: false },
      { from: at(13, 45), to: at(15, 0), closed: null, first: 11, last: 13, elsewhere: false },
      { from: at(16, 0), to: at(17, 30), closed: 'cap', first: 14, last: 16, elsewhere: true }
    ])
  })

  it('ends a stretch nobody closed at its last entry', () => {
    expect(stretchesOf([begin(at(9, 0)), view(at(9, 0), 'a'), view(at(18, 30), 'a', { phase: 'tool' })])).toEqual([{ from: at(9, 0), to: at(18, 30), closed: null, first: 0, last: 2, elsewhere: false }])
    expect(stretchesOf([view(at(9, 0), 'a'), end(at(10, 0))])).toEqual([])
  })

  it('runs the stretch the log is still writing until now, though nothing changed lately, and only that one', () => {
    const open = replayIndex([begin(at(9, 0)), view(at(9, 0), 'a'), view(at(9, 30), 'a', { phase: 'idle' })], at(11, 0))
    const closed = replayIndex([begin(at(9, 0)), view(at(9, 0), 'a'), end(at(9, 40))], at(11, 0))
    const earlier = replayIndex([begin(at(9, 0)), view(at(9, 0), 'a'), begin(at(10, 0)), view(at(10, 0), 'a')], at(11, 0))

    expect(open.stretches.map(stretch => stretch.to)).toEqual([at(11, 0)])
    expect(gapAt(open, at(10, 30))).toBeNull()
    expect(closed.stretches.map(stretch => stretch.to)).toEqual([at(9, 40)])
    expect(earlier.stretches.map(stretch => stretch.to)).toEqual([at(9, 0), at(11, 0)])
  })

  it('says plainly when nothing was logged', () => {
    const index = replayIndex(DAY)
    const said = (t: number) => {
      const gap = gapAt(index, t)

      return gap && gapText(gap)
    }

    expect(said(at(8, 30))).toBe('Nothing was logged before 09:02')
    expect(said(at(10, 0))).toBeNull()
    expect(said(at(12, 10))).toBeNull()
    expect(said(at(12, 30))).toBe('Nothing was logged from 12:10 to 13:45')
    expect(said(at(15, 30))).toBe('Nothing was logged from 15:00 to 16:00')
    expect(said(at(18, 0))).toBe('The log was full from 17:30')
    expect(gapAt(index, at(18, 0))).toEqual({ from: at(17, 30), to: null, after: 'cap' })

    const open = replayIndex([begin(at(9, 0)), view(at(18, 30), 'a')])

    expect(gapText(gapAt(open, at(19, 0))!)).toBe('Nothing was logged after 18:30')
    expect(gapText(gapAt(replayIndex([]), at(12, 0))!)).toBe('Nothing was logged this day')
  })

  it('finds the stretch a time falls in, the next one in a gap, and the starts to jump to', () => {
    const index = replayIndex(DAY)

    expect(stretchAt(index, at(9, 30))).toBe(0)
    expect(stretchAt(index, at(12, 30))).toBe(-1)
    expect(sceneStretchAt(index, at(12, 30))).toBe(1)
    expect(sceneStretchAt(index, at(8, 0))).toBe(0)
    expect(sceneStretchAt(index, at(20, 0))).toBe(3)
    expect(stretchStartBefore(index, at(14, 0))).toBe(at(13, 45))
    expect(stretchStartBefore(index, at(13, 45))).toBe(at(9, 2))
    expect(stretchStartBefore(index, at(9, 2))).toBeNull()
    expect(stretchStartAfter(index, at(9, 2))).toBe(at(13, 45))
    expect(stretchStartAfter(index, at(8, 0))).toBe(at(9, 2))
    expect(stretchStartAfter(index, at(16, 30))).toBeNull()
  })
})

describe('the Room at a time', () => {
  it('starts each stretch afresh with the snapshot after its begin, and follows changes and departures', () => {
    const index = replayIndex(DAY)

    expect(idsAt(index, at(9, 2))).toEqual(['a'])
    expect(viewsAt(index, positionAt(index, at(9, 30))).get('a')?.phase).toBe('thinking')
    expect(viewsAt(index, positionAt(index, at(10, 30))).get('a')).toMatchObject({ phase: 'tool', step: 'reading Budget.xlsx' })
    expect(idsAt(index, at(11, 10))).toEqual(['a', 'h'])
    expect(viewsAt(index, positionAt(index, at(11, 25))).get('h')?.outcome).toBe('completed')
    expect(idsAt(index, at(11, 45))).toEqual(['a'])
    expect(idsAt(index, at(14, 0))).toEqual(['b'])
    expect(idsAt(index, at(16, 30))).toEqual(['e'])
  })

  it('shows an empty Room in a gap and ignores entries outside every stretch', () => {
    const index = replayIndex(DAY)

    expect(positionAt(index, at(8, 30))).toBe(-1)
    expect(idsAt(index, at(8, 30))).toEqual([])
    expect(idsAt(index, at(12, 30))).toEqual([])
    expect(idsAt(index, at(23, 0))).toEqual([])
  })

  it('changes position only when the time crosses an entry', () => {
    const index = replayIndex(DAY)

    expect(positionAt(index, at(10, 1))).toBe(positionAt(index, at(10, 59)))
    expect(positionAt(index, at(11, 0))).not.toBe(positionAt(index, at(10, 59)))
  })

  it('gives the same Room seeking back and forth as folding the stretch afresh', () => {
    let seed = 11
    const random = () => {
      seed = (seed * 16807) % 2147483647

      return seed / 2147483647
    }
    const entries: RoomLogEntry[] = []
    let t = at(0, 5)

    for (let stretch = 0; stretch < 3; stretch++) {
      entries.push(begin(t), view(t, 'a0'))

      for (let step = 0; step < 1500; step++) {
        t += Math.floor(random() * 12_000)
        const id = `a${Math.floor(random() * 14)}`
        entries.push(random() < 0.15 ? gone(t, id) : view(t, id, { phase: random() < 0.5 ? 'tool' : 'thinking', step: `step ${step}` }))
      }

      if (stretch < 2) {
        entries.push(end(t))
      }

      t += 40 * 60_000
    }

    const index = replayIndex(entries)
    const stretches = stretchesOf(entries)
    const fresh = (time: number) => {
      const views = new Map<string, RoomLogAgent>()
      const stretch = stretches.find(entry => entry.from <= time && time <= entry.to)

      for (let entry = stretch?.first ?? 0; stretch && entry <= stretch.last && entries[entry].t <= time; entry++) {
        const item = entries[entry]

        if (item.k === 'agent') {
          views.set(item.id, item)
        } else if (item.k === 'gone') {
          views.delete(item.id)
        }
      }

      return [...views]
    }

    expect(index.keyframes.length).toBeGreaterThan(20)

    for (let probe = 0; probe < 300; probe++) {
      const time = at(0, 0) + Math.floor(random() * (t - at(0, 0)))

      expect([...viewsAt(index, positionAt(index, time))]).toEqual(fresh(time))
    }
  })

  it('reads the clock as never running backwards', () => {
    const index = replayIndex([begin(at(9, 0)), view(at(9, 0), 'a'), view(at(8, 59), 'a', { phase: 'tool' }), end(at(9, 30))])

    expect(viewsAt(index, positionAt(index, at(9, 0))).get('a')?.phase).toBe('tool')
  })
})

describe('hand-offs', () => {
  it('gives the ones logged in a window, never one outside a stretch', () => {
    const index = replayIndex([...DAY, handoff(at(12, 40), 'note', 'a', 'h')])

    expect(handoffsIn(index, at(10, 0), at(11, 20)).map(found => found.entry.kind)).toEqual(['note', 'result'])
    expect(handoffsIn(index, at(11, 0), at(11, 20)).map(found => found.entry.kind)).toEqual(['result'])
    expect(handoffsIn(index, at(11, 20), at(11, 20))).toEqual([])
    expect(handoffsIn(index, at(12, 0), at(13, 0))).toEqual([])
  })

  it('plays one as a replay record between replayed agents', () => {
    const [found] = handoffsIn(replayIndex(DAY), at(11, 10), at(11, 20))

    expect(replayHandoff(found.index, found.entry, 7000)).toEqual({ id: 'r:#0000007', kind: 'result', from: 'r:h', to: 'r:a', at: 7000, trace: { source: 'frame', type: 'replay', at: 7000 } })
  })
})

describe('replayed agents', () => {
  const views = new Map<string, RoomLogAgent>([
    ['a', view(1, 'a', { phase: 'waiting', area: 'bench', wait: true })],
    ['h', view(1, 'h', { kind: 'helper', parent: 'a', phase: 'finished', outcome: 'timeout' })],
    ['j', view(1, 'j', { kind: 'automation', area: 'automations', phase: 'tool', step: 'running' })],
    ['e', view(1, 'e', { kind: 'elsewhere', area: 'elsewhere', phase: 'thinking', where: 'Telegram' })]
  ])

  it('are records nothing in Herald can act on', () => {
    const cast = replayAgents(views, NO_CAST, 5000)

    expect(cast.list).toHaveLength(4)
    expect(cast.list.every(agent => agent.id.startsWith('r:') && agent.sessionKey === null && agent.sessionId === '' && agent.title === '' && agent.desk === null && agent.usage === null && agent.tool === null && agent.asking === null)).toBe(true)
    expect(cast.byId.get('a')?.approval).toEqual({ requestId: 'replay:a', rpcId: null, sessionId: '', params: { description: null, command: null, tool_name: null, choices: null, allow_permanent: null, allow_session: null } })
    expect(cast.byId.get('h')).toMatchObject({ id: 'r:h', parentId: 'r:a', phase: 'finished', result: { status: 'timeout', summary: null, costUsd: null } })
    expect(cast.byId.get('j')?.automation).toEqual({ jobId: '', profile: null, paused: false, running: true, runStartedAt: null, lastRunAt: null, lastOutcome: null })
    expect(cast.byId.get('e')?.elsewhere).toEqual({ where: 'Telegram', active: true, lastActiveAt: null, approval: false, liveAt: null })
    expect(cast.byId.get('a')?.lastEventAt).toBe(5000)
  })

  it('stay the same objects while their views do not change', () => {
    const cast = replayAgents(views, NO_CAST, 5000)
    const copies = new Map([...views].map(([id, entry]): [string, RoomLogAgent] => [id, { ...entry, t: 2 }]))

    expect(replayAgents(copies, cast, 9000)).toBe(cast)

    const changed = replayAgents(new Map([...copies, ['a', view(3, 'a', { phase: 'tool', area: 'docs' })]]), cast, 9000)

    expect(changed).not.toBe(cast)
    expect(changed.byId.get('h')).toBe(cast.byId.get('h'))
    expect(changed.byId.get('e')).toBe(cast.byId.get('e'))
    expect(changed.byId.get('a')).not.toBe(cast.byId.get('a'))
    expect(changed.byId.get('a')).toMatchObject({ phase: 'tool', approval: null, lastEventAt: 9000 })
    expect(replayAgents(new Map([...copies].slice(1)), cast, 9000).list).toHaveLength(3)
  })

  it('keep an agent identical across positions where its view held', () => {
    const index = replayIndex(DAY)
    const first = replayAgents(viewsAt(index, positionAt(index, at(10, 30))), NO_CAST, 1)
    const later = replayAgents(viewsAt(index, positionAt(index, at(11, 10))), first, 2)

    expect(later.byId.get('a')).toBe(first.byId.get('a'))
    expect(later.list).toHaveLength(2)
  })

  it('say only fixed words as facts', () => {
    const cast = replayAgents(
      new Map([...views, ['ok', view(1, 'ok', { kind: 'automation', area: 'automations', outcome: 'ok' })], ['bad', view(1, 'bad', { kind: 'automation', area: 'automations', outcome: 'failed' })], ['done', view(1, 'done', { kind: 'helper', phase: 'finished', outcome: 'interrupted' })]]),
      NO_CAST,
      1
    )
    const said = (id: string) => replayFacts(cast.byId.get(id)!).map(fact => [fact.kind, fact.text, fact.trace])

    expect(said('a')).toEqual([['waiting', 'waited for your OK', null]])
    expect(said('h')).toEqual([['result', 'ran out of time', null]])
    expect(said('done')).toEqual([['result', 'was stopped', null]])
    expect(said('j')).toEqual([['running', 'running', null]])
    expect(said('ok')).toEqual([['lastRun', 'ran', null]])
    expect(said('bad')).toEqual([['lastRun', 'failed', null]])
    expect(said('e')).toEqual([['activity', 'Telegram', null]])
  })
})
