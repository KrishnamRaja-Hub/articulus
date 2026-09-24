/*
 * Validate a data directory (default data/). Usage:
 *   npm run validate:data                       strict ("publish") mode: every error fails
 *   npm run validate:data -- --mode=ci          committed-data mode for CI (see below)
 *   npm run validate:data -- --suites           also run tsc, vitest (src), smoke and build against this data
 *   flags: --data-dir D  --prev-dir P (diff guard vs P)  --report R (JSON, default .pipeline/validation-report.json)
 *
 * Exit codes: 0 passed, 1 a check failed, 2 usage error or crash.
 *
 * CI mode: code failures and structural data errors still fail. When data/meta.json says the data was built by an
 * older NORMALIZE_VERSION ("legacy data"), the known symptoms of pre-fix data (orphans, title-shift heuristics,
 * data-dependent canaries, meta freshness, missing raw store) are reported with severity "legacy" and do not fail;
 * staleness and academic-year checks are warnings in CI mode. Once refreshed data lands, they are errors again.
 *
 * Checks (id: severity):
 *   files.present / files.json / meta.schema / institutions.schema|unique / index.schema|unique|file-prefix|receiving
 *   index.app-imports / index.stray-file / agreement.present|json|schema|index-match|year|sending
 *   catalog.schema|id|institution|units / tree.schema|root|empty|empty-node|req-empty|req-consistent|n-of
 *   tree.recommended-required / group.schema|in-scope|single-college|duplicates|in-catalog      : error
 *   (publish mode) institutions.scope / index.scope / index.coverage                             : error
 *   meta.normalize-version / meta.fetched-at / meta.validation                                   : error (legacy in CI)
 *   meta.age (> 30 d) / meta.academic-year                                                       : error (warning in CI)
 *   meta.age (> 7 d)                                                                             : warning
 *   catalog.orphans (> maxOrphanFraction) / heuristic.recommended-math / heuristic.no-required-math : error (legacy in CI)
 *   catalog.orphans (any) / rows.placeholder-only / heuristic.title-subject / heuristic.upper-division-required
 *   tree.optional-title / tree.n-of-all / normalize.template-mismatch / normalize.dropped / diff.catalog-drop : warning
 *   canary.*: error or warning per canary (scripts/pipeline/canaries.ts); data-dependent ones legacy in CI
 *   raw.reproducible: data/agreements must equal a rebuild from data/raw                          : error
 *   diff.agreement-removed / institution-removed / college-removed / total-groups-drop            : error (override: DATA_ACCEPT_LARGE_CHANGE=1)
 *   diff.groups-drop / diff.required-rows: error; warning when normalize version or academic year changed
 *   suite.*: the app's suites against this data                                                  : error
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PIPELINE } from './pipeline/config.ts'
import { checkRawReproducible } from './pipeline/raw-check.ts'
import { annotations, summaryMarkdown, summaryText } from './pipeline/report.ts'
import { build, hasRaw, readRaw } from './pipeline/store.ts'
import { addSuites, runSuites } from './pipeline/suites.ts'
import { validateData } from './pipeline/validate.ts'

const repo = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const value = (f: string) => { const a = argv.find((x) => x.startsWith(f + '=')); if (a) return a.slice(f.length + 1); const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const known = ['--mode', '--suites', '--data-dir', '--prev-dir', '--report']
const bad = argv.filter((a) => a.startsWith('--') && !known.some((k) => a === k || a.startsWith(k + '=')))
const mode = value('--mode') ?? 'publish'
if (bad.length || (mode !== 'publish' && mode !== 'ci')) { console.error(`usage: validate-data [--mode=publish|ci] [--suites] [--data-dir D] [--prev-dir P] [--report R]${bad.length ? `; unknown ${bad.join(' ')}` : ''}`); process.exit(2) }

try {
  const dataDir = resolve(value('--data-dir') ?? resolve(repo, 'data'))
  const prevDir = value('--prev-dir')
  const reportPath = resolve(value('--report') ?? resolve(repo, '.pipeline', 'validation-report.json'))
  const cfg = PIPELINE
  let built = null
  try { built = hasRaw(dataDir, cfg) ? build(readRaw(dataDir, cfg), cfg) : null } catch { /* reported by checkRawReproducible */ }
  const report = validateData(dataDir, { cfg, mode, now: new Date(), prevDir: prevDir && existsSync(prevDir) ? resolve(prevDir) : undefined, acceptDiff: /^(1|true|yes)$/i.test(process.env[cfg.diff.overrideEnv] ?? ''), notes: built?.notes, templateMismatches: built?.templateMismatches })
  checkRawReproducible(dataDir, cfg, report)
  if (argv.includes('--suites')) addSuites(report, runSuites(repo, dataDir))

  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n')
  writeFileSync(reportPath.replace(/\.json$/, '') + '.md', summaryMarkdown(report) + '\n')
  console.log(summaryText(report))
  console.log(`\nreport: ${reportPath}`)
  if (process.env.GITHUB_ACTIONS) {
    console.log(annotations(report).join('\n'))
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(report) + '\n')
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `passed=${report.passed}\nerrors=${report.counts.error}\nlegacy=${report.counts.legacy}\nwarnings=${report.counts.warning}\n`)
  }
  process.exit(report.passed ? 0 : 1)
} catch (e) {
  console.error('validate-data crashed:', (e as Error).stack ?? e)
  process.exit(2)
}
