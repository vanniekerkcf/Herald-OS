import type { RoomActivity } from '../../../../shared/room.ts'
import { describeTool } from './areas.ts'
import { cronRunJob, HERALD_SOURCES, whereOf } from './elsewhere.ts'
import type { RoomAgent, RoomArea, RoomBasis, RoomElsewhere, RoomPhase, RoomResult } from './types.ts'

/*
 * Live detail for work outside Herald: what Herald's bridge plugin in each Hermes process reports
 * (RoomActivity in shared/room.ts), taken in only while the person has both the lane and live
 * detail on. An event addresses `e:<its session>`; a helper's own events carry the helper's own
 * session, so they address the helper `e:<child>` that its helper.start brought in. Events about
 * Herald's own work are dropped, as the Room shows that from Herald's backend. Approvals there are
 * shown and never answered, nothing opens, and work that stops reporting goes back to the lane's
 * coarse view.
 */

/** Live detail that still says the work is busy is let go after this long without an event: a process that died sends no end. */
export const OUTSIDE_STALE_MS = 10 * 60_000

/** What the Room already shows of Herald's own work, which live detail never shows twice. */
export interface HeraldWork {
  /** The stored ids of Herald's live sessions. */
  sessionKeys: ReadonlySet<string>
  /** The sessions of Herald's helpers. */
  childSessions: ReadonlySet<string>
  /** The jobs at the Automations board. */
  jobIds: ReadonlySet<string>
}

const HELPER_ENDS: readonly RoomResult['status'][] = ['completed', 'failed', 'error', 'timeout', 'interrupted']

export const outsideAgentId = (session: string): string => `e:${session}`

export function heraldWork(agents: Readonly<Record<string, RoomAgent>>): HeraldWork {
  const sessionKeys = new Set<string>()
  const childSessions = new Set<string>()
  const jobIds = new Set<string>()

  for (const agent of Object.values(agents)) {
    if (agent.id.startsWith('s:') && agent.sessionKey) {
      sessionKeys.add(agent.sessionKey)
    } else if (agent.kind === 'helper' && agent.basis?.childSessionId) {
      childSessions.add(agent.basis.childSessionId)
    } else if (agent.automation) {
      jobIds.add(agent.automation.jobId)
    }
  }

  return { sessionKeys, childSessions, jobIds }
}

/** The events not taken in yet, in main's order: a replay on subscribing again repeats old ones. */
export function freshEvents(events: readonly RoomActivity[], seen: number): RoomActivity[] {
  return events.filter(event => event.seq > seen).sort((a, b) => a.seq - b.seq)
}

function heraldSession(session: string, herald: HeraldWork): boolean {
  const job = cronRunJob(session)

  return herald.sessionKeys.has(session) || herald.childSessions.has(session) || (job !== null && herald.jobIds.has(job))
}

/** About Herald's own work: one of its sessions, its helpers or its automations' runs, or a session stored as Herald's. */
export function isHeraldWork(event: RoomActivity, herald: HeraldWork): boolean {
  return HERALD_SOURCES.some(source => source === event.source) || heraldSession(event.session, herald) || (event.child !== null && heraldSession(event.child, herald))
}

/** The lane's record for work an event brought in before the lane's read named it. */
export function outsideLane(source: string | null, at: number): RoomElsewhere {
  return { where: whereOf(source), active: true, lastActiveAt: at, approval: false, liveAt: at }
}

function startTurn(agent: RoomAgent, basis: RoomBasis, at: number): void {
  basis.status = 'working'
  basis.tools = []
  basis.approvals = []
  basis.toolArea = null
  basis.toolTarget = null
  basis.toolStep = null
  basis.toolFront = false
  basis.turnArea = null
  basis.turnTarget = null
  basis.turnFront = false
  agent.turnStartedAt = at
}

/** A tool call's key: the plugin's call id, else the event's seq; with the tool's name, so an end without an id finds its tool. */
const callKey = (tool: string, id: string | number): string => `${tool}#${id}`

function startTool(agent: RoomAgent, basis: RoomBasis, event: RoomActivity, tool: string): void {
  const terminal = tool === 'terminal'
  const step = describeTool({ name: tool, target: terminal ? null : event.target, folder: terminal ? event.target : null, action: null, command: null, app: null }, { cwd: null, area: agent.area, target: agent.target })
  const key = callKey(tool, event.call ?? event.seq)

  basis.tools = [...basis.tools.filter(entry => entry !== key), key]
  basis.toolArea = step.area
  basis.toolTarget = step.target
  basis.toolStep = step.step
  basis.toolFront = step.front === true

  if (step.area && step.area !== 'bench') {
    basis.turnArea = step.area
    basis.turnTarget = step.target
    basis.turnFront = step.front === true
  }

  agent.tool = tool
  basis.status = 'working'
}

function endTool(basis: RoomBasis, event: RoomActivity, tool: string): void {
  const exact = event.call ? basis.tools.indexOf(callKey(tool, event.call)) : -1
  const index = exact >= 0 ? exact : basis.tools.findIndex(entry => entry.startsWith(`${tool}#`))

  if (index >= 0) {
    basis.tools = basis.tools.filter((_, at) => at !== index)
  }
}

