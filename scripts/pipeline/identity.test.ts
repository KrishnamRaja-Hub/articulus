/* Payload identity (C-2), mandatory raw store (H-1), institution changes (M-7), acknowledgements (L-4), response cap (L-8). */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { assistClient } from './assist-client.ts'
import { PIPELINE, httpConfig } from './config.ts'
import { PayloadIdentityError, fetchRaw } from './fetch.ts'
import { defaultDataset, setIdentity, startMockAssist, type MockAssist, type MockOptions } from './mock-assist.ts'
import { checkRawReproducible } from './raw-check.ts'
import { ackRefusal, validateData, type Report } from './validate.ts'
import { NOW, cleanupTmp, fastEnv, readJson, run, snapshot, tmp } from './test-helpers.ts'

let mock: MockAssist | undefined
afterEach(async () => { await mock?.close(); mock = undefined })
afterAll(cleanupTmp)
const serve = async (o: MockOptions = {}) => (mock = await startMockAssist(o))
const DA = 113, FH = 51
const BME = '79-mechanical-engineering-b-s.json'
const isBme = (q: { receivingId: number; label: string }) => q.receivingId === 79 && /^Mechanical/.test(q.label)
const fetchWith = async (o: MockOptions, env: Record<string, string> = {}) => {
  const m = await serve(o)
  const client = assistClient(httpConfig(fastEnv(m.url, env)))
  const out = await fetchRaw(client, PIPELINE, { base: m.url, now: NOW, log: () => {} }).then((b) => ({ b, e: undefined }), (e: unknown) => ({ b: undefined, e }))
  return { ...out, client }
}
const published = async (o: MockOptions = {}) => {
  const m = await serve(o)
  const data = join(tmp('ident'), 'data')
  const r = await run(m.url, data)
  expect(r.ok, r.error).toBe(true)
  return { m, data }
}
const errs = (r: Report) => r.findings.filter((f) => f.severity === 'error')

describe('C-2: payload identity is checked against the request', () => {
  const scenarios: [string, MockOptions['rewrite'], RegExp][] = [
    ['F23 wrong academic year', (p, q) => { if (isBme(q) && q.sendingId === FH) setIdentity(p, 'academicYear', { id: 76, code: '2025-2026' }) }, /academicYear 76\/2025-2026 \(requested 77\/2026-2027\)/],
    ['F25 wrong receiving UC', (p, q) => { if (isBme(q) && q.sendingId === FH) setIdentity(p, 'receivingInstitution', { id: 117 }) }, /receivingInstitution 117 \(requested 79\)/],
    ['F41 De Anza and Foothill swapped', (p, q) => {
      if (isBme(q) && (q.sendingId === DA || q.sendingId === FH)) setIdentity(p, 'sendingInstitution', { id: q.sendingId === DA ? FH : DA, isCommunityCollege: true })
    }, /sendingInstitution 51 \(requested 113\)/],
    ['wrong major report', (p, q) => { if (isBme(q) && q.sendingId === FH) p.result.name = 'Civil Engineering, B.S.' }, /name "Civil Engineering, B\.S\." \(requested report "Mechanical Engineering, B\.S\."\)/],
  ]
  it.each(scenarios)('%s: fetch fails with every mismatch counted', async (_, rewrite, msg) => {
    const { b, e, client } = await fetchWith({ rewrite })
    expect(b).toBeUndefined()
    expect(e).toBeInstanceOf(PayloadIdentityError)
    expect((e as Error).message).toMatch(msg)
    expect(client.stats.identityMismatches).toBe((e as PayloadIdentityError).mismatches.length)
    expect(client.stats.identityMismatches).toBeGreaterThan(0)
  })
  it('the swap is reported for both colleges', async () => {
    const { e } = await fetchWith({ rewrite: scenarios[2][1] })
    expect((e as PayloadIdentityError).mismatches).toHaveLength(2)
  })
  it('correct payloads pass with no mismatches', async () => {
    const { b, client } = await fetchWith({})
    expect(b?.agreements.length).toBeGreaterThan(0)
    expect(client.stats.identityMismatches).toBe(0)
  })
  it('a mismatched payload is never stored or published: data/ stays byte-for-byte untouched', async () => {
    const { m, data } = await published()
    await m.close(); mock = undefined
    const before = snapshot(data)
    const m2 = await serve({ rewrite: scenarios[2][1] })
    const r = await run(m2.url, data)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('fetch')
    expect(r.error).toMatch(/identity mismatch/)
    expect(snapshot(data)).toEqual(before)
    expect(existsSync(join(data, '..', 'work', 'staging', 'data', 'raw'))).toBe(false)
  })
  it('the gate re-checks stored payloads against the raw manifest (tampered with a recomputed checksum)', async () => {
    const { data } = await published()
    const dir = join(data, 'raw'), gz = join(dir, 'agreements', `${BME}.gz`)
    const payloads = JSON.parse(gunzipSync(readFileSync(gz)).toString('utf8'))
    const [a, b] = [payloads[0].result.sendingInstitution, payloads[1].result.sendingInstitution]
    payloads[0].result.sendingInstitution = b; payloads[1].result.sendingInstitution = a
    const buf = gzipSync(Buffer.from(JSON.stringify(payloads)))
    writeFileSync(gz, buf)
    const manifest = readJson(join(dir, 'manifest.json'))
    manifest.agreements.find((x: { file: string }) => x.file === BME).sha256 = createHash('sha256').update(buf).digest('hex')
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    const r = validateData(data, { cfg: PIPELINE, mode: 'ci', now: NOW })
    checkRawReproducible(data, PIPELINE, r)
    expect(r.passed).toBe(false)
    expect(errs(r).some((f) => f.file === BME && /C-2 identity/.test(f.message))).toBe(true)
  })
})

