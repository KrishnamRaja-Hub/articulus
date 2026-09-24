/*
 * Rebuild data/agreements, index.json and institutions.json from the stored raw payloads (data/raw) with the current
 * normalize, without calling ASSIST. For when NORMALIZE_VERSION bumps. fetchedAt stays the raw fetch time.
 * Same gates and flags as `npm run fetch`. Usage: npm run renormalize [-- --dry-run --skip-suites ...]
 */
import { resolve } from 'node:path'
import { cliArgs } from './pipeline/cli.ts'
import { githubOutputs, runPipeline } from './pipeline/run.ts'

const args = cliArgs(process.argv.slice(2))
const r = await runPipeline({ source: 'raw', ...args, repoRoot: resolve(import.meta.dirname, '..') })
githubOutputs(r)
process.exit(r.ok ? 0 : r.report ? 1 : 2)
