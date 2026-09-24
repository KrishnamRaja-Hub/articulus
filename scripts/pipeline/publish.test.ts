/* Publish safety: locking (concurrent runs), crash recovery, the no-baseline refusal, auto-renormalize, redaction. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { NORMALIZE_VERSION } from '../../src/engine/normalize.ts'
import { startMockAssist, type MockAssist } from './mock-assist.ts'
import { LockError, acquireLock, dataLockPath, recoverPublish, swapIn, treeHash, type SwapHook } from './publish.ts'
import { fenced, redact } from './run.ts'
import { cleanupTmp, readJson, run, snapshot, tmp } from './test-helpers.ts'

let mock: MockAssist | undefined
afterEach(async () => { await mock?.close(); mock = undefined })
afterAll(cleanupTmp)
const published = async () => {
  const m = (mock = await startMockAssist())
  const data = join(tmp('pub'), 'data')
  const r = await run(m.url, data)
  expect(r.ok, r.error).toBe(true)
  return { m, data }
}
/** A mock change the diff guard must refuse (college 137 vanishes). */
const dropCollege = (m: MockAssist) => { for (const x of m.opts.dataset.majors) for (const row of x.rows) delete row.by[137] }
const errors = (r: Awaited<ReturnType<typeof run>>) => r.report?.findings.filter((f) => f.severity === 'error').map((f) => f.check) ?? []
const siblings = (data: string) => readdirSync(dirname(data)).filter((f) => f.startsWith('.data'))
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!

describe('lock', () => {
  it('a live lock refuses; a dead-pid, torn or over-age lock is broken; release removes it', () => {
    const p = join(tmp('lock'), '.x.lock')
    const a = acquireLock(p, 'a')
    expect(() => acquireLock(p, 'b')).toThrow(LockError)
    a.release()
    expect(existsSync(p)).toBe(false)

    writeFileSync(p, JSON.stringify({ pid: deadPid(), host: hostname(), at: new Date().toISOString(), purpose: 'crashed' }))
    acquireLock(p, 'c').release()

    writeFileSync(p, JSON.stringify({ pid: process.pid, host: 'other-host', at: new Date(Date.now() - 7 * 3600_000).toISOString(), purpose: 'old' }))
    acquireLock(p, 'd').release()

    writeFileSync(p, '{"pid":')
    utimesSync(p, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))
    acquireLock(p, 'e').release()
    expect(existsSync(p)).toBe(false)
  })

  it('concurrent runs on the same data dir: exactly one runs, the other fails at `lock` and changes nothing', async () => {
    const { m, data } = await published()
    const before = snapshot(data)
    const [a, b] = await Promise.all([run(m.url, data), run(m.url, data)])
    expect([a.stage, b.stage].sort()).toEqual(['done', 'lock'])
    const loser = a.stage === 'lock' ? a : b
    expect(loser.ok).toBe(false)
    expect(loser.error).toMatch(/another pipeline run holds/)
    expect(readJson(join(data, 'index.json'))).toEqual(JSON.parse(Buffer.from(before['index.json'], 'base64').toString()))
    expect(existsSync(dataLockPath(data))).toBe(false)
    expect(existsSync(join(data, '..', 'work', '.lock'))).toBe(false)
  })

  it('H-2: a rejected run cannot leak into another run publishing to a different data dir through a shared work dir', async () => {
    const { m, data } = await published()
    const work = join(data, '..', 'work'), other = join(tmp('pub2'), 'data')
    // A run on another data dir sharing the work dir is serialized by the work-dir lock.
    const [a, b] = await Promise.all([run(m.url, data, { workDir: work }), run(m.url, other, { workDir: work })])
    expect([a.stage, b.stage].sort()).toEqual(['done', 'lock'])
    // Sequentially: a rejected run leaves nothing a later run could pick up (per-run staging, removed afterwards).
    dropCollege(m)
    const bad = await run(m.url, data)
    expect(errors(bad)).toContainEqual(expect.stringMatching(/^diff\./))
    expect(readdirSync(work).filter((f) => f.startsWith('staging'))).toEqual([])
  })

  it('a lock left by a killed run does not block the next run', async () => {
    const { m, data } = await published()
    writeFileSync(dataLockPath(data), JSON.stringify({ pid: deadPid(), host: hostname(), at: new Date().toISOString(), purpose: 'killed' }))
    mkdirSync(join(data, '..', 'work', 'staging-zombie', 'data'), { recursive: true })
    const r = await run(m.url, data)
    expect(r.ok, r.error).toBe(true)
    expect(existsSync(join(data, '..', 'work', 'staging-zombie'))).toBe(false)
  })
})

