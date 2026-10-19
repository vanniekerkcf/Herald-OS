import { shortName } from './areas.ts'
import { rowUsage } from './costs.ts'
import type { RoomAutomation, RoomRowUsage } from './types.ts'

/*
 * Herald's automations, as the Automations page reads them: cron jobs from `/api/cron/jobs` and
 * each job's latest run from `/api/cron/jobs/{id}/runs`. Cron agents send no gateway events, so a
 * job's pet shows only this coarse status: its name, whether a run is under way, and when the last
 * run was and how it ended. A job's prompt, script, delivery target and error text never get here.
 */

const NAME_MAX = 60

/** A cron job cut down to its name and status. */
export interface RoomCronJob {
  /** `<profile>:<id>`, as the Automations page keys jobs. */
  key: string
  id: string
  profile: string | null
  name: string
  paused: boolean
  lastRunAt: number | null
  lastOutcome: 'ok' | 'failed' | null
  nextRunAt: number | null
  /** A scheduler has claimed a run of it, when the record says so. */
  claimed: boolean
}

/** A job's latest run: when it started and ended, whether Hermes counts it as still going, and what it used. */
export interface RoomCronRun {
  id: string
  startedAt: number | null
  endedAt: number | null
  active: boolean
  failed: boolean
  /** Its token counts and cost, as for any session row; shown only with cost meters on. */
  usage: RoomRowUsage | null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Hermes stamps cron times as epoch seconds or ISO strings; the Room's are milliseconds. */
export function timeOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : value
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)

    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

const failed = (status: unknown): boolean => /error|fail/i.test(typeof status === 'string' ? status : '')

export const cronJobKey = (job: Pick<RoomCronJob, 'id' | 'profile'>): string => `${job.profile ?? ''}:${job.id}`

/** A `/api/cron/jobs` row: its id, name and status fields only. */
export function roomCronJob(raw: unknown): RoomCronJob | null {
  const job = record(raw)
  const id = text(job.id)

  if (!id) {
    return null
  }

  const profile = text(job.profile)
  const status = text(job.last_status)

  return {
    key: cronJobKey({ id, profile }),
    id,
    profile,
    name: shortName(text(job.name) ?? '', NAME_MAX) ?? '',
    paused: job.state === 'paused' || job.enabled === false,
    lastRunAt: timeOf(job.last_run_at),
    lastOutcome: status ? (failed(status) ? 'failed' : 'ok') : null,
    nextRunAt: timeOf(job.next_run_at),
    claimed: Boolean(job.fire_claim || job.run_claim)
  }
}

/** A run row from `/api/cron/jobs/{id}/runs`: times, Hermes's own `is_active` and its token counts and cost, never its title or preview. */
export function roomCronRun(raw: unknown): RoomCronRun | null {
  const run = record(raw)
  const id = text(run.id)

  if (!id) {
    return null
  }

  return { id, startedAt: timeOf(run.started_at), endedAt: timeOf(run.ended_at), active: run.is_active === true, failed: failed(run.end_reason), usage: rowUsage(run) }
}

/** What the job's records say changed: a job that moves is read again, as a run may have started or ended. */
export function cronJobSignature(job: RoomCronJob): string {
  return [job.paused ? 1 : 0, job.claimed ? 1 : 0, job.lastRunAt ?? '-', job.lastOutcome ?? '-', job.nextRunAt ?? '-'].join(':')
}

/**
 * The job's status from its record and its latest run. `run` undefined keeps what `previous` knew
 * about a run under way, since runs are read less often than jobs; null says it has no runs.
 */
export function automationOf(job: RoomCronJob, run: RoomCronRun | null | undefined, previous: RoomAutomation | null): RoomAutomation {
  const running = run === undefined ? (previous?.running ?? false) : Boolean(run?.active)
  const runStartedAt = run === undefined ? (previous?.runStartedAt ?? null) : run?.active ? run.startedAt : null
  const ended = run && !run.active ? run : null

  return {
    jobId: job.id,
    profile: job.profile,
    paused: job.paused,
    running,
    runStartedAt: running ? runStartedAt : null,
    lastRunAt: job.lastRunAt ?? ended?.endedAt ?? ended?.startedAt ?? null,
    lastOutcome: job.lastOutcome ?? (ended ? (ended.failed ? 'failed' : 'ok') : null)
  }
}