/** Fold one event into the agent it addresses, a draft the reducer copied: where it works, its tools and the approvals it waits on. */
export function takeActivity(agent: RoomAgent, basis: RoomBasis, event: RoomActivity): void {
  switch (event.kind) {
    case 'session.start':
      startTurn(agent, basis, event.at)
      break
    case 'session.end':
      basis.status = 'idle'
      basis.tools = []
      basis.approvals = []
      agent.turnStartedAt = null
      break
    case 'tool.start':
      if (event.tool) {
        startTool(agent, basis, event, event.tool)
      }

      break
    case 'tool.end':
      if (event.tool) {
        endTool(basis, event, event.tool)
      }

      break
    case 'approval.start': {
      const key = event.call ?? 'approval'

      // Hermes may ask again for the same call.
      if (!basis.approvals.includes(key)) {
        basis.approvals = [...basis.approvals, key]
      }

      basis.status = 'working'
      break
    }
    case 'approval.end': {
      const index = event.call ? basis.approvals.indexOf(event.call) : -1

      basis.approvals = basis.approvals.filter((_, at) => at !== (index >= 0 ? index : 0))
      break
    }
    case 'helper.end':
      agent.phase = 'finished'
      agent.result = {
        status: HELPER_ENDS.find(status => status === event.status) ?? 'completed',
        summary: null,
        durationSeconds: null,
        filesRead: null,
        filesWritten: null,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        apiCalls: null,
        costUsd: null,
        at: event.at
      }
      basis.status = 'idle'
      basis.tools = []
      basis.approvals = []
      break
  }

  const lane = agent.elsewhere ?? outsideLane(event.source, event.at)

  agent.elsewhere = { ...lane, approval: basis.approvals.length > 0, liveAt: Math.max(lane.liveAt ?? 0, event.at), lastActiveAt: Math.max(lane.lastActiveAt ?? 0, event.at) }
}

/** Back to the lane's coarse view: no live status, tools, approvals or steps. */
export function dropLive(agent: RoomAgent, basis: RoomBasis): void {
  basis.status = null
  basis.tools = []
  basis.approvals = []
  basis.toolArea = null
  basis.toolTarget = null
  basis.toolStep = null
  basis.toolFront = false
  basis.turnArea = null
  basis.turnTarget = null
  basis.turnFront = false
  agent.turnStartedAt = null
  agent.tool = null

  if (agent.elsewhere) {
    agent.elsewhere = { ...agent.elsewhere, approval: false, liveAt: null }
  }
}

function place(agent: RoomAgent, phase: RoomPhase, area: RoomArea, target: string | null, step: string | null): void {
  agent.phase = phase
  agent.area = area
  agent.target = target
  agent.step = step
}

/**
 * Where work outside Herald stands and what it says. With live detail: on the bench while an
 * approval waits there, at the area for the tool it runs, thinking where its turn last worked;
 * a helper rests in the lounge between tools and keeps where it finished. Without: phase 2's
 * coarse view, in the lane, thinking while Hermes counts it as active.
 */
export function deriveOutside(agent: RoomAgent, basis: RoomBasis): void {
  const lane = agent.elsewhere
  const where = lane?.where ?? whereOf(null)
  const helper = agent.parentId !== null
  const live = (lane?.liveAt ?? null) !== null
  const working = live && (helper || basis.status === 'working')
  const running = working && basis.tools.length > 0
  const home: RoomArea = helper ? 'lounge' : 'elsewhere'

  if (!running || (helper && agent.phase === 'finished')) {
    agent.tool = null
  }

  if (helper && agent.phase === 'finished') {
    agent.step = null
  } else if (lane?.approval) {
    place(agent, 'waiting', 'bench', null, `waiting for your OK in ${where}`)
  } else if (running && basis.toolArea === 'bench') {
    place(agent, 'waiting', 'bench', null, `waiting for you in ${where}`)
  } else if (running) {
    place(agent, 'tool', basis.toolArea ?? basis.turnArea ?? home, basis.toolTarget, basis.toolStep)
  } else if (working) {
    place(agent, 'thinking', basis.turnArea ?? home, basis.turnTarget, 'thinking')
  } else if (live && basis.status === 'idle') {
    // The plugin said the turn ended, which is newer than the session list's idea of whether it is active.
    place(agent, 'idle', 'elsewhere', null, null)
  } else {
    place(agent, lane?.active ? 'thinking' : 'idle', 'elsewhere', null, null)
  }
}

/** Work outside Herald that live detail says is under way: a turn, an approval wait, or a helper still at work. */
export function busyOutside(agent: Pick<RoomAgent, 'kind' | 'phase' | 'parentId' | 'elsewhere' | 'basis'>): boolean {
  const lane = agent.elsewhere

  return agent.kind === 'elsewhere' && agent.phase !== 'finished' && lane !== null && lane.liveAt !== null && (agent.parentId !== null || lane.approval || agent.basis?.status === 'working')
}

/** When live detail on busy work goes stale; null when nothing waits on it. */
export function staleAt(agent: RoomAgent): number | null {
  const liveAt = agent.elsewhere?.liveAt ?? null

  return liveAt !== null && busyOutside(agent) ? liveAt + OUTSIDE_STALE_MS : null
}

/** Work the lane's read keeps though its list no longer has it: busy, a helper on its way out, or heard from recently. */
export function keepsLive(agent: RoomAgent, now: number): boolean {
  const liveAt = agent.elsewhere?.liveAt ?? null

  return agent.parentId !== null || busyOutside(agent) || (liveAt !== null && now - liveAt < OUTSIDE_STALE_MS)
}

/** Any live detail at all, which turning it off takes away. */
export function hasLiveDetail(agent: RoomAgent): boolean {
  const basis = agent.basis

  return agent.kind === 'elsewhere' && (agent.parentId !== null || (agent.elsewhere?.liveAt ?? null) !== null || Boolean(basis && (basis.status !== null || basis.tools.length || basis.approvals.length)))
}

/** Work live detail brought in that the lane has not listed yet: a lane row brings its stored id. */
export const unlisted = (agent: RoomAgent): boolean => agent.kind === 'elsewhere' && agent.parentId === null && agent.sessionKey === null
