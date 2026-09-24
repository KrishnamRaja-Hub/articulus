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
