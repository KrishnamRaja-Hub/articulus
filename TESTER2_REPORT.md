# TESTER 2 report: data pipeline, validation gate, workflows, trust, determinism, performance

Tester: adversarial systems/QA pass on the machinery (not the transfer rules). Repo state: `abf0759` (FIXES round 4).
All experiments ran on a copy of the repo. assist.org was never called: every fetch went to the repo's mock ASSIST
(`scripts/pipeline/mock-assist.ts`) behind a fault-injecting proxy I wrote. The real `data/` was never modified.
The only file added to the repo is this report.

## 1. Executive summary

**Is the daily refresh production-safe? Transport: yes. Content: not yet.**

- **Transport and shape failures fail closed.** All 20 transport and shape faults were rejected: timeouts
  mid-stream, TCP resets, truncated JSON, HTML with 200, 429 storms, XSRF handshake changes, AcademicYears drift,
  malformed JSON-in-JSON and deadline overruns. In every case `data/` stayed byte-identical, the exit code was right
  (2 for fetch/build, 1 for the gate), and `failure.md` named the stage. This part is solid.
- **Content problems that make requirements easier are published automatically.** The gate cannot tell a
  harmful loosening from a real ASSIST update. The diff guard only counts groups and rows against thresholds; it has no
  notion of "a transcript that used to be red is now green". On real-sized data it caught only **103 of 283 (36%)**
  corruptions that can produce a false green. Examples: "take all" → "choose n−1" (0 of 21), a series shortened
  (0 of 22), a row flipped to UC-only (1 of 22), a required row deleted (2 of 22). End to end through the mock
  pipeline, 3 of these corruptions were published and produce a demonstrated false green (F36, F37, F38).
- **Payload identity is never checked.** A payload for the wrong academic year, the wrong UC, or with De Anza and
  Foothill swapped merges silently (F23, F25, F41; gate C12: 0 of 22 detected).
- **Several gate bypasses exist** (section 3): CI passes when `data/raw` is deleted, concurrent runs can publish the
  other run's rejected data stamped `passed: true`, a crash disables the diff guard on the next run, and slow
  cumulative drift is never flagged.

**Recommendation before relying on it for students:**

1. Add the payload identity assertions (C-2). This is a small change.
2. Until a semantic "loosening" diff exists (C-1), run the refresh with `DATA_REFRESH_MODE=pr`, with a required human
   review whenever any agreement's content changed. Keep the direct push only for "no content change" days.

**What the owner must configure:**

| Setting | Why |
|---|---|
| Settings → Actions → Workflow permissions: Read and write | The refresh commits `data/`. |
| `DATA_REFRESH_TOKEN`: a fine-grained token, contents:write on this repo only (plus pull-requests:write in PR mode) | Needed when `main` is protected. Needed in PR mode, otherwise CI never runs on the bot PR and auto-merge stalls silently (H-6). Needed for the push to trigger CI or deploy. |
| A deploy trigger: `DEPLOY_WORKFLOW`, or a host with git integration (Netlify, Vercel, Pages) | Data is bundled at build time. A commit is not a deploy. Without this the live site ages to "verdicts paused" after 30 days, and no alert fires (H-6). |
| An external freshness monitor on the live site (the built `meta.json` `fetchedAt`), alerting after 2 days | Covers stalled deploys, disabled schedules, cancelled jobs (M-9). |
| A branch ruleset or CODEOWNERS so that only the data bot changes `data/**`, and CI is a required check | Closes H-1 and L-2. |
| Watch for issues labeled `data-refresh-failure` | This is the only failure signal. |
| A plan for the first run | Committed data is legacy (normalize v1, 2025-2026, no raw store). The site shows "verdicts paused" everywhere today. The first refresh will very likely hit diff-guard errors and need a reviewed `accept_large_change` run. That run disables all diff checks (M-1), so review its report by hand. |

## 2. Metrics

