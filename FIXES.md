# Fixes: verified issues and what changed

Every issue below was reproduced before it was fixed, and each fix was checked afterward.

Checks run after the fixes:

- `npx tsc -b` passes.
- `npm test` passes 13 of 13 (was 11; 2 new regression tests).
- `node scripts/smoke.mjs` passes 95 of 95.
- `npm run build` finishes with no warnings.
- The production build was driven in headless Chromium to confirm the UI changes (steps below).

## 1. Split-series cards named honors courses the student never took, and listed a college twice

**Where:** `src/engine/verify.ts`, `reqStatus`

**Reproduced:** With `113:MATH 1B` and `51:MATH 1C` taken against Berkeley ME, the `MATH 52` violation came back with three partials, `[113, 113, 51]`. De Anza's partials claimed `113:MATH 1BH` as "taken", although the student took only the regular `MATH 1B`.

**Cause:** Where ASSIST allows regular and honors courses to be combined, `has()` correctly treats `MATH 1B` and `MATH 1BH` as the same course. But `reqStatus` then reported the group's course id (the honors twin) as taken, not the id the student actually entered. De Anza's regular group and its honors group each produced a partial, so the college appeared twice. That also gave two React children the same key in the violation card.

**Fix:**
- Each course in `have` is now mapped back to the id actually in the taken set.
- Partials are kept one per college, the one with the most progress.
- On a tie, the partial whose missing courses are regular rather than honors wins, so the card says "MATH 1C missing", not "MATH 1CH missing".
- Whether a group is satisfied is still decided by the original `has()` check, so what counts as complete is unchanged.

**Test:** "split partials name only courses actually taken, one partial per college". It fails on the old code (`expected [113, 113, 51] to deeply equal [113, 51]`) and passes now.

## 2. With two violations, every card blamed every wasted course

**Where:** `src/sections/Planner.tsx`, the violation card's "Repair" line

**Reproduced:** With `113:PHYS 4B`, `51:PHYS 4C`, `113:MATH 1B` and `51:MATH 1C` taken, both the MATH 52 card and the PHYSICS 7B card said "PHYS 4C at Foothill, MATH 1C at Foothill earns no credit toward …". Each card named a course that belongs to the other violation.

**Cause:** `wasted` was computed once for the whole page, as every taken course unused by any satisfied requirement. It was then printed inside each card, next to that card's requirement name.

**Fix:** The page-wide list is removed. Each card now works out its own list: the pieces in that violation's partials that the solver's repair group does not reuse. In the browser, the MATH 52 card now reads "MATH 1C at Foothill earns no credit toward MATH 52", and the PHYSICS 7B card names only PHYS 4C.

## 3. Uncoverable requirements were labelled "not needed for the cheapest path"

**Where:** `src/sections/Planner.tsx`, the requirement map

**Reproduced:** A script solved every agreement once for each community college as the only college. It found 1,223 rows that are required, have articulations elsewhere, and are listed in `plan.unsolvable`, yet the map labelled them "not needed for the cheapest path". One example is Berkeley ME CHEM 1A/1AL/1B with Mission College as home. The summary badge correctly said requirements could not be met, but the row itself suggested the student could skip it.

**Fix:** A row with no articulation at any selected college now reads "not articulated at the selected colleges". The label is red when the row is required and grey when it is optional. Rows that have an articulation at a selected college keep the old label. In the browser, with Mission College alone, 3 rows show the new label.

## 4. The build warned that the Berkeley ME fixture was being lazy-loaded twice

**Where:** `src/data.ts`

**Reproduced:** `npm run build` printed `[INEFFECTIVE_DYNAMIC_IMPORT] data/agreements/79-mechanical-engineering-b-s.json is dynamically imported by src/data.ts but also statically imported`.

**Cause:** The Trap section needs Berkeley ME right away, so it is imported directly. The same file was also matched by the lazy loader that covers all agreement files.

**Fix:** The lazy loader now skips that one file. `loadAgreement` returns the copy that is already loaded, so the Planner behaves the same. The build is now warning-free.

## 5. The template assumption was not checked

**Where:** `src/engine/normalize.ts`

