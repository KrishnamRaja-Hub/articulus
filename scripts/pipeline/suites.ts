/*
 * Run the app's own suites (tsc, vitest, smoke, build) against a data directory. Staged data is never copied into
 * data/ to be tested: the suites run in a throwaway "shadow" copy of the repo whose data/ is the staged data and
 * whose node_modules is a symlink to the real one.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Report } from './validate.ts'

export interface Suite { name: string; command: string[] }
const bin = (name: string) => join('node_modules', '.bin', name)
export const APP_SUITES: Suite[] = [
  { name: 'typecheck', command: [bin('tsc'), '-b'] },
  // src only: the app's data-dependent tests. The pipeline's own tests do not depend on data/.
  { name: 'vitest (app)', command: [bin('vitest'), 'run', 'src'] },
  { name: 'smoke', command: [process.execPath, 'scripts/smoke.mjs'] },
  { name: 'build', command: [bin('vite'), 'build', '--logLevel', 'warn'] },
]

const SKIP = new Set(['node_modules', '.git', 'dist', 'data', '.claude', '.pipeline', 'tsconfig.tsbuildinfo'])

/** Copy the repo (minus heavy/irrelevant entries) to a temp dir and put `dataDir` in as data/. */
export function makeShadow(repoRoot: string, dataDir: string): string {
  const shadow = mkdtempSync(join(tmpdir(), 'articulus-shadow-'))
  for (const e of readdirSync(repoRoot)) if (!SKIP.has(e)) cpSync(join(repoRoot, e), join(shadow, e), { recursive: true })
  cpSync(dataDir, join(shadow, 'data'), { recursive: true, filter: (src) => !/^[\\/]raw([\\/]|$)/.test(resolve(src).slice(resolve(dataDir).length)) })
  const nm = join(repoRoot, 'node_modules')
  if (!existsSync(nm)) throw new Error(`suites: ${nm} not found; run npm ci first`)
  symlinkSync(nm, join(shadow, 'node_modules'), 'dir')
  return shadow
}

export function runSuites(repoRoot: string, dataDir: string, suites: Suite[] = APP_SUITES, log: (m: string) => void = console.log): Report['suites'] {
  const inPlace = resolve(dataDir) === resolve(repoRoot, 'data')
  const cwd = inPlace ? repoRoot : makeShadow(repoRoot, dataDir)
  try {
    return suites.map((s) => {
      log(`suite: ${s.name} ...`)
      const t = Date.now()
      const r = spawnSync(s.command[0], s.command.slice(1), { cwd, encoding: 'utf8', timeout: 20 * 60_000, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI ?? '1' }, maxBuffer: 64 * 1024 * 1024 })
      const ok = r.status === 0
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`
      log(`suite: ${s.name} ${ok ? 'PASS' : `FAIL (exit ${r.status ?? r.signal})`} in ${((Date.now() - t) / 1000).toFixed(1)} s`)
      return { name: s.name, command: s.command.join(' ').replace(process.execPath, 'node'), ok, ms: Date.now() - t, ...(ok ? {} : { tail: out.slice(-6000) }) }
    })
  } finally {
    if (!inPlace) rmSync(cwd, { recursive: true, force: true })
  }
}

/** Fold suite results into a report: a failed suite is an error ("code" failure, never legacy). */
export function addSuites(r: Report, results: Report['suites']) {
  r.suites = results
  for (const s of results) {
    r.checks++
    if (!s.ok) { r.findings.push({ check: `suite.${s.name.split(' ')[0]}`, severity: 'error', message: `\`${s.command}\` failed against this data` }); r.counts.error++ }
  }
  r.passed = r.counts.error === 0
}
