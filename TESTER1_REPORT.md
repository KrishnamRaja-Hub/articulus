# Articulus: Tester 1 report (counselor + QA)

- **Tester:** Claude, acting as a veteran California community-college transfer counselor and QA engineer.
- **Date:** 2026-09-24.
- **Commit tested:** `abf0759` (FIXES round 4).
- **Repo changes:** none apart from this file. `dist/` was rebuilt by `npm run build`; it is git-ignored.
- **Scripts and screenshots:** `/tmp/claude-0/-home-user-articulus/7831a9bf-5b6f-5531-9068-823767bea7ba/scratchpad/tester1/`.

## Executive summary (plain language)

### Can a student use this today?

**Only as a split-series warning tool, and only with a counselor.**

**Do not follow the schedule it builds.**

### What is safe now

**The new trust guard works.** The bundled data is out of date: it was built by an older importer, never validated, has no download date, and is for 2025-26. The page correctly refuses to call anyone "done":

- The badge says "Can't confirm — data needs refresh". It is amber, not green.
- A red banner appears at the top of the planner.
- A red chip stays in the header while the student scrolls.
- On a finished transcript, the schedule note no longer says "Everything required is already complete".

I tried every path I could think of to get a green verdict on this data. None worked:

- desktop and phone widths;
- print;
- switching majors quickly;
- Scenario 2;
- the Trap demo;
- a device clock set before the download date, 8 days after it, 30 days after it, and after July 1.

That is 187 of 187 checks. Red verdicts (split series, "cannot be met") still show, and each carries a "needs a refresh" caveat.

**The rule engine is still exact.** I wrote a new checker from the written rules. It agrees with the app on 40,000 random transcripts and 240 named scenarios:

- 0 false "OK";
- 0 false "not OK";
- every row, every split and every blocking flag matches.

### What is not safe

1. **The schedule is often impossible to follow, and nothing tells the student.**
   - **Business calculus instead of Calculus I.** For UC Irvine, the planner picks business or "short" calculus to cover MATH 2A. It then schedules Calculus II, III or IV with no Calculus I. At CCSF it even puts Calculus III in the first term. This affects 116 plans.
   - **Calculus IV alone.** Where ASSIST lists Calculus IV alone (UCI MATH 2D/2E), the plan never includes Calculus III.
   - **Physics before calculus.** Physics mechanics comes before any calculus in 17% of plans, and in the same term as Calculus I in another 40%.
   - **Quarter and semester calendars clash.** Semester courses are placed in "Winter" quarter terms. In 12 cases, the next course depends on a semester course that is still running.
2. **"Everything required is already complete. Nothing left to schedule."** appears under a red "Some requirements cannot be met" badge. This happens whenever nothing more can be planned but requirements are still unmet.
   - I reproduced it on a scratch copy of the app whose data is marked trusted. A Mission College student, Berkeley ME, chemistry not done: this student reads "Everything required is already complete".
   - On today's untrusted data the text is softer: "Nothing left to schedule… before you stop taking courses". It is still misleading.
   - This hits 588 of 660 "took everything the plan offered" transcripts. It becomes a real false "you're done" the day the data is refreshed. **CRITICAL (latent).**
3. **Other misleading wording.**
   - **"Minimum units" is shown on plans that are not minimum.** 442 of 990 such plans use more units than the true minimum, up to 17 more.
   - **The requirement map shows the honors version of courses.** For example, "MATH 1BH, MATH 1CH" for a student taking the regular MATH 1B and 1C. This happens in 1,088 of 9,017 mapped rows, including on the default page.
4. **UC Irvine ME/EE students can never be told they are ready.** Sections titled "…necessary to graduate in two years" and "Additional major electives" are treated as required for admission. This comes from a title rule in the importer, so re-fetching the data will not fix it.
5. **Last round's data problems are unchanged.** The data still needs `npm run fetch`. For example, UCLA ME with no calculus still passes inside the engine. The trust guard now hides it behind "Can't confirm".

### Caveats if it is shown to students before these are fixed

- Present it as a split-series checker.
- Hide or clearly caveat the term-by-term schedule. At minimum:
  - add "prerequisites not checked";
  - use "Fall 2026" only if the student can still enroll.
- Fix the "Everything required is already complete" note **before** the data is refreshed and marked trusted.
- Every verdict still needs a counselor's sign-off.

## Metrics

"Positive" means the tool says the student is OK. **Rule** means the answer the written rules give on the current fixtures. **Real** means what a counselor expects in reality.

