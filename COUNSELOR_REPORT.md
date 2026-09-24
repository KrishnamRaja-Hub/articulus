# Articulus: counselor QA report

Tester: Claude, acting as a transfer counselor and QA engineer. Date: 2026-09-24. Commit tested: `5a730b0`. No repo files were changed apart from this report.

## Executive summary (plain language)

**Can a student rely on this today? No, not by itself.** The checking engine does exactly what its written rules say. The data files and the schedule it suggests are not ready to act on without a counselor.

What I found:

1. **The rule engine is correct.** I wrote my own checker from the rules, without reusing any of the app's code, and compared the two on 372,766 transcripts. Most were real ASSIST agreements and some were synthetic ones.
   - The app never said "OK" when the rules say "not OK" (0 false positives).
   - The app never said "not OK" when the rules say "OK" (0 false negatives).
   - All three rescind stories from Plan.md are caught, as far as the data allows. So are the De Anza/Foothill split series, honors mixing, CVC third-college pieces, and retakes.
2. **The data files are out of date, and that causes wrong answers in real life.** The fixtures were built before three import fixes (F-01, F-02, F-03), and they have not been regenerated with `npm run fetch`.
   - **UCLA Mechanical Engineering shows a green "Every requirement covered" for a student who took no calculus.** I saw this in the browser. This is the one finding that could lead to a rescinded admission. **CRITICAL.**
   - Some students are told they are not done when they are:
     - Foothill chemistry does not count for Berkeley ME or EECS.
     - UC Davis requires all 7 composition/communication courses instead of 1.
     - UCLA ME requires four upper-division courses.
     - 14 of the 22 majors can never turn green, because a required course has no ASSIST record.
3. **The suggested schedules are not usable as written.**
   - In 480 of 842 plans that include Calculus I (57%), a more advanced math course (Calc II/III, linear algebra, differential equations) sits in the same term or earlier. For example, a Santa Monica plan puts Multivariable Calculus in term 1 and Calculus 2 in term 5.
   - To save a unit or two, the planner often spreads the calculus sequence over several colleges. This happens in 455 of 626 multi-college plans, and 237 of those mix quarter and semester schools. It also moves students off their home college (62 of 68 cases where home alone would do).
   - All of this follows the ASSIST row rules. But it is the kind of sequence-splitting across campuses that Plan.md warns about, and no counselor would recommend it.

**Safe to use today only with these caveats:**
- Use it as a split-series warning checker, not as the final word on a transcript.
- Use it only for majors whose trees I checked by hand against the rows: Berkeley CS/EECS/ME, UCSD ECE, UCI CS/ME, UC Davis ME. Even for those, a Foothill student's chemistry and calculus rows for Berkeley and UC Davis are incomplete.
- Every green badge needs a counselor to sign off.
- Do not follow the term-by-term schedule as written.
- **Before any student uses it:** run `npm run fetch` and re-run these suites. Until then, hide UCLA ME or add a warning to it.

## Metrics

### Verifier verdict (`isValid`), app vs independent oracle

"Positive" means the tool says the student is OK.

| Suite | Cases | TP | TN | FP | FN | Precision | Recall | FPR | FNR |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Named counselor scenarios (vs my hand-set expected verdict) | 206 | 48 | 158 | 0 | 0 | 100% | 100% | 0% | 0% |
| Exhaustive per-row subsets, 22 real agreements | 282,560 | 41,836 | 240,724 | 0 | 0 | 100% | 100% | 0% | 0% |
| Random real transcripts (sparse/dense/near-complete/honors-flip/garbage, 1–15 colleges) | 10,000 | 666 | 9,334 | 0 | 0 | 100% | 100% | 0% | 0% |
| Synthetic trees (nested AND/OR/N_OF, optional, UC-only, placeholder, honors, repeated ids) | 80,000 | 24,916 | 55,084 | 0 | 0 | 100% | 100% | 0% | 0% |
| **Total** | **372,766** | **67,466** | **305,300** | **0** | **0** | 100% | 100% | 0% | 0% |

**Named scenarios vs the real world.** Where the fixture itself is wrong, the expected verdict differs:

| TP | TN | FP | FN |
|---:|---:|---:|---:|
| 46 | 156 | **2** | **2** |

All four mismatches are data limitations. They are CRITICAL-1 and HIGH-1/HIGH-2 in the failure tables below.

### Row-level, splits, deferred, missing (app vs oracle)

