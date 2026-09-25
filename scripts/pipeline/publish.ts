/*
 * Publishing primitives: an exclusive run lock, crash recovery, a staged-tree hash, and the directory swap.
 *
 * The swap replaces the published data directory with a validated staging directory, as close to atomically as a
 * directory allows. At every instant one of these holds, so a crash (kill -9, ENOSPC, power loss) is recoverable:
 *   - data/ is the old, complete directory (plus maybe a partial .data-next-*), or
 *   - data/ is gone and .data-prev-* is the old, complete directory (between the two renames), or
 *   - data/ is the new, complete directory (plus maybe a .data-prev-* being deleted).
 * recoverPublish() runs at the start of every pipeline run (under the lock) and restores or cleans these.
 */
import { createHash } from 'node:crypto'
import { closeSync, cpSync, existsSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

/** Test seam: called between swap steps; a throw here simulates a failure at that point. */
export type SwapHook = (step: 'copied' | 'merged' | 'moved-prev' | 'moved-next') => void

const sidecars = (target: string) => {
  const t = resolve(target)
  return { parent: dirname(t), re: new RegExp(`^\\.${basename(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(next|prev)-(\\d+)-(\\d+)$`) }
}

/** Thrown by swapIn when the copy about to be published is not the tree that was validated. */
export class StagedChangedError extends Error {}

/**
 * Swap stagingDir in as targetDir. With `expect`, the copy made next to the target is hashed (treeHash, with the same
 * exclusions) before anything is renamed; a mismatch with the validated hash throws StagedChangedError and leaves
 * targetDir untouched, so a tree changed after validation can never be published.
 */
export function swapIn(stagingDir: string, targetDir: string, hook: SwapHook = () => {}, expect?: { hash: string; exclude: string[] }) {
  const target = resolve(targetDir), parent = dirname(target), tag = `${process.pid}-${Date.now()}`
  const next = join(parent, `.${basename(target)}-next-${tag}`), prev = join(parent, `.${basename(target)}-prev-${tag}`)
  try {
    // 1. Copy staging next to the target (same filesystem, so the renames are atomic), carrying over any entries of
    //    the old data/ that staging does not produce (so a file another tool keeps in data/ is never lost).
    cpSync(stagingDir, next, { recursive: true })
    hook('copied')
    // What is renamed into place is this copy: prove it is what was validated (before old entries are merged in,
    // which were never part of the staged tree).
    if (expect && treeHash(next, expect.exclude) !== expect.hash) throw new StagedChangedError('staged data changed after validation (hash of the copy to publish differs); refusing to publish')
    if (existsSync(target)) for (const e of readdirSync(target)) if (!existsSync(join(next, e))) cpSync(join(target, e), join(next, e), { recursive: true })
    hook('merged')
    // 2. data -> .data-prev-*, .data-next-* -> data. On failure between them, the previous directory is renamed back.
    const had = existsSync(target)
    if (had) renameSync(target, prev)
    try {
      hook('moved-prev')
      renameSync(next, target)
      hook('moved-next')
    } catch (e) {
      if (had && !existsSync(target)) renameSync(prev, target)
      throw e
    }
    // 3. Only now is the previous copy disposable.
    if (had) rmSync(prev, { recursive: true, force: true })
  } finally {
    rmSync(next, { recursive: true, force: true })
  }
}

/**
 * Undo what a crashed swap left behind. Call only while holding the lock.
 * - data/ missing and a .data-prev-* exists: the crash hit between the two renames; the newest prev that contains
 *   index.json is the last good data (complete: it was renamed whole), so it is renamed back. Other prevs are kept
 *   in that case (and when none is restorable); they are deleted by a later run that finds data/ in place.
 * - Every .data-next-* (possibly a partial copy) is deleted, and every .data-prev-* when data/ exists.
 * Returns what it did (for the log).
 */
export function recoverPublish(targetDir: string): string[] {
  const target = resolve(targetDir), { parent, re } = sidecars(target), done: string[] = []
  if (!existsSync(parent)) return done
  const found = readdirSync(parent).map((f) => ({ f, m: re.exec(f) })).filter((x) => x.m)
    .map((x) => ({ path: join(parent, x.f), kind: x.m![1] as 'next' | 'prev', at: Number(x.m![3]) }))
    .sort((a, b) => b.at - a.at)
  if (!existsSync(target)) {
    // The newest prev that is a complete data directory (a readable index.json array); a junk, partial or corrupt prev
    // is never restored.
    const prev = found.find((x) => x.kind === 'prev' && readableIndex(x.path))
    if (prev) {
      renameSync(prev.path, target)
      done.push(`restored ${basename(target)}/ from ${basename(prev.path)} (a previous publish crashed between renames)`)
      found.splice(found.indexOf(prev), 1)
      // Other prevs are kept until a later run finds data/ in place (i.e. after this restore is known good).
      for (const x of found) if (x.kind === 'prev') done.push(`kept ${basename(x.path)} (cleaned up by a later run)`)
      found.splice(0, found.length, ...found.filter((x) => x.kind !== 'prev'))
    } else if (found.some((x) => x.kind === 'prev')) {
      // Nothing restorable: keep every prev for a human to inspect.
      for (const x of found) if (x.kind === 'prev') done.push(`kept ${basename(x.path)} (no readable index.json; not restored)`)
      found.splice(0, found.length, ...found.filter((x) => x.kind !== 'prev'))
    }
  }
  for (const x of found) {
    rmSync(x.path, { recursive: true, force: true })
    done.push(`removed leftover ${basename(x.path)}`)
  }
  return done
}

/** Does dir hold an index.json that parses to an array (what readDataSet requires)? */
const readableIndex = (dir: string) => {
  try { return Array.isArray(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))) } catch { return false }
}

