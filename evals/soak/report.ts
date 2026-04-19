/** Markdown report writer for the soak harness. */
import type { PromResult } from './collect-metrics';

export type Tally = { scenario: string; ok: number; err: number };
export type SloSnapshot = {
  http5xxRate: PromResult;
  httpP95: PromResult;
  wsDisconnectRate: PromResult;
  outboxPending: PromResult;
};

function fmt(v: number | null, fallback = 'n/a', digits = 3): string {
  if (v === null || !Number.isFinite(v)) return fallback;
  return v.toFixed(digits);
}

function verdict(slo: SloSnapshot | null): { pass: boolean; reasons: string[] } {
  if (!slo) return { pass: false, reasons: ['Prometheus unreachable — no SLO check'] };
  const reasons: string[] = [];
  if ((slo.http5xxRate.value ?? 0) > 0.01) reasons.push('HTTP 5xx rate above 1%');
  if ((slo.httpP95.value ?? 0) > 0.5) reasons.push('HTTP p95 above 500ms');
  if ((slo.outboxPending.value ?? 0) > 1000) reasons.push('Outbox backlog > 1000');
  return { pass: reasons.length === 0, reasons };
}

export function writeReport(args: {
  runId: string;
  startedAt: number;
  elapsedMs: number;
  tallies: Tally[];
  slo: SloSnapshot | null;
}): string {
  const { runId, startedAt, elapsedMs, tallies, slo } = args;
  const finishedAt = new Date(startedAt + elapsedMs).toISOString();
  const v = verdict(slo);

  return `# Soak Report — ${runId}

- Started: ${new Date(startedAt).toISOString()}
- Finished: ${finishedAt}
- Duration: ${(elapsedMs / 60_000).toFixed(1)} min
- Verdict: **${v.pass ? 'PASS ✅' : 'FAIL ❌'}**
${v.reasons.length ? `- Reasons: ${v.reasons.map((r) => `\`${r}\``).join(', ')}` : ''}

## Scenarios
| Name | OK | Errors |
| --- | ---: | ---: |
${tallies.map((t) => `| ${t.scenario} | ${t.ok} | ${t.err} |`).join('\n')}

## SLO snapshot (at report time)
${
  slo
    ? `| Metric | Value | Threshold |
| --- | ---: | ---: |
| HTTP 5xx rate | ${fmt(slo.http5xxRate.value)} | 0.01 |
| HTTP p95 latency (s) | ${fmt(slo.httpP95.value)} | 0.5 |
| WS disconnect rate (/s) | ${fmt(slo.wsDisconnectRate.value)} | — |
| Outbox pending | ${fmt(slo.outboxPending.value, 'n/a', 0)} | 1000 |
`
    : '_Prometheus unreachable — no SLO snapshot._'
}

## Recommendations
${
  v.pass
    ? '- No SLO violations observed. Proceed to the forced-restart test in docs/runbook/realtime-soak.md.'
    : '- Hold. Investigate the flagged metrics before promoting to prod.'
}
`;
}