| Metric | Named scenarios | Exhaustive real | Random real | Synthetic |
|---|---|---|---|---|
| Row satisfied: TP / TN / FP / FN | 1,162 / 2,978 / **1** / 0 | 2,752,384 / 3,231,484 / 0 / 0 | 109,070 / 88,746 / 0 / 0 | 500,795 / 600,873 / 0 / 0 |
| Split detection: TP / FP / FN | 41 / 0 / 0 | 26,481 / 0 / **1** | 1,202 / 0 / 0 | 13,803 / 0 / 127 |
| Split precision / recall | 100% / 100% | 100% / 99.996% | 100% / 100% | 100% / 99.08% |
| Blocking vs warning accuracy | 41/41 (38 blocking, 3 warning) | 26,481/26,481 (24,269 blocking, 2,212 warning) | 1,202/1,202 (1,075 / 127) | 13,803/13,803 |
| Deferred (UC-only) TP / FP / FN | 109 / 0 / 0 | 143,388 / 0 / 0 | 6,539 / 0 / 0 | 31,570 / 369 / 1,517 |
| Deferred precision / recall | 100% / 100% | 100% / 100% | 100% / 100% | 98.84% / 95.42% |
| `missing` exact (set of row ids named) | 205/206 (99.5%) | 282,560/282,560 | 10,000/10,000 | 79,211/80,000 (99.0%) |

What explains each non-perfect cell (details in the bug table below):
- The one row-level false positive in the named scenarios is the garbage id `113:MATH 1AHH` (LOW-5). It cannot be entered from the UI.
- The real-data split miss is UCI EE `EECS 40` (LOW-6). The app keeps only one partial per college, so it misses a split that the literal rule reports. This never changes the verdict.
- The synthetic deferred-list differences come from choose-N nodes with n ≥ 2 (LOW-3). No current fixture has one.
- The synthetic `missing` differences are one wording choice. When a choose-N cannot be met, the app leaves UC-only rows out of `missing`.

### Planner

| Metric | Real data (990-run grid: 22 majors × 15 homes × {home, home+Foothill, all 15}; plus 2,000 random transcripts) | Synthetic realistic trees |
|---|---|---|
| Runs | 2,990 | 3,000 (1,783 feasible) |
| Plan valid (oracle) when `unsolvable` is empty | 532 / 532 (100%) | 1,771 / 1,781 checked; **10 invalid** |
| `unsolvable` empty exactly when feasible at the allowed colleges | 2,990 / 2,990 | 2,982 / 3,000. **18** say "cannot be met" when a plan exists (MED-1) |
| Plans only at allowed colleges | 2,990 / 2,990 | 3,000 / 3,000 |
| Blocking splits created by the planner | 0 | **1** (MED-2) |
| Plans a UC-only row / re-plans a taken course | 0 / 0 | – |
| "Offered at …" names correct and complete | 100% | – |
| Unit-minimal vs brute force | 166 / 166 agree (2 hit the search limit) | 1,771 / 1,781 agree (99.4%). The 10 differences are the invalid plans above |
| `optimal:true` but not minimal | 0 | 0 in realistic trees. 10 of 1,765 when optional subtrees sit inside a choice (LOW-2, latent) |
| Deterministic under shuffled allowed and taken order | 2,990 / 2,990 | – |
| Deterministic under shuffled tree and group order | 771 / 771 | – |
| Timing per solve p50 / p95 / max | 3.2 / 11.0 / 44.7 ms | 0.77 / 7.5 / 492 ms. One unrealistic tree took 4.6 s |
| Per-term cap respected; units add up | 100% | – |
| Same-college letter order (1A before 1B) | 0 violations | – |
| **Advanced math in the same or an earlier term than Calc I** | **480 / 842 plans with Calc I (57%)**: 382 across colleges, 98 within one college | – |
| **Math sequence spread over 2+ colleges** | **455 / 626 multi-college plans (73%)**, 237 mixing quarter and semester | – |
| **Moves courses off the home college when home alone could finish** | **62 / 68**. 21 of those save ≤ 3 units; 2 save 1 unit | – |

### UI (Playwright, production build, Chromium, 1440 px and 390 px)

- 13 scenarios × 2 widths, 403 mechanical checks. **403/403 agree with the oracle.** The checks cover:
  - the badge's color and title, the deferred count, and the warning count;
  - violation cards, including amber vs red;
  - units to go and when "minimum units" appears;
  - the term list compared term by term with the engine's plan, and term names for the home system;
  - courses only at allowed colleges;
  - the "not coverable" card and the "after transfer" card;
  - every row of the requirement map (check / red / amber, "confirm with a counselor", "Take at UC after transfer");
  - no console errors, and no visible horizontal overflow at 390 px.
