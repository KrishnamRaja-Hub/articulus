/*
 * The data pipeline shared by `npm run fetch` and `npm run renormalize`:
 *   lock + crash recovery -> raw (ASSIST or data/raw) -> normalize -> staging -> validate (+ diff guard, canaries)
 *   -> app suites -> publish
 * Nothing under data/ changes unless every gate passes. Two runs never overlap (lock files on the data dir and the
 * work dir), each run stages in its own directory, and a crash mid-publish is repaired by the next run.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NORMALIZE_VERSION } from '../../src/engine/normalize.ts'
import { assistClient } from './assist-client.ts'
import { PIPELINE, httpConfig, type PipelineConfig } from './config.ts'
import { fetchRaw, type RawBundle } from './fetch.ts'
import { LockError, acquireLock, dataLockPath, recoverPublish, swapIn, treeHash, type Lock, type SwapHook } from './publish.ts'
import { summaryMarkdown, summaryText } from './report.ts'
import { BASELINE_FILE, decideDirs, decisionMarkdown, makeBaseline, readDataSet, writeBaseline, type Decision } from './diff.ts'
import { build, hasRaw, readRaw, writeBuilt, writeRaw, type RawManifest } from './store.ts'
import { addSuites, runSuites, type Suite } from './suites.ts'
import { validateData, type Meta, type Report } from './validate.ts'

export interface RunOptions {
  source: 'assist' | 'raw'
  repoRoot: string
  /** Published data directory (default <repo>/data). */
  dataDir: string
  /** Scratch space for staging and reports (default <repo>/.pipeline, gitignored). */
  workDir: string
  now?: Date
  cfg?: PipelineConfig
  env?: NodeJS.ProcessEnv
  /** Skip the app suites (tests of the pipeline itself only). */
  skipSuites?: boolean
  suites?: Suite[]
  acceptDiff?: boolean
  /** Validate but do not publish. */
  dryRun?: boolean
  /** A refresh that needs human review (diff.ts): 'fail' (default) publishes nothing and fails with the diff report;
   *  'stage' publishes to dataDir with the new reviewed baseline, for the workflow to open a PR that a human merges
   *  (never auto-merged). Default from DATA_REFRESH_ON_REVIEW=pr. */
  onReview?: 'fail' | 'stage'
  log?: (m: string) => void
  /**
   * Allow publishing when there is no previous data to diff against. Without it, a run with no data/index.json
   * refuses to publish: a crash or a deleted data/ must never switch the diff guard off.
   */
  firstPublish?: boolean
  /**
   * On a fetch run whose published data was built by another NORMALIZE_VERSION, first rebuild it offline from the
   * raw store and publish that (default true), so a version bump never waits on ASSIST for trusted data.
   */
  autoRenormalize?: boolean
  /** Break locks older than this (default 6 h). A lock whose process is gone is broken at once. */
  lockMaxAgeMs?: number
  /** Test seams: a throw simulates a crash at that point. */
  hooks?: { swap?: SwapHook; beforePublish?: () => void }
}
export interface RunResult {
  ok: boolean
  published: boolean
  /** agreements/index/institutions changed vs the previous data. */
  contentChanged: boolean
  rawChanged: boolean
  report?: Report
  /** Release decision (diff.ts): 'review' = looser or large per-college change; needs a human before it goes live. */
  decision?: Decision['decision']
  error?: string
  stage: 'lock' | 'preflight' | 'fetch' | 'build' | 'validate' | 'suites' | 'review' | 'publish' | 'done'
  /** An automatic offline renormalize (NORMALIZE_VERSION changed) was published before this run's fetch. */
  renormalized?: boolean
}

const writeJson = (p: string, v: unknown, indent = 2) => writeFileSync(p, JSON.stringify(v, null, indent) + '\n')

const SECRET_NAME = /TOKEN|SECRET|PASSW|KEY|AUTH|COOKIE|CREDENTIAL|PRIVATE|SESSION/i