### Verifier verdict (`isValid`)

| Suite | Cases | TP | TN | FP | FN | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|---:|
| Named scenarios, app vs expected rule answer | 234 with a verdict expectation | 34 | 200 | 0 | 0 | 100% | 100% |
| Named scenarios, app vs my new oracle | 240 | 34 | 206 | 0 | 0 | 100% | 100% |
| Named scenarios, my oracle vs the previous counselor oracle | 240 | 240 agree | | | | | |
| Random real transcripts, 22 agreements, app vs my oracle | 40,000 | 3,718 | 36,282 | 0 | 0 | 100% | 100% |
| **Named scenarios vs real-world expectation** | 234 | 33 | 197 | **1** | **3** | 97.1% | 91.7% |

The 240 named scenarios are:

- 204 named templates across all 22 agreements:
  - empty transcript;
  - complete De Anza route and complete Foothill route;
  - blocking split;
  - duplicate at a second college;
  - honors swap with and without an ASSIST twin;
  - split in a recommended row;
  - "everything in the catalog";
  - route minus one row;
  - rows from two different colleges.
- 36 hand-written cases:
  - the Plan.md stories;
  - the Trap;
  - a series repaired at a third college;
  - a third CVC college;
  - honors hints;
  - UC-only rows;
  - no-record rows;
  - choose-N rows;
  - courses at colleges the student did not select;
  - garbage ids.

All four real-world mismatches depend on the data. They are the known fixture problems from COUNSELOR_REPORT, and the untrusted-data UI no longer turns them green:

- **FP:** UCLA ME with no calculus (CRITICAL-1). The engine says valid; the UI shows "Can't confirm".
- **FN 1:** a full Foothill route for Berkeley ME, whose Foothill chemistry is orphaned (HIGH-1).
- **FN 2:** UCSD Math/CS choice of CSE 15L or CSE 29, where neither row has an ASSIST record (HIGH-4).
- **FN 3:** UCLA CS COM SCI 35L, which has no ASSIST record (HIGH-4).

A row-level real-world false negative remains by design: UCSD MATH 20E with De Anza MATH 1CH (HIGH-5). The row stays unsatisfied, but the honors hint appears.

### Row, split, blocking and hint accuracy (app vs my oracle)

| Metric | Named scenarios | 40k random transcripts |
|---|---|---|
| Row satisfied, exact | 4,744 / 4,744 | 784,838 / 784,838 |
| Split series: TP / FP / FN | 26 / 0 / 0 | 5,267 / 0 / 0 |
| Blocking vs warning correct | 26 / 26 | 5,267 / 5,267 |
| Honors hint present exactly when expected | 88 / 88 | – |

Hints were checked on:

- 85 generated honors swaps;
- the UCSD 20E case;
- the "already satisfied by another group" case;
- the "incomplete even with the swap" case;
- the "twin listed" case.

They never change a verdict. Existing suites: `npx vitest run` gives 618 passed, 10 skipped and 23 todo, with exit code 0.

### Trust guard

| Check | Result |
|---|---|
| `dataTrust()` edge cases: legacy meta, 7/8/30-day boundaries, future date, zone-less date, string types, schema, wrong or badly formatted academic year, null meta, invalid clock, June 30 / July 1 | 22 / 22 |
| Browser checks on 3 builds × 2 widths | **187 / 187** |

The three builds were:

- the real repo (untrusted);
- a scratch copy with trusted `meta.json`;
- a scratch copy with aging `meta.json`.

The browser checks covered:

- the badge's color and icon;
- no "Every requirement covered" or "Everything required is already complete" anywhere on untrusted data;
- the banner state and the header chip;
- the caveat on red verdicts;
- the "nothing left" note;
- quick switching between majors;
- the honors hint;
- clock-shifted views of the trusted copy (8 days → aging, 30 days → untrusted, July 1 → untrusted, clock before the download date → untrusted);
- print media (the banner stays visible);
- the Trap caption;
- console errors;
- horizontal overflow at 390 px.

The only paths that still show green on untrusted data are illustrations, not verdicts:

- the Trap demo's "PHYSICS 7B satisfied at De Anza", which is captioned;
- the per-row green checks in the requirement map, which only mean "this row is complete".

### UI truth (the screen matches the engine, untrusted build)

