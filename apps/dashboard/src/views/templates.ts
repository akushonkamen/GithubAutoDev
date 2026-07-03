/**
 * Minimal server-rendered HTML templates — T-M11-004.
 *
 * Templates deliberately avoid a view-engine dependency; each renders
 * a small HTML page by string concatenation. Pages are read-only.
 */

import type { DashboardCostRow, DashboardRunDetail, DashboardRunSummary } from '../server.js';

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} — CGAO Dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
  a { color: #2563eb; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<nav><a href="/">Runs</a> | <a href="/costs">Costs</a> | <a href="/healthz">Health</a></nav>
${body}
</body>
</html>
`;
}

export function renderRunList(runs: readonly DashboardRunSummary[]): string {
  const rows = runs
    .map(
      (r) => `<tr>
  <td><a href="/runs/${escapeHtml(r.id)}">${escapeHtml(r.id)}</a></td>
  <td>${escapeHtml(r.repo)}</td>
  <td>${escapeHtml(r.state)}</td>
  <td>${escapeHtml(r.riskLevel ?? '—')}</td>
  <td>${escapeHtml(r.updatedAt)}</td>
</tr>`,
    )
    .join('\n');
  return shell(
    'Runs',
    `<table>
<thead><tr><th>ID</th><th>Repo</th><th>State</th><th>Risk</th><th>Updated</th></tr></thead>
<tbody>${rows}</tbody>
</table>`,
  );
}

export function renderRunDetail(run: DashboardRunDetail): string {
  return shell(
    `Run ${run.id}`,
    `<table>
<tbody>
  <tr><th>ID</th><td>${escapeHtml(run.id)}</td></tr>
  <tr><th>Repo</th><td>${escapeHtml(run.repo)}</td></tr>
  <tr><th>State</th><td>${escapeHtml(run.state)}</td></tr>
  <tr><th>Risk</th><td>${escapeHtml(run.riskLevel ?? '—')}</td></tr>
  <tr><th>Generation</th><td>${run.generation}</td></tr>
  <tr><th>Attempt</th><td>${run.currentAttempt}</td></tr>
  <tr><th>Gate status</th><td>${escapeHtml(run.gateStatus ?? '—')}</td></tr>
  <tr><th>Fingerprint</th><td><code>${escapeHtml(run.fingerprint ?? '—')}</code></td></tr>
  <tr><th>Merge decision</th><td>${escapeHtml(run.mergeDecision ?? '—')}</td></tr>
  <tr><th>Updated</th><td>${escapeHtml(run.updatedAt)}</td></tr>
</tbody>
</table>`,
  );
}

export function renderCosts(rows: readonly DashboardCostRow[]): string {
  const body = rows
    .map(
      (r) => `<tr>
  <td>${escapeHtml(r.repo)}</td>
  <td>${r.consumed}</td>
  <td>${r.limit}</td>
  <td>${r.percent.toFixed(1)}%</td>
</tr>`,
    )
    .join('\n');
  return shell(
    'Costs',
    `<table>
<thead><tr><th>Repo</th><th>Consumed</th><th>Limit</th><th>% Used</th></tr></thead>
<tbody>${body}</tbody>
</table>`,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}