- Scenarios: Scenario 2 button, a warning-only split, UCSD ECE (deferred-heavy), UCLA CS (no-record row), Mission-only Berkeley ME (cannot be met), all done, UCLA ME with all 15 colleges, honors split, semester home, UC Davis ME at Foothill only, a mixed quarter/semester case, full De Anza, and a blocking 7C split.
- The screen faithfully shows what the engine decided. The problems are in what it means (UCLA ME green, prerequisite order, wording). They are listed below.

## Failures and findings

Severity uses the brief's scale:
- **CRITICAL**: the student is told OK and is not.
- **HIGH**: the student is told not OK and is.
- **MEDIUM** and **LOW**: everything else.

Type:
- **data**: the fixture predates the normalize fixes; needs `npm run fetch`.
- **app bug**: the code is wrong.
- **rule risk**: the code follows the rule, but the rule misleads in practice.

### Real-world false positives

| ID | Sev | Type | Repro | Expected | Actual | Root cause |
|---|---|---|---|---|---|---|
| CRITICAL-1 | **CRITICAL** | data | See "CRITICAL-1 repro" below | Not OK: UCLA requires MATH 31A–33A for ME transfer | `isValid: true`. In the UI, all 15 colleges and nothing taken gives a green "Every requirement covered", 59 units, and **no math course in the schedule** (screenshot `shot_U7-ucla-me-all15_1440.png`) | `data/agreements/117-mechanical-engineering-b-s.json` puts MATH 31A–33A, MECH&AE 82 and 94 under an `OPTIONAL "STRONGLY RECOMMENDED COURSES"` node. The upper-division rows are required instead. This is the F-03 title-pairing shift. `normalize.ts:216-222` is fixed, but the fixture was not regenerated. Nothing in the UI warns about it; the only caveat is the footer's "planning aid". |

**CRITICAL-1 repro.** File `117-mechanical-engineering-b-s.json`. The same transcript is used by scenarios `A3` and `I-lame`.
- Taken:
  - `113:CHEM 1A`, `113:CHEM 1B`, `113:CHEM 1C`
  - `113:ENGL C1000`
  - `113:CIS 22B`
  - `51:ENGR 11`, `51:ENGR 37L`, `51:ENGR 47`
  - `114:ENGIN 230`, `114:ENGIN 257`, `114:ENGIN 240`
  - `113:PHYS 4A`, `113:PHYS 4B`, `113:PHYS 4C` (A3 uses the Foothill PHYS 4A/4B/4C instead)
- No MATH courses.
- Allowed: any. Home: 113.

No false positives of the app's own making were found in 372,766 comparisons.

### Real-world false negatives

| ID | Sev | Type | Repro | Expected | Actual | Root cause |
|---|---|---|---|---|---|---|
| HIGH-1 | HIGH | data | `79-mechanical-engineering-b-s.json`, taken all at Foothill: `51:MATH 1A`, `1B`, `1C`, `1D`, `2A`, `2B`; `51:PHYS 4A`, `4B`, `4C`; `51:CHEM 1A`, `1B`, `1C` (scenario `I-FH-bme`) | Valid: ASSIST articulates Foothill CHEM 1A–1C | Invalid. The CHEM row is "not articulated at the selected colleges". The Foothill courses can still be added from search | F-01 orphans. The Berkeley chemistry row only has De Anza and Santa Monica groups. There are **376 orphaned catalog courses** across 8 agreements: they can be found in search but count toward nothing. Other examples: UC Davis `MAT 021C/021D` at Foothill, UC Davis `CHE 002A/002B` (only De Anza) |
| HIGH-2 | HIGH | data | UCLA ME with math, chemistry, physics, CS and composition done (scenario `I-lame-noupper`) | Valid for admission | Invalid: EC ENGR 100, MECH&AE 101/102 and MAT SCI 104 are "missing" | Same title shift as CRITICAL-1 |
| HIGH-3 | HIGH | data | `89-mechanical-engineering-b-s.json`, allowed [51], home 51 (scenario `K4`, UI `U10`) | Composition/communication is a single choice, and FH ENGL C1000 covers UWP 001 | "Cannot be met". COM 001, 002, 003 and 004 and NAS 005 are all required. Every UC Davis major asks for all 7 | F-02: a "choose N" section became AND. The same cause makes UC Davis CS require all 11 science courses, and UCSD CSE require BILD 1/2/3, CHEM 6A/6B, PHYS 2A/2B **and** PHYS 4A/4B |
| HIGH-4 | HIGH | data / rule 3 | UCLA CS with every catalog course taken (scenario `N3`) | OK: COM SCI 35L is taken at UCLA | Red, "COM SCI 35L — no ASSIST articulation record; confirm with a counselor" | Rows missing from every payload get the `NOT_LISTED` placeholder and are never deferrable. 14 of 22 majors can never turn green. This errs in the safe direction and the text is right to send the student to a counselor |
| HIGH-5 | HIGH (rule risk) | rule | `7-ece-electrical-engineering-b-s.json`, taken `113:MATH 1CH`, `113:MATH 1D` (scenario `F6`) | A counselor expects UCSD to accept honors Calc III for MATH 20E | 20E not satisfied, so the student is told to retake MATH 1C. MATH 20C does accept 1CH | Rule 1: De Anza lists no honors twin for the 20E row. Correct by the rule, but likely wrong in practice. Confirm with UCSD |

