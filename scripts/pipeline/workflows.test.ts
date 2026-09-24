/* The GitHub workflows parse and keep the properties production depends on. (CI also runs actionlint.) */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { REPO } from './test-helpers.ts'

type Step = { name?: string; uses?: string; run?: string; if?: string; id?: string; with?: Record<string, unknown>; env?: Record<string, string> }
type Job = { 'runs-on': string; 'timeout-minutes'?: number; permissions?: Record<string, string>; steps: Step[]; if?: string; env?: Record<string, string> }
type Workflow = { name: string; on: Record<string, unknown>; permissions?: Record<string, string>; concurrency?: { group: string; 'cancel-in-progress': unknown }; jobs: Record<string, Job> }

const dir = join(REPO, '.github', 'workflows')
const load = (f: string) => parse(readFileSync(join(dir, f), 'utf8'), { strict: true, uniqueKeys: true }) as Workflow
const scripts = Object.keys(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts)

describe('workflows', () => {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
  it('exist and parse as strict YAML', () => {
    expect(files.sort()).toEqual(['ci.yml', 'data-refresh.yml'])
    for (const f of files) expect(() => load(f)).not.toThrow()
  })
  it.each(files)('%s: every job has a timeout, pinned actions, and only npm scripts that exist', (f) => {
    const w = load(f)
    expect(w.permissions).toEqual({ contents: 'read' }) // least privilege by default
    for (const [name, job] of Object.entries(w.jobs)) {
      expect(job['timeout-minutes'], `${f} ${name}`).toBeGreaterThan(0)
      for (const s of job.steps) {
        if (s.uses) expect(s.uses).toMatch(/^[\w-]+\/[\w-]+@v\d+$/)
        for (const m of (s.run ?? '').matchAll(/npm run ([\w:-]+)/g)) expect(scripts, `${f}: npm run ${m[1]}`).toContain(m[1])
      }
    }
  })

  it('data-refresh: daily cron + manual, serialized, can commit and file issues, publishes only after the gates', () => {
    const w = load('data-refresh.yml')
    expect(w.on.schedule).toEqual([{ cron: '0 9 * * *' }])
    expect(w.on).toHaveProperty('workflow_dispatch')
    expect(w.concurrency).toMatchObject({ group: 'data-refresh', 'cancel-in-progress': false })
    const job = w.jobs.refresh
    expect(job.permissions).toMatchObject({ contents: 'write', issues: 'write' })
    const names = job.steps.map((s) => s.name ?? s.uses)
    const at = (re: RegExp) => names.findIndex((n) => re.test(n ?? ''))
    expect(at(/setup-node/)).toBeGreaterThan(-1)
    expect(job.steps[at(/setup-node/)].with?.['node-version']).toBe(22)
    expect(job.steps[at(/^Install/)].run).toBe('npm ci')
    const fetch = job.steps[at(/^Fetch/)]
    expect(fetch.run).toMatch(/^npm run fetch\b/)
    expect(fetch.run).not.toMatch(/--skip-suites/) // production always runs the app suites against staged data
    expect(at(/^Commit/)).toBeGreaterThan(at(/^Fetch/))
    expect(at(/^Commit/)).toBeGreaterThan(at(/strict gate/))
    // The commit step never runs after a failure (default success() condition), and never in a dry run.
    expect(job.steps[at(/^Commit/)].if).toMatch(/!inputs\.dry_run/)
    expect(job.steps[at(/^Commit/)].if).not.toMatch(/always|failure/)
    const issue = job.steps[at(/failure issue \(last good/)]
    expect(issue.if).toBe('failure()')
    expect(issue.run).toMatch(/data-refresh-failure/)
    expect(job.steps[at(/^Upload/)].if).toBe('always()')
    expect(job.env?.DATA_ACCEPT_LARGE_CHANGE).toMatch(/inputs\.accept_large_change/)
  })

  it('ci: push/PR run typecheck, tests, smoke, build and the committed-data gate; nightly runs the oracle stress', () => {
    const w = load('ci.yml')
    expect(w.on).toHaveProperty('push')
    expect(w.on).toHaveProperty('pull_request')
    const runs = w.jobs.test.steps.map((s) => s.run ?? '')
    for (const cmd of ['npm ci', 'npx tsc -b', 'npx vitest run', 'node scripts/smoke.mjs', 'npm run build', 'npm run validate:data:ci']) expect(runs).toContain(cmd)
    const stress = w.jobs['oracle-stress']
    expect(stress.if).toMatch(/schedule/)
    const step = stress.steps.find((s) => /solve\.test/.test(s.run ?? ''))!
    expect(step.env).toEqual({ ORACLE_CASES: '20000', ORDER_CASES: '20000' })
  })
})