| Width | Scenarios entered through the real UI | Checks | Agree |
|---|---:|---:|---:|
| 1440 | 63 | 505 | 504 |
| 390 | 40 | 321 | 320 |
| Trust-focused run | 26 page loads | 187 | 187 |
| **Total** | | **1,013** | **1,011 (99.8%)** |

The mechanical checks were:

- the badge's color and title against `badgeStatus(…, 'untrusted')`;
- never green;
- each term's name and courses against `solve()`;
- the split cards, amber or red;
- the number of hint rows;
- the three stats.

Both disagreements are the same input: Foothill MATH 1BH cannot be entered for Berkeley ME, because the search lists only courses that articulate for the major. It has no effect on the verdict.

The **meaning** problems (the "nothing left" note, honors chips in the map, "minimum units") are faithful renderings of the engine's output, so they are listed as findings below and not as UI mismatches.

### Planner realism

The grid: 22 agreements × 15 home colleges × {home only, home plus a neighbour, all 15} × {empty transcript, first two home-only terms done}. That is 1,950 plans. 377 of them are complete (`unsolvable` empty); the rest are blocked mostly by fixture gaps.

The prerequisite classifier is my own: it uses titles and course letters and does not use `sequence.ts`.

| Metric | Result |
|---|---|
| Plans that need a prerequisite neither taken nor planned | **190 / 1,950 (9.7%)**, 225 courses. Complete plans: 22 / 377 |
| of which business or "short" calculus paired with the engineering calculus chain | **116 plans**, all UC Irvine: ME 30, CSE 27, EE 27, CS 16 |
| of which Calculus IV planned without Calculus III (single-course ASSIST rows) | 41 courses (De Anza MATH 1D 18, Foothill MATH 1D 23) |
| Order violations: prerequisite planned but not in an earlier term | 114 plans (106 physics mechanics before any calculus, 8 math). Complete plans: 20 |
| Empty-transcript plans with physics mechanics before the first calculus course | **83 / 477 (17%)** |
| … in the same term as the first calculus course | 193 / 477 (40%) |
| Lab before its lecture | 0 |
| Per-term unit cap exceeded (other than a single oversized course) | 0 |
| Semester-college course placed in a quarter "Winter" term | 135 |
| … where a dependent course follows in the next "Spring" term (same semester, so impossible) | **12** |
| Colleges per plan | mean 1.71, max 6. Distribution: 1: 1,073; 2: 547; 3: 209; 4: 89; 5: 13; 6: 19 |
| Math chain spread over 2+ colleges | 126 / 1,950 |
| Physics chain spread | 43 / 1,950 |
| Chemistry chain spread | 32 / 1,950 |
| Home alone could finish, but the plan leaves home | 38 / 68 |
| Plans labelled "minimum units" that use more units than the pure-unit minimum | **442 / 990** (all-15 configs: 312 / 330). Max +17 units (UCI EE, Foothill, all 15: 110.5 vs 93.5) |
| Unit delta vs pure units | +1,605 units over 990 plans. Home-only plans: 0 of 330 differ |
| Honors courses planned | 294 / 1,320 plans |
| Plans longer than 6 terms (the UI flags these) | 248 / 1,320 |
| Plans a college not allowed / re-plans a taken course / creates a blocking split | 0 / 0 / 0 (1,320 runs) |
| Plan valid per my oracle whenever `unsolvable` is empty | 308 / 308 |
| Deterministic under shuffled `allowed` | 1,950 / 1,950 |
| Solve time | p50 3.3 ms, p95 44 ms, max 321 ms |

## Findings (sorted by severity)

Severity:

- **CRITICAL:** the student is told OK and is not.
- **HIGH:** the student is told not OK and is, or the plan cannot be followed.
- **MEDIUM** and **LOW:** everything else.

"Suspected" means the finding depends on real-world facts that I could not confirm offline.

### CRITICAL

**C-1. "Everything required is already complete" under a red badge.** Type: app bug. Latent CRITICAL on trusted or aging data; HIGH wording today.

- **Repro:**
  - Agreement: `79-mechanical-engineering-b-s.json`, allowed [32], home 32 (Mission).
  - Taken: `32:MAT 003A, 003B, 004A, 004B, 004C`, `32:PHY 004A, 004B, 004C, 004D`.
  - Trust: trusted (scratch copy with fresh `meta.json`).
  - Screenshot: `s_trusted_bme_mission_done.png`.
