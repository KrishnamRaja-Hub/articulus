# Independent validation suite

Every code or data change is checked against a second implementation of the transfer rules that shares no code with
the app. When the app and this oracle disagree, or either disagrees with a counselor's written expectation, the suite
fails and prints the exact transcript to reproduce it. It started from the counselor tester's harness
(`COUNSELOR_REPORT.md`) and runs under plain `npx vitest run`.

## What is checked

| File | Checks |
|---|---|
| `isolation.test.ts` | The oracle side (`oracle.ts`, `brute.ts`, `synth.ts`, `scenarios.ts`, `fixtures.ts`, `realcases.ts`, `budget.ts`, `metrics.ts`) imports only `import type` from `src/`, node builtins, and its own files. Only `compare.ts` and `planner-harness.ts` call the app. |
| `scenarios.test.ts` | 214 named counselor scenarios, including the three Plan.md rescind stories. Each asserts app == oracle == counselor expectation, then runs the planner and checks its rules and any scenario-specific plan expectations. |
| `verify-real.test.ts` | `verifySchedule` vs the oracle on all 22 agreements. For every row it tries every subset of the courses its groups list at 1, 2 and 3 colleges (plus honors twins), both alone and with the rest of the major complete. It also runs random sparse, dense, near-complete, honors-flipped and garbage transcripts. |
| `verify-synth.test.ts` | Synthetic trees (nested AND/OR/N_OF, optional subtrees, UC-only rows, unrecorded rows, honors twins, shared courses, repeated ids) and hand-built edge trees. A self-test runs six plausible regressions (for example "unrecorded row treated as UC-only" or "honors twins dropped") and requires the suite to catch each one. |
| `planner.test.ts` | `solve` vs the oracle and an independent brute force, on realistic synthetic agreements and on the real grid (homes × {home, home + Foothill, all 15}) plus random transcripts. It also runs the latent-finding repros. |

The planner rules checked are:

- It plans only at allowed colleges.
- It never re-plans a taken course and never plans a UC-only row.
- It never creates a blocking split.
- `unsolvable` is empty exactly when the root can pass at the allowed colleges.
- When `unsolvable` is empty, the plan is valid per the oracle.
- `plan.result` agrees with the oracle.
- The plan is deterministic under input order.
- The plan is minimal against the brute force. A plan marked `optimal: true` that is not minimal is a failure. One marked `optimal: false` is only counted.

Rules implemented by `oracle.ts` (README "Verification", FIXES.md Round 3):

1. **Satisfying a row.** A row is satisfied by one complete group from one college. Honors twins (exactly one trailing H) swap only at a college that lists both the regular group and its honors twin for that row.
2. **Split series.** A split is an unsatisfied row with pieces at two or more colleges whose honors-stripped codes differ.
3. **UC-only rows.** A row is UC-only when it has no groups anywhere **and** an explicit ASSIST reason other than `No articulation listed`. A row with no record is neither a route nor deferrable.
4. **Choices (OR / N_OF).** Let s = satisfied children, a = open children with a CC route, d = UC-only children.
   - s ≥ n: satisfied.
   - s + a + d < n: cannot be met.
   - a > 0: the CC alternatives are owed first. UC-only rows fill only max(0, n − s − a) slots.
   - Otherwise: deferred.
5. **Optional subtrees.** They never fail, satisfy or defer anything for their parent.
6. **Blocking splits.** Top down from a failing root, an AND needs every failing required child, and an OR / N_OF needs every failing child that has a CC route. A split in a needed row is blocking. Any other split is a warning.
7. **Validity.** `isValid` = the root passes and there is no blocking split.

## Running it

```
npx vitest run tests/independent                           # CI budget: about 15 s wall on 4 cores
INDEPENDENT_BUDGET=full npx vitest run tests/independent   # nightly: about 110 s, 285k real + 160k synthetic cases
INDEPENDENT_SEED=7 npx vitest run tests/independent        # another seed for every generator
npx tsc -p tests/independent                               # type-check (root tsconfig covers src and scripts only)
```

Other switches:

