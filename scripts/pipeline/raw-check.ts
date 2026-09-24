/* Committed-data audit: data/agreements must be exactly what the current normalize builds from data/raw. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PipelineConfig } from './config.ts'
import { build, hasRaw, readRaw, type Built } from './store.ts'
import type { Report, Severity } from './validate.ts'

/**
 * Rebuild from data/raw with the current normalize and require identical output (catches hand edits, and a
 * normalize change without a NORMALIZE_VERSION bump). Returns the build (notes, template mismatches) or null.
 * Without a raw store: an error in publish mode, legacy/warning in CI mode.
 */
export function checkRawReproducible(dataDir: string, cfg: PipelineConfig, r: Report): Built | null {
  const push = (severity: Severity, message: string, file?: string) => { r.findings.push({ check: 'raw.reproducible', severity, message, file }); r.counts[severity]++ }
  const done = <T>(v: T) => { r.passed = r.counts.error === 0; return v }
  r.checks++
  if (!hasRaw(dataDir, cfg)) {
    push(r.mode === 'publish' ? 'error' : r.legacyData ? 'legacy' : 'warning', `no raw payloads under ${cfg.raw.dir}/: the data cannot be audited or renormalized offline (it predates the raw store)`)
    return done(null)
  }
  let built: Built
  try { built = build(readRaw(dataDir, cfg), cfg) } catch (e) { push('error', `raw store unusable: ${(e as Error).message}`); return done(null) }
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
