/*
 * Single configuration file for the ASSIST data pipeline (fetch, renormalize, validate).
 * Institution ids come from ASSIST /api/institutions (see README "Institution ids").
 */

export const PIPELINE = {
  /** ASSIST origin. Overridable with ASSIST_BASE (tests point it at the local mock server). */
  base: 'https://assist.org',

  /** Receiving universities: Berkeley, UCLA, UCSD, Irvine, Davis. */
  universities: [79, 117, 7, 120, 89],
  /**
   * Sending community colleges: De Anza, Foothill, Santa Monica, Pasadena City, Diablo Valley, Irvine Valley,
   * Orange Coast, El Camino, Berkeley City, City College of SF, San Jose City, Santa Barbara City, Saddleback,
   * West Valley, Mission.
   */
  colleges: [113, 51, 137, 49, 114, 124, 74, 103, 58, 33, 136, 92, 65, 80, 32],
  /** Display names that differ from ASSIST's; others are derived from the ASSIST name. */
  shortNames: { 79: 'UC Berkeley', 117: 'UCLA', 7: 'UC San Diego', 120: 'UC Irvine', 89: 'UC Davis', 33: 'CCSF' } as Record<number, string>,
  /** Major reports to fetch, matched against the ASSIST report label. */
  majorFilter: (label: string) =>
    /Computer Science|Electrical Engineering|Mechanical Engineering/.test(label) && /B\.[AS]\./.test(label) && !/Minor/.test(label),

  http: {
    /** Per-request timeout (ASSIST_TIMEOUT_MS). */
    timeoutMs: 30_000,
    /** Attempts per request on 5xx / network error / timeout, with exponential backoff (ASSIST_RETRIES). */
    attempts: 4,
    /** First backoff; doubles each attempt, plus up to 50% jitter (ASSIST_BACKOFF_MS). */
    backoffMs: 2_000,
    /** Session renewals allowed per request on 429 (ASSIST rate-limits per session cookie). */
    renewals: 6,
    /** Pause after every successful request, to be polite (ASSIST_DELAY_MS). */
    delayMs: 200,
    /** Whole-fetch budget (ASSIST_DEADLINE_MS); exceeding it fails the run with nothing written. */
    deadlineMs: 40 * 60_000,
  },

  raw: {
    /** Raw payloads live next to the data they built so `npm run renormalize` works offline. */
    dir: 'raw',
    /** Fail if the gzipped raw store grows past this (then move raw storage to a workflow artifact). */
    maxTotalBytes: 40 * 1024 * 1024,
    maxFileBytes: 15 * 1024 * 1024,
  },

  /** Diff guard against the currently published data. Exceeding a limit is an error unless overridden. */
  diff: {
    /** Total course groups across all agreements may drop by at most this fraction. */
    maxTotalGroupDrop: 0.10,
    /** One agreement's course groups may drop by at most this fraction. */
    maxAgreementGroupDrop: 0.25,
    /** One agreement's effectively-required row count may change (either way) by at most this fraction. */
    maxRequiredRowChange: 0.20,
    /** One agreement's catalog may drop by at most this fraction (warning only). */
    maxCatalogDrop: 0.25,
    /** Env var that accepts a large diff for one run (set by workflow_dispatch input accept_large_change). */
    overrideEnv: 'DATA_ACCEPT_LARGE_CHANGE',
  },

  validate: {
    /** Catalog courses no requirement uses (F-01 orphans): error when above this fraction of the catalog. */
    maxOrphanFraction: 0.05,
    /** Data older than this is a warning; older than staleErrorDays an error (publish mode only). */
    agingDays: 7,
    staleErrorDays: 30,
    /** Majors that must have an effectively-required lower-division math row (heuristic guard for CRITICAL-1). */
    mathRequiredMajors: /Computer Science|Electrical Engineering|Mechanical Engineering/,
    /**
     * Findings a human reviewed and accepted: `${checkId}|${agreementFile}`. Each needs a reason. An acknowledged
     * error is reported as a warning. Keep this list short and dated.
     */
    acknowledged: {} as Record<string, string>,
  },
}

export type PipelineConfig = typeof PIPELINE

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)

/** Environment overrides for the HTTP client (used by tests and CI). */
export const httpConfig = (env = process.env) => ({
  base: (env.ASSIST_BASE || PIPELINE.base).replace(/\/+$/, ''),
  timeoutMs: num(env.ASSIST_TIMEOUT_MS, PIPELINE.http.timeoutMs),
  attempts: Math.max(1, num(env.ASSIST_RETRIES, PIPELINE.http.attempts)),
  backoffMs: num(env.ASSIST_BACKOFF_MS, PIPELINE.http.backoffMs),
  renewals: PIPELINE.http.renewals,
  delayMs: num(env.ASSIST_DELAY_MS, PIPELINE.http.delayMs),
  deadlineMs: num(env.ASSIST_DEADLINE_MS, PIPELINE.http.deadlineMs),
})
export type HttpConfig = ReturnType<typeof httpConfig>
