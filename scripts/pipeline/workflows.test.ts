/* The GitHub workflows parse and keep the properties production depends on. (CI also runs actionlint.) */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { REPO } from './test-helpers.ts'

type Step = { name?: string; uses?: string; run?: string; shell?: string; if?: string; id?: string; with?: Record<string, unknown>; env?: Record<string, string> }
type Job = { 'runs-on': string; needs?: string | string[]; outputs?: Record<string, string>; 'timeout-minutes'?: number; permissions?: Record<string, string>; steps: Step[]; if?: string; env?: Record<string, string> }
type Workflow = { name: string; on: Record<string, unknown>; permissions?: Record<string, string>; concurrency?: { group: string; 'cancel-in-progress': unknown }; jobs: Record<string, Job> }

const dir = join(REPO, '.github', 'workflows')
const load = (f: string) => parse(readFileSync(join(dir, f), 'utf8'), { strict: true, uniqueKeys: true }) as Workflow
const scripts = Object.keys(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts)

describe('workflows', () => {
  it('Node version: .nvmrc and package.json engines', () => {
    expect(readFileSync(join(REPO, '.nvmrc'), 'utf8').trim()).toBe('22')
    expect(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).engines).toEqual({ node: '>=22.18' })
  })

  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
  it('exist and parse as strict YAML', () => {
    expect(files.sort()).toEqual(['ci.yml', 'data-refresh.yml', 'freshness.yml'])
    for (const f of files) expect(() => load(f)).not.toThrow()
  })
  it.each(files)('%s: every job has a timeout, pinned actions, and only npm scripts that exist', (f) => {
    const w = load(f)
    expect(w.permissions).toEqual({ contents: 'read' }) // least privilege by default
    for (const [name, job] of Object.entries(w.jobs)) {
      expect(job['timeout-minutes'], `${f} ${name}`).toBeGreaterThan(0)
      for (const s of job.steps) {
        if (s.uses) expect(s.uses).toMatch(/^[\w-]+\/[\w-]+@v\d+$/)
        // One Node version source: .nvmrc (package.json engines states the minimum).
        if (s.uses?.startsWith('actions/setup-node@')) {
          expect(s.with?.['node-version-file'], `${f} ${name}`).toBe('.nvmrc')
          expect(s.with?.['node-version'], `${f} ${name}`).toBeUndefined()
        }
        // Step outputs go through env, never interpolated into a shell script.
        expect(s.run ?? '', `${f} ${name} ${s.name}`).not.toMatch(/\$\{\{\s*steps\./)
        // A byte cut can split a UTF-8 character: always follow `head -c` with iconv -c.
        for (const m of (s.run ?? '').matchAll(/^.*head -c.*$/gm)) expect(m[0], `${f} ${name}`).toMatch(/iconv -c -f utf-8 -t utf-8/)
        for (const m of (s.run ?? '').matchAll(/npm run ([\w:-]+)/g)) expect(scripts, `${f}: npm run ${m[1]}`).toContain(m[1])
      }
    }
  })

  it('data-refresh: daily cron + manual, serialized, read-only refresh, publishes only after the gates', () => {
    const w = load('data-refresh.yml')
    expect(w.on.schedule).toEqual([{ cron: '23 9 * * *' }]) // off the hour: GitHub delays :00 schedules most
    expect(w.on).toHaveProperty('workflow_dispatch')
    expect(w.concurrency).toMatchObject({ group: 'data-refresh', 'cancel-in-progress': false })
    const job = w.jobs.refresh
    // The job that runs npm ci and every third-party tool never holds a write token.
    for (const v of Object.values(job.permissions ?? {})) expect(v).not.toBe('write')
    const names = job.steps.map((s) => s.name ?? s.uses)
    const at = (re: RegExp) => names.findIndex((n) => re.test(n ?? ''))
    expect(at(/setup-node/)).toBeGreaterThan(-1)
    // CI-status gate: any event (the bot's data commits get CI via workflow_dispatch), failure stops the refresh.
    const head = job.steps[at(/CI status/)]
    expect(head.run).toMatch(/gh run list --workflow ci\.yml --branch/)
    expect(head.run).not.toMatch(/--event push/)
    expect(head.run).toMatch(/failure\|timed_out.*exit 1/)
    expect(job.steps[at(/^Install/)].run).toBe('npm ci')
    const fetch = job.steps[at(/^Fetch/)]
    expect(fetch.run).toMatch(/^npm run fetch\b/)
    expect(fetch.run).not.toMatch(/--skip-suites/) // production always runs the app suites against staged data
    expect(fetch.run).toMatch(/--no-auto-renormalize/) // a NORMALIZE_VERSION bump goes to review, never auto-publishes
    // The pipeline makes the release decision; a review decision is staged for a PR instead of failing the run.
    expect(fetch.env?.DATA_REFRESH_ON_REVIEW).toBe('pr')
    const decision = job.steps[at(/strict gate/)]
    expect(at(/strict gate/)).toBeGreaterThan(at(/^Fetch/))
    expect(decision.id).toBe('decision')
    expect(decision.env?.PIPELINE_DECISION).toBe(`\${{ steps.${fetch.id}.outputs.decision }}`)
    expect(decision.run).not.toMatch(/--decision-out/) // no such flag: the decision comes from the pipeline
    expect(decision.run).toMatch(/decision=review/) // missing/invalid decision fails safe to review
    expect(job.outputs?.decision).toBe('${{ steps.decision.outputs.decision }}')
    const upload = job.steps[at(/^Upload data for the publish job/)]
    expect(at(/^Upload data for the publish job/)).toBeGreaterThan(at(/strict gate/))
    expect(upload.if).toMatch(/!inputs\.dry_run/)
    expect(upload.if).not.toMatch(/always|failure/)
    expect(job.steps[at(/^Upload reports/)].if).toBe('always()')
    expect(job.env?.DATA_ACCEPT_LARGE_CHANGE).toMatch(/inputs\.accept_large_change/)

    // publish: write token, runs only after a successful refresh, never in a dry run, never runs npm.
    const pub = w.jobs.publish
    expect(pub.needs).toBe('refresh')
    expect(pub.if).toMatch(/needs\.refresh\.result == 'success'/)
    expect(pub.if).toMatch(/!inputs\.dry_run/)
    expect(pub.permissions).toMatchObject({ contents: 'write', 'pull-requests': 'write' })
    for (const s of pub.steps) expect(s.run ?? '').not.toMatch(/\bnpm\b/)
    expect(pub.env?.DECISION).toBe('${{ needs.refresh.outputs.decision }}')
    const pnames = pub.steps.map((s) => s.name ?? s.uses)
    const route = pub.steps[pnames.findIndex((n) => /^Choose the route/.test(n ?? ''))]
    // Anything but an explicit publish, and every override, goes to a review PR.
    expect(route.run).toMatch(/"\$DECISION" != "publish"/)
    expect(route.run).toMatch(/ACCEPTED.*route=review/)
    const commit = pub.steps[pnames.findIndex((n) => /^Commit/.test(n ?? ''))]
    expect(commit).toBeDefined()
    expect(commit.if ?? '').not.toMatch(/always|failure/)
    // Auto-merge only on the automerge route (decision=publish in PR mode), never for review.
    const merges = [...(commit.run ?? '').matchAll(/^.*gh pr merge.*$/gm)].map((m) => m[0])
    expect(merges.length).toBeGreaterThan(0)
    for (const m of merges) expect(m).toMatch(/"\$ROUTE" = "automerge"/)
    // Superseded data-refresh/* PRs are closed on the push route too (else merging one rolls data back),
    // same-repository only, and a failed close does not fail the job.
    const crun = commit.run ?? ''
    const push = crun.slice(crun.indexOf('if [ "$ROUTE" = "push" ]; then\n'))
    expect(push.slice(0, push.indexOf('exit 0'))).toMatch(/\bsupersede\b/)
    expect(crun).toMatch(/isCrossRepository == false/)
    expect(crun).toMatch(/gh pr close[^\n]*\|\|/)

    // notify: failure issue whenever any job failed or was cancelled.
    const notify = w.jobs.notify
    expect(notify.if).toMatch(/always\(\)/)
    expect(notify.if).toMatch(/needs\.\*\.result/)
    expect(notify.permissions).toMatchObject({ issues: 'write' })
    const issue = notify.steps.find((s) => /failure issue \(last good/.test(s.name ?? ''))!
    expect(issue.run).toMatch(/data-refresh-failure/)
  })

  it('ci: push/PR run typecheck, tests, smoke, build and the committed-data gate; nightly runs the oracle stress', () => {
    const w = load('ci.yml')
    expect(w.on).toHaveProperty('push')
    expect(w.on).toHaveProperty('pull_request')
    const runs = w.jobs.test.steps.map((s) => s.run ?? '')
    for (const cmd of ['npm ci', 'npx tsc -b', 'npx tsc -p tests/independent', 'npx vitest run', 'node scripts/smoke.mjs', 'npm run build', 'npm run validate:data:ci']) expect(runs).toContain(cmd)
    const stress = w.jobs['oracle-stress']
    expect(stress.if).toMatch(/schedule/)
    const step = stress.steps.find((s) => /solve\.test/.test(s.run ?? ''))!
    expect(step.env).toEqual({ ORACLE_CASES: '20000', ORDER_CASES: '20000' })
  })

  it('freshness: a non-numeric FRESHNESS_MAX_HOURS fails loudly instead of disabling the monitor', () => {
    const w = load('freshness.yml')
    const age = w.jobs.check.steps.find((s) => s.id === 'age')!
    expect(age.run).toMatch(/\$MAX_HOURS" =~ \^\[0-9\]\{1,6\}\$/)
    // GitHub's default `bash -e` would end the step on a failed live fetch before `stale=` is written
    expect(age.shell).toBe('bash --noprofile --norc {0}')
    expect(age.run).not.toMatch(/set -[a-z]*e/)
    expect(age.run).toMatch(/::error title=FRESHNESS_MAX_HOURS::[^\n]*\n\s*exit 1/)
  })
})
