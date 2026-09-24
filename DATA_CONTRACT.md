# Data contract (shared by the fetch pipeline and the app)

## `data/meta.json`

```jsonc
{
  "schema": 1,
  "normalizeVersion": 2,          // NORMALIZE_VERSION from src/engine/normalize.ts that built data/
  "fetchedAt": "2026-09-24T08:00:00Z" | null,
  "academicYear": { "id": 76, "code": "2025-2026" } | null,
  "validation": { "passed": true, "at": "<ISO>", "checks": 1234, "report": "data/validation-report.json" } | null,
  "agreements": 22
}
```

The pipeline writes this file on every successful refresh. The legacy file (`normalizeVersion: 1`, `fetchedAt: null`, `validation: null`) marks the fixtures fetched before the normalize fixes.

## Trust policy (the app enforces this in `src/data-trust.ts`)

Levels are evaluated in order.

| Level | When | Effect in the UI |
|---|---|---|
| `untrusted` | `normalizeVersion !== NORMALIZE_VERSION`, `validation` missing or failed, `fetchedAt` missing, older than 30 days, or `academicYear` is not the one in effect today | No green verdict. The badge says the data needs a refresh and to confirm with a counselor. Red verdicts (split series, missing requirements) are still shown, because they come from ASSIST rows that exist. |
| `aging` | Older than 7 days | Green is allowed. An amber banner shows the data date. |
| `trusted` | Otherwise | Normal. |

The academic year in effect runs from July 1 to June 30. For example, from 2026-07-01 the expected code is "2026-2027".
