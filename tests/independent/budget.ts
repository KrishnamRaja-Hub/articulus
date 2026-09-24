/**
 * Case budgets. Default ("ci") keeps the whole independent suite well under a minute; INDEPENDENT_BUDGET=full is the
 * nightly run (roughly the counselor report's volumes). INDEPENDENT_SEED changes every seeded generator.
 */
export const FULL = process.env.INDEPENDENT_BUDGET === 'full'
export const SEED = Number(process.env.INDEPENDENT_SEED ?? 12345)

export const BUDGET = FULL
  ? {
      // real agreements: per-row subsets over 1, 2 and 3 colleges, alone and with the rest of the major complete
      subsetCap: 256, pairs: 20, triples: 10, pairCap: 48,
      randomTranscripts: 10_000,
      synthTrees: 20_000,          // x 4 transcripts x 2 generators (random / inherited optional flags)
      plannerSynth: 3_000,
      plannerRealRandom: 1_500,
      plannerHomes: 'all' as const, // every college as home x {home, home + Foothill, all 15}
      bruteBudget: 60_000,
    }
  : {
      subsetCap: 16, pairs: 1, triples: 1, pairCap: 8,
      randomTranscripts: 1_500,
      synthTrees: 2_500,
      plannerSynth: 500,
      plannerRealRandom: 120,
      plannerHomes: [113, 51, 137, 33] as number[], // De Anza, Foothill, Santa Monica, CCSF (two quarter, two semester)
      bruteBudget: 20_000,
    }

/** Per-test timeout for the heavy tests (vitest's default 5 s is too tight when files run in parallel). */
export const SLOW = FULL ? 60 * 60_000 : 120_000