- **Expected:** "Not done: CHEM 1A/1AL/1B is offered at De Anza or Santa Monica."
- **Actual:**
  - The badge is red: "Some requirements cannot be met", with a "Not coverable" card.
  - The schedule says **"Everything required is already complete. Nothing left to schedule."**
  - The stats say "0 units to go · minimum units".
  - On today's untrusted data the note reads "Nothing left to schedule under the current data… before you stop taking courses". That still suggests the student is finished.
- **Scope:** 588 of 660 "took everything the plan offered" transcripts (`emptyterms.mjs`).
- **Root cause:**
  - `src/sections/Planner.tsx:373-374` chooses the note from `plan.terms.length === 0` alone.
  - `src/sections/plannerStatus.ts:55-57` `nothingLeftNote` ignores `status` and `plan.unsolvable`.

### HIGH

**H-1. Plans schedule courses whose prerequisites are neither taken nor planned.** Type: app bug. The business-calculus articulation itself is a suspected data issue.

- **Repro A:** `120-mechanical-engineering-b-s.json`, allowed [33], home 33 (CCSF), empty transcript, any trust. Screenshot: `s_uci_me_ccsf.png`.
  - Fall 2026: MATH 110C Calculus III.
  - Spring 2027: MATH 130 Linear Algebra and Differential Equations.
  - Spring 2028: MATH 100A **Short** Calculus I.
  - Fall 2028: MATH 100B Short Calculus II.
- **Repro B:** the same agreement, allowed [113], home 113 (De Anza), empty transcript.
  - Winter 2027: MATH 12 "Introductory Calculus for Business" and MATH 1B Calculus II in the same term.
  - Fall 2027: MATH 1D Calculus IV, with no 1A or 1C anywhere.
- **Expected:** Calculus I (110A or 1A) → II → III, or the plan warns that Calculus I and III must be taken first. Business or short calculus is never a prerequisite for Calculus II or III.
- **Actual:**
  - 190 of 1,950 plans have a missing prerequisite.
  - 116 plans pair business calculus with Calculus II or higher.
  - Nothing in the UI mentions it.
- **Root cause:**
  - `solve.ts` minimises units plus penalties, and ties break on course id. `"113:MATH 12" < "113:MATH 1A"` as strings.
  - At CCSF, MATH 100A (3 units) is cheaper than 110A (5 units).
  - `sequence.ts:74` returns no topic for "business", "short", "life sciences" or "intermediate" titles.
  - `prereqs()` orders only courses that are already in the plan. Nothing adds or flags a prerequisite that is missing. For example, De Anza MATH 1D alone articulates to UCI MATH 2D/2E, so 1C is never planned.

**H-2. Physics mechanics is scheduled before any calculus.** Type: app bug (planner realism).

- **Repro:** `7-mae-mechanical-engineering-b-s.json`, allowed [51], home 51 (Foothill), empty transcript.
  - Term 1: PHYS 4A.
  - Term 2: MATH 1A.
- **Scope:**
  - 83 of 477 plans put mechanics before calculus.
  - 193 put it in the same term as the first calculus course.
  - Also Berkeley ME with Pasadena, Berkeley City or Saddleback as home and all 15 colleges allowed: PHYS in term 1, calculus in term 2 at Orange Coast.
- **Expected:** calculus-based physics after, or at best concurrent with, Calculus I (usually I completed and II concurrent).
- **Root cause:** `sequence.ts` has no math → physics edge. `pack()` (`solve.ts:874-912`) orders by depth, then by larger units first.

**H-3. Quarter and semester calendars are mixed into impossible sequences.** Type: app bug.

- **Repro:** `79-mechanical-engineering-b-s.json`, home 113, all 15 allowed, empty transcript. The plan:
  - Fall 2026: OCC MATH A182H "Calculus 1 and 2 Honors" and PHYS A185.
  - Winter 2027: OCC MATH A280 Calculus 3. Orange Coast has no Winter term, so this is its January–May semester.
  - Spring 2027: OCC MATH A285 Linear Algebra/Differential Equations and PHYS A280 E&M. These are in the same OCC semester as their prerequisite A280.
- **Scope:** 135 semester courses in Winter quarter terms; 12 dependent pairs.
- **Root cause:** `pack()` (`solve.ts:888-895`) names and fills every term in the home college's system. It does not know the calendar of the college offering each course.

**H-4. Non-admission sections are treated as required.** Type: rule risk / normalize. Suspected; confirm on ASSIST.