**Status:** The README listed this as a known limitation. The requirement tree is built from the first sending college's template on the assumption that every college's template is the same. It **could not be checked against real data**: ASSIST is blocked by this environment's network policy (the connection was refused with a 403), and the fixtures store only the merged result, not the raw payloads.

**Fix:**
- Added `templateMismatches(payloads)`. It compares each college's template with the first college's, looking at titles, AND/OR between groups, "N of" rules and the UC course in each row.
- `normalize()` prints a warning naming the colleges whose template differs. Behavior is otherwise unchanged, so no agreement is dropped.
- The next `npm run fetch` will show whether any real template differs.

**Test:** "flags colleges whose requirement template differs from the first", using small hand-built payloads.

## 6. The README said articulation notes were "already parsed"

**Reproduced:** `normalize.ts` never reads note or attribute fields. The fixture JSON contains only `catalog`, `root`, `groups`, `courses` and similar fields, with no notes.

**Fix:** The Future scope and Limitations sections now say that notes are dropped during normalization, and that surfacing them needs parsing, a re-fetch, and UI work. Test counts were updated from 11 to 13, and the template limitation now describes the new check.

## Checked, correct as written, not changed

- "0 of 5,611 groups span two colleges" is correct. I recounted: 5,611 groups, and none mixes colleges.
- 11 tests and 95 of 95 smoke runs, as the README stated before these changes.
- Term naming across the year boundary (Fall 2026, then Winter and Spring 2027) and the unit conversion.

## Known limitations, not changed

These are documented design limits, not bugs:

- The greedy solver does not guarantee the fewest units.
- Course order is guessed from letter suffixes.
- General education and IGETC are not modeled.
- Semester units convert to quarter units at a flat 1.5.

Fixing any of them is new feature work, listed under Future scope in the README.

---

# Round 2: fixes for the tester's findings (`TEST_REPORT.md`)

Five agents each fixed one area in an isolated copy of the repo, and their work was merged here. Each new test was shown to fail on the old code and pass on the fix.

Checks on the merged result:

- `npx tsc -b` passes.
- `npm test` passes 60 of 60 (was 13).
- `node scripts/smoke.mjs` passes 95 of 95.
- `npm run build` has no warnings.
- The page checks pass at 1440px and 390px with no console errors.

| ID | Area | What was wrong | What changed |
|---|---|---|---|
| F-01 | normalize | Courses from colleges whose ASSIST layout differs from the first college's were dropped (e.g. Foothill CHEM for Berkeley ME). | A college's articulations are attached by the UC courses they fully cover. Requirements that only other layouts list are added as optional. **Needs `npm run fetch`.** |
| F-02 | normalize | A group whose only section is "choose N" became "take all". | That group now keeps its "choose N" rule. **Needs `npm run fetch`.** |
| F-03 | normalize | Titles were paired with groups by count, so "recommended" labels shifted (e.g. UCLA ME calculus). | Each group takes the nearest title before it by `position`. **Needs `npm run fetch`.** |
| F-19 | normalize | Empty input crashed. A repeated college was duplicated. | Clear errors, de-duplication, and corrected units for "or" series. |
| F-04 | verify | Honors swaps applied at colleges with no honors twin. | New `honorsColleges(req)`: swaps apply per college. The checker, planner and repair text all use it. |
| F-09 | verify | MATH 1BH at one college plus MATH 1B at another was called a split. | Honors-stripped codes are compared, so it is a duplicate. |
| F-12 | verify | `missing` listed every "either/or" alternative as required and showed "(group)". | Built bottom-up: "One of: CSE 15L, CSE 29", "(B + C)". |
| F-05 | pack | A later course could be scheduled before an earlier one when a middle course was skipped. | Each course waits for the nearest lower letter. Out-of-order pairs went from 316 to 0 in 1,650 plans. |
| F-18 | pack | Course order mixed colleges. Plain numbers were never ordered. | Order is decided within one college. Plain numbers are ordered only when titles show an ordinal (I/II). |
| F-14 | pack | An invalid cap put everything in one term. Oversized courses passed silently. | An invalid cap falls back to the default. Oversized courses get `Term.overCap`, which the UI shows. |
| F-15 | pack | A semester plan starting in Winter was named "Fall". | It now starts at the next valid term (Spring). |
| F-16 | units | Per-course rounding added up in totals. | Exact units are used. Rounding happens only for display. |
| F-06 | solve | The solver could create a new split series. | Groups that would open a split are used only as a last resort and are reported in `unsolvable`. Solver-made splits in the fuzz run went from 14 to 5, all reported. |
| F-10 | solve | Courses made redundant by later picks stayed in the plan. | Pruned after solving. Plans with wasted courses went from 64/660 to 0. |
| F-11 | solve | Ties depended on input order. | Strict tie-break key. Shuffled inputs that changed the plan went from 233/264 to 0. |
| F-13 | solve | The 200-step limit dropped requirements silently. | The limit comes from the tree size, and leftovers are reported. |
| F-17 | solve | A course missing from the catalog cost 0 units. | Such groups are never planned. |
| F-07 | UI | Red ✗ next to "100% articulation integrity". | The icon and title come from one status value. |
| F-08 | UI | The repair text ignored honors ("retake MATH 1B" when MATH 1BH was taken). | Uses the engine's per-college honors rule. |
| F-20 | UI | At 390px, term cards were 724px wide and cut off. | Fits in 342px, with no horizontal scroll on any major. |
| F-21 | UI | 8 of 15 colleges were grey. | 15 distinct colors. |
| F-22 | UI | Multi-word search ("calculus iii") found nothing. | Every word must match the start of a title word. |
| F-23 | UI | The Trap section showed quarter units for Berkeley. | Converted to semester units, with the system named. |

