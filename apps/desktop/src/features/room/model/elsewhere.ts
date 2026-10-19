import { shortName } from './areas.ts'
import { timeOf } from './automations.ts'
import { rowUsage } from './costs.ts'
import type { RoomRowUsage } from './types.ts'

/*
 * The elsewhere lane: Hermes work in other processes (messaging bots, the Hermes CLI and TUI,
 * Hermes's own desktop app, cron run by the messaging gateway), read from Hermes's session database
 * through `/api/sessions` only when the person turns the lane on. Coarse on purpose: a title,
 * where it runs (from a fixed table), whether Hermes counts it as active and when it last was,
 * read at most once a minute. A row's preview and model never get here, and its token counts and
 * cost only while the person has cost meters on. Live steps come from model/outside.ts.
 */

/** The lane is read this often while it is on and the Room is shown. */
export const ELSEWHERE_EVERY_MS = 60_000
/** Sessions last active longer ago than this are left out. */
export const ELSEWHERE_RECENT_MS = 60 * 60_000
/** The lane holds at most this many. */
export const ELSEWHERE_MAX = 12
/** How many rows one read asks Hermes for, most recently active first. */
export const ELSEWHERE_LIMIT = 40

/** The sources Herald's own sessions are stored with (ADR-003, ADR-016). */
export const HERALD_SOURCES = ['herald_os', 'hermes_os'] as const
/** Sources that are Herald's own sessions or helpers inside another session. */
export const NOT_ELSEWHERE = [...HERALD_SOURCES, 'tool'] as const

const TITLE_MAX = 60
/** A cron run's session id: `cron_<job id>_<YYYYmmdd_HHMMSS>`. */
const CRON_RUN = /^cron_(.+)_\d{8}_\d{6}$/

/** Where a session runs, by its source; anything else is another Hermes app. */
const WHERE: Record<string, string> = {
  cli: 'the Hermes CLI',
  oneshot: 'the Hermes CLI',
  tui: 'the Hermes TUI',
  desktop: "Hermes's desktop app",
  local: 'Hermes',
  cron: 'a scheduled job',
  acp: 'an editor',
  api_server: 'the Hermes API',
  webhook: 'a webhook',
  msgraph_webhook: 'a webhook',
  relay: 'a messaging relay',
  telegram: 'Telegram',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  whatsapp_cloud: 'WhatsApp',
  slack: 'Slack',
  signal: 'Signal',
  mattermost: 'Mattermost',
  matrix: 'Matrix',
  homeassistant: 'Home Assistant',
  email: 'email',
  sms: 'SMS',
  dingtalk: 'DingTalk',
  feishu: 'Feishu',
  wecom: 'WeCom',
  wecom_callback: 'WeCom',
  weixin: 'WeChat',
  bluebubbles: 'iMessage',
  qqbot: 'QQ',
  yuanbao: 'Yuanbao'
}

const ELSEWHERE_FALLBACK = 'another Hermes app'

/** A `/api/sessions` row cut down to what the lane shows. */
export interface RoomElsewhereRow {
  id: string
  /** The session's source as Hermes stores it, for leaving Herald's own out; the lane shows `where`. */
  source: string | null
  where: string
  title: string
  startedAt: number | null
  lastActiveAt: number | null
  active: boolean
  /** Its token counts and cost, kept only while cost meters are on. */
  usage: RoomRowUsage | null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Where a source runs, from the fixed table. */
export const whereOf = (source: string | null): string => (source && Object.hasOwn(WHERE, source) ? WHERE[source] : ELSEWHERE_FALLBACK)

/** A `/api/sessions` row: id, source, title, times and `is_active`, and with `counts` its token counts and cost; never its preview. */
export function roomElsewhereRow(raw: unknown, counts = false): RoomElsewhereRow | null {
  const row = record(raw)
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : null

  if (!id) {
    return null
  }

  const source = typeof row.source === 'string' && row.source.trim() ? row.source.trim().toLowerCase() : null

  return {
    id,
    source,
    where: whereOf(source),
    title: typeof row.title === 'string' ? (shortName(row.title, TITLE_MAX) ?? '') : '',
    startedAt: timeOf(row.started_at),
    lastActiveAt: timeOf(row.last_active) ?? timeOf(row.started_at),
    active: row.is_active === true,
    usage: counts ? rowUsage(row) : null
  }
}

/** The job a cron run belongs to, from its session id. */
export function cronRunJob(sessionId: string): string | null {
  return CRON_RUN.exec(sessionId)?.[1] ?? null
}

/**
 * The rows the lane shows: not Herald's own sessions (by source, or a stored id one of Herald's
 * agents holds), not runs of an automation the Room already shows, and only recent ones; active
 * first, then the most recently active.
 */
export function elsewhereRows(rows: readonly RoomElsewhereRow[], herald: { sessionKeys: ReadonlySet<string>; jobIds: ReadonlySet<string> }, now: number): RoomElsewhereRow[] {
  const excluded = new Set<string>(NOT_ELSEWHERE)

  return rows
    .filter(row => !(row.source && excluded.has(row.source)) && !herald.sessionKeys.has(row.id))
    .filter(row => {
      const job = row.source === 'cron' ? cronRunJob(row.id) : null

      return !(job && herald.jobIds.has(job))
    })
    .filter(row => row.active || (row.lastActiveAt !== null && now - row.lastActiveAt < ELSEWHERE_RECENT_MS))
    .sort((a, b) => Number(b.active) - Number(a.active) || (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, ELSEWHERE_MAX)
}
