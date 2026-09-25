# Data contract (shared by the fetch pipeline and the app)

## `data/meta.json`

```jsonc
{
  "schema": 1,
  "normalizeVersion": 2,          // NORMALIZE_VERSION from src/engine/normalize.ts that built data/
  "fetchedAt": "2026-09-24T08:00:00Z" | null,
  "academicYear": { "id": 76, "code": "2025-2026" } | null,   // the year the agreements are for
  "yearInEffect": "2026-2027",    // optional: the year in effect (July 1 rule) when fetched
  "carriedOver": true,            // optional: ASSIST had not published yearInEffect yet, so the prior year was fetched
  "validation": { "passed": true, "at": "<ISO>", "checks": 1234, "report": "data/validation-report.json" } | null,
  "agreements": 22
}
```

The pipeline writes this file on every successful refresh. The legacy file (`normalizeVersion: 1`, `fetchedAt: null`, `validation: null`) marks the fixtures fetched before the normalize fixes.

## Trust policy (the app enforces this in `src/data-trust.ts`)

Levels are evaluated in order.

| Level | When | Effect in the UI |
|---|---|---|
| `untrusted` | `normalizeVersion !== NORMALIZE_VERSION`, `validation` missing or failed, `fetchedAt` missing, older than 30 days, or `academicYear` is the wrong year: not the one in effect today, except for the prior-year cases under `aging` (two or more years back, or a future year, is always untrusted) | No green verdict. The badge says the data needs a refresh and to confirm with a counselor. Red verdicts (split series, missing requirements) are still shown, because they come from ASSIST rows that exist. |
| `aging` | Older than 7 days; or `academicYear` is the year before the one in effect and either `carriedOver: true`, or it was fetched before this July 1 and today is within 7 days of July 1 | Green is allowed. An amber banner shows the data date and each caveat. A prior year adds "2026-27 agreements aren't published on ASSIST yet; showing 2025-26. Articulation can change between years", and the plan shows the year it uses ("2025-26 agreement (2026-27 agreements aren't published on ASSIST yet)"). |
| `trusted` | Otherwise | Normal. |

The academic year in effect runs from July 1 to June 30. For example, from 2026-07-01 the expected code is "2026-2027".

### July 1 rollover (TESTER1_REPORT M-6)

ASSIST often publishes a new year's agreements weeks after July 1. A hard cutoff would make the whole site untrusted for those weeks, so:

- **Pipeline** (`scripts/pipeline/academic-year.ts`, `fetch.ts`): tries the year in effect first. If ASSIST does not list it, or lists it but has published no matching agreements for the configured pairs, it fetches the prior year and writes `carriedOver: true` and `yearInEffect` to `meta.json`. The validator accepts that as a warning. It never falls back two years: the run fails and the last published data stays. The daily refresh keeps re-checking, and the first run after ASSIST publishes the new year switches to it (`carriedOver: false`). The whole data set uses one year. If ASSIST has published the new year for some pairs but not others, the new year is used and the diff guard flags the majors or colleges that disappeared for review.
- **App** (`src/data-trust.ts`): a carried-over prior year is `aging` with the caveat above, for as long as the pipeline keeps re-checking (the 30-day age limit still applies). Prior-year data that is not marked, fetched before July 1, is `aging` for 7 days after July 1 so the pipeline has time to run, then untrusted. Data two or more years back, a carry-over mark from an earlier rollover, and data for a future year are untrusted.
- **Not covered**: which year's agreement governs a given student (the year a course was taken, or the year they will apply). The app checks every course against the one bundled year and says which year that is.

## Operations (workflows in `.github/workflows/`)

### What runs

