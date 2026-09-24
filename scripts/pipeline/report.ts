/* Human-readable renderings of a validation report: terminal summary and Markdown (issue body / step summary). */
import type { Finding, Report } from './validate.ts'

const ORDER = { error: 0, legacy: 1, warning: 2, info: 3 } as const
const sorted = (fs: Finding[]) => [...fs].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.check.localeCompare(b.check) || (a.file ?? '').localeCompare(b.file ?? ''))
const verdict = (r: Report) =>
  !r.passed ? 'FAILED' : r.counts.legacy ? 'PASSED for code; committed data is LEGACY (see legacy findings)' : 'PASSED'

export function summaryText(r: Report, maxPerSeverity = 40): string {
  const lines = [
    `validate:data ${verdict(r)}  mode=${r.mode}  data=${r.dataDir}`,
    `  normalize: code v${r.normalizeVersion}, data v${r.dataNormalizeVersion ?? '?'}${r.legacyData ? ' (legacy data)' : ''}`,
    `  ${r.checks} checks: ${r.counts.error} errors, ${r.counts.legacy} legacy, ${r.counts.warning} warnings, ${r.counts.info} info`,
  ]
  if (r.diff) {
    lines.push(r.diff.previous
      ? `  diff vs published: +${r.diff.added.length} -${r.diff.removed.length} ~${r.diff.changed.length} agreements (${r.diff.unchanged} unchanged); groups ${r.diff.previous.groups}${r.diff.overridden ? '; large-change override ON' : ''}`
      : '  diff vs published: no previous data')
  }
  const cs = r.canaries
  lines.push(`  canaries: ${cs.filter((c) => c.result === 'pass').length} pass, ${cs.filter((c) => c.result === 'fail').length} fail, ${cs.filter((c) => c.result === 'skipped').length} skipped`)
  for (const s of r.suites) lines.push(`  suite ${s.ok ? 'PASS' : 'FAIL'} ${s.name} (${(s.ms / 1000).toFixed(1)} s)`)
  for (const sev of ['error', 'legacy', 'warning'] as const) {
    const fs = sorted(r.findings.filter((f) => f.severity === sev))
    if (!fs.length) continue
    lines.push('', `${sev.toUpperCase()} (${fs.length})`)
    for (const f of fs.slice(0, maxPerSeverity)) lines.push(`  [${f.check}]${f.file ? ` ${f.file}:` : ''} ${f.message}`)
    if (fs.length > maxPerSeverity) lines.push(`  ... ${fs.length - maxPerSeverity} more in the JSON report`)
  }
  return lines.join('\n')
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
export function summaryMarkdown(r: Report, maxRows = 60): string {
  const out = [
    `### Data validation: ${verdict(r)}`,
    '',
    `Mode \`${r.mode}\`, normalize code v${r.normalizeVersion} / data v${r.dataNormalizeVersion ?? '?'}. ${r.checks} checks: **${r.counts.error} errors**, ${r.counts.legacy} legacy, ${r.counts.warning} warnings.`,
  ]
  if (r.legacyData && r.mode === 'ci') out.push('', '> The committed data was built by an older normalize. Its known symptoms are listed as **legacy**; they do not fail CI. The daily data refresh (or `npm run renormalize`) replaces it.')
  if (r.diff?.previous) out.push('', `Diff vs published: +${r.diff.added.length} / -${r.diff.removed.length} / ~${r.diff.changed.length} agreements.`)
  if (r.suites.length) out.push('', r.suites.map((s) => `- ${s.ok ? 'PASS' : '**FAIL**'} \`${s.command}\``).join('\n'))
  const fs = sorted(r.findings.filter((f) => f.severity !== 'info'))
  if (fs.length) {
    out.push('', '| severity | check | file | message |', '|---|---|---|---|')
    for (const f of fs.slice(0, maxRows)) out.push(`| ${f.severity} | ${f.check} | ${f.file ?? ''} | ${esc(f.message.slice(0, 300))} |`)
    if (fs.length > maxRows) out.push('', `${fs.length - maxRows} more findings in validation-report.json.`)
  }
  const failed = r.suites.filter((s) => !s.ok && s.tail)
  for (const s of failed) out.push('', `<details><summary>${s.name} output (tail)</summary>`, '', '```', s.tail!.slice(-4000), '```', '', '</details>')
  return out.join('\n')
}

/** GitHub annotations (one line each) when running inside Actions. */
export const annotations = (r: Report, max = 30) =>
  sorted(r.findings.filter((f) => f.severity !== 'info')).slice(0, max)
    .map((f) => `::${f.severity === 'error' ? 'error' : 'warning'} title=${f.severity === 'legacy' ? 'legacy data' : 'data'} ${f.check}::${f.file ? f.file + ': ' : ''}${f.message.replace(/\r?\n/g, ' ').slice(0, 400)}`)
