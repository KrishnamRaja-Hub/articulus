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
