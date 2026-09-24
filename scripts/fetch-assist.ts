/*
 * Pull ASSIST articulation for the configured universities, colleges and majors, then publish it to data/ only if
 * every gate passes. Usage: npm run fetch [-- --dry-run --skip-suites --accept-large-change --data-dir D --work-dir W]
 *
 * - Academic year: discovered from /api/AcademicYears (the one in effect by the July-1 rule); ASSIST_ACADEMIC_YEAR_ID pins one.
 * - Config (institutions, majors, timeouts, thresholds): scripts/pipeline/config.ts. ASSIST_BASE overrides the origin.
 * - Raw payloads are stored gzipped under data/raw so `npm run renormalize` can rebuild data/ offline.
 * - Exit 0: published (or dry run passed). 1: a gate failed. 2: fetch/build failed. data/ is untouched unless 0.
 */
import { resolve } from 'node:path'
import { cliArgs } from './pipeline/cli.ts'
import { githubOutputs, runPipeline } from './pipeline/run.ts'

const args = cliArgs(process.argv.slice(2))
const r = await runPipeline({ source: 'assist', ...args, repoRoot: resolve(import.meta.dirname, '..') })
githubOutputs(r)
process.exit(r.ok ? 0 : r.report ? 1 : 2)
