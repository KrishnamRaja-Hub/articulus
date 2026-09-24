/* Committed-data audit: data/agreements must be exactly what the current normalize builds from data/raw. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PipelineConfig } from './config.ts'
import { payloadIdentityErrors, type RawBundle } from './fetch.ts'
import { build, hasRaw, readRaw, type Built } from './store.ts'
import type { Report, Severity } from './validate.ts'

/**
 * Rebuild from data/raw with the current normalize and require identical output (catches hand edits, and a
 * normalize change without a NORMALIZE_VERSION bump). Returns the build (notes, template mismatches) or null.
 * Without a raw store: an error, except in CI mode on legacy data that was never fetched by the pipeline (H-1: current
 * data without raw payloads cannot be audited, so deleting data/raw must not turn a hand edit green).
 * Also checks every stored payload is for the college / UC / year / major its manifest entry says (C-2).
 */
export function checkRawReproducible(dataDir: string, cfg: PipelineConfig, r: Report): Built | null {
  const push = (severity: Severity, message: string, file?: string) => { r.findings.push({ check: 'raw.reproducible', severity, message, file }); r.counts[severity]++ }
  const done = <T>(v: T) => { r.passed = r.counts.error === 0; return v }
  r.checks++
  if (!hasRaw(dataDir, cfg)) {
    const neverFetched = readFetchedAt(dataDir) === null
    const excused = r.mode === 'ci' && r.legacyData && neverFetched
    push(excused ? 'legacy' : 'error', `no raw payloads under ${cfg.raw.dir}/: the data cannot be audited or renormalized offline${excused ? ' (it predates the raw store)' : ' (raw is mandatory for data built by the current normalize or fetched by the pipeline)'}`)
    return done(null)
  }
  let built: Built, bundle: RawBundle
  try { bundle = readRaw(dataDir, cfg) } catch (e) { push('error', `raw store unusable: ${(e as Error).message}`); return done(null) }
  r.checks++
  for (const a of bundle.agreements) {
    if (a.sources.length !== a.payloads.length) { push('error', `raw manifest lists ${a.sources.length} sources but the file holds ${a.payloads.length} payloads`, a.file); continue }
    a.payloads.forEach((p, i) => {
      const bad = payloadIdentityErrors(p, { sendingId: a.sources[i].sendingId, receivingId: a.receivingId, academicYear: bundle.academicYear, major: a.major })
      if (bad.length) push('error', `raw payload ${i} does not match its manifest entry (C-2 identity): ${bad.join('; ')}`, a.file)
    })
  }
  try { built = build(bundle, cfg) } catch (e) { push('error', `raw store unusable: ${(e as Error).message}`); return done(null) }
  if (r.legacyData) {
    push(r.mode === 'ci' ? 'legacy' : 'error', 'raw store present, but data/ was built by another normalize version: run `npm run renormalize`')
    return done(built)
  }
  const same = (v: unknown, file: string) => { try { return JSON.stringify(JSON.parse(readFileSync(join(dataDir, file), 'utf8'))) === JSON.stringify(v) } catch { return false } }
  if (!same(built.index, 'index.json')) push('error', 'index.json differs from the one rebuilt from raw payloads')
  if (!same(built.institutions, 'institutions.json')) push('error', 'institutions.json differs from the one rebuilt from raw payloads')
  for (const [f, a] of built.agreements) {
    r.checks++
    if (!same(a, join('agreements', f))) push('error', 'differs from the agreement rebuilt from raw payloads (hand edit, or normalize changed without a NORMALIZE_VERSION bump)', f)
  }
  return done(built)
}

function readFetchedAt(dataDir: string): string | null | undefined {
  try { return (JSON.parse(readFileSync(join(dataDir, 'meta.json'), 'utf8')) as { fetchedAt?: string | null }).fetchedAt } catch { return undefined }
}