- **Repro:** `120-mechanical-engineering-b-s.json`, home 113, any transcript.
- **Expected:** admission readiness depends on "MAJOR PREPARATION COURSES REQUIRED FOR TRANSFER".
- **Actual:** a permanent red "Some requirements cannot be met", because these rows are required:
  - ENGR 7A/7B (Irvine Valley only);
  - ENGRMAE 91;
  - the sections "…NECESSARY TO GRADUATE IN TWO YEARS" and "ADDITIONAL MAJOR ELECTIVES".
  - UCI EE is the same: all 10 "ADDITIONAL MAJOR ELECTIVES", including the no-record EECS 22L.
- **Root cause:** `src/engine/normalize.ts:147` sets `required = !/RECOMMEND/i.test(title)`. Refreshing the data does not change this.

**H-5. Data false negatives are unchanged (engine level).** Type: data limitation, needs `npm run fetch`.

- Foothill chemistry is orphaned for Berkeley ME and EECS.
- UC Davis choose-N rows became "take all".
- UCLA ME requires upper-division courses.
- 14 majors depend on no-record rows.

These are COUNSELOR_REPORT HIGH-1 to HIGH-4, confirmed in scenarios `H-BME-FH-full`, `H-SMCS-OR-norecord` and `H-LCS-everything`. The UI now shows them with a "needs a refresh" caveat.

### MEDIUM

**M-1. "Minimum units" is shown on plans that are not unit-minimal.** Type: app wording.

- **Scope:** 442 of 990 plans. For example, UCI EE, Foothill home, all 15: the plan is labelled "minimum units" at 110.5 units, while 93.5 are possible across 9 colleges.
- **Cause:** the cost adds 5 units per extra college and per split subject chain. The label should read something like "best plan (fewest units after travel/chain penalties)".
- **Root cause:** `plannerStatus.ts:60` `optimalNote`.

**M-2. The requirement map shows honors courses the student never took or planned.** Type: app bug (UI truth).

- **Repro:** the default page load (Berkeley CS B.A., De Anza + Foothill, empty transcript).
  - The schedule plans MATH 1B, 1C, 2A and 2B.
  - The map shows MATH 52 as "MATH 1BH MATH 1CH" and MATH 54 as "MATH 2AH MATH 2BH".
- **Scope:** 1,088 of 9,017 mapped rows, in 436 of 660 plans.
- **Root cause:** `verify.ts:37-40` returns the first satisfying group, and ASSIST lists the honors group first. `Planner.tsx:417,452` prints `g.courses` verbatim.

**M-3. The schedule has no caveat on untrusted data.** Type: data + UI.

- **Repro:** UCLA ME, home 113, all colleges. Screenshot: `s_ucla_me_390.png`.
- **Actual:** the badge correctly says "Can't confirm". But "Your cross-enrollment schedule" plans calculus-based physics and circuits with **no calculus at all**, because of the stale data, and the section itself carries no warning.

**M-4. Travel and honors realism.** Type: rule risk.

- The "all colleges" plans send De Anza, Foothill, Mission and other Bay Area students to Orange Coast for their entire math and physics sequence.
- They start with an honors "Calculus 1 and 2" course that assumes prior calculus.
- Home alone could finish in 38 of 68 cases, but the plan leaves home anyway.
- Honors courses are planned in 294 of 1,320 plans.
- A subject chain split across 3 colleges costs the same as one split across 2. For example, UCLA CS at Mission after two terms: math at Mission, then CCSF, then Santa Barbara City.
- **Root cause:** `solve.ts` cost function (penalties 5/5; honors is only a late tie-break).

**M-5. Plans always start "Fall 2026".** Type: app.

- On 2026-09-24, semester colleges started in August and registration is closed.
- The UI passes no `startTerm`, and `solve.ts:114` defaults to Fall 2026.

**M-6. One academic year for the whole transcript.** Type: rule risk.

- UC evaluates a course under the agreement in effect when it was taken. The app checks every course against a single year.
- The trust rule also marks the data untrusted every July 1 until the pipeline fetches the new year's agreements. On some campuses those are published late.

### LOW