describe('crash safety', () => {
  const steps: Parameters<SwapHook>[0][] = ['copied', 'merged', 'moved-prev', 'moved-next']
  it.each(steps)('swapIn: a failure after `%s` leaves either the old or the new tree, complete, and no leftovers', (step) => {
    const dir = tmp('swap'), data = join(dir, 'data'), staging = join(dir, 'staging')
    mkdirSync(join(data, 'agreements'), { recursive: true }); mkdirSync(join(staging, 'agreements'), { recursive: true })
    writeFileSync(join(data, 'index.json'), 'old'); writeFileSync(join(data, 'keep.txt'), 'kept')
    writeFileSync(join(staging, 'index.json'), 'new')
    const old = snapshot(data)
    expect(() => swapIn(staging, data, (s) => { if (s === step) throw new Error(`crash at ${s}`) })).toThrow(/crash/)
    const now = snapshot(data)
    if (step === 'moved-next') expect(now).toMatchObject({ 'index.json': Buffer.from('new').toString('base64'), 'keep.txt': old['keep.txt'] })
    else expect(now).toEqual(old)
    expect(readdirSync(dir).filter((f) => f.startsWith('.data'))).toEqual(step === 'moved-next' ? [expect.stringMatching(/^\.data-prev-/)] : [])
    recoverPublish(data)
    expect(readdirSync(dir).filter((f) => f.startsWith('.data'))).toEqual([])
  })

  it('a throw just before the swap (after the stamp) leaves data/ byte-for-byte intact', async () => {
    const { m, data } = await published()
    const before = snapshot(data)
    const r = await run(m.url, data, { hooks: { beforePublish: () => { throw new Error('simulated crash') } } })
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('publish')
    expect(snapshot(data)).toEqual(before)
    const r2 = await run(m.url, data)
    expect(r2.ok, r2.error).toBe(true)
  })

  it('H-3: kill -9 between the renames (data/ gone, .data-prev-* and a partial .data-next-* left): the next run restores the last good data and the diff guard still applies', async () => {
    const { m, data } = await published()
    const good = snapshot(data), parent = dirname(data), ts = Date.now()
    renameSync(data, join(parent, `.data-prev-99999-${ts}`))
    mkdirSync(join(parent, `.data-next-99999-${ts}`, 'agreements'), { recursive: true }) // partial copy
    dropCollege(m)
    const r = await run(m.url, data, { firstPublish: false })
    expect(r.ok).toBe(false)
    expect(errors(r)).toContainEqual(expect.stringMatching(/^diff\./)) // compared against the restored baseline
    expect(snapshot(data)).toEqual(good)
    expect(siblings(data)).toEqual([])
  })

  it('H-3: with no previous data and no firstPublish, nothing is fetched or published', async () => {
    const { m, data } = await published()
    rmSync(data, { recursive: true })
    const requests = m.log.length
    const r = await run(m.url, data, { firstPublish: false })
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('preflight')
    expect(r.error).toMatch(/--first-publish/)
    expect(m.log.length).toBe(requests)
    expect(existsSync(data)).toBe(false)
  })

  it('treeHash sees content and path changes and honours exclusions', () => {
    const d = tmp('hash')
    mkdirSync(join(d, 'a')); writeFileSync(join(d, 'a', 'x'), '1'); writeFileSync(join(d, 'meta.json'), 'm')
    const h = treeHash(d, ['meta.json'])
    writeFileSync(join(d, 'meta.json'), 'changed')
    expect(treeHash(d, ['meta.json'])).toBe(h)
    writeFileSync(join(d, 'a', 'x'), '2')
    expect(treeHash(d, ['meta.json'])).not.toBe(h)
  })
})