| Workflow | When | What it does |
|---|---|---|
| `data-refresh.yml` | daily 09:23 UTC, manual | `refresh` job (read-only token): fetch, normalize, gate, app suites, strict re-check and the diff decision. `publish` job (write token, no `npm`): commits `data/` or opens a PR. `notify` job: opens or updates the `data-refresh-failure` issue when any job failed, timed out or was cancelled. `keepalive` job (scheduled runs): re-enables both schedules. |
| `freshness.yml` | every 6 h, manual | Independent monitor. Fails and opens or updates a `data-stale` issue when `fetchedAt` in `data/meta.json` on the default branch (and at `LIVE_META_URL`, if set) is older than `FRESHNESS_MAX_HOURS` (default 36). Closes the issue when data is fresh again. |
| `ci.yml` | push, PR, nightly, manual | Code and committed-data checks, actionlint (checksum-verified binary), nightly oracle stress. A manual run with `stress=false` skips the stress job; the refresh uses that. |

Concurrency: one `data-refresh` run at a time, queued and never cancelled; one freshness check at a time.

### Publish or review

The pipeline step (`npm run fetch`, `scripts/pipeline/run.ts` with `scripts/pipeline/diff.ts`) makes the release decision after every gate passes. It emits the step output `decision=publish|review`, writes `.pipeline/decision.json` (its `decision` field), `.pipeline/diff-report.md`, and appends the decision to `.pipeline/report.md`, which becomes the PR and commit body. The workflow sets `DATA_REFRESH_ON_REVIEW=pr`, so a `review` decision still stages `data/` together with a new `data/baseline-manifest.json` (the reviewed baseline) for the review PR. Without that variable, as in a local run, a `review` decision fails the run and publishes nothing. The workflow then re-checks `data/` with `npm run validate:data -- --report … --prev-dir .pipeline/prev/data` (the previous data is `data/` at the refreshed commit). A missing or invalid decision counts as `review`.

The refresh runs `npm run fetch -- --no-auto-renormalize`: data built by an older `NORMALIZE_VERSION` is not rebuilt and published automatically; the fetch's own normalize-version check sends the rebuilt data to review.

The app unit tests are a data gate too: the pipeline runs the app suites against the staged `data/` before any publish, and CI runs `npx vitest run` against the committed data, so a data change that breaks an app test fails the refresh or CI instead of shipping.

Before refreshing, the `refresh` job checks the latest completed CI run (any event except `schedule`) for the default branch's HEAD, else the latest on the branch. The bot's data commits get CI through `workflow_dispatch`, not `push`, so the check is not limited to push runs. A failed or timed-out run stops the refresh; an unknown status only logs a notice, because the refresh runs the app suites itself.

The first run after this change goes to review, because no `data/baseline-manifest.json` exists yet. A person merging that PR creates the baseline, and later runs judge looser changes against it.

A run with no previous data (no `data/index.json`) is refused unless it is started with `--first-publish`. That flag only lets the run proceed: its decision is always `review`, never `publish`, even with `--accept-large-change` or `DATA_ACCEPT_LARGE_CHANGE=1`, because none of the data has been reviewed. Locally (no `DATA_REFRESH_ON_REVIEW=pr`) the run fails and publishes nothing, and the message says to rerun with `DATA_REFRESH_ON_REVIEW=pr`. That stages `data/` with a new `data/baseline-manifest.json`, which then lands through a reviewed PR.

| Decision | `DATA_REFRESH_MODE` | Result |
|---|---|---|
| `publish` | unset | Commit to the default branch, then dispatch `DEPLOY_WORKFLOW`. If there's no `DATA_REFRESH_TOKEN`, it also dispatches CI with `stress=false`, because a `GITHUB_TOKEN` push triggers no workflows. The run also closes the open failure issue. |
| `publish` | `pr` | Force-push `data-refresh/<YYYY-MM-DD>`, open or update its PR with the report as body, and enable auto-merge (squash). This needs `DATA_REFRESH_TOKEN`; without it the job fails (a PR opened by `GITHUB_TOKEN` gets no CI run, so auto-merge would stall). |
| `review` (or `accept_large_change`) | any | The same branch and PR, labeled `data-refresh-review`. No auto-merge, and nothing goes live until a person merges. |