describe('H-1: the raw store is mandatory for current data', () => {
  it('deleting data/raw fails the CI gate for pipeline-built data', async () => {
    const { data } = await published()
    rmSync(join(data, 'raw'), { recursive: true })
    for (const mode of ['ci', 'publish'] as const) {
      const r = validateData(data, { cfg: PIPELINE, mode, now: NOW })
      checkRawReproducible(data, PIPELINE, r)
      expect(r.passed).toBe(false)
      expect(errs(r).map((f) => f.check)).toContain('raw.reproducible')
    }
  })
  it('legacy data never fetched by the pipeline is reported as legacy in CI, not failed', async () => {
    const { data } = await published()
    rmSync(join(data, 'raw'), { recursive: true })
    const meta = readJson(join(data, 'meta.json'))
    writeFileSync(join(data, 'meta.json'), JSON.stringify({ ...meta, normalizeVersion: 1, fetchedAt: null }))
    const r = validateData(data, { cfg: PIPELINE, mode: 'ci', now: NOW })
    checkRawReproducible(data, PIPELINE, r)
    expect(r.findings.find((f) => f.check === 'raw.reproducible')?.severity).toBe('legacy')
    // Old normalize version but fetched by the pipeline: raw must exist.
    writeFileSync(join(data, 'meta.json'), JSON.stringify({ ...meta, normalizeVersion: 1 }))
    const r2 = validateData(data, { cfg: PIPELINE, mode: 'ci', now: NOW })
    checkRawReproducible(data, PIPELINE, r2)
    expect(errs(r2).map((f) => f.check)).toContain('raw.reproducible')
  })
})

describe('M-7: institution field changes are flagged for review', () => {
  const flipped = () => {
    const ds = defaultDataset()
    ds.institutions.find((i) => i.id === DA)!.termType = 2 // De Anza: quarter -> semester
    ds.institutions.find((i) => i.id === FH)!.names[0].name = 'Foothill Community College'
    return ds
  }
  it('a terms flip is an error (data untouched); a rename is a warning; the override accepts it', async () => {
    const { m, data } = await published()
    await m.close(); mock = undefined
    const before = snapshot(data)
    const m2 = await serve({ dataset: flipped() })
    const r = await run(m2.url, data)
    expect(r.ok).toBe(false)
    expect(snapshot(data)).toEqual(before)
    const f = r.report!.findings
    expect(f.find((x) => x.check === 'institutions.changed-meaning')).toMatchObject({ severity: 'error', message: expect.stringMatching(/113.*terms changed "quarter" -> "semester"/) })
    expect(f.filter((x) => x.check === 'institutions.renamed').map((x) => [x.severity, /51.*name changed/.test(x.message)])).toEqual([['warning', true]]) // short stays "Foothill"
    const ok = await run(m2.url, data, { acceptDiff: true })
    expect(ok.ok, ok.error).toBe(true)
    expect(readJson(join(data, 'institutions.json')).find((i: { id: number }) => i.id === DA).terms).toBe('semester')
  })
  it('unchanged institutions raise nothing', async () => {
    const { data } = await published()
    const prev = join(tmp('prev'), 'data')
    cpSync(data, prev, { recursive: true })
    const r = validateData(data, { cfg: PIPELINE, mode: 'publish', now: NOW, prevDir: prev })
    expect(r.findings.filter((x) => x.check.startsWith('institutions.'))).toEqual([])
  })
})

describe('L-4: acknowledgements expire and cannot cover canaries or schema checks', () => {
  const f = (check: string, file?: string) => ({ check, severity: 'error' as const, message: 'm', file })
  it.each([
    [f('heuristic.no-required-math', BME), 'reviewed; expires 2026-12-31', null],
    [f('heuristic.no-required-math', BME), 'reviewed', /expires YYYY-MM-DD/],
    [f('heuristic.no-required-math', BME), 'reviewed; expires 2026-09-01', /expired/],
    [f('heuristic.no-required-math', BME), 'expires 2026-02-30', /expires YYYY-MM-DD/],
    [f('canary.bme.physics-split', BME), 'expires 2026-12-31', /cannot be acknowledged/],
    [f('agreement.schema', BME), 'expires 2026-12-31', /cannot be acknowledged/],
    [f('diff.total-groups-drop'), 'expires 2026-12-31', /one agreement file/],
  ])('%j with "%s"', (finding, reason, want) => {
    const got = ackRefusal(finding, reason, NOW)
    if (want === null) expect(got).toBeNull()
    else expect(got).toMatch(want)
  })
})

describe('L-8: response size cap', () => {
  it('an oversized payload fails the fetch instead of being parsed', async () => {
    const { e } = await fetchWith({ padBytes: 300_000 }, { ASSIST_MAX_RESPONSE_BYTES: '200000' })
    expect((e as Error).message).toMatch(/exceeds ASSIST_MAX_RESPONSE_BYTES/)
  })
})