describe('M-6: NORMALIZE_VERSION bump', () => {
  it('a fetch run first renormalizes stale data from the raw store, even when ASSIST is down', async () => {
    const { m, data } = await published()
    const metaPath = join(data, 'meta.json'), meta = readJson(metaPath)
    writeFileSync(metaPath, JSON.stringify({ ...meta, normalizeVersion: NORMALIZE_VERSION - 1 }))
    await m.close(); mock = undefined
    const logs: string[] = []
    const r = await run('http://127.0.0.1:9', data, { log: (x) => logs.push(x), envExtra: { ASSIST_RETRIES: '1' } })
    expect(r.stage).toBe('fetch') // the fetch itself failed...
    expect(r.renormalized).toBe(true) // ...but the data was rebuilt offline first
    const after = readJson(metaPath)
    expect(after.normalizeVersion).toBe(NORMALIZE_VERSION)
    expect(after.fetchedAt).toBe(meta.fetchedAt)
    expect(after.validation.passed).toBe(true)
    expect(logs.join('\n')).toMatch(/renormalizing from the raw store/)
  })
  it('autoRenormalize: false leaves it alone', async () => {
    const { m, data } = await published()
    const metaPath = join(data, 'meta.json')
    writeFileSync(metaPath, JSON.stringify({ ...readJson(metaPath), normalizeVersion: NORMALIZE_VERSION - 1 }))
    await m.close(); mock = undefined
    const r = await run('http://127.0.0.1:9', data, { autoRenormalize: false, envExtra: { ASSIST_RETRIES: '1' } })
    expect(r.renormalized).toBeUndefined()
    expect(readJson(metaPath).normalizeVersion).toBe(NORMALIZE_VERSION - 1)
  })
})

describe('M-5 / L-7: no secrets or fence breaks in logs and reports', () => {
  it('redacts secret env values, GitHub tokens, cookies, auth headers and URL userinfo', () => {
    const env = { GH_TOKEN: 'ghs_supersecretvalue123', DATA_REFRESH_TOKEN: 'abcdef123456', PATH: '/usr/bin' }
    const s = redact([
      'push to https://x-access-token:abcdef123456@github.com/o/r failed',
      'token ghs_supersecretvalue123 and ghp_ABCDEFGHIJKLMNOPQRSTUV',
      'Cookie: .AspNetCore.Antiforgery.x=CfDJ8secret; X-XSRF-TOKEN=CfDJ8other',
      'Authorization: Bearer eyJhbGciOi.abc.def',
      'PATH is /usr/bin',
    ].join('\n'), env)
    for (const leak of ['abcdef123456', 'supersecretvalue', 'ghp_ABCDEF', 'CfDJ8', 'eyJhbGciOi']) expect(s).not.toContain(leak)
    expect(s).toContain('/usr/bin')
  })
  it('failure output never leaks the environment secrets into failure.md, the log or the result', async () => {
    const m = (mock = await startMockAssist({ faults: [{ match: '/api/institutions', status: 500 }] }))
    const data = join(tmp('leak'), 'data'), secret = 'ghs_leakyleakyleaky0123456789'
    const logs: string[] = []
    const r = await run(m.url, data, { envExtra: { GH_TOKEN: secret, ASSIST_API_KEY: secret }, log: (x) => logs.push(x), hooks: {} })
    // make the secret appear in the error path: the base URL carries it as userinfo
    const r2 = await run(m.url.replace('://', `://user:${secret}@`), data, { envExtra: { GH_TOKEN: secret }, log: (x) => logs.push(x) })
    for (const x of [r.error ?? '', r2.error ?? '', logs.join('\n'), readFileSync(join(data, '..', 'work', 'failure.md'), 'utf8')]) expect(x).not.toContain(secret)
  })
  it('fenced() cannot be closed by content', () => {
    const f = fenced('a ``` b ```` c')
    expect(f.startsWith('`````\n')).toBe(true)
    expect(f.endsWith('\n`````')).toBe(true)
  })
})