| Area | Result |
|---|---|
| Pipeline fault injection (mock ASSIST + mutating proxy, 41 scenarios) | 4 legitimate scenarios published correctly: transient 500s, duplicate report, whitespace, reversed `templateAssets` (output byte-identical). Of 37 injected faults: **28 rejected safely** with `data/` byte-identical, 2 harmless faults absorbed (60 MB junk payload, NBSP trimmed), **7 published**: F23, F25, F36, F37, F38, F40, F41. Fail-safe rate on harmful faults: **28/35 = 80%**. Transport and shape faults: **20/20 = 100%**. |
| Gate detection, real-sized data: 25 corruption types × 22 agreements = 512 injections. Catalog pruned the way normalize builds it. | **Overall 260/512 = 50.8%.** At academic-year rollover or a normalize version bump: 233/512 = 45.5%. With `accept_large_change`: 213/512 = 41.6%. |
| … by category | schema 110/110 · identity (receivingId, year) 44/44 · title shift 28/44 · required→optional 13/22 · orphans 16/44 (4.9%: 0/22 by design, 5.2%: 16/22) · row drop 16/42 · college 27/88 · "choose/take" 4/30 · UC-only flip 1/22 · group weakened or added 0/44 · series split into single courses 1/22 · De Anza/Foothill swap 0/22 |
| … corruptions that can cause a false green | **103/283 detected (36%)**. Of the 180 undetected, 24 have a concrete witness: a transcript that is valid on the bad data and invalid on the original. The witness search is limited to single-college solver plans, so this is a lower bound. |
| Bypasses demonstrated | **7**: H-1 CI with raw deleted, H-2 concurrent runs, H-3 crash disables the diff guard, H-4 cumulative drift, M-1 rollover and all-or-nothing override, L-2 raw tamper with re-hash, M-6 version bump. |
| kill -9 during publish (`swapIn`, 60 trials, 3,000-file directories) | 0 partial or mixed `data/`. The result was always the complete old set (29) or the complete new set (31). Leftover `.data-next-*` in 29 trials and `.data-prev-*` in 5. |
| Disk full (tmpfs) | `data/` untouched. `.data-next-*` leftovers pile up (3 runs filled the disk to 100%). |
| Renormalize determinism | 3 separate processes: agreements, index and institutions byte-identical. Fetch output equals renormalize output. Reversed `templateAssets` gives identical output. |
| Solver determinism | 660 plans hash-identical across 5 processes, including `TZ=America/Los_Angeles`, `Asia/Kolkata` and a Turkish locale. |
| Solver timing, real grid (22 agreements × 15 homes × {home, home+1, all 15}, 990 solves, default weights) | p50 3.9 ms, **p95 58.7 ms**, p99 212.9 ms, **max 291.4 ms** (UCI EE, all 15 colleges). The p95 < 100 ms and max < 500 ms targets are met. |
| Random 25% transcripts at 3 colleges, all 15 allowed (600 solves) | p50 11.6, p95 41.3, max 289.6 ms |
| Huge transcript (every catalog course) | verify max 0.2 ms, solve max 2.5 ms |
| Adversarial synthetic trees (N_OF k of m, 15 colleges × 3 groups per row) | 5 of 10: 0.5 s · 10 of 20: 0.7 s · 15 of 30: 1.2 s · 20 of 40: 1.9 s · 30 of 60: **3.4 s** per solve, on the UI thread (M-4) |
| Bundle | main `index-*.js` 485 KB (148 KB gzip); 22 lazy agreement chunks of 25–92 KB (≤ 11 KB gzip) |
| App suites run by the gate | tsc 1.1 s, vitest src 11.0 s, smoke 0.6 s, build 1.1 s |
| Trust policy boundaries (31 cases) | 0 mismatches against DATA_CONTRACT.md. 7 edge cases noted (L-3, M-2). |
| actionlint 1.7.7 | 0 findings (shellcheck not installed, so `run:` scripts were not shell-linted) |
| Existing tests (`vitest run scripts`) | 77/77 pass |

