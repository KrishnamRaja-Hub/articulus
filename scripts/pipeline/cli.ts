/* Shared flag parsing for the pipeline CLIs. */
import { resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..', '..')

export function cliArgs(argv: string[]) {
  const flag = (f: string) => argv.includes(f)
  const value = (f: string) => {
    const i = argv.findIndex((a) => a === f || a.startsWith(f + '='))
    if (i < 0) return undefined
    return argv[i].includes('=') ? argv[i].slice(f.length + 1) : argv[i + 1]
  }
  const known = ['--dry-run', '--skip-suites', '--accept-large-change', '--first-publish', '--no-auto-renormalize', '--data-dir', '--work-dir']
  const unknown = argv.filter((a) => a.startsWith('--') && !known.some((k) => a === k || a.startsWith(k + '=')))
  if (unknown.length) { console.error(`unknown flag(s): ${unknown.join(' ')}; known: ${known.join(' ')}`); process.exit(2) }
  return {
    dataDir: resolve(value('--data-dir') ?? process.env.ARTICULUS_DATA_DIR ?? resolve(repo, 'data')),
    workDir: resolve(value('--work-dir') ?? process.env.ARTICULUS_WORK_DIR ?? resolve(repo, '.pipeline')),
    dryRun: flag('--dry-run'),
    skipSuites: flag('--skip-suites'),
    acceptDiff: flag('--accept-large-change'),
    /** Allow a run with no previous data (no diff guard baseline); its decision is always review. Never needed once data/ exists. */
    firstPublish: flag('--first-publish'),
    /** Do not rebuild stale-NORMALIZE_VERSION data from the raw store before a fetch. */
    autoRenormalize: !flag('--no-auto-renormalize'),
  }
}
