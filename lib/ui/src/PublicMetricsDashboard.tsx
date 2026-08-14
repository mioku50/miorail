'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  PublicMetricsSnapshotV1Schema,
  type PublicMetricsSnapshotV1,
} from '@mioagent/route-domain';

void React;

type MetricsStateV1 =
  | { kind: 'loading'; snapshot: null }
  | { kind: 'ready'; snapshot: PublicMetricsSnapshotV1 }
  | { kind: 'error'; snapshot: null };

export interface PublicMetricsDashboardProps {
  endpoint?: string;
  productHref?: string;
  productLabel?: string;
}

function integerV1(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function countV1(metric: { value: number | null; status: string }): string {
  if (metric.value !== null) return integerV1(metric.value);
  return metric.status === 'suppressed' ? '< 5 · private' : 'Not available';
}

function rateV1(metric: PublicMetricsSnapshotV1['metrics']['executionSuccessRate']): string {
  if (metric.valueBps === null) return 'Not enough proofs';
  return `${(metric.valueBps / 100).toFixed(metric.valueBps % 100 === 0 ? 0 : 2)}%`;
}

function shortHashV1(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function MetricNode({
  step,
  label,
  value,
  detail,
  tone,
}: {
  step: string;
  label: string;
  value: string;
  detail: string;
  tone: 'blue' | 'violet' | 'green' | 'neutral';
}) {
  return (
    <article className={`pm-node pm-node-${tone}`}>
      <span className="pm-node-step mono">{step}</span>
      <p>{label}</p>
      <strong className="mono">{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

export function PublicMetricsDashboard({
  endpoint = '/api/public/metrics',
  productHref = '/opportunities',
  productLabel = 'Open Miorail',
}: PublicMetricsDashboardProps) {
  const [state, setState] = useState<MetricsStateV1>({ kind: 'loading', snapshot: null });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(endpoint, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('metrics_unavailable');
        const body = await response.json() as unknown;
        const candidate = typeof body === 'object' && body !== null && 'snapshot' in body
          ? (body as { snapshot: unknown }).snapshot
          : body;
        const snapshot = PublicMetricsSnapshotV1Schema.parse(candidate);
        if (!cancelled) setState({ kind: 'ready', snapshot });
      } catch {
        if (!cancelled) setState({ kind: 'error', snapshot: null });
      }
    })();
    return () => { cancelled = true; };
  }, [endpoint, retry]);

  const through = useMemo(() => {
    if (!state.snapshot) return null;
    return new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(new Date(state.snapshot.window.through));
  }, [state.snapshot]);

  if (state.kind === 'loading') {
    return (
      <main className="mio-metrics pm-state" aria-live="polite">
        <span className="pm-pulse" aria-hidden="true" />
        <p>Reading the public Base evidence ledger…</p>
      </main>
    );
  }

  if (state.kind === 'error') {
    return (
      <main className="mio-metrics pm-state" aria-live="polite">
        <p>The public evidence ledger is temporarily unavailable.</p>
        <button type="button" onClick={() => { setState({ kind: 'loading', snapshot: null }); setRetry((value) => value + 1); }}>
          Try again
        </button>
      </main>
    );
  }

  const { snapshot } = state;
  const { metrics } = snapshot;
  return (
    <main className="mio-metrics">
      <header className="pm-header">
        <a className="pm-brand" href={productHref} aria-label="Miorail home">
          <span className="pm-logo" aria-hidden="true"><i /><i /><i /><i /></span>
          <span>Miorail</span>
        </a>
        <span className="pm-chain"><i /> Base mainnet · public ledger</span>
        <a className="pm-open" href={productHref}>{productLabel} <span aria-hidden="true">↗</span></a>
      </header>

      <section className="pm-hero">
        <div className="pm-eyebrow"><span>LIVE EVIDENCE</span><i /> All-time, through {through} UTC</div>
        <h1>What Miorail has actually<br /><em>verified on Base.</em></h1>
        <p>
          Product telemetry derived from route runs, reconciled Route Proofs,
          paid intelligence receipts and measured B20 launches — not page views,
          GitHub activity or invented estimates.
        </p>
      </section>

      <section className="pm-lifecycle" aria-label="Miorail verified execution lifecycle">
        <div className="pm-rail" aria-hidden="true" />
        <MetricNode step="01" label="Discover" value={integerV1(metrics.b20LaunchesMeasured.value)} detail="B20 launches measured" tone="neutral" />
        <MetricNode step="02" label="Evaluate" value={integerV1(metrics.routesEvaluated.value)} detail="route runs evaluated" tone="blue" />
        <MetricNode step="03" label="Execute" value={integerV1(metrics.routesExecuted.value)} detail="runs submitted to a wallet" tone="violet" />
        <MetricNode step="04" label="Verify" value={integerV1(metrics.routeProofsVerified.value)} detail="terminal proofs reconciled" tone="green" />
      </section>

      <section className="pm-proof-band">
        <div className="pm-rate">
          <span>Execution success rate</span>
          <strong className="mono">{rateV1(metrics.executionSuccessRate)}</strong>
          <small>
            {integerV1(metrics.executionSuccessRate.numerator)} successful of{' '}
            {integerV1(metrics.executionSuccessRate.denominator)} terminal reconciled proofs
          </small>
        </div>
        <div className="pm-divider" aria-hidden="true" />
        <div className="pm-wallets">
          <span>Unique Base wallets</span>
          <strong className="mono">{countV1(metrics.uniqueBaseWallets)}</strong>
          <small>Small cohorts are suppressed, never exposed.</small>
        </div>
      </section>

      <section className="pm-exchange">
        <div className="pm-exchange-copy">
          <span className="pm-kicker">x402 INTELLIGENCE EXCHANGE</span>
          <h2>Agents buy evidence.<br />Miorail can sell it back.</h2>
          <p>Only settled, persisted x402 receipts are counted. Seller deliveries count only after a deterministic data hash is recorded.</p>
        </div>
        <div className="pm-x402-flow" aria-label="x402 intelligence metrics">
          <div><span>USDC spent</span><strong className="mono">{metrics.x402UsdcSpent.value ?? 'Not available'}</strong></div>
          <b aria-hidden="true">→</b>
          <div><span>Evidence purchased</span><strong className="mono">{integerV1(metrics.x402IntelligencePurchased.value)}</strong></div>
          <b aria-hidden="true">⇄</b>
          <div className="sell"><span>Evidence sold</span><strong className="mono">{integerV1(metrics.x402IntelligenceSold.value)}</strong></div>
        </div>
      </section>

      <section className="pm-method">
        <div>
          <span className="pm-kicker">MEASUREMENT CONTRACT</span>
          <h2>Every number says exactly what it counts.</h2>
        </div>
        <div className="pm-definitions">
          {Object.entries(snapshot.definitions).map(([key, definition]) => (
            <details key={key}>
              <summary>{key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}</summary>
              <p>{definition}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="pm-integrity">
        <div><span>Schema</span><code>{snapshot.schemaVersion}</code></div>
        <div><span>Definitions</span><code>{snapshot.definitionsVersion}</code></div>
        <div><span>Snapshot hash</span><code title={snapshot.snapshotHash}>{shortHashV1(snapshot.snapshotHash)}</code></div>
      </section>

      <section className="pm-caveats">
        <span>Caveats</span>
        <ul>{snapshot.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul>
      </section>

      <footer className="pm-footer">
        <span>Miorail · evidence before execution</span>
        <a href={productHref}>{productLabel}</a>
      </footer>
    </main>
  );
}
