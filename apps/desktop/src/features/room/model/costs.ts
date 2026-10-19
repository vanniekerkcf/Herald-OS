import type { RoomAgent, RoomCostStatus, RoomKind, RoomResult, RoomRowUsage, RoomSessionCounts, RoomState, RoomUsage } from './types.ts'

/*
 * Cost meters: the tokens and money Hermes itself counted for each piece of work, from what it
 * already reports (a session's usage frames, a helper's `subagent.complete`, the session database's
 * rows for Herald's own sessions, for work outside Herald and for automation runs). Shown only when
 * the person turns meters on, and an estimate always says it is one.
 */

export const COST_STATUSES: readonly RoomCostStatus[] = ['actual', 'estimated', 'included', 'unknown']

/** A row of one of Herald's own sessions from `/api/sessions`: its stored id and what it used, nothing else. */
export interface RoomCostRow extends RoomRowUsage {
  id: string
}

/** What a tag or the header shows, and where its numbers come from. */
export interface RoomMeter {
  text: string
  title: string
}

const WHOSE: Record<RoomKind, string> = {
  conversation: 'this conversation',
  mission: 'this mission',
  helper: "this helper's job",
  automation: "this automation's latest run",
  elsewhere: 'this session'
}

const COST_TITLE: Record<RoomCostStatus, string> = {
  actual: 'The cost is what the provider billed.',
  estimated: "The cost is Hermes's estimate.",
  included: 'Its cost is included in a plan.',
  unknown: 'Hermes does not know its cost.'
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** A session row's token counts and cost; null when it says nothing about either. */
export function rowUsage(raw: unknown): RoomRowUsage | null {
  const row = record(raw)
  const input = amount(row.input_tokens)
  const output = amount(row.output_tokens)
  const estimated = amount(row.estimated_cost_usd)
  const actual = amount(row.actual_cost_usd)
  const stated = COST_STATUSES.find(status => status === row.cost_status) ?? null
  const billed = stated === 'actual' && actual !== null
  // Hermes keeps the latest call's status: an "actual" session without a billed amount is still an estimate.
  const costStatus = stated && (stated !== 'actual' || billed) ? stated : estimated !== null ? 'estimated' : null
  const costUsd = billed ? actual : estimated

  return input === null && output === null && costUsd === null && costStatus === null ? null : { input, output, costUsd, costStatus }
}

/** One of Herald's own sessions from `/api/sessions`: id, token counts and cost only. */
export function roomCostRow(raw: unknown): RoomCostRow | null {
  const row = record(raw)
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : null

  return id ? { id, ...(rowUsage(row) ?? { input: null, output: null, costUsd: null, costStatus: null }) } : null
}

/** Input and output tokens together: Hermes counts reasoning inside the output. */
export function tokensOf(counts: Pick<RoomSessionCounts, 'input' | 'output'> | null): number | null {
  if (!counts || (counts.input === null && counts.output === null)) {
    return null
  }

  return (counts.input ?? 0) + (counts.output ?? 0)
}

/**
 * A conversation's usage: token totals from its frames, which are newer than the session
 * database's, else from the database; its cost only from the database; the turn's tokens from the
 * frames alone, since the turn began.
 */
export function sessionUsage(counts: RoomSessionCounts | null, turnTokens: number | null, row: RoomRowUsage | null, at: number): RoomUsage | null {
  if (!counts && !row) {
    return null
  }

  const now = tokensOf(counts)

  return {
    input: counts?.input ?? row?.input ?? null,
    output: counts?.output ?? row?.output ?? null,
    reasoning: counts?.reasoning ?? null,
    calls: counts?.calls ?? null,
    turn: now !== null && turnTokens !== null && now >= turnTokens ? now - turnTokens : null,
    costUsd: row?.costUsd ?? null,
    costStatus: row?.costStatus ?? null,
    at
  }
}

/** A helper's usage for its whole job, from `subagent.complete`, where Hermes's cost is an estimate. */
export function helperUsage(result: RoomResult): RoomUsage | null {
  const { inputTokens: input, outputTokens: output, reasoningTokens: reasoning, apiCalls: calls, costUsd } = result

  if ([input, output, reasoning, calls, costUsd].every(value => value === null)) {
    return null
  }

  return { input, output, reasoning, calls, turn: null, costUsd, costStatus: costUsd === null ? null : 'estimated', at: result.at }
}

/** Usage from a row of the session database: a session outside Herald, or an automation's latest run. */
export function usageOfRow(row: RoomRowUsage | null, at: number): RoomUsage | null {
  return row ? { input: row.input, output: row.output, reasoning: null, calls: null, turn: null, costUsd: row.costUsd, costStatus: row.costStatus, at } : null
}

export function sameUsage(a: RoomUsage | null, b: RoomUsage | null): boolean {
  if (!a || !b) {
    return a === b
  }

  return a.input === b.input && a.output === b.output && a.reasoning === b.reasoning && a.calls === b.calls && a.turn === b.turn && a.costUsd === b.costUsd && a.costStatus === b.costStatus
}

function compact(count: number): string {
  const rounded = Math.round(count)

  if (rounded < 1000) {
    return String(rounded)
  }

  const [value, unit] = rounded < 999_950 ? [rounded / 1000, 'k'] : [rounded / 1_000_000, 'M']

  return `${value.toFixed(1).replace(/\.0$/, '')}${unit}`
}

/** A token count as a meter says it: '950 tokens', '12.3k tokens', '1.2M tokens'. */
export function tokensText(count: number): string {
  return Math.round(count) === 1 ? '1 token' : `${compact(count)} tokens`
}

const dollars = (usd: number): string => (usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`)

/** Money as a meter says it: a billed amount plainly, an estimate marked as one, a plan's share in words; nothing when Hermes does not know it. */
export function moneyText(usd: number | null, status: RoomCostStatus | null): string | null {
  if (status === 'included') {
    return 'included in a plan'
  }

  if (usd === null || status === null || status === 'unknown') {
    return null
  }

  return status === 'actual' ? dollars(usd) : `${dollars(usd).startsWith('<') ? '' : '~'}${dollars(usd)} est.`
}

/** What an agent's tag shows; null when Hermes reported nothing for it. */
export function meterOf(agent: Pick<RoomAgent, 'kind' | 'usage'> & Partial<Pick<RoomAgent, 'parentId'>>): RoomMeter | null {
  const usage = agent.usage

  if (!usage) {
    return null
  }

  const tokens = tokensOf(usage)
  // A session the database has not counted yet says 0: that is no news, not a reading.
  const parts = [tokens ? tokensText(tokens) : null, moneyText(usage.costUsd, usage.costStatus)].filter((part): part is string => part !== null)

  if (!parts.length) {
    return null
  }

  const helper = agent.kind === 'helper' || (agent.kind === 'elsewhere' && Boolean(agent.parentId))
  const whose = helper ? WHOSE.helper : WHOSE[agent.kind]
  const title = [
    !tokens ? null : `Tokens Hermes counted for ${whose}${usage.turn === null ? '' : ` (this turn: ${compact(usage.turn)})`}.`,
    usage.costStatus ? COST_TITLE[usage.costStatus] : null,
    agent.kind === 'helper' ? 'Hermes adds this to the conversation that started the helper.' : null
  ]

  return { text: parts.join(' · '), title: title.filter(Boolean).join(' ') }
}

/**
 * The meters' total for the header: every conversation, mission, automation's latest run and
 * piece of work outside Herald in the room. Helpers are left out, as Hermes adds a helper's cost
 * to the conversation that started it. Tokens add up exactly; the money is marked as an estimate
 * when any part of it is one, or when Hermes knows no cost for some of the work.
 */
export function roomTotal(state: Pick<RoomState, 'agents'>): RoomMeter | null {
  let tokens: number | null = null
  let usd: number | null = null
  let billed = 0
  let estimated = 0
  let unknown = 0
  let included = 0

  for (const agent of Object.values(state.agents)) {
    const usage = agent.usage

    if (!usage || agent.kind === 'helper' || (agent.kind === 'elsewhere' && agent.parentId)) {
      continue
    }

    const count = tokensOf(usage)

    if (count !== null) {
      tokens = (tokens ?? 0) + count
    }

    if (usage.costStatus === 'included') {
      included += 1
    } else if (usage.costUsd !== null && (usage.costStatus === 'actual' || usage.costStatus === 'estimated')) {
      usd = (usd ?? 0) + usage.costUsd
      billed += usage.costStatus === 'actual' ? 1 : 0
      estimated += usage.costStatus === 'estimated' ? 1 : 0
    } else if (count !== null) {
      unknown += 1
    }
  }

  const money = usd !== null ? moneyText(usd, estimated || unknown ? 'estimated' : 'actual') : included ? moneyText(null, 'included') : null
  const parts = [tokens === null ? null : tokensText(tokens), money].filter((part): part is string => part !== null)

  if (!parts.length) {
    return null
  }

  const title = [
    "Tokens and cost Hermes counted for the conversations, missions, automations' latest runs and work outside Herald in the room.",
    "Helpers are not added: Hermes adds a helper's cost to the conversation that started it.",
    estimated ? (billed ? "Part of the cost is Hermes's estimate." : "The cost is Hermes's estimate.") : billed && !unknown ? 'The cost is what the providers billed.' : null,
    unknown ? `Hermes does not know the cost of ${unknown === 1 ? 'one of them' : `${unknown} of them`}, so the total is an estimate.` : null,
    included ? `${included === 1 ? 'One of them is' : `${included} of them are`} included in a plan.` : null
  ]

  return { text: `In the room: ${parts.join(' · ')}`, title: title.filter(Boolean).join(' ') }
}