## 3. Findings

| ID | Severity | Title |
|---|---|---|
| C-1 | CRITICAL | Changes that make requirements easier publish automatically; the gate detects 36% of them |
| C-2 | CRITICAL | Payload identity (sending college, UC, academic year) is never checked; wrong or swapped payloads merge silently |
| H-1 | HIGH | CI gate bypass: delete `data/raw` and hand-edit an agreement → CI green, app "trusted", false green |
| H-2 | HIGH | Concurrent runs sharing a work dir publish the other run's rejected data, stamped `validation.passed: true` |
| H-3 | HIGH | After a crash (or whenever `data/index.json` is missing) the diff guard is skipped entirely |
| H-4 | HIGH | Cumulative drift: 80% of an agreement's groups vanish over 6 daily runs with 0 errors |
| H-5 | HIGH | A whole college going dark inside an agreement is invisible at real size (2/22 detected) |
| H-6 | HIGH (suspected) | PR mode and deploy can stall silently while the workflow reports success and closes the failure issue |
| M-1 | MEDIUM | Rollover and version bumps weaken the diff guard; `accept_large_change` is all-or-nothing |
| M-2 | MEDIUM | App trust reads only `meta.json`: meta says 2026-27 and trusted, agreements are 2025-26 → green |
| M-3 | MEDIUM | Engine fails open on degenerate trees (an empty root is valid); shown green in the browser once the gate is bypassed |
| M-4 | MEDIUM | Solver has no time budget and runs on the main thread: 1.2–3.4 s freezes on large "choose N" trees |
| M-5 | MEDIUM | Write tokens (and a branch-protection-bypassing token) are exposed to `npm ci` and every dependency |
| M-6 | MEDIUM | A `NORMALIZE_VERSION` bump merges CI-green, then pauses verdicts for every user until the next refresh |
| M-7 | MEDIUM | `institutions.json` field changes are unguarded (a `termType` flip published) |
| M-8 | MEDIUM | One bad index entry or agreement blanks the whole site (no error boundary) |
| M-9 | MEDIUM | Alerting gaps: a cancelled or timed-out job opens no issue; the schedule can be auto-disabled |
| L-1 | LOW | kill -9 and ENOSPC leave `.data-next-*` / `.data-prev-*` copies in the repo root |
| L-2 | LOW | The raw store has checksums but no provenance: a tampered payload with a recomputed sha passes the strict gate |
| L-3 | LOW | Trust edge cases: a client clock 1 minute behind → paused; Feb 30 accepted; trust never re-evaluated in an open tab |
| L-4 | LOW | `acknowledged` findings never expire and can downgrade canary and schema errors |
| L-5 | LOW | The refresh ignores main's CI status and runs only part of the test suite; bot pushes skip CI |
| L-6 | LOW | Actions pinned by tag; actionlint installed via `curl \| bash` |
| L-7 | LOW | ASSIST-controlled strings reach issue and PR Markdown unescaped |
| L-8 | LOW | Response bodies are unbounded (a 60 MB payload is parsed fully in memory) |

### C-1 CRITICAL: changes that make requirements easier publish automatically

**Reproduction (end to end, mock ASSIST):** `node harness/pipeline-attacks.ts F36,F37,F38`. Each scenario starts
from a good publish, then serves the modified ASSIST response on the next daily run.

- **F36:** Berkeley ME's required section gets `NFollowing: 4` (take 4 of 5). Published. A Foothill transcript with
  no chemistry is `isValid: true`.
- **F37:** every college says "No Course Articulated" for MATH 52. Published. The row becomes UC-only, so it is
  deferred. A transcript without MATH 1B/1C is valid.
- **F38:** the MATH 52 row is removed from the template. Published. A transcript without MATH 1B/1C is valid.

**Reproduction (real-sized data):** `node harness/gate-attacks.ts` with `PRUNE=1` (numbers in section 2):

