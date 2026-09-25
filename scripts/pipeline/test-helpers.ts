/* Shared helpers for the pipeline tests (offline: every request goes to the local mock). */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { runPipeline, type RunOptions } from './run.ts'

export const REPO = resolve(import.meta.dirname, '..', '..')
/** In effect: 2026-2027, which the mock lists as id 77. */
export const NOW = new Date('2026-09-24T12:00:00Z')
const made: string[] = []
/** Call from afterAll: removes every dir tmp() made in this test file. */
export const cleanupTmp = () => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }) }
export const tmp = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `articulus-${tag}-`)); made.push(d); return d }

export const fastEnv = (base: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ ASSIST_BASE: base, ASSIST_DELAY_MS: '0', ASSIST_BACKOFF_MS: '5', ASSIST_TIMEOUT_MS: '400', ASSIST_RETRIES: '3', ...extra })

/** Every file under dir -> its content (to prove a failed run left data/ byte-for-byte untouched). */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else out[relative(dir, p)] = readFileSync(p).toString('base64')
    }
  }
  walk(dir)
  return out
}

export const run = (base: string, dataDir: string, extra: Partial<RunOptions> & { envExtra?: Record<string, string> } = {}) => {
  const { envExtra, ...rest } = extra
  // firstPublish only where there is nothing yet (tests of the no-baseline refusal pass firstPublish: false). A first
  // publish always decides review, so it is seeded the way the workflow lands it: staged for a reviewed PR.
  const first = !existsSync(join(dataDir, 'index.json'))
  return runPipeline({ source: 'assist', repoRoot: REPO, dataDir, workDir: join(dataDir, '..', 'work'), now: NOW, env: fastEnv(base, envExtra), skipSuites: true, log: () => {}, firstPublish: first, ...(first ? { onReview: 'stage' as const } : {}), ...rest })
}

export const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