### App bugs

The app bugs below were found on synthetic trees or on inputs the UI cannot produce, except MED-3, MED-4 and LOW-7 to LOW-9, which show up with current data.

| ID | Sev | Type | Repro | Expected | Actual | Root cause |
|---|---|---|---|---|---|---|
| MED-1 | MEDIUM (latent) | app bug | Hand tree `OR(P1 no-record, U1 UC-only)`, or a synthetic `N_OF(3)[R2 no-record, R3 CC, R4 UC-only, R5 CC]` with R3 and R5 planned (`INHERIT=1 node synth_plan_show.mjs 170`) | The verifier passes it: the UC-only row fills the slot the no-record row cannot | The solver reports `unsolvable: ["1 more of: R2"]`, so the badge is red "cannot be met" while its own plan is valid. In other trees the needed CC courses are left out of the plan (e.g. `…show.mjs 388`) | `solve.ts:85-87` `quota`: `art = kids.filter((c) => !free(c))` counts rows with no record as articulable. `verify.ts:386` does not (`canRoute`). Not reachable now, because every real choose-N has n = 1 and none mixes a no-record row with a UC-only row. It becomes reachable once `npm run fetch` produces real N_OF groups (F-02) |
| MED-2 | MEDIUM (latent) | app bug / rule | Synthetic `INHERIT=1 node synth_plan_show.mjs 464`: `N_OF(1)[OR(AND(R1,R2),R3), N_OF(4)[OR(R1..), AND(R6 UC-only,R7), R8, R9 UC-only]]` | The planner and the checker agree | The planner returns `unsolvable: []` and `optimal: true`, but the plan is invalid and **opens a new blocking split** on R3 | The verifier (`verify.ts:393`) treats an alternative that passes only because of a UC-only slot as "deferred", so a CC route is owed elsewhere. The solver treats it as satisfied. Separately, it is questionable whether a mostly-completed CC alternative should count as "UC-only" at all. Not reachable in current fixtures |
| MED-3 | MEDIUM | app (planner) | Every plan in `order_check.mjs`. UI `U9`: Berkeley ME, home Santa Monica, nothing taken | Calculus I before Calc II/III, linear algebra and differential equations; Calc I before calculus-based physics | Fall 2026: MATH 11 (Multivariable) + CHEM 11; Spring 2027: MATH 7 (Calc 1); … Fall 2028: MATH 8 (Calc 2). 480 of 842 plans are inverted. UI `U3` (UCSD ECE, De Anza + CCSF) starts with CCSF MATH 130 "Linear Algebra and Differential Equations" before any calculus | `solve.ts:504-523` `pack` only orders letter suffixes within one college, and plain numbers only by ordinal titles. It has no cross-college or cross-subject prerequisites, and "Calculus 1" / "Multivariable Calculus" are not recognized as a series. Documented as a heuristic, but the UI presents the schedule and term count ("5 semesters") as a plan |
| MED-4 | MEDIUM | rule risk (planner objective) | `away.mjs`, `order_check.mjs` | Keep the student at home; never build the calculus chain across quarter and semester colleges | 62 of 68 home-solvable cases move courses away, 21 of them to save ≤ 3 units. Berkeley City with all 15 allowed: 6 courses at 5 different colleges. 455 of 626 multi-college plans spread the math sequence, e.g. Foothill MATH 1A (quarter) then Mission MAT 003B (semester Calc II) | The objective is minimum converted units first; home is only a tie-break (`solve.ts:200-205`). Rule 2 checks one row at a time, so a cross-college chain over *different* rows is allowed |
| LOW-1 | LOW | app (UI wording) | UI `U2`: Berkeley EECS, core at De Anza + FH PHYS 4D + FH BIOL 1B/1C | A warning chip that makes clear it means "toward PHYSICS 7C" | Chip "PHYS 4C at De Anza · no credit". That course *does* earn credit toward PHYSICS 7B | `Planner.tsx:248,262-266` lists the violation's own pieces as "no credit" with no row context |
| LOW-2 | LOW (latent) | app bug | Synthetic trees where an optional subtree sits inside an OR/N_OF, or an alternative is an AND whose children are all optional (`node synth_plan_show.mjs 2274`) | An optional subtree never satisfies a choice | The solver's `quota` subtracts optional children as if satisfied (`solve.ts:85` `fixed`), giving 10 `optimal:true` plans that are not minimal and 136 invalid plans in the unrealistic generator. The verifier treats an AND with no required children as satisfied (`verify.ts:382`, `!req.length ? 'sat'`), so a vacuous alternative can satisfy an OR with no courses. That is a latent false-positive path | Not reachable: normalize gives a choice's children the choice's own `required` flag |
| LOW-3 | LOW (latent) | app bug | `node handtrees.mjs` | `N_OF(2)(CC, U1, U2)` with nothing taken lists one UC-only row as certain; `OR(U1, U2)` defers one row | The first lists no deferred rows. `OR(U1,U2)` and `N_OF(2)(CC done, U1, U2)` defer both U1 and U2 | `verify.ts:393-394`: when a > 0 the slots UC-only rows must fill are dropped; when passing as deferred, every UC-only row is listed. No real node has n ≥ 2 |
| LOW-4 | LOW | app (text) | `K4` / `U10` | "CHE 002A and CHE 002B (one series) — offered at De Anza" | "1 of: CHE 002A, CHE 002B — offered at De Anza": reads as either/or | Row ids contain commas and are joined with ", " in `shortfall` (`solve.ts:159-163`). Empty lists also appear: "3 of: " and "One of: " (`verify.ts:388`) |
| LOW-5 | LOW | app bug | `verifySchedule({113:MATH 1AHH, 113:MATH 1B}, Berkeley ME)` (scenario `Q5`) | MATH 51 not satisfied | Satisfied via the honors group `[1AH, 1BH]` | `verify.ts:311`: `has` accepts `c + 'H'` even when `c` already ends in H. No "…HH" ids exist and the UI adds only catalog ids |
| LOW-6 | LOW | definitional | `120-electrical-engineering-b-s.json`, taken `113:CIS 35A`, `113:CIS 36B`, `58:CIS 36B` | Literal rule: De Anza 35A and Berkeley City 36B are different courses at two colleges, so a split | No split. Without `113:CIS 36B` it *is* flagged, so adding a course removes the warning | `verify.ts:319-331,340-341` keeps only the best partial per college. The app's "incomplete at De Anza, missing 35B" is arguably the better advice. The verdict is unaffected |
| LOW-7 | LOW | app (test hygiene) | `npm test` at repo root | 129/129 | 1 failed / 486 passed: it collects stale copies under `.claude/worktrees/*` | No `exclude` in the vitest config. `npx vitest run --dir src` gives 129/129 |
| LOW-8 | LOW | data | UC Davis requirement map | Section names match their rows | "CHEMISTRY" sits over ECS 050, "PHYSICS" over composition, "MATHEMATICS" over physics | F-03 title shift |
| LOW-9 | LOW | UX / rule | Any green badge with courses still to take | Make it clear the green badge means the *plan* covers everything | "Every requirement covered" appears before anything is taken | `plannerStatus.ts:32`. A student could read it as "I am done" |

