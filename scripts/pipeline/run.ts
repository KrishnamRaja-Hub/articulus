/*
 * The data pipeline shared by `npm run fetch` and `npm run renormalize`:
 *   raw (ASSIST or data/raw) -> normalize -> staging -> validate (+ diff guard, canaries) -> app suites -> publish
 * Nothing under data/ changes unless every gate passes.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NORMALIZE_VERSION } from '../../src/engine/normalize.ts'
import { assistClient } from './assist-client.ts'
import { PIPELINE, httpConfig, type PipelineConfig } from './config.ts'
import { fetchRaw, type RawBundle } from './fetch.ts'
import { swapIn } from './publish.ts'
import { summaryMarkdown, summaryText } from './report.ts'
import { BASELINE_FILE, decideDirs, decisionMarkdown, makeBaseline, readDataSet, writeBaseline, type Decision } from './diff.ts'
import { build, readRaw, writeBuilt, writeRaw, type RawManifest } from './store.ts'
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
  stage: 'fetch' | 'build' | 'validate' | 'suites' | 'review' | 'publish' | 'done'
}

const writeJson = (p: string, v: unknown, indent = 2) => writeFileSync(p, JSON.stringify(v, null, indent) + '\n')

export async function runPipeline(o: RunOptions): Promise<RunResult> {
  const cfg = o.cfg ?? PIPELINE, env = o.env ?? process.env, log = o.log ?? console.log
  const now = o.now ?? new Date()
  const dataDir = resolve(o.dataDir), workDir = resolve(o.workDir), staging = join(workDir, 'staging', 'data')
  rmSync(join(workDir, 'staging'), { recursive: true, force: true })
  for (const f of ['validation-report.json', 'report.md', 'failure.md', 'decision.json', 'diff-report.md']) rmSync(join(workDir, f), { force: true })
  mkdirSync(staging, { recursive: true })
  let stage: RunResult['stage'] = 'fetch'
  const fail = (error: string, report?: Report): RunResult => {
    writeFileSync(join(workDir, 'failure.md'), `### Data refresh failed at stage \`${stage}\`\n\n\`\`\`\n${error.slice(0, 6000)}\n\`\`\`\n${report ? '\n' + summaryMarkdown(report) + '\n' : ''}`)
    log(`FAILED at ${stage}: ${error.split('\n')[0]}`)
    log(`published data untouched: ${dataDir}`)
    return { ok: false, published: false, contentChanged: false, rawChanged: false, report, error, stage }
  }

  try {
    // 1. raw payloads
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
    const report = validateData(staging, { cfg, mode: 'publish', now, staged: true, prevDir: existsSync(join(dataDir, 'index.json')) ? dataDir : undefined, acceptDiff, notes: built.notes, templateMismatches: built.templateMismatches })

    // 4. the app's own suites against the staged data
    if (report.passed && !o.skipSuites) {
      stage = 'suites'
      addSuites(report, runSuites(o.repoRoot, staging, o.suites, log))
    }
    const rawChanged = rawDiffers(dataDir, staging, cfg)
    writeJson(join(workDir, 'validation-report.json'), report)
    writeFileSync(join(workDir, 'report.md'), summaryMarkdown(report) + '\n')
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

    // 6. publish: meta.json records the passed validation (DATA_CONTRACT.md), then swap the directory in
    stage = 'publish'
    const published: Report = { ...report, dataDir: 'data' }
    writeJson(join(staging, 'validation-report.json'), published, 1)
    writeJson(join(staging, 'meta.json'), { ...meta, validation: { passed: true, at: now.toISOString(), checks: report.checks, report: 'data/validation-report.json' } })
    swapIn(staging, dataDir)
    rmSync(join(workDir, 'staging'), { recursive: true, force: true })
    const contentChanged = report.diff?.contentChanged ?? true
    log(`published ${built.index.length} agreements to ${dataDir} (${contentChanged ? 'content changed' : 'content unchanged; meta refreshed'})`)
    return { ok: true, published: true, contentChanged, rawChanged, report, decision: decision.decision, stage: 'done' }
  } catch (e) {
    return fail((e as Error).stack ?? String(e))
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
    `errors=${r.report?.counts.error ?? ''}`, `changed_agreements=${r.report?.diff?.changed.length ?? ''}`,
  ].join('\n') + '\n')
}