The route is always a PR in these cases. A newer refresh PR, a direct publish, and a direct-publish run that finds `data/` already current all close older open `data-refresh/*` PRs from this repository as superseded, so a stale PR cannot later be merged and roll the data back (a failed close only warns). Only a direct publish to the default branch closes the failure issue. After a merged PR, the freshness monitor confirms the data landed.

### `accept_large_change`

This is a manual input only; scheduled runs never set it. It needs `accept_reason` (at least 15 characters). The reason and the actor are logged in the run summary, the commit message and the PR body. It downgrades diff-guard errors for that run only (`DATA_ACCEPT_LARGE_CHANGE=1` exists in that run alone). The pipeline counts the override as human review (it publishes with a new baseline), but the workflow always forces the review route, so the data a person merges is the data this run fetched.

### Repository settings the owner must configure

1. **Settings → Actions → General → Workflow permissions:** "Read repository contents and packages permissions" (read-only default). Each job asks for more in its own `permissions:` block. Also turn on **"Allow GitHub Actions to create and approve pull requests"** (review PRs).
2. **Settings → General → Pull Requests:** turn on "Allow auto-merge" (only for `DATA_REFRESH_MODE=pr`).
3. **Secret `DATA_REFRESH_TOKEN`** (recommended; required for `DATA_REFRESH_MODE=pr`, and when the default branch blocks direct pushes). Use a fine-grained PAT or a GitHub App token for this repository only, with Contents: read and write and Pull requests: read and write. Pushes and PRs made with it trigger CI and push-based deploys. It is exposed only to the `publish` job's commit step, never to `npm ci` or the test suites.
4. **Variables** (Settings → Secrets and variables → Actions → Variables):
   - `DEPLOY_WORKFLOW`: the file name of the deploy workflow (it must have `workflow_dispatch`). Leave it unset if the host deploys on push (Netlify, Vercel, Pages git integration) and `DATA_REFRESH_TOKEN` is set.
   - `DATA_REFRESH_MODE`: `pr` to always go through auto-merging PRs. Leave it unset to push directly.
   - `LIVE_META_URL`: URL of the deployed `meta.json`. It lets the monitor catch a stalled deploy, not just a stalled commit, and the external monitor (item 8) watches the same URL.
   - `FRESHNESS_MAX_HOURS`: optional, default `36`. Must be a positive whole number; anything else fails the monitor run loudly.
5. **Branch ruleset on the default branch:** require the `CI / test` status check and pull requests for humans. Allow the `DATA_REFRESH_TOKEN` identity (or the GitHub App) to bypass for direct data pushes, or use `DATA_REFRESH_MODE=pr`. Add a CODEOWNERS entry or path rule so that only the data bot changes `data/**`.
6. **Notifications:** watch the repository for issues labeled `data-refresh-failure` and `data-stale`.
7. **With `DATA_REFRESH_MODE=pr`: a deploy workflow triggered by `push` on `data/**` of the default branch (required).** A merged data PR is a push by whoever merged it; the refresh workflow neither dispatches `DEPLOY_WORKFLOW` for it nor closes the `data-refresh-failure` issue (only a direct publish does). Without a push-triggered deploy the merged data never goes live, and the failure issue stays open until closed by hand or by a later direct publish.
8. **External uptime / JSON-age monitor on `LIVE_META_URL` (required).** Configure a monitor outside GitHub (any uptime service that can assert on a JSON field) that alerts when the live `meta.json` is unreachable or its `fetchedAt` is older than about 36 h. The in-repository monitor and keepalive depend on GitHub Actions schedules, which are best-effort (see below), so they cannot be the only alarm.

### Inactivity disablement (public repositories)

GitHub disables scheduled workflows after 60 days without repository activity. Both scheduled workflows call the documented REST endpoint `PUT /repos/{owner}/{repo}/actions/workflows/{file}/enable` for `data-refresh.yml` and `freshness.yml`. This makes no commits and needs `actions: write`. The monitor also warns if a workflow was not `active`. This is best-effort: if GitHub disables both at once, neither runs, and scheduled runs can be delayed or dropped. That is why the external monitor on `LIVE_META_URL` (settings item 8) is a required setup step, not an option.