| Corruption | Detected |
|---|---|
| C05: "take all" → "all but one" | 0/21 |
| C03: series group loses a course | 0/22 |
| C04: bogus group added | 0/22 |
| C02: UC-only flip | 1/22 |
| C01: row deleted | 2/22 |
| C24: every series split into single courses | 1/22 (only the Berkeley ME canary) |

**Expected:** a change that turns an existing red transcript green is never published without human confirmation.
**Actual:** the change is published, and `meta.validation.passed` is true.

**Root cause:**
- `scripts/pipeline/validate.ts:403-464` (`diffGuard`) compares only group counts (25%), `minRows` (20%, and exactly
  20% passes: F36 and F38 are 5→4 rows) and lost colleges.
- There is no diff of `ucOnlyRows` (computed at `validate.ts:318` but never compared), the row id set, the group
  contents, or `required`/`n`.
- The canaries (`scripts/pipeline/canaries.ts`) cover only Berkeley ME, UCLA ME and Davis ME; 19 of 22 agreements
  have no behavioral canary.

**Fix:**
- Add a semantic diff per agreement. Classify each change as tightening or loosening:
  - a row id removed;
  - a row that was required becomes optional;
  - `n` decreased, or AND → N_OF/OR;
  - a group added or shortened;
  - a row that had groups becomes UC-only.
- Any loosening should be an error unless it is acknowledged per row, or it should route the refresh to a PR that
  needs human approval.
- A cheap, generic check: for each agreement and each college, solve on the old data; require that the planned
  transcript is still invalid on the new data if it was invalid before. This is the same witness method as the
  harness.
- Make the diff thresholds strict (`<` rather than `<=`).

### C-2 CRITICAL: payload identity is never checked