### Other rule risks

- **UCSD PHYS 2A/2B/2C are separate rows** (scenarios `E-*`).
  - De Anza PHYS 4A + Foothill PHYS 4B + De Anza PHYS 4C satisfies all three rows, per the agreement.
  - But Plan.md's own story is that the two colleges put thermodynamics in different quarters. A student can finish all rows and skip or double-cover a topic.
  - The verdict matches the agreement, but a counselor would warn. The tool shows nothing.
- **"No Course Articulated" is treated as proof that a course is taken after transfer.**
  - Examples: UCSD MAE 3, ECE 35, ECE 5; UC Davis CHE 002AH/BH, based on a single college's note.
  - ASSIST's wording means only "this college has no equivalent". It does not mean "UC allows this after transfer" in the way "This course must be taken at the university after transfer" does.
  - The UI says these "do not count against your plan". That is fine for UCSD ECE, but the rule should prefer the explicit wording.
- **Berkeley ME's CHEM 1A/1AL/1B row appears twice**, once as required and once in the science choose-1, and one completion satisfies both.
  - I checked this: the De Anza and Santa Monica series really do cover both 1A/1AL and 1B, so it is acceptable. It is not a finding.
- **Colleges outside the 15 cannot be entered.** Plan.md's Scenario 1 student is at Mt. SAC and could not use the tool.

