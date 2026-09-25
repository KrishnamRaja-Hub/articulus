/* End-to-end: the whole pipeline against the local mock ASSIST. Never touches assist.org or the repo's data/. */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { NORMALIZE_VERSION } from '../../src/engine/normalize.ts'
import { PIPELINE } from './config.ts'
import { defaultDataset, startMockAssist, title, type MockAssist, type MockOptions } from './mock-assist.ts'
import { runPipeline } from './run.ts'
import { NOW, REPO, cleanupTmp, fastEnv, readJson, run, snapshot, tmp } from './test-helpers.ts'

let mock: MockAssist | undefined
afterEach(async () => { await mock?.close(); mock = undefined })
afterAll(cleanupTmp)
const serve = async (o: MockOptions = {}) => (mock = await startMockAssist(o))
/** Fault matcher for one major's articulation payloads (the mock's report keys are opaque, like ASSIST's). */
const payloadOf = (label: string) => new RegExp(`/api/articulation/Agreements\\?key=.*${Buffer.from(label).toString('hex')}$`)
/** A data dir with a first good publish from the default mock data set. */
const published = async () => {
  const m = await serve()
  const data = join(tmp('e2e'), 'data')
  const r = await run(m.url, data)
  expect(r.ok, r.error).toBe(true)
  return { m, data }
}

const node = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ code: number; out: string }>((resolve) => {
  const p = spawn(process.execPath, args, { cwd: REPO, env: { ...process.env, ...env } })
  let out = ''
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
  p.on('close', (code) => resolve({ code: code ?? -1, out }))
})