## Integration done during the merge

- `solve.ts`: kept both the pruning block from the solver fix and the new `pack(...)` call from the scheduling fix.
- The planner now uses `honorsColleges`, so the planner and checker agree. Foothill MATH 1B + 1CH now plans MATH 1C instead of stalling.
- The page shows the new `overCap` flag on term cards.

## Still open after the tester's full suite on the merged code

- **Design decision (yours):** a split in a recommended course or an unused alternative is still fatal. These tester checks fail by design: V12–V15, S38, fuzz F2 (5 last-resort splits, all reported) and F4 (25 splits that can't be repaired).
- **Needs `npm run fetch`:** 8 data files still have orphaned courses. The fixed normalize code only takes effect once the data is regenerated.
- **Known limitation:** the greedy solver is not always unit-minimal (S01). Exact optimization is future scope.
- **Outdated tester checks:** 679 matrix "units sum" failures and the S07 cap check assume the old per-course rounding and the old silent over-cap behavior. F-07's browser setup now produces a valid plan, so it shows green "100%", which is correct.
- **Cost:** the solver is about 3× slower (about 18 ms per solve), because pruning and split checks re-verify the plan.
- **5 of 1,320 plans** use 2–3 more units than before (a different tie-break path in UCI CS and UC Davis CSE/ME). Overall total units went down: 68,090.5 → 66,849.

---

# Round 3: business rules and the exact solver

## Business decisions

A wrong "you're fine" (false positive) can cost a student their admission. A wrong "you're failing" (false negative) costs them retakes, time and money. Both count, and the first counts more.

1. **Splits that don't matter are warnings, not failures.** A split only costs the plan when the plan still needs that requirement. A split in a recommended course, or in an alternative the plan doesn't use, is shown in amber: "these courses earn no credit toward it, but your plan doesn't need it."
2. **"Complete at the UC after transfer" needs proof.** A requirement is UC-only when no college in the agreement offers it and ASSIST says so explicitly for at least one college. A row that ASSIST never mentions stays missing and shows "No ASSIST record · confirm with a counselor".
3. **The community-college route is always owed first.** In "choose N", UC-only rows fill only the slots a community-college course cannot fill.

## What was built

- **Checker (`verify.ts`):**
  - Blocking and warning splits.
  - Requirements deferred to the UC.
  - New helpers `ucOnly`, `canRoute`, `isDeferrable` and `blockingSplits`.
- **Planner (`solve.ts`):** an exact minimum-units search that replaces the greedy one. `Plan.optimal` is set to true only when minimality is proven.
  - It matches a brute-force oracle on 20,000 random cases.
  - Total units across 990 real solves went from 49,363 to 47,470. For example, UCSD MAE at Saddleback went from 57 to 52 units, because honors MATH A182H covers two requirements.
  - Typical time is 3–4 ms; the worst case is about 50 ms.
- **Page:**
  - The badge reads "Every requirement covered" and shows details for deferred items and warnings.
  - Amber cards for warning splits.
  - A "Complete at <UC> after transfer" section.
  - Cannot-be-met items are listed with the colleges that offer them.
  - A "minimum units" / "near-minimum" note.
  - A new warning color.

## Issues found and fixed during the merge

- **UC-only rows based on a placeholder:** 30 of 42 deferrals rested only on a placeholder that our own import code writes. Fixed by the proof rule (decision 2 above).
- **"Choose N" with a UC-only row:** "choose 2 of: a community-college course, a UC-only row" was called complete with nothing taken. The brute-force oracle caught this. Fixed so the community-college course is owed first.
- **Rows with no ASSIST record counted as routes:** an unrecorded row was treated as a route the student could take. It now counts as neither a route nor UC-only (`canRoute`).
- **Duplicate UC-only rule in the planner:** the planner kept its own copy of the UC-only rule. It now uses the checker's `ucOnly`.
- **Smoke script:** it now counts only blocking splits.

## Checks

- `npx tsc -b` passes.
- `npm test` passes 129 of 129.
- The oracle stress run matches on all 20,000 cases.
- `scripts/smoke.mjs` passes 95 of 95.
- The build has no warnings.
- In the browser (1440px and 390px), UCLA CS shows the counselor row and Scenario 2 is still red, with no overflow and no console errors.

## Still open

- **Old data files.** With the current fixtures, 14 of 22 majors can't turn green, because they depend on rows with no ASSIST record. `npm run fetch` with the fixed import code should resolve most of these.

---

# Round 4: fresh data, trust guard, schedule order, planner cost, permanent validation

| Area | What was wrong | What changed |
|---|---|---|
| Data freshness | Data was refreshed only when someone ran `npm run fetch` by hand. The bundled files predate the import fixes. | A daily GitHub Actions refresh (`.github/workflows/data-refresh.yml`). It finds the academic year itself, retries, stages everything, validates, and then commits `data/`. If a gate fails, nothing is published, the last good data stays, and an issue is opened. Raw payloads are stored, so the data can be rebuilt offline (`npm run renormalize`). |
| Validation | No checks on data. | `npm run validate:data` runs about 56,000 checks: schema, invariants, orphans, the calculus-marked-recommended heuristic, a diff guard against large drops, known-truth canaries, and the app's own suites run against the candidate data. CI mode reports legacy data without failing code changes. |
| Trust | Stale data could show a green verdict (UCLA ME with no calculus). | `src/data-trust.ts` implements the policy in DATA_CONTRACT.md. **Untrusted** data never shows green; the page says "Can't confirm — data needs refresh" and shows a site-wide banner. **Aging** data (over 7 days) shows a caveat. |
| Honors | De Anza MATH 1CH + 1D was rejected for UCSD MATH 20E with no explanation. | The verdict stays strict. A hint says "ASSIST lists MATH 1C, not MATH 1CH… confirm with a counselor before retaking" (`src/engine/hints.ts`). |
| Schedule order | 57% of plans that include Calculus I put higher math in the same term or earlier. | Prerequisites are inferred from course titles and numbers (`src/engine/sequence.ts`). Plans that break a prerequisite went from 739/990 to 0. Labs share a term with their lecture. |
| Planner cost | Minimizing units pulled students away from their home college and split math across colleges. | The cost is now units + 5 per extra college + 5 per subject chain split across colleges, and it stays exact and proven. Plans that leave home when home alone would do went from 162 to 66 of 204. Math split across colleges with an empty transcript went from 409 plans to 0. Units rose about 4%. |
| Latent bugs | Planner and checker disagreed on "choose N" rows with no ASSIST record, and on nested UC-only slots. | The planner now uses the checker's own rules (`treeState`). Checked against 20,000 random trees. |
| Determinism | Shuffling the input exposed three order dependencies. | Order-free keys for repeated rows, sorted messages, and choices crossed in an order fixed by their content. The same plan comes out under any permutation (5,490 of 5,490 checks). |
| Permanent validation | Only our own tests checked the app. | `tests/independent/`: an oracle that shares no code with the app, 214 counselor scenarios, exhaustive and fuzz runs, and planner checks against brute force. It runs in CI (about 35 s) and nightly at full budget. |

**Checks:**
- `tsc`: clean.
- 618 tests pass.
- Full independent budget: green.
- 20,000-case oracle stress: green.
- Smoke: 95 of 95.
- Build: clean.
- `validate:data:ci`: passes, with legacy data reported rather than failed.

# Round 5: two more testers (TESTER1_REPORT.md, TESTER2_REPORT.md)

The work was split into 14 short, file-scoped agents, then merged and checked together.

**Business decisions:**
- Plans include enrollment prerequisites. Their units are counted and each is labeled "prerequisite".
- Calculus-based Mechanics comes after Calc I, and E&M after Calc II.
- Real quarter and semester calendars are used.
- A subject chain costs 5 × (colleges − 1).
- Plans start in the next term still open for registration.
- UC Irvine advisory sections are optional.
- Only neutral or stricter data changes publish on their own. Loosening changes, large drops and a changed academic year go to a review PR.
- After July 1, the prior year's data is kept, with a caveat, until ASSIST publishes the new year.

**Tester 1 (counselor):**

| Finding | What changed |
|---|---|
| C-1: "Everything required is already complete" when nothing could be scheduled | The note now follows the verdict and names up to 3 unmet requirements (`scheduleNote`, `unmetNames`). |
| H-1: missing enrollment prerequisites (business calculus before Calc I) | `src/engine/prereq.ts` adds same-college prerequisites, counts their units and labels them (`Plan.prereqOnly`). A prerequisite offered only at another college becomes a warning (`Plan.prereqWarnings`). `optimal` stays true only when it is still proven. |
| H-2: no math→physics order | Mechanics comes after Calc I and E&M after Calc II (`sequence.ts`). Algebra-based physics is excluded. |
| H-3: quarter and semester terms mixed | `src/engine/calendar.ts` puts all terms on one shared timeline. Each course goes in its college's own calendar, and the unit cap counts terms that run at the same time. |
| H-4: UC Irvine advisory sections were required | Titles are classified in normalize, and unclear ones stay required and raise a warning. `NORMALIZE_VERSION` is now 3. New validator checks and a canary. |
| M-1: "minimum units" | Replaced with "lowest cost under our rules". |
| M-2: honors codes the student didn't take | The satisfied group with the fewest honors swaps is shown. |
| M-3: no caveat on the schedule for untrusted or aging data | `scheduleCaveat`. |
| M-4: 3 colleges cost the same as 2 | chainPenalty × (k−1). The independent brute force was updated to match, in its own code. |
| M-5: always "Fall 2026" | A start-term selector. There is now one registration-cutoff rule (`src/terms.ts`), used by both the page and the engine. |
| M-6: July 1 rollover | The pipeline falls back to the prior year, never two years back. `meta.carriedOver` makes the data aging with a caveat. Unmarked prior-year data has a 7-day grace period. The plan shows which year's agreement it uses. |
| L-1 to L-7 | The hero and footer follow the live trust state. Plain-language banner. Trust is re-checked every minute and on tab focus. The count check was tightened. Honors hints name the 1AHP companion. The Trap demo is never green on untrusted data. LinAlg and DiffEq are not ordered by letter. A search with no match explains why. |

**Tester 2 (adversarial systems):**

| Finding | What changed |
|---|---|
| C-1: loosening changes auto-published; the gate stopped only 36% of false-green corruptions | `scripts/pipeline/diff.ts` classifies each change semantically and replays verdicts on sample transcripts. Anything looser than the last reviewed baseline (`data/baseline-manifest.json`) goes to review. It now stops **281 of 283 (99.3%)**; the 2 misses are exact duplicate groups, which don't change meaning. |
| C-2: payload identity not checked | Each payload's college, UC, year and major must match the request, or the run fails before anything is stored. The CI gate re-checks the stored raw payloads. |
| H-1: raw store optional | Required in publish and CI mode, except for legacy data that was never fetched. |
| H-2: shared staging, no lock | Lock files with stale-lock detection, and a unique staging directory per run. The staged tree is hashed after validation and re-checked just before the swap. |
| H-3: no recovery after a crash | `recoverPublish()` restores the last good data. Publishing onto an empty repo needs `--first-publish`. |
| H-4, H-5: slow drift, one college's data dropping | Changes are judged against the reviewed baseline. Per-college drop thresholds send a run to review. |
| H-6: no PR mode, deploy or freshness monitor | `data-refresh.yml` has separate jobs: refresh (read-only), publish (commit, review PR or auto-merge PR), notify and keepalive. `freshness.yml` opens an issue if data is more than 36 h old. |
| M-1: `accept_large_change` too broad | Manual runs only. It needs a reason of at least 15 characters, which is logged, applies to one run, and always opens a review PR. |
| M-2: trust read only meta.json | The academic year of each loaded agreement is checked against meta. |
| M-3: an empty tree or "choose 0" counted as valid | Rejected by verify and by the validator. The independent oracle has the same fail-closed rule. |
| M-4: no solver time limit, ran on the main thread | `timeLimitMs`, and a Web Worker (`solveClient.ts`) that drops stale answers. The badge shows "Planning…" and is never green meanwhile. Checked in Chromium: the worker loads, the plan renders, no errors. |
| M-5: token exposure | `redact()` covers logs, reports and errors. Workflows turn off credential persistence and pass inputs through env. |
| M-6: a normalize bump made data untrusted | The pipeline first rebuilds offline from the raw store. |
| M-7: institution changes | A change to a college's calendar type or community-college flag is an error, and a rename is a warning. |
| M-8: no error boundary | Each section has one, with a calm fallback that shows no green. |
| M-9: cancelled runs, 60-day schedule disablement | The notify job also covers cancelled and timed-out runs. Keepalive re-enables the schedules. |
| L items | Expiring acknowledgements, a cap on response size, escaped Markdown, the actionlint checksum, and a CI-must-be-green check before a refresh. Deferred: L-2 (signing the raw manifest with an HMAC needs a secret). |

**Checks:**
- `tsc -b` and `tsc -p tests/independent`: clean.
- vitest: 799 pass.
- Independent suite: 333 pass.
- Smoke: 95 of 95.
- Build: clean.
- `validate:data:ci`: exit 0. The committed data is v1 and reported as legacy, so it stays untrusted until the first refresh.

**Open:**
- The committed data predates `NORMALIZE_VERSION` 3. The first refresh will go to review because no baseline exists yet, and merging that PR creates the baseline.
- The advisory-section rule is based on titles. Check UC Irvine CS, CSE and EE, and UC Davis EE and ME, on ASSIST after the refresh.
- Large synthetic "choose 20 of 40" trees take 1–2 s outside the search loop. They run in the worker, so the page doesn't freeze.

---

## Rounds 6–8: wrong verdicts, import gaps, planner robustness, accessibility

Testers covered verdicts, the planner, the data pipeline, the GitHub workflows and the browser UI. Fixers each owned separate files, then a final round re-ran every earlier repro against the finished code.

**Round 6 checks:** 8 false "complete" and 3 false "incomplete" out of 621. All fixed except the "choose several" case, which is covered by the safety net below.

| Finding | Fix |
|---|---|
| H-2: a missing ASSIST reason fell back to "No Course Articulated" | Falls back to `NOT_LISTED` (counselor). A record with no courses and no reason is the validator error `normalize.no-articulation-record`. |
| "Course(s) Denied" read as UC-only | UC-only only for an allowlist of ASSIST reasons (`UC_ONLY_REASONS`: No Course Articulated, must be taken at the university after transfer, Never Articulated). Anything else sends the student to a counselor, in normalize, verify and the gate. |
| M-1: And group with a blank item | The whole group is dropped. |
| M-2: rows in only some colleges' templates were forced optional | They keep their section's required-ness; colleges without the row are `NOT_LISTED`. |
| M-3: "ELECTIVE(S)" always optional | Optional only under the same rule as "ADDITIONAL". |
| H-1: badge blocked on splits the plan resolves | `completedSplits` judges completed-course splits with the finished plan. |
| L-1 / L-2: carried-over data green; empty agreement years skipped the check | Prior-year data is amber (`CAUTION_TITLE`). Empty years are untrusted. |
| M-4: one course fills two slots of a "choose N" group | **Safety net, not a full fix:** a required choose-2+ group sets `ValidationResult.review`, and the badge turns a would-be green amber ("Looks covered — confirm the 'choose several' requirement with a counselor"). The validator warns `tree.choose-n-review`. No current agreement has one. |

**Round 7: import**

| Finding | Fix |
|---|---|
| C-1: `courseGroupConjunctions` ignored, so "A And (B or C)" read as "A or B or C" | Groups are combined as ASSIST says: an And range is the cross product, capped at 64 alternatives. A malformed or unknown conjunction list, or one over the cap, makes the row `NOT_LISTED` at that college, and the validator warns `normalize.conjunctions`. |
| M-3: content normalize can't model was dropped silently | Unmodelled cells (GE, requirement text) become required counselor rows. Odd section types, `NFollowingUnits` and unknown instructions raise the warning `normalize.unmodelled`. |
| L-1: case-sensitive conjunctions, NFollowing ignored, prefix case | Case-insensitive; NFollowing becomes N_OF; course ids are upper-cased. |

**Round 7: engine and badge**

| Finding | Fix |
|---|---|
| M-2: schema errors read loosely (lowercase "and" as choose-1, missing `required` as optional, empty course group satisfied by nothing, missing children crashed) | `malformed()` checks the schema of the whole tree and fails closed; nothing throws. |
| Invalid trust values could show green | Anything except exactly "trusted" or "aging" is untrusted. |

**Round 7: planner**

| Finding | Fix |
|---|---|
| N-1: Statics, Dynamics and Circuits planned before calculus and physics | Ordering by title (ENGR, EGR, ENGN, ENGIN): after Calculus II and calculus-based mechanics; Circuits also after E&M; Dynamics after Statics. Went from 23/330 plans affected to 0. |
| N-2: a planner error left "Planning…" forever and disabled the worker | The worker catches errors and replies. The client delivers an error plan, keeps the worker, and has a 10 s watchdog. The badge shows "Couldn't build a plan". |
| N-3: NaN or string units, NaN or fractional year, or Summer start made the solver hang or return garbage | Inputs are validated with clear errors, and the pack loop is bounded. A tree with a row that has no groups list gives an invalid plan instead of throwing. |
| N-4: `chosen` named courses that weren't planned (honors twins) | It names the planned courses. |

**Round 7: pipeline and workflows**

| Finding | Fix |
|---|---|
| High: a normalize-version bump auto-published without review | A renormalize pass that needs review forces the run's decision to review. The workflow also passes `--no-auto-renormalize`. |
| M1: a removed required choice passed as "stricter" when a row was added | New looser change `choice-removed`, which goes to review. |
| M2: data edited after validation could publish | `swapIn` re-hashes the copy and refuses on a mismatch. |
| L1 / L2: recovery could pick an incomplete backup; duplicate listing entries were stored | Only a complete backup is restored. Exact duplicates are dropped; a conflicting duplicate fails the fetch. |
| Workflows | CI gate checks runs from any event. Superseded PRs close on every route. Off-hour cron. Numeric, bounded `FRESHNESS_MAX_HOURS`, and the freshness step no longer exits early on a failed live fetch (so the stale issue still opens). No `${{ }}` in `run:`. `.nvmrc` and `engines >=22.18`. UTF-8-safe truncation. Docs cover PR-mode deploy and the required external monitor. |

**Round 7: browser UI**

| Finding | Fix |
|---|---|
| H-1: keyboard users couldn't Tab to the Planner (hidden until scrolled into view) | Reveal uses opacity only, and focus reveals a block at once. |
| H-2: two selects had no accessible name | `Select` requires a label. |
| M-1 / M-2: a wrong red verdict flashed for one frame; a mixed old-plan/new-selection frame | Planning state comes from the inputs on every render (`planState.ts`). A plan counts only for the exact inputs it was solved for. |
| M-3: old plan fully visible while planning | Dimmed, inert, with "Updating the plan…". |
| L items | "Try again" on the error screen (clear of the nav); chips named "Remove …" with focus kept; prior-year and choose-several caveats shown together. |

**Final checks:**
- `tsc -b` and `tsc -p tests/independent`: clean.
- vitest: 936 pass.
- Independent suite: 333 pass.
- Smoke: 95 of 95.
- Build: clean.
- `validate:data:ci`: exit 0.
- actionlint: clean.
- Re-verification: every earlier repro passes. Browser checks at 375, 768 and 1280 px: 11 of 11.

**Still open:**
- **The bundled data predates these fixes.** It shows as untrusted until the first refresh. For example, the legacy UCLA CS file still lets CIS 22A alone count for COM SCI 32.
- **The ASSIST conjunction field names are unconfirmed.** They are our best knowledge, and a mismatch fails closed. Confirm on the first real fetch.
- **Choose-N:** a full fix (each course fills one slot, in verify and the solver) is still to do. The safety net covers it until then.
- **Known plan-quality issues:**
  - Same-titled courses are treated as equal (Foothill "Calculus").
  - Scheduling doesn't put the longest prerequisite chain first.
  - Duplicate course content across colleges.
  - No re-optimization after prerequisites are added.
  - Home college and distance are ignored.
  - Summer is never planned.
- **Low items:**
  - `NFollowingUnits` is read as "take all".

---

## Round 9: small fixes

| Issue | Fix |
|---|---|
| Registration cutoffs and the July 1 year switch used UTC (6 pm Aug 31 in California counted as Sep 1) | `pacificDate()` in `src/terms.ts` reads the California calendar date. The app, calendar and pipeline all use it. It returns null (ask the student / untrusted / the run fails) for invalid dates, dates before 2 AD, or a runtime without the time zone. `codeInEffect` throws a clear error instead of "NaN-NaN". |
| Trap demo could be green on prior-year data | `demoTone(ok, trust)` mirrors `badgeStatus`: prior-year or not-trusted data is an illustration, never green. |
| Same term limit for semester and quarter schools; mixed-calendar plans warned by card count | The limit is two academic years of the home calendar (`maxTermsFor`). `beyondWindow()` flags cards that end after that window, by date, so mixed quarter/semester plans are judged correctly. |
| No placement caveat for honors/combined calculus | `isHonorsCalculus()` adds an informational note under the course. It never changes the verdict. |
| Empty schedule header on a planning failure | The schedule is hidden for an error plan and during the first build (`showSchedule`). |
| "Try again" couldn't recover from a network failure (Chromium caches failed module imports) | Agreements load as JSON with `fetch`. Failures are evicted from the cache, successes are kept, concurrent requests are shared. |
| Focus after "Try again" | Focus moves to the recovered section, or to the fallback if it fails again or focus was lost on the first crash. |
| `--first-publish` skipped review | A first publish always decides review, even with the accept overrides. |
| Unreadable, empty, garbage or dangling `data/index.json` could count as previous data and publish | `previousData()` in `run.ts`: the run is refused at preflight unless every entry is a plain file name that loads. `decide()` with nothing to compare returns review. Recovery skips a corrupt sidecar. |

**Final checks:**
- `tsc -b` and `tsc -p tests/independent`: clean.
- vitest: 1025 pass.
- Independent suite: 333 pass.
- Smoke: 95 of 95.
- Build: clean.
- `validate:data:ci`: exit 0.
- actionlint: clean.
- Browser re-run at 375, 768 and 1280 px: every item passes, with 0 green frames. The mixed-calendar sweep (70 plans) had no missed or false warnings. "Try again" recovers after 2 failures with no reload.

**Decisions taken:**
- A covered plan that runs past two years keeps its green badge, with a red "talk to a counselor about your timeline" warning under the schedule.
- Dry runs are not refused on unreadable previous data. They publish nothing and decide review.