## What held up

These were confirmed with independent code and measured.

- **Split-series detection.** Checked every placement across De Anza and Foothill of:
  - PHYS 4B/4C for Berkeley 7B (16 cases);
  - PHYS 4A/4B/4C for the UCLA series (8 cases);
  - MATH 1A–1D for Berkeley 51, 52 and 53 (16 cases);
  - a third CVC college in the middle of a series;
  - three-college splits;
  - a split repaired at a fourth college.
- **Duplicates and blocking.**
  - A retake at another college is a duplicate, not a split.
  - A satisfied row is never a split.
  - The CHEM row, which appears twice, is reported once.
  - Blocking vs warning was right in 100% of 41,527 splits, of which 2,342 were warnings.
- **Honors.**
  - Mixing works only where the college lists an honors twin (De Anza MATH 52/51/CHEM/BILD; not Foothill MATH 52).
  - 1BH at one college with 1B at another is a duplicate.
  - The Orange Coast MATH A182H honors course correctly counts for both of the UCI rows it is listed for (MATH 2A and 2B).
- **UC-only rows.** Rows with an explicit ASSIST reason are deferred and never planned. Rows with only the placeholder stay open with "confirm with a counselor". In a choice, the CC route is owed first (UC Davis ME chemistry, Berkeley STAT 20).
- **Hostile input.** Garbage ids, lower-case or padded ids, other UCs' ids, 5,000 junk ids, and a ~5,000-course transcript made up of the union of every catalog: no crash and no false credit.
- **Planner on real data.**
  - Plans only at allowed colleges and never re-plans taken courses.
  - Never opens a blocking split.
  - "Cannot be met" matched real feasibility in all 2,990 runs, and "offered at" names are exact.
  - Fully deterministic, including under shuffled tree and group order.
  - Proven unit-minimal against brute force in every one of 166 checkable cases; `optimal:true` is never wrong on real data.
  - Fast: p95 11 ms.
- **Existing checks.** `npx vitest run --dir src` passes 129/129. `scripts/smoke.mjs` passes 95/95. The production build is warning-free. No console errors, and no visible overflow at 390 px.

## How to rerun

All scripts are in the session's temporary workspace (not kept in the repo). Each suite writes a `*_result.json`. `./run_all.sh` runs every engine suite (about 12 minutes).

| Script | What it does |
|---|---|
| `oracle.mjs` | Independent oracle for verdict, row status, splits (union per college), blocking, deferred and missing. Does not import `src/engine/` |
| `brute.mjs` | Independent exact minimum-units branch-and-bound over the oracle |
| `scenarios.mjs` + `run_scenarios.mjs` | 206 named counselor scenarios with expected verdicts, real-world notes, and planner expectations (`K*`) |
| `scen_metrics.mjs` | The named scenarios, app vs oracle |
| `fuzz.mjs` | Exhaustive per-row subsets over up to 3 colleges, twice (alone, and with the rest of the major complete), plus `NRAND` random transcripts. `ONLY=79-` restricts it to some files |
| `synth.mjs` | Synthetic-tree verifier fuzz. `INHERIT=1` gives realistic optional flags; `PH=0` / `UC=0` remove no-record or UC-only rows |
| `synth_plan.mjs`, `synth_plan_show.mjs <i>` | Synthetic planner vs brute force, and a repro of case `i` (use the same env) |
| `planner.mjs` | Real-data planner grid + random runs: rules, feasibility, determinism, minimality, timing |
| `order_check.mjs`, `away.mjs` | Prerequisite order, cross-college math chains, off-home planning |
| `handtrees.mjs` | Hand-built edge trees |
| `ui.mjs` | Playwright UI truth test (13 scenarios × 2 widths) |

Setup for `ui.mjs`:
1. `npm run build`
2. `npx vite preview --port 4180 --strictPort &`
3. `node ui.mjs`
4. Kill the preview processes by PID.

Screenshots are saved as `shot_*.png`.