**Reproduction:** `node harness/pipeline-attacks.ts F23,F25,F41` (proxy rewrites Foothill's Berkeley ME payload).

- **F23:** the payload's `academicYear` is 2025-2026 while the run is 2026-2027. Published.
- **F25:** `receivingInstitution` is UCLA. Published.
- **F41:** the De Anza and Foothill payloads have `sendingInstitution` swapped. Published.

At data level, C12 (De Anza ↔ Foothill swapped) is detected 0 of 22 times, with a false-green witness on Berkeley ME
(home Foothill, 12 courses valid on the swapped data and invalid on the real data).

**Expected:** each payload must be for the college, UC and year that were requested.
**Actual:** only the first payload's year and UC are ever read. The sending id is taken from the payload, not from
the request.

**Root cause:**
- `scripts/pipeline/fetch.ts:60-63` checks only that the fields are strings.
- `src/engine/normalize.ts:97` takes `sendingIds` from the payloads.
- `normalize.ts:202-204` takes `receivingId` and `year` from `payloads[0]` only.

**Fix:**
- In `fetchRaw`, assert that `JSON.parse(r.sendingInstitution).id === cc`, `receivingInstitution.id === uc`,
  `academicYear.id === academicYear.id` (and `code`), and `r.name === m.label`. Throw on any mismatch.
- In `normalize()`, throw if the payloads disagree on receiving institution or year.
- Add a gate check on the raw manifest: each source's `sendingId` equals the payload's.

### H-1 HIGH: CI gate bypass by deleting the raw store

**Reproduction:** take any published data. Delete `data/raw`. Add `{institutionId: 51, courses: ["51:PHYS 4B"]}` to
Berkeley ME PHYSICS 7B. Then run `node scripts/validate-data.ts --mode=ci`.

**Actual:** `PASSED`, exit 0, 0 errors and 1 warning (`raw.reproducible: no raw payloads`). The app's
`dataTrust(meta)` is `trusted`.

**Expected:** a hand edit of current (non-legacy) data fails CI.

**Root cause:** `scripts/pipeline/raw-check.ts:17-18`. A missing raw store is only a warning in CI mode when
`legacyData` is false.

**Fix:**
- A missing raw store must be an error whenever `meta.normalizeVersion === NORMALIZE_VERSION`, or whenever `meta.fetchedAt`
  is not null.
- Protect `data/**` with CODEOWNERS or a branch ruleset.

### H-2 HIGH: concurrent runs publish the wrong data stamped as validated

**Reproduction** (two processes, same `--work-dir`):

1. Run A: `harness/slowA.ts` against the good mock, with a 6 s suite.
2. While A is in its suites, run B: `npm run fetch -- --skip-suites` against a mock where Santa Monica vanished.
3. B is rejected (`diff.college-removed`, exit 1).
4. A then publishes, and `data/agreements/79-mechanical-engineering-b-s.json` has `sendingIds: [113, 51]`: **B's
   rejected data**. `meta.validation.passed` is true, and A's log says "content unchanged".

**Root cause:**
- `scripts/pipeline/run.ts:272-274`: every run removes and reuses `<workDir>/staging`.
- `run.ts:328`: `swapIn` copies whatever is in `staging` at that moment.
- There is no lock.

CI is protected by the concurrency group and a fresh checkout. Local use (`npm run fetch` alongside
`npm run renormalize`) is not.

**Fix:**
- Use a unique staging dir per run (`mkdtemp`).
- Take an exclusive lock file on `workDir` and `dataDir`.
- Hash the staged tree after validation and verify the hash just before `swapIn`.

### H-3 HIGH: the diff guard is skipped when `data/` is missing

**Reproduction:** `node harness/race.ts` (first block). This simulates a kill -9 between the two renames in
`swapIn`: `data/` is gone and `.data-prev-*` exists. A fetch in which college 137 vanished is then **published**
(`ok=true`, `diff.previous=undefined`). With `data/` present, the same fetch is rejected (`diff.college-removed`).

**Root cause:**
- `scripts/pipeline/run.ts:90`: `prevDir` is set only if `data/index.json` exists, otherwise first-publish rules
  apply.
- `scripts/pipeline/publish.ts` never restores or cleans `.data-prev-*` on the next start.

**Fix:**
- Refuse to publish with no previous data unless `--first-publish` is passed.
- On start, recover `.data-prev-*` or `.data-next-*`.
- In CI, diff against `git show HEAD:data/`.

### H-4 HIGH: cumulative drift is never flagged

**Reproduction:** `node harness/frog.ts`. Each day, 24% of UCLA CS course groups are removed (and the catalog is
pruned the way normalize would). Days 1 to 6 all pass with no new errors. After 6 days, 80% of the groups are gone.

**Root cause:** `validate.ts:436-456` compares only with the immediately previous publish.

**Fix:** also compare against a pinned baseline (for example the first publish of the academic year, or the last
human-reviewed snapshot) with cumulative limits.

### H-5 HIGH: a whole college going dark is invisible at real size

**Reproduction:** gate C10 (all Foothill groups dropped, Foothill kept in `sendingIds`): detected 2 of 22 (the
Berkeley ME canary). C25 (Foothill loses half its rows): 3 of 22. With 15 colleges, one college is about 7% of the
groups, which is under the 25% per-agreement limit. In the small mock data set, F22 was caught only because the mock
is small.

**Effect:** students of that college get false red ("not articulated at the selected colleges") everywhere.

**Root cause:** `validate.ts:444-451`. There is no per-college statistic.

**Fix:** diff group counts per (agreement, college). Losing more than 50% at any college should be an error.

### H-6 HIGH (suspected; GitHub-side behavior not reproducible offline): PR mode and deploy can stall silently

These follow from `.github/workflows/data-refresh.yml` and documented GitHub behavior:

1. **PR mode.** With `DATA_REFRESH_MODE=pr` and no `DATA_REFRESH_TOKEN`, the PR is opened by `GITHUB_TOKEN`
   (lines 119-125), and pull_request workflows do not run for it. If CI is a required check, `gh pr merge --auto`
   waits forever. The job still succeeds, and the step at lines 136-141 closes the failure issue with "Recovered: …
   published validated data". Each day adds another stalled PR.
2. **Deploy.** In push mode without `DEPLOY_WORKFLOW` or a host-side git integration, nothing deploys the commit. The
   live bundle ages to "untrusted" after 30 days and no alert fires.

**Fix:**
- Fail PR mode when `DATA_REFRESH_TOKEN` is absent.
- Close the failure issue only after verifying that the PR merged, or that the live site serves the new
  `fetchedAt`.
- Add a daily check of the live site's freshness.

### M-1 MEDIUM: rollover and version bumps weaken the diff guard; the override is all-or-nothing

At `validate.ts:414`, `shapeMayMove` turns `diff.groups-drop` and `diff.required-rows` into warnings whenever the
academic year or normalize version changes. That is exactly when the most content changes (July).

| Corruption | Steady state | Rollover |
|---|---|---|
| Overall | 260 | 233 |
| C06 | 4 | 0 |
| C07 | 13 | 6 |
| C08 | 10 | 3 |

`DATA_ACCEPT_LARGE_CHANGE` downgrades every diff error for the whole run, and the ASSIST data fetched on the
accepting run is not the data that was reviewed. Overall detection falls to 213; C11 (college removed) falls from 22
to 2.

**Fix:**
- At rollover, keep the thresholds but compare against the previous year's data normalized with the current code.
- Make the acceptance specific: an accept file listing the exact findings (check, file, value) that were reviewed.

### M-2 MEDIUM: app trust reads only `meta.json`

**Reproduction:** build with a `meta.json` that says 2026-2027, v2, validation passed, while the agreements keep
`year: "2025-2026"`. In the browser the badge reads "Every requirement covered … UC Berkeley · **2025-2026 agreement**".

The following are also accepted as trusted:
- `validation: {passed: true}` with no `at` or `checks`;
- an `academicYear.id` that does not match the code;
- `agreements: 0`.

**Root cause:** `src/data-trust.ts:81-127`, and `src/data.ts:37` passes meta only.

**Fix:**
- Treat data as untrusted if `agreement.year !== meta.academicYear.code` (check on load, in `Planner`), or if
  `index.length !== meta.agreements`.
- Validate the full `validation` shape.

### M-3 MEDIUM: the engine fails open on degenerate trees

`verifySchedule` returns `isValid: true` for an empty root and for `N_OF n: 0`. In the browser, trusted meta plus an
empty-tree agreement shows a green "Every requirement covered" with 0 courses. The gate catches both shapes
(`tree.empty`, `tree.n-of`, canary), so this needs a gate bypass first (H-1, L-2).

**Fix:** a required AND or N_OF with no children, or with `n < 1`, is invalid at runtime.

### M-4 MEDIUM: solver worst case on the UI thread

Synthetic "choose 15 of 30" rows, each with 3 groups at 15 colleges, take 1.2 s per solve; "choose 30 of 60" takes
3.4 s. `solve` runs inside `useMemo` (`src/sections/Planner.tsx:78`) on every course added. It has a node budget but
no time budget. Real data today is fine (max 291 ms).

**Fix:** add a time budget (about 150 ms) with a greedy fallback, and move solving to a Web Worker.

### M-5 MEDIUM: write tokens are exposed to the whole build

In `data-refresh.yml`:
- line 53: `GH_TOKEN` (contents, issues, PR and actions write) is job-level;
- line 59: checkout persists `DATA_REFRESH_TOKEN`, a token meant to bypass branch protection, in `.git/config`.

Both are readable by `npm ci` lifecycle scripts and by every tool the suites run (vitest, vite, tsc and their
dependencies).

**Fix:**
- Set `persist-credentials: false`.
- Split into a read-only fetch/validate job that uploads `data/` as an artifact, and a commit job with no `npm ci`.
- Set `GH_TOKEN` per step.
- Pin actions by SHA.

### M-6 MEDIUM: a normalize version bump pauses verdicts for everyone

With `NORMALIZE_VERSION = 3` and data at v2, `validate:data:ci` reports "PASSED for code; committed data is LEGACY" and
exits 0. The deployed app then shows "verdicts paused" to every user until the next refresh and deploy (up to about
24 h or more).

**Fix:** once a raw store exists, CI fails when the code and data versions differ. Require `npm run renormalize` in
the same PR.

### M-7 MEDIUM: `institutions.json` field changes are unguarded

F40: ASSIST flips De Anza's `termType` to semester. Published. The diff checks only institution removal
(`validate.ts:424-426`). This changes unit conversion and term caps for every De Anza plan.

**Fix:** a changed `terms` or `isCC` is an error; a changed `name` or `short` is a warning.

### M-8 MEDIUM: one bad index entry or agreement blanks the whole site

**Reproduction (browser):**
- An index entry whose file is missing gives a blank page: `kc[e] is not a function`, from `src/data.ts:28`, called
  unguarded at `Planner.tsx:68`.
- An agreement without `root` gives a blank page: `Cannot read properties of undefined (reading 'kind')`.

Neither is a false green, but the site goes down. The gate catches both.

**Fix:** catch load errors, and add an error boundary that shows "data unavailable, confirm with a counselor".

### M-9 MEDIUM: alerting gaps

- The failure issue step runs only on `failure()` (`data-refresh.yml:155`). A job-level timeout or cancellation opens
  no issue.
- When the pipeline step is killed, the issue says "Failed before the pipeline ran", which is misleading.
- GitHub disables scheduled workflows after 60 days without repository activity. Daily failures produce only issue
  comments, so a long outage can silently disable the schedule (suspected).

**Fix:** use `if: failure() || cancelled()`, and add the external freshness monitor from section 1.

### LOW

- **L-1.** `publish.ts:14`: the `cpSync` into `.data-next-*` sits outside the `try/finally`. kill -9 left leftovers
  in 34 of 60 trials, and ENOSPC left one per run until the disk was 100% full. `data/` itself was never partial.
  These directories sit in the repo root and are not gitignored.
- **L-2.** `store.ts:437-449` checks the manifest sha only. `harness/rawtamper.mjs` edits Foothill's MATH 52 payload
  and recomputes the sha. `renormalize` then publishes, and both the strict and CI gates pass, with a false green (a
  Foothill transcript without MATH 1C is valid; on the original it is not). Protect `data/**` with CODEOWNERS or a
  ruleset, or sign the manifest with an HMAC secret held by the workflow.
- **L-3.** In `data-trust.ts`:
  - a client clock 1 minute behind `fetchedAt` gives "download date is in the future", so verdicts pause;
  - `2027-02-30` rolls over silently instead of being rejected;
  - `T24:00:00Z` is accepted;
  - trust is computed once at module load (`data.ts:37`), so a tab left open across day 30 or July 1 never changes
    level.

  Allow a few hours of clock skew, reject dates that do not round-trip, and re-evaluate trust on focus.
- **L-4.** `config.ts:201` and `validate.ts:370-371`: acknowledgements have no expiry. They can downgrade canary and
  schema errors, and a finding with no file is acknowledged by `check|`. Require an expiry date and disallow them for
  canaries and schema checks.
- **L-5.** The refresh runs only tsc, vitest src, smoke and build. It does not run `tests/independent`, the pipeline
  tests or `validate:data:ci`, and it does not check main's CI status. Pushes made with `GITHUB_TOKEN` trigger no CI.
- **L-6.** `actions/*@v4` are pinned by tag. `ci.yml:247` installs actionlint via `curl | bash`.
- **L-7.** `failure.md` embeds up to 80 characters of raw response inside a code fence, and report tables include
  ASSIST labels. A response containing a triple backtick can break the fence and inject Markdown or @mentions into the
  issue.
- **L-8.** `assist-client.ts:159`: `r.text()` has no size cap. A 60 MB payload was accepted and took 5 s; the
  `raw.maxFileBytes` limit applies only after gzip. Add a maximum on response bytes.

## 4. What held up

- **Transport and shape fail closed:** 20 of 20, `data/` byte-identical, correct exit codes, a useful `failure.md`.
  Covered: HTML with 200, truncated or `null` JSON, `isSuccessful: false`, mid-stream hang, TCP reset, 429 storm, 400
  after renewal, XSRF cookie rename, AcademicYears type drift and id drift, malformed nested JSON, nested field as an
  object, every listing empty, and the deadline.
- **Detected well:**
  - a college silently returning zero reports (`diff.college-removed`);
  - a whole agreement removed or renamed (`diff.agreement-removed`);
  - the CRITICAL-1 math title shift (18 of 22, plus heuristics and canary);
  - every schema and identity corruption (154 of 154): units 0 or NaN, a group spanning colleges, duplicate row ids,
    receivingId swapped, agreement year ≠ meta year, empty tree.
- **Publish is atomic in practice:** 60 kill -9 trials and disk-full never produced partial or mixed `data/`.
- **Determinism:** renormalize is byte-identical across processes; fetch output equals renormalize output;
  `templateAssets` order is irrelevant; solver plans are identical across processes, time zones and locales.
- **Performance on real data** meets the targets: p95 58.7 ms, max 291 ms. Verify on a huge transcript takes 0.2 ms.
  The bundle loads agreements lazily.
- **The trust policy matches DATA_CONTRACT.md** on all 31 boundary cases: 7 and 30 days, the July 1 UTC rollover
  (Pacific evening of June 30), leap day, a future `fetchedAt`, zone-less times, string versions, newer versions,
  schema 2, and a bad clock. Stale data never shows green.
- **A failing refresh keeps the last good data:** nothing is committed and the failure issue is opened.
- **Workflows:** `permissions: contents: read` at the top level, a `data-refresh` concurrency group with no
  cancel-in-progress, a code-changed-during-refresh guard before push, no untrusted `${{ }}` in `run:` (only booleans
  and admin-controlled `vars`), and actionlint clean.

## 5. How to rerun

The harness is outside the repo, in the session scratchpad:
the session's temporary workspace (not kept in the repo).
It imports from a copy of the repo at `../repo`. To use it elsewhere, copy the repo (without `node_modules`), symlink
`node_modules`, and set `REPO` in `common.ts`.

```
node harness/pipeline-attacks.ts [F23,F36,...]   # 41 fetch-level scenarios via the mock + mutating proxy
PRUNE=1 node harness/gate-attacks.ts             # 512 gate injections on real-sized data (steady, rollover, accept)
node harness/race.ts                             # H-3 crash state, in-process race control
node harness/mockserve.ts 18801 good & node harness/mockserve.ts 18802 bad &
  node harness/slowA.ts <data> <work> http://127.0.0.1:18801 & npm run fetch -- --skip-suites --data-dir <data> --work-dir <work>   # H-2, with ASSIST_BASE=...18802
node harness/frog.ts                             # H-4 cumulative drift
node harness/swapkill.ts                         # kill -9 during swapIn, 60 trials
node harness/diskfull.ts                         # after: mount -t tmpfs -o size=220k tmpfs out/tmpfs; cp -r <published data> out/tmpfs/data
node harness/trust.ts                            # 31 trust-policy boundary cases
node harness/perf.ts && node harness/det.ts      # timings and cross-process determinism
node harness/rawtamper.mjs <dataDir>             # L-2, then npm run renormalize -- --skip-suites --data-dir <dataDir>
```

To reproduce H-1 by hand: take published data, `rm -rf data/raw`, edit an agreement, then run
`npm run validate:data:ci` (it exits 0).