/** Content hash of a directory tree (relative paths + bytes), to prove what was validated is what gets published. */
export function treeHash(dir: string, exclude: string[] = []): string {
  const h = createHash('sha256')
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f), rel = relative(dir, p)
      if (exclude.includes(rel)) continue
      if (statSync(p).isDirectory()) walk(p)
      else h.update(`${rel}\0${readFileSync(p).length}\0`).update(readFileSync(p))
    }
  }
  walk(dir)
  return h.digest('hex')
}

export interface LockInfo { pid: number; host: string; at: string; purpose: string }
export interface Lock { path: string; release: () => void }
export class LockError extends Error {}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * Take an exclusive lock file (O_EXCL create). A lock is stale, and is broken, when its process is gone (same host)
 * or it is older than maxAgeMs (any host). Otherwise a LockError names the holder.
 */
export function acquireLock(path: string, purpose: string, maxAgeMs = 6 * 3600_000, now = () => Date.now()): Lock {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      const info: LockInfo = { pid: process.pid, host: hostname(), at: new Date(now()).toISOString(), purpose }
      try { writeSync(fd, JSON.stringify(info) + '\n') } finally { closeSync(fd) }
      let released = false
      return {
        path,
        release: () => {
          if (released) return
          released = true
          try { if ((JSON.parse(readFileSync(path, 'utf8')) as LockInfo).pid === process.pid) rmSync(path, { force: true }) } catch { /* already gone */ }
        },
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    let info: Partial<LockInfo> = {}
    try { info = JSON.parse(readFileSync(path, 'utf8')) } catch { /* torn write by a crashed holder: judge by age */ }
    const age = now() - (Date.parse(info.at ?? '') || statSync(path).mtimeMs)
    const dead = info.host === hostname() && typeof info.pid === 'number' && !alive(info.pid)
    const torn = info.pid === undefined && age > 60_000
    if (!(dead || torn || age > maxAgeMs)) {
      throw new LockError(`another pipeline run holds ${path} (pid ${info.pid ?? '?'} on ${info.host ?? '?'}, ${info.purpose ?? '?'}, since ${info.at ?? '?'}); wait for it, or delete the file if that process is gone`)
    }
    rmSync(path, { force: true }) // stale: break it and try once more (a racing breaker loses on the O_EXCL create)
  }
  throw new LockError(`could not take ${path}: another run took it while a stale lock was being broken`)
}

/** Lock path for a published directory: a sibling file, because the directory itself is swapped. */
export const dataLockPath = (targetDir: string) => { const t = resolve(targetDir); return join(dirname(t), `.${basename(t)}.lock`) }