- `INDEPENDENT_STRICT_LATENT=1` enforces the latent planner findings instead of reporting them.
- `INDEPENDENT_PLANNER_WEIGHTS=5,5` minimizes the weighted objective (see below).
- `INDEPENDENT_METRICS_DIR=…` redirects the metrics output.

## Metrics

Each file prints a one-line summary and writes `node_modules/.cache/articulus-independent/<section>.json` and the combined `last-metrics.json`. They live under `node_modules`, so git ignores them, and CI can upload them as an artifact.

The metrics include:

- verdict TP/TN/FP/FN with precision and recall;
- per-row accuracy;
- split precision and recall;
- blocking accuracy;
- deferred precision and recall;
- the exact-`missing` rate;
- planner rule violations, minimality counts and solve timing;
- the named scenarios scored against the counselor's answer and against the real-world answer.

Any false positive or false negative against the oracle fails the suite. It also fails on any disagreement in rows, splits, blocking, deferred or missing, unless it is one of the documented deviations below.

## Documented deviations (counted, not failed)

These deviations are recognized by construction: the oracle recomputes the case under the app's convention and checks that it matches. They are not matched against the app's output text.

- **LOW-3.** Which UC-only rows are listed as deferred when a choice has several UC-only alternatives. The oracle's `defer: 'app-low3'` option models the app's listing.
- **LOW-6.** The app keeps one partial per college, so it can miss a split that the literal union rule reports (`splitHiddenByBestPartial`). The verdict is never affected.
- **Wording.** Whether an "N of: …" `missing` string names a UC-only row. `missing` is compared on the other rows.
- **LOW-5** (scenario `Q5` only, hostile input): `113:MATH 1AHH` stands in for `MATH 1AH`. The verdict must still match. The test log says when this stops reproducing.
- **MED-1, MED-2 and LOW-2** (planner, latent): hand repros in `planner.test.ts`, reported as present or fixed. The realistic synthetic generator (`latentShapes: false`) avoids those shapes. The full budget also fuzzes them and enforces the hard rules there.

## Data-dependent scenarios

The fixtures in `data/` predate the normalize fixes F-01 to F-03 (`data/meta.json` has `normalizeVersion: 1`). The scenarios whose correct real-world answer differs are marked `dataDependent: 'refetch'`: `A3`, `R1` and `I-lame` (CRITICAL-1), `I-FH-bme` and `F14` (HIGH-1), `I-lame-noupper` (HIGH-2), and `I-dme`, `K4` and `N4` (HIGH-3). Also marked are `N3` and the 22 `I-all-*` scenarios (HIGH-4: which majors can turn green).

- Until `normalizeVersion >= 2`, their legacy expectation is enforced and the real-world describe is skipped. The skip reason is in the describe name.
- After `npm run fetch`, the legacy describe is skipped and the real-world expectations are enforced.
- Scenarios without a recorded real-world answer show as `todo` until someone re-derives it from the refreshed rows.

A refresh can legitimately change other scenarios too, since the rows themselves change. A failure after a refresh means a person must read the new rows before editing the expectation. The oracle is not the source of truth for expectations.

## Planner objective (TODO after the penalty merge)

`planner-harness.ts` passes weights 0 under `OPTION_NAMES` (placeholders `P_COLLEGE` / `P_CHAIN`), so minimality is checked in pure-units mode. To enforce the weighted objective (units + 5 per extra non-home college + 5 per subject chain across more than one college):

1. Set `OPTION_NAMES` to the real `SolveOptions` field names.
2. Confirm that `brute.ts` `planCost` counts colleges and chains the way `solve()` does.
3. Run with `INDEPENDENT_PLANNER_WEIGHTS=5,5`, or make that the default `OBJECTIVE`.

## Adding a scenario

Add an entry in `scenarios.ts` with:

- the agreement file;
- `taken` (catalog ids);
- `allowed` and `home` if the plan matters;
- `expect`, which is the rules' answer on these fixtures, read off the rows by hand;
- a one-line `why`.

If the real-world answer differs because of the data, set `dataDependent: 'refetch'` and `realWorld`. Never copy an expectation from the app's output.
