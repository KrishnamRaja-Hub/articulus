/**
 * Metrics output. Each test file writes its section to <dir>/<section>.json and the combined view to
 * <dir>/last-metrics.json, then prints a one-screen summary. The default dir is node_modules/.cache (ignored by git,
 * kept by CI caches); override with INDEPENDENT_METRICS_DIR (e.g. to upload as a CI artifact).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { FULL, SEED } from './budget.ts'
import { META } from './fixtures.ts'

export const METRICS_DIR = process.env.INDEPENDENT_METRICS_DIR ?? fileURLToPath(new URL('../../node_modules/.cache/articulus-independent/', import.meta.url))

export function writeMetrics(section: string, data: unknown) {
  mkdirSync(METRICS_DIR, { recursive: true })
  const stamped = { at: new Date().toISOString(), budget: FULL ? 'full' : 'ci', seed: SEED, normalizeVersion: META.normalizeVersion, ...(data as object) }
  writeFileSync(join(METRICS_DIR, `${section}.json`), `${JSON.stringify(stamped, null, 1)}\n`)
  const all: Record<string, unknown> = {}
  for (const f of readdirSync(METRICS_DIR).filter((x) => x.endsWith('.json') && x !== 'last-metrics.json').sort()) {
    try { all[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(METRICS_DIR, f), 'utf8')) } catch { /* a concurrent writer; the next file rewrites it */ }
  }
  writeFileSync(join(METRICS_DIR, 'last-metrics.json'), `${JSON.stringify(all, null, 1)}\n`)
  console.log(`[independent] ${section}: ${JSON.stringify(stamped)}\n[independent] metrics -> ${join(METRICS_DIR, 'last-metrics.json')}`)
}