- **L-1.** The footer ("built on the same public ASSIST data your university will audit against") and the hero ("Real 2025-26 data", "a split series never costs you your admission") are shown unchanged while the data is untrusted. Files: `Footer.tsx:17`, `Hero.tsx`.
- **L-2.** The banner says "Verdicts are paused", but red verdicts still show. Its reasons use internal jargon ("importer version"). File: `data-trust.ts:109`.
- **L-3.** Trust is computed once at page load (`data.ts:36`), so a tab left open never downgrades. `meta.agreements` is not checked against `index.json`. `validation.passed: "true"` (a string) is reported as "failed validation".
- **L-4.** The honors hint for Foothill MATH 1AH → UC Davis MAT 021A says "Honors versions are usually accepted". But ASSIST lists 1AH **with** the 1AHP seminar, and the plan schedules 1AHP. The hint and the plan disagree.
- **L-5.** The Trap demo shows a green "PHYSICS 7B satisfied" on untrusted data. It has a caption.
- **L-6.** The letter rule orders MATH 2A before 2B (Differential Equations before Linear Algebra) and 1C before 2A. That adds a term. For example, the Berkeley CS B.A. De Anza plan takes 5 quarters for 5 courses. 248 of 1,320 plans run past 6 terms.
- **L-7.** A course that is taken but not articulated for the major (Foothill MATH 1BH for Berkeley ME) cannot be entered. It has no effect on the verdict.

## What held up

- **The trust guard.** No green verdict or completion claim appears on untrusted data in any path I tried: 187 of 187 browser checks and 22 of 22 policy cases. Red verdicts keep their caveat. Aging data shows green with a caveat, as specified.
- **The verdict engine.**
  - 0 false positives and 0 false negatives against a newly written oracle on 40,240 transcripts.
  - It agrees with the previous tester's oracle on 240 of 240 scenarios.
  - Split detection, blocking vs warning, duplicates (a retake at a second college), a series repaired at a third college, three-college splits, honors twins, UC-only rows, no-record rows, and choose-N / OR rows are all exact.
  - The Plan.md stories: Scenario 2 is caught for the UCLA series. Scenario 1 (an online Calculus II that needs its pair) is shown as incomplete with the pair to finish. Scenario 3 (a university-side prerequisite) is outside ASSIST data and is not claimed.
- **Honors hints.** They appear exactly when expected (88 of 88) and never change a verdict.
- **Planner hard rules.**
  - Only allowed colleges; never re-plans a taken course; never creates a blocking split.
  - The plan is valid whenever it says it is.
  - Labs go with their lectures, and per-term caps are respected.
  - Deterministic; p95 solve time 44 ms.
  - Ordering within the math chain is much better than last round. Only 8 math order violations remain in 1,950 plans (linear algebra or differential equations before Calculus II), plus the missing-prerequisite cases in H-1.
- **The screen matches the engine** on 1,011 of 1,013 checks, with no console errors and no horizontal overflow at 390 px.

## How to rerun

All scripts are in `/tmp/claude-0/-home-user-articulus/7831a9bf-5b6f-5531-9068-823767bea7ba/scratchpad/tester1/`. Run them with Node 22 as `node --import ./reg.mjs <script>`. `reg.mjs` registers a loader that resolves the app's extensionless imports.

**Engine suites:** `./run_all.sh`, about 2 minutes.

| Script | What it does |
|---|---|
| `oracle.mjs` | New independent checker. No `src/` imports |
| `scenarios.mjs`, `hand.mjs`, `runscen.mjs` | 240 named scenarios → `scen_result.json` |
| `fuzz.mjs` | `N=40000` random transcripts |
| `trust.mjs` | `dataTrust` edge cases |
| `realism.mjs` (+ `classify.mjs`) | Prerequisite, order, calendar, college and chain metrics → `realism_result.json` |
| `plancheck.mjs`, `physcalc.mjs`, `semwinter.mjs`, `delta.mjs`, `mapchips.mjs`, `emptyterms.mjs` | Individual findings |
| `show.mjs <file> <home> <allowed\|all> [taken,…] [c/h]` | Prints one plan |

**UI suites** (`ui.mjs`, `ui2.mjs`, `W=390 MAX=40 node --import ./reg.mjs ui2.mjs`, `shot2.mjs`) need three servers:

1. The real app: `npm run build`, then `npx vite preview --port 4190 --strictPort`.
2. `trusted/` on port 4191, a repo copy with a fresh `meta.json`.
3. `aging/` on port 4192, a copy with `fetchedAt` 14 days old.

To build each copy, run `npx vite build` in it, then serve it with `npx vite preview --port 419x --strictPort`. The browser is Playwright's Chromium, launched with `executablePath: '/opt/pw-browsers/chromium'`. Kill the preview servers by PID; the PIDs are in `pid_*`.
