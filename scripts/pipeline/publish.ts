/* Replace the published data directory with a validated staging directory, as close to atomically as a directory allows. */
import { cpSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * 1. Copy staging next to the target (same filesystem, so renames are atomic), carrying over any entries of the
 *    old data/ that staging does not produce (so a file another tool keeps in data/ is never lost).
 * 2. rename data -> .data-prev-*, rename .data-next-* -> data, delete the previous copy.
 * If step 2 fails halfway, the previous directory is renamed back. The window with no data/ is two renames long.
 */
export function swapIn(stagingDir: string, targetDir: string) {
  const target = resolve(targetDir), parent = dirname(target), tag = `${process.pid}-${Date.now()}`
  const next = join(parent, `.${basename(target)}-next-${tag}`), prev = join(parent, `.${basename(target)}-prev-${tag}`)
  cpSync(stagingDir, next, { recursive: true })
  try {
    if (existsSync(target)) for (const e of readdirSync(target)) if (!existsSync(join(next, e))) cpSync(join(target, e), join(next, e), { recursive: true })
    const had = existsSync(target)
    if (had) renameSync(target, prev)
    try { renameSync(next, target) } catch (e) { if (had) renameSync(prev, target); throw e }
    if (had) rmSync(prev, { recursive: true, force: true })
  } finally {
    rmSync(next, { recursive: true, force: true })
  }
}
