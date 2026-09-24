/**
 * The app's verifySchedule against the oracle on all 22 real agreements: exhaustive per-row subsets (bounded by the
 * budget) and random transcripts. Any disagreement fails with the exact repro.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { BUDGET, SEED, SLOW } from './budget.ts'
import { check, describeFailures, Metrics } from './compare.ts'
import { CCS, INDEX, loadAgreement } from './fixtures.ts'
import { writeMetrics } from './metrics.ts'
import { exhaustive, randomTranscript } from './realcases.ts'
import { rng } from './synth.ts'

const EX = new Metrics('real-exhaustive'), RND = new Metrics('real-random')
const t0 = performance.now()

describe('verifySchedule vs oracle: exhaustive per-row subsets on every real agreement', () => {
  for (const e of INDEX) it(e.file, () => {
    const a = loadAgreement(e.file), r = rng(SEED + e.file.length * 7919), M = new Metrics(e.file)
    for (const taken of exhaustive(a, r, BUDGET)) check(M, e.file, a, taken)
    EX.merge(M)
    expect(M.cases).toBeGreaterThan(0)
    expect(M.failureCount, describeFailures(M)).toBe(0)
  }, SLOW)
})

describe('verifySchedule vs oracle: random real transcripts', () => {
  it(`${BUDGET.randomTranscripts} sparse / dense / near-complete / honors-flipped / garbage transcripts over 1-15 colleges`, () => {
    const r = rng(SEED + 1)
    for (let i = 0; i < BUDGET.randomTranscripts; i++) {
      const e = r.pick(INDEX), a = loadAgreement(e.file)
      check(RND, e.file, a, randomTranscript(a, r, CCS))
    }
    expect(RND.failureCount, describeFailures(RND)).toBe(0)
  }, SLOW)
})

afterAll(() => writeMetrics('verify-real', { seconds: Number(((performance.now() - t0) / 1000).toFixed(1)), exhaustive: EX.summary(), random: RND.summary() }))