describe('pipeline end to end (mock ASSIST)', () => {
  it('happy path via the CLI: writes agreements, index, institutions, raw, meta.json and the report', async () => {
    const m = await serve()
    const dir = tmp('cli'), data = join(dir, 'data')
    const args = ['scripts/fetch-assist.ts', '--skip-suites', '--first-publish', '--data-dir', data, '--work-dir', join(dir, 'work')]
    // Fix 8: --first-publish alone never publishes (a first publish is always review) ...
    const refused = await node(args, fastEnv(m.url, { DATA_REFRESH_ON_REVIEW: '' }))
    expect(refused.code, refused.out).toBe(1)
    expect(refused.out).toMatch(/release decision: review/)
    expect(refused.out).toMatch(/DATA_REFRESH_ON_REVIEW=pr/)
    expect(existsSync(data)).toBe(false)
    // ... not even with --accept-large-change ...
    const accepted = await node([...args, '--accept-large-change'], fastEnv(m.url, { DATA_REFRESH_ON_REVIEW: '' }))
    expect(accepted.code, accepted.out).toBe(1)
    expect(existsSync(data)).toBe(false)
    // ... it is staged for a reviewed PR through the review path.
    const { code, out } = await node(args, fastEnv(m.url, { DATA_REFRESH_ON_REVIEW: 'pr' }))
    expect(code, out).toBe(0)
    expect(out).toMatch(/release decision: review/)
    const meta = readJson(join(data, 'meta.json'))
    expect(meta).toMatchObject({ schema: 1, normalizeVersion: NORMALIZE_VERSION, academicYear: { id: 77, code: '2026-2027' }, validation: { passed: true, report: 'data/validation-report.json' } })
    const index = readJson(join(data, 'index.json'))
    expect(meta.agreements).toBe(index.length)
    expect(index.map((e: { file: string }) => e.file)).toContain('79-mechanical-engineering-b-s.json')
    expect(index.some((e: { major: string }) => /History/.test(e.major))).toBe(false) // major filter
    for (const e of index) {
      expect(existsSync(join(data, 'agreements', e.file))).toBe(true)
      expect(existsSync(join(data, 'raw', 'agreements', `${e.file}.gz`))).toBe(true)
    }
    const report = readJson(join(data, 'validation-report.json'))
    expect(report.passed).toBe(true)
    expect(report.canaries.filter((c: { result: string }) => c.result !== 'pass')).toEqual([])
    expect(meta.validation.checks).toBe(report.checks)
    // Every agreement request carried the academic year discovered from /api/AcademicYears.
    expect(m.log.filter((p) => p.startsWith('/api/agreements')).every((p) => p.includes('academicYearId=77'))).toBe(true)

    // The strict gate passes on what was published, including raw reproducibility.
    const v = await node(['scripts/validate-data.ts', '--data-dir', data, '--report', join(dir, 'v.json')], {})
    expect(v.code, v.out).toBe(0)
  })

  it('a second run with unchanged ASSIST data changes only meta.json and the report', async () => {
    const { m, data } = await published()
    const before = snapshot(data)
    const r = await run(m.url, data, { now: new Date(NOW.getTime() + 86_400_000) })
    expect(r.ok, r.error).toBe(true)
    expect(r.contentChanged).toBe(false)
    expect(r.rawChanged).toBe(false)
    const after = snapshot(data)
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]).sort()
    expect(changed).toEqual(['meta.json', 'raw/manifest.json', 'validation-report.json']) // manifest: fetchedAt only
  })

  it.each([
    ['persistent 5xx on one payload', { faults: [{ match: payloadOf('Mechanical Engineering, B.S.'), status: 502 }] }, /HTTP 502/],
    ['5xx on one listing (the old fetcher skipped it silently)', { faults: [{ match: 'receivingInstitutionId=7&sendingInstitutionId=51', status: 500 }] }, /HTTP 500/],
    ['timeouts', { faults: [{ match: '/api/institutions', hangMs: 5_000 }] }, /timeout/],
    ['404 on a payload', { faults: [{ match: payloadOf('Computer Science, B.S.'), status: 404 }] }, /HTTP 404/],
    ['AcademicYears shape change', { dataset: { ...defaultDataset(), academicYears: { years: [] } } }, /AcademicYears/],
    ['only a year two back is listed (M-6: no carry-over past one year)', { dataset: { ...defaultDataset(), academicYears: [{ Id: 75, FallYear: 2024 }] } }, /neither 2026-2027 .* nor the carry-over year 2025-2026/],
    ['neither the year in effect nor the prior year has published agreements', { publishedYearIds: [75] }, /no agreements matched the major filter/],
  ] as [string, MockOptions, RegExp][])('partial fetch (%s) fails and leaves published data untouched', async (_, opts, err) => {
    const { m, data } = await published()
    await m.close(); mock = undefined
    const m2 = await serve(opts)
    const before = snapshot(data)
    const r = await run(m2.url, data)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('fetch')
    expect(r.error).toMatch(err)
    expect(snapshot(data)).toEqual(before)
    expect(readFileSync(join(data, '..', 'work', 'failure.md'), 'utf8')).toMatch(/failed at stage `fetch`/)
  })

  describe('July 1 rollover: ASSIST has not published the new year yet (M-6)', () => {
    const expectCarried = (data: string) => {
      const meta = readJson(join(data, 'meta.json'))
      expect(meta).toMatchObject({ academicYear: { id: 76, code: '2025-2026' }, yearInEffect: '2026-2027', carriedOver: true, validation: { passed: true } })
      const index = readJson(join(data, 'index.json'))
      for (const e of index) expect(readJson(join(data, 'agreements', e.file)).year).toBe('2025-2026')
      const report = readJson(join(data, 'validation-report.json'))
      expect(report.findings.filter((f: { check: string }) => f.check === 'meta.academic-year'))
        .toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringMatching(/carried over: 2026-2027 agreements are not published/) })])
    }

    it('mock lists only the old year: publishes it, marked carriedOver', async () => {
      const m = await serve({ dataset: { ...defaultDataset(), academicYears: [{ Id: 75, FallYear: 2024 }, { Id: 76, FallYear: 2025 }] } })
      const data = join(tmp('carry'), 'data')
      const r = await run(m.url, data)
      expect(r.ok, r.error).toBe(true)
      expectCarried(data)
      expect(m.log.filter((p) => p.startsWith('/api/agreements')).every((p) => p.includes('academicYearId=76'))).toBe(true)
    })

    it('new year listed but no agreements published for it: falls back to the prior year, marked carriedOver', async () => {
      const m = await serve({ publishedYearIds: [75, 76] })
      const data = join(tmp('carry2'), 'data')
      const r = await run(m.url, data)
      expect(r.ok, r.error).toBe(true)
      expectCarried(data)
      const listings = m.log.filter((p) => p.startsWith('/api/agreements'))
      expect(listings.some((p) => p.includes('academicYearId=77'))).toBe(true) // tried first
      expect(listings.filter((p) => p.includes('academicYearId=76')).length).toBeGreaterThan(0)
    })

    it('once ASSIST publishes the new year, the next run switches to it and clears the mark', async () => {
      const m = await serve({ publishedYearIds: [76] })
      const data = join(tmp('carry3'), 'data')
      expect((await run(m.url, data)).ok).toBe(true)
      await m.close(); mock = undefined
      const m2 = await serve()
      const r = await run(m2.url, data, { acceptDiff: true })
      expect(r.ok, r.error).toBe(true)
      expect(readJson(join(data, 'meta.json'))).toMatchObject({ academicYear: { id: 77, code: '2026-2027' }, yearInEffect: '2026-2027', carriedOver: false })
    })

    it('before July 1 the prior year is simply the year in effect (Jun 30 UTC), not a carry-over', async () => {
      const m = await serve()
      const data = join(tmp('jun30'), 'data')
      const r = await run(m.url, data, { now: new Date('2026-06-30T23:59:59Z') })
      expect(r.ok, r.error).toBe(true)
      expect(readJson(join(data, 'meta.json'))).toMatchObject({ academicYear: { id: 76, code: '2025-2026' }, yearInEffect: '2025-2026', carriedOver: false })
    })
  })

  it('transient 5xx and 429s are retried and the run still publishes', async () => {
    const m = await serve({ rateLimitPerSession: 7, faults: [{ match: '/api/articulation/Agreements', status: 503, times: 2 }] })
    const r = await run(m.url, join(tmp('retry'), 'data'))
    expect(r.ok, r.error).toBe(true)
  })

  it('the CLI exits 2 on a fetch failure and writes nothing', async () => {
    const m = await serve({ faults: [{ match: '/api/institutions', status: 500 }] })
    const dir = tmp('cli-fail'), data = join(dir, 'data')
    const { code } = await node(['scripts/fetch-assist.ts', '--skip-suites', '--first-publish', '--data-dir', data, '--work-dir', join(dir, 'work')], fastEnv(m.url))
    expect(code).toBe(2)
    expect(existsSync(data)).toBe(false)
  })

  it('a validation failure (CRITICAL-1 shape: calculus only recommended) is not published', async () => {
    const { m, data } = await published()
    const ds = m.opts.dataset
    const ucla = ds.majors.find((x) => x.receivingId === 117)!
    const assets = ucla.assets
    // The F-03 title shift: "recommended" lands on the calculus groups, the upper-division group becomes required.
    ucla.assets = (c) => [title(0.5, 'STRONGLY RECOMMENDED COURSES'), ...(assets(c) as { type: string; position: number; content?: string }[])
      .map((x) => (x.type === 'RequirementTitle' && x.position === 3 ? { ...x, content: 'UPPER DIVISION' } : x))]
    const before = snapshot(data)
    const r = await run(m.url, data)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('validate')
    const failed = r.report!.findings.filter((f) => f.severity === 'error').map((f) => f.check)
    expect(failed).toEqual(expect.arrayContaining(['canary.ucla-me.math31a-required', 'heuristic.recommended-math', 'heuristic.no-required-math']))
    expect(snapshot(data)).toEqual(before)
    expect(readJson(join(data, '..', 'work', 'validation-report.json')).passed).toBe(false)
  })

  it('a canary failure blocks publishing (Berkeley ME PHYSICS 7B no longer split-sensitive)', async () => {
    const { m, data } = await published()
    const bme = m.opts.dataset.majors.find((x) => x.receivingId === 79 && /Mechanical/.test(x.label))!
    const row = bme.rows.find((r) => r.cell.id === 'PHYSICS7B')!
    row.by = { ...row.by, 51: [[['PHYS', '4B']], [['PHYS', '4C']]] } // Foothill "Or": either course alone
    const r = await run(m.url, data)
    expect(r.ok).toBe(false)
    expect(r.report!.findings.filter((f) => f.severity === 'error').map((f) => f.check)).toContain('canary.berkeley-me.phys-split-blocks')
  })

  describe('diff guard', () => {
    it('refuses when an agreement disappears; DATA_ACCEPT_LARGE_CHANGE=1 accepts it', async () => {
      const { m, data } = await published()
      const ds = m.opts.dataset
      ds.majors = ds.majors.filter((x) => !(x.receivingId === 120 && x.label === 'Computer Science, B.S.'))
      const before = snapshot(data)
      const r = await run(m.url, data)
      expect(r.ok).toBe(false)
      expect(r.report!.findings.filter((f) => f.severity === 'error').map((f) => f.check)).toContain('diff.agreement-removed')
      expect(snapshot(data)).toEqual(before)

      const ok = await run(m.url, data, { envExtra: { [PIPELINE.diff.overrideEnv]: '1' } })
      expect(ok.ok, ok.error).toBe(true)
      expect(ok.report!.diff!.overridden).toBe(true)
      expect(readJson(join(data, 'index.json')).some((e: { file: string }) => e.file === '120-computer-science-b-s.json')).toBe(false)
    })
    it('refuses when a college drops out of an agreement and when many groups vanish', async () => {
      const { m, data } = await published()
      const bme = m.opts.dataset.majors.find((x) => x.receivingId === 79 && /Mechanical/.test(x.label))!
      bme.colleges = [113, 51]
      for (const x of m.opts.dataset.majors) for (const row of x.rows) delete row.by[137]
      const r = await run(m.url, data)
      const errs = r.report!.findings.filter((f) => f.severity === 'error').map((f) => f.check)
      expect(r.ok).toBe(false)
      expect(errs).toContain('diff.college-removed')
      expect(errs).toContain('diff.groups-drop')
    })
    it('a 404 listing means "no agreements for that pair", and the guard notices the college it drops', async () => {
      const { m, data } = await published()
      m.opts.faults.push({ match: 'receivingInstitutionId=79&sendingInstitutionId=137', status: 404 })
      const r = await run(m.url, data)
      expect(r.stage).toBe('validate')
      expect(r.report!.findings.filter((f) => f.severity === 'error').map((f) => f.check)).toContain('diff.college-removed')
    })
    it('refuses when the required-row count jumps', async () => {
      const { m, data } = await published()
      const dv = m.opts.dataset.majors.find((x) => x.receivingId === 89)!
      const assets = dv.assets
      // "choose 1 of" becomes "take all" (the F-02 shape): 2 -> 5 required rows
      dv.assets = (c) => JSON.parse(JSON.stringify(assets(c)).replace(/,"advisements":\[[^\]]*\]/g, ''))
      const r = await run(m.url, data)
      expect(r.ok).toBe(false)
      expect(r.report!.findings.filter((f) => f.severity === 'error').map((f) => f.check)).toContain('diff.required-rows')
    })
  })

  describe('app suites gate', () => {
    it('a failing suite blocks publishing; passing suites publish', async () => {
      const m = await serve()
      const data = join(tmp('suites'), 'data')
      const bad = await run(m.url, data, { skipSuites: false, suites: [{ name: 'always fails', command: [process.execPath, '-e', 'process.exit(3)'] }] })
      expect(bad.ok).toBe(false)
      expect(bad.stage).toBe('suites')
      expect(existsSync(data)).toBe(false)
      // The suite runs in a shadow repo whose data/ is the staged data, never the real data/.
      const probe = `const fs=require('fs');process.exit(fs.existsSync('data/raw')||!fs.existsSync('data/agreements/79-mechanical-engineering-b-s.json')||!fs.existsSync('node_modules/.bin/vitest')?1:0)`
      const good = await run(m.url, data, { skipSuites: false, suites: [{ name: 'probe', command: [process.execPath, '-e', probe] }] })
      expect(good.ok, good.error).toBe(true)
      expect(good.report!.suites).toMatchObject([{ name: 'probe', ok: true }])
    })
  })

  describe('renormalize', () => {
    it('rebuilds data/ from the raw store offline and restores a hand-edited agreement', async () => {
      const { m, data } = await published()
      await m.close(); mock = undefined // no network from here on
      const file = join(data, 'agreements', '79-mechanical-engineering-b-s.json')
      const good = readFileSync(file, 'utf8')
      const meta0 = readJson(join(data, 'meta.json'))
      writeFileSync(file, good.replace('"PHYSICS 7B"', '"PHYSICS 7X"'))
      const dir = join(data, '..')
      const v = await node(['scripts/validate-data.ts', '--data-dir', data, '--report', join(dir, 'v.json')], {})
      expect(v.code).toBe(1)
      expect(v.out).toMatch(/raw\.reproducible/)

      const r = await node(['scripts/renormalize.ts', '--skip-suites', '--data-dir', data, '--work-dir', join(dir, 'work')], {})
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(file, 'utf8')).toBe(good)
      const meta = readJson(join(data, 'meta.json'))
      expect(meta.fetchedAt).toBe(meta0.fetchedAt) // renormalize never pretends to have fetched
      expect(meta.normalizeVersion).toBe(NORMALIZE_VERSION)
    })
    it('fails clearly without a raw store (legacy data)', async () => {
      const dir = tmp('renorm-legacy'), data = join(dir, 'data')
      const r = await runPipeline({ source: 'raw', repoRoot: REPO, dataDir: join(REPO, 'data'), workDir: join(dir, 'work'), now: NOW, skipSuites: true, dryRun: true, log: () => {} })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/no raw payloads/)
      expect(existsSync(data)).toBe(false)
    })
    it('detects a corrupted raw file by checksum', async () => {
      const { m, data } = await published()
      await m.close(); mock = undefined
      writeFileSync(join(data, 'raw', 'agreements', '79-mechanical-engineering-b-s.json.gz'), 'garbage')
      const r = await runPipeline({ source: 'raw', repoRoot: REPO, dataDir: data, workDir: join(data, '..', 'work'), now: NOW, skipSuites: true, log: () => {} })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/checksum/)
      rmSync(join(data, '..'), { recursive: true, force: true })
    })
  })
})