/**
 * Remove credentials from text bound for logs, failure.md, report.md and RunResult.error (which the workflow posts
 * to issues): values of secret-looking env vars, GitHub tokens, bearer/basic auth, cookies and antiforgery tokens,
 * and URL userinfo.
 */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text
  const values = Object.entries(env).filter(([k, v]) => SECRET_NAME.test(k) && v && v.length >= 6).map(([, v]) => v!).sort((a, b) => b.length - a.length)
  for (const v of values) out = out.split(v).join('***')
  return out
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, '***')
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/((?:Set-)?Cookie|Authorization|X-XSRF-TOKEN|XSRF-TOKEN|\.AspNetCore\.[\w.-]+)(\s*[:=]\s*)[^\s;,'"]+/gi, '$1$2***')
    .replace(/(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***@')
}

/** A Markdown code fence longer than any backtick run in the content, so the content cannot close it (L-7). */
export const fenced = (s: string) => {
  const f = '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return `${f}\n${s}\n${f}`
}

/**
 * Lock, recover from any crashed publish, renormalize stale data offline if needed, then run the pipeline.
 * A second run on the same data dir or work dir fails fast at stage `lock` and touches nothing.
 */
export async function runPipeline(o: RunOptions): Promise<RunResult> {
  const env = o.env ?? process.env, rawLog = o.log ?? console.log, cfg = o.cfg ?? PIPELINE
  const log = (m: string) => rawLog(redact(m, env))
  const dataDir = resolve(o.dataDir), workDir = resolve(o.workDir)
  const locks: Lock[] = []
  try {
    try {
      mkdirSync(workDir, { recursive: true })
      mkdirSync(resolve(dataDir, '..'), { recursive: true })
      locks.push(acquireLock(dataLockPath(dataDir), `${o.source} run`, o.lockMaxAgeMs))
      locks.push(acquireLock(join(workDir, '.lock'), `${o.source} run`, o.lockMaxAgeMs))
    } catch (e) {
      const error = redact(e instanceof LockError ? e.message : String((e as Error).stack ?? e), env)
      log(`FAILED at lock: ${error}`)
      return { ok: false, published: false, contentChanged: false, rawChanged: false, error, stage: 'lock' }
    }
    for (const m of recoverPublish(dataDir)) log(`recovery: ${m}`)
    // Staging dirs of crashed runs: ours are unique per run, and the lock means no live run owns one.
    for (const f of readdirSync(workDir)) if (f.startsWith('staging')) rmSync(join(workDir, f), { recursive: true, force: true })

    let renormalized = false
    const stale = o.source === 'assist' && o.autoRenormalize !== false && !o.dryRun ? staleVersion(dataDir, cfg) : null
    if (stale !== null) {
      log(`published data was built by normalize v${stale} (code is v${NORMALIZE_VERSION}): renormalizing from the raw store before fetching`)
      const r = await runLocked({ ...o, source: 'raw' }, dataDir, workDir, env, log)
      renormalized = r.published
      log(r.published ? 'renormalize published; continuing with the fetch' : `renormalize did not publish (failed at ${r.stage}); continuing with the fetch`)
    }
    const r = await runLocked(o, dataDir, workDir, env, log)
    return stale !== null ? { ...r, renormalized } : r
  } finally {
    for (const l of locks.reverse()) l.release()
  }
}

/** The published data's normalize version, when it differs from the code's and a raw store can rebuild it. */
export function staleVersion(dataDir: string, cfg: PipelineConfig = PIPELINE): number | null {
  if (!hasRaw(dataDir, cfg)) return null
  try {
    const v = (JSON.parse(readFileSync(join(dataDir, 'meta.json'), 'utf8')) as Meta).normalizeVersion
    return typeof v === 'number' && v !== NORMALIZE_VERSION ? v : null
  } catch { return null }
}

/** Files rewritten at publish time (the validation stamp), so excluded from the validated-tree hash. */
const STAMPED = ['meta.json', 'validation-report.json', BASELINE_FILE] // the baseline is written from the validated tree

async function runLocked(o: RunOptions, dataDir: string, workDir: string, env: NodeJS.ProcessEnv, log: (m: string) => void): Promise<RunResult> {
  const cfg = o.cfg ?? PIPELINE
  const now = o.now ?? new Date()
  for (const f of ['validation-report.json', 'report.md', 'failure.md', 'decision.json', 'diff-report.md']) rmSync(join(workDir, f), { force: true })
  // Unique per run (H-2): nothing another process does to the work dir can change what this run validated.
  const stagingRoot = mkdtempSync(join(workDir, 'staging-')), staging = join(stagingRoot, 'data')
  mkdirSync(staging, { recursive: true })
  let stage: RunResult['stage'] = 'preflight'
  const fail = (err: string, report?: Report): RunResult => {
    const error = redact(err, env)
    writeFileSync(join(workDir, 'failure.md'), `### Data refresh failed at stage \`${stage}\`\n\n${fenced(error.slice(0, 6000))}\n${report ? '\n' + redact(summaryMarkdown(report), env) + '\n' : ''}`)
    log(`FAILED at ${stage}: ${error.split('\n')[0]}`)
    log(`published data untouched: ${dataDir}`)
    return { ok: false, published: false, contentChanged: false, rawChanged: false, report, error, stage }
  }

  try {
    // 0. Never publish without a baseline unless asked (H-3): a missing data/ must not switch the diff guard off.
    const hasPrev = existsSync(join(dataDir, 'index.json'))
    if (!hasPrev && !o.firstPublish && !o.dryRun) {
      return fail(`no published data at ${dataDir} (index.json missing), so the diff guard has nothing to compare against. ` +
        'Restore it (git checkout -- data) and rerun; pass --first-publish only if this really is the first publish.')
    }

    // 1. raw payloads
    stage = 'fetch'
    let bundle: RawBundle
    if (o.source === 'assist') {
      const http = httpConfig(env)
      const client = assistClient(http, log)
      const pin = env.ASSIST_ACADEMIC_YEAR_ID ? Number(env.ASSIST_ACADEMIC_YEAR_ID) : undefined
      bundle = await fetchRaw(client, cfg, { base: http.base, now, pinYear: pin, log })
      log(`fetch complete: ${bundle.agreements.length} agreements, ${bundle.agreements.reduce((t, a) => t + a.payloads.length, 0)} payloads, ${client.stats.requests} requests (${client.stats.retries} retries, ${client.stats.renewals} session renewals)`)
    } else {
      bundle = readRaw(dataDir, cfg)
      log(`raw store: ${bundle.agreements.length} agreements fetched ${bundle.fetchedAt} (${bundle.academicYear.code})`)
    }

    // 2. normalize into staging
    stage = 'build'
    const built = build(bundle, cfg)
    writeBuilt(staging, built)
    if (o.source === 'assist') log(`raw store: ${(writeRaw(staging, bundle, cfg).totalBytes / 1024 / 1024).toFixed(2)} MB gzipped`)
    else cpSync(join(dataDir, cfg.raw.dir), join(staging, cfg.raw.dir), { recursive: true })
    const meta: Meta = { schema: 1, normalizeVersion: NORMALIZE_VERSION, fetchedAt: bundle.fetchedAt, academicYear: bundle.academicYear, validation: null, agreements: built.index.length }
    writeJson(join(staging, 'meta.json'), meta)

    // 3. validate staged data against the contract, invariants, canaries, and the published data (diff guard)
    stage = 'validate'
    const acceptDiff = o.acceptDiff || /^(1|true|yes)$/i.test(env[cfg.diff.overrideEnv] ?? '')
    const report = validateData(staging, { cfg, mode: 'publish', now, staged: true, prevDir: hasPrev ? dataDir : undefined, acceptDiff, notes: built.notes, templateMismatches: built.templateMismatches })

    // 4. the app's own suites against the staged data
    if (report.passed && !o.skipSuites) {
      stage = 'suites'
      addSuites(report, runSuites(o.repoRoot, staging, o.suites, log))
    }
    const validated = treeHash(staging, STAMPED)
    const rawChanged = rawDiffers(dataDir, staging, cfg)
    writeJson(join(workDir, 'validation-report.json'), report)
    writeFileSync(join(workDir, 'report.md'), redact(summaryMarkdown(report), env) + '\n')
    log(summaryText(report))
    if (!report.passed) return fail(`${report.counts.error} validation error(s); see ${join(workDir, 'validation-report.json')}`, report)

    // 5. release decision: only neutral or stricter changes publish on their own (diff.ts)
    stage = 'review'
    const prevDir = existsSync(join(dataDir, 'index.json')) ? dataDir : undefined
    const decision = decideDirs(prevDir, staging)
    // A human who re-ran with the override after reading the report has reviewed it: publish, with the new baseline.
    if (decision.decision === 'review' && acceptDiff) { decision.decision = 'publish'; decision.reasons.push(`accepted by ${cfg.diff.overrideEnv}; this data becomes the reviewed baseline`) }
    const decisionMd = decisionMarkdown(decision)
    writeJson(join(workDir, 'decision.json'), decision)
    writeFileSync(join(workDir, 'diff-report.md'), decisionMd + '\n')
    appendFileSync(join(workDir, 'report.md'), '\n' + decisionMd + '\n')
    log(`release decision: ${decision.decision}${decision.reasons.length ? ` (${decision.reasons.join('; ')})` : ''}`)
    if (decision.updateBaseline) writeBaseline(staging, makeBaseline(readDataSet(staging)!, now))
    const onReview = o.onReview ?? (env.DATA_REFRESH_ON_REVIEW === 'pr' ? 'stage' : 'fail')
    if (o.dryRun) { log('dry run: not publishing'); return { ok: true, published: false, contentChanged: !!report.diff?.contentChanged, rawChanged, report, decision: decision.decision, stage: 'done' } }
    if (decision.decision === 'review' && onReview === 'fail') {
      const r = fail(`needs human review, not published: ${decision.reasons.join('; ')}\n(set DATA_REFRESH_ON_REVIEW=pr to stage it for a reviewed PR with a new ${BASELINE_FILE})`, report)
      appendFileSync(join(workDir, 'failure.md'), '\n' + decisionMd + '\n')
      return { ...r, decision: 'review' }
    }

    // 6. publish: meta.json records the passed validation (DATA_CONTRACT.md), then swap the directory in.
    //    What gets published must be byte-for-byte what was validated.
    stage = 'publish'
    if (treeHash(staging, STAMPED) !== validated) return fail('staged data changed after validation; refusing to publish', report)
    o.hooks?.beforePublish?.()
    const published: Report = { ...report, dataDir: 'data' }
    writeJson(join(staging, 'validation-report.json'), published, 1)
    writeJson(join(staging, 'meta.json'), { ...meta, validation: { passed: true, at: now.toISOString(), checks: report.checks, report: 'data/validation-report.json' } })
    swapIn(staging, dataDir, o.hooks?.swap)
    const contentChanged = report.diff?.contentChanged ?? true
    log(`published ${built.index.length} agreements to ${dataDir} (${contentChanged ? 'content changed' : 'content unchanged; meta refreshed'})`)
    return { ok: true, published: true, contentChanged, rawChanged, report, decision: decision.decision, stage: 'done' }
  } catch (e) {
    return fail((e as Error).stack ?? String(e))
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

/** Did any raw payload file change (by manifest checksum)? */
function rawDiffers(prevDir: string, nextDir: string, cfg: PipelineConfig) {
  const m = (d: string) => { try { return JSON.parse(readFileSync(join(d, cfg.raw.dir, 'manifest.json'), 'utf8')) as RawManifest } catch { return undefined } }
  const a = m(prevDir), b = m(nextDir)
  if (!a || !b) return !!(a || b)
  const key = (x: RawManifest) => JSON.stringify(x.agreements.map((y) => [y.file, y.sha256]))
  return key(a) !== key(b)
}

/** Expose results to later workflow steps. */
export function githubOutputs(r: RunResult, env = process.env) {
  if (!env.GITHUB_OUTPUT) return
  appendFileSync(env.GITHUB_OUTPUT, [
    `ok=${r.ok}`, `published=${r.published}`, `content_changed=${r.contentChanged}`, `raw_changed=${r.rawChanged}`, `stage=${r.stage}`, `decision=${r.decision ?? ''}`,
    `errors=${r.report?.counts.error ?? ''}`, `changed_agreements=${r.report?.diff?.changed.length ?? ''}`, `renormalized=${!!r.renormalized}`,
  ].join('\n') + '\n')
}
