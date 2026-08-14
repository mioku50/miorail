import {
  PUBLIC_METRICS_DEFINITIONS_VERSION_V1,
  sealPublicMetricsSnapshotV1,
  type PublicMetricsSnapshotV1,
} from '@mioagent/route-domain';
import { client } from '@mioagent/db';

export interface PublicMetricCountsV1 {
  routesEvaluated: number;
  routesExecuted: number;
  routeProofsVerified: number;
  routeProofsCompleted: number;
  x402SpentUsdc: string;
  x402IntelligencePurchased: number;
  x402IntelligenceSold: number;
  b20LaunchesMeasured: number;
  uniqueBaseWallets: number;
}

export const PUBLIC_METRICS_DEFINITIONS_V1 = {
  routesEvaluated: 'Distinct Base mainnet route runs that stored at least one normalized provider candidate.',
  routesExecuted: 'Distinct generic Route Proofs with at least one transaction hash recorded from Base Account submission.',
  routeProofsVerified: 'Generic and B20 Route Proofs with a terminal onchain-reconciled result: completed, partial failure, or failed.',
  x402UsdcSpent: 'Settled outgoing production x402 payments recorded by Miorail, normalized from a decimal cost or the canonical Base USDC atomic amount. Developer smoke payments are excluded.',
  x402IntelligencePurchased: 'Settled Intelligence Charges whose paid evidence was delivered to a route run.',
  x402IntelligenceSold: 'Paid Miorail seller-intelligence responses with facilitator settlement and a persisted delivery data hash.',
  b20LaunchesMeasured: 'Distinct canonical B20 launches with at least one immutable Exit-First observation.',
  uniqueBaseWallets: 'Distinct normalized Base wallets seen in route runs, B20 entry proofs, or durable Base MCP action receipts. Values below five are suppressed.',
  executionSuccessRate: 'Completed Route Proofs divided by all terminal verified Route Proofs. Pending and reconciliation-required records are excluded.',
} as const;

export const PUBLIC_METRICS_CAVEATS_V1 = [
  'These are product records backed by Miorail storage, not Base-wide protocol statistics.',
  'A route evaluation is counted only after a normalized candidate is stored; provider attempts with no candidate are not included.',
  'A submitted transaction is not a verified Route Proof. Verified counts require terminal reconciliation.',
  'B20 measured means an Exit-First observation exists. It does not mean qualified, safe, recommended, or executable now.',
  'x402 developer smoke traffic, failed settlements, and ambiguous legacy amounts are excluded.',
] as const;

function countMetricV1(value: number) {
  return { value, status: value === 0 ? ('zero' as const) : ('measured' as const) };
}

function normalizedUsdcV1(value: string): string {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return '0';
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${BigInt(whole)}.${trimmed}` : BigInt(whole).toString();
}

export function publicMetricsSnapshotFromCountsV1(
  counts: PublicMetricCountsV1,
  through: Date,
): PublicMetricsSnapshotV1 {
  const denominator = counts.routeProofsVerified;
  const numerator = counts.routeProofsCompleted;
  const x402UsdcSpent = normalizedUsdcV1(counts.x402SpentUsdc);
  return sealPublicMetricsSnapshotV1({
    schemaVersion: 'public-metrics/v1',
    definitionsVersion: PUBLIC_METRICS_DEFINITIONS_VERSION_V1,
    chainId: 8453,
    window: { kind: 'all_time', through: through.toISOString() },
    metrics: {
      routesEvaluated: countMetricV1(counts.routesEvaluated),
      routesExecuted: countMetricV1(counts.routesExecuted),
      routeProofsVerified: countMetricV1(counts.routeProofsVerified),
      x402UsdcSpent: {
        value: x402UsdcSpent,
        status: x402UsdcSpent === '0' ? 'zero' : 'measured',
      },
      x402IntelligencePurchased: countMetricV1(counts.x402IntelligencePurchased),
      x402IntelligenceSold: countMetricV1(counts.x402IntelligenceSold),
      b20LaunchesMeasured: countMetricV1(counts.b20LaunchesMeasured),
      uniqueBaseWallets: counts.uniqueBaseWallets < 5
        ? { value: null, status: 'suppressed' }
        : { value: counts.uniqueBaseWallets, status: 'measured' },
      executionSuccessRate: denominator === 0
        ? { valueBps: null, numerator, denominator, status: 'not_available' }
        : {
            valueBps: Math.floor((numerator * 10_000) / denominator),
            numerator,
            denominator,
            status: 'measured',
          },
    },
    definitions: PUBLIC_METRICS_DEFINITIONS_V1,
    caveats: [...PUBLIC_METRICS_CAVEATS_V1],
  });
}

function asCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function readPublicMetricsSnapshotV1(now = new Date()): Promise<PublicMetricsSnapshotV1> {
  const rows = await client`
    WITH
      generic_proofs AS (
        SELECT
          status,
          CASE
            WHEN jsonb_typeof(payload->'transactionHashes') = 'array'
              THEN jsonb_array_length(payload->'transactionHashes')
            ELSE 0
          END AS transaction_count
        FROM route_proofs
      ),
      b20_proofs AS (
        SELECT
          status,
          CASE
            WHEN jsonb_typeof(payload->'transactionHashes') = 'array'
              THEN jsonb_array_length(payload->'transactionHashes')
            ELSE 0
          END AS transaction_count
        FROM b20_entry_route_proofs
      ),
      all_terminal_proofs AS (
        SELECT status FROM generic_proofs
          WHERE transaction_count > 0 AND status IN ('completed', 'partial_failure', 'failed')
        UNION ALL
        SELECT status FROM b20_proofs
          WHERE transaction_count > 0 AND status IN ('completed', 'partial_failure', 'failed')
      ),
      -- The canonical pair is checked in the WHERE, so it binds EVERY branch
      -- below. It used to sit inside one arm of the CASE: a receipt carrying a
      -- decimal 'cost' was summed into a figure labelled Base USDC without its
      -- network or its asset ever being read, and because that arm came first
      -- it also won over the receipt's own atomic amount. A public total is
      -- exactly where a legacy row must not be allowed to pass as canonical.
      production_x402_spend AS (
        SELECT CASE
          -- The facilitator's atomic integer is authoritative. It is the only
          -- amount this system writes today, and it cannot be confused with a
          -- decimal.
          WHEN receipt->>'amount' ~ '^\\d+$'
            THEN (receipt->>'amount')::numeric / 1000000::numeric
          -- A decimal cost is a legacy write path and is read only when there
          -- is no atomic amount to disagree with. An 'amount' that is itself
          -- decimal ("0.001") reaches here and is counted once, not twice.
          WHEN receipt->>'cost' ~ '^\\d+(\\.\\d{1,6})?$'
            THEN (receipt->>'cost')::numeric
          -- Neither field is readable: the receipt is ambiguous and is worth
          -- nothing to a public total.
          ELSE 0::numeric
        END AS usdc
        FROM x402_receipts
        WHERE receipt->>'status' = 'settled'
          AND receipt->>'direction' = 'outgoing_buyer_payment'
          AND COALESCE(receipt->>'category', '') <> 'dev_smoke'
          AND receipt->>'network' = 'eip155:8453'
          AND lower(receipt->>'asset') = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
      ),
      wallets AS (
        SELECT lower(wallet_address) AS wallet FROM route_runs WHERE chain_id = 8453
        UNION
        SELECT lower(wallet_address) AS wallet FROM b20_entry_route_proofs WHERE chain_id = 8453
        UNION
        SELECT lower(wallet_address) AS wallet FROM base_mcp_action_receipts WHERE chain_id = 8453
      )
    SELECT
      (SELECT count(DISTINCT rr.id) FROM route_runs rr
        WHERE rr.chain_id = 8453 AND EXISTS (
          SELECT 1 FROM route_candidates rc WHERE rc.route_run_id = rr.id
        )) AS routes_evaluated,
      (SELECT count(*) FROM generic_proofs WHERE transaction_count > 0) AS routes_executed,
      (SELECT count(*) FROM all_terminal_proofs) AS route_proofs_verified,
      (SELECT count(*) FROM all_terminal_proofs WHERE status = 'completed') AS route_proofs_completed,
      COALESCE((SELECT sum(usdc) FROM production_x402_spend), 0)::text AS x402_spent_usdc,
      -- evidence_id is what the definition means by "delivered": a settled
      -- charge that never attached evidence bought nothing a route run could
      -- read. route_run_id cannot stand in for it — the column is NOT NULL, so
      -- every charge has one and it distinguishes nothing.
      (SELECT count(*) FROM intelligence_charges
        WHERE status = 'settled' AND evidence_id IS NOT NULL) AS x402_intelligence_purchased,
      (SELECT count(*) FROM x402_receipts
        WHERE receipt->>'status' = 'settled'
          AND receipt->>'direction' = 'incoming_seller_payment'
          AND receipt->>'category' = 'seller_intelligence'
          AND receipt->'details'->>'deliveryStatus' = 'delivered'
          AND receipt->'details'->>'dataHash' ~ '^0x[0-9a-f]{64}$') AS x402_intelligence_sold,
      (SELECT count(DISTINCT o.launch_id)
        FROM b20_opportunity_observations o
        JOIN b20_launches l ON l.id = o.launch_id
        WHERE l.canonical = true) AS b20_launches_measured,
      (SELECT count(*) FROM wallets WHERE wallet ~ '^0x[0-9a-f]{40}$') AS unique_base_wallets
  `;
  const row = rows[0] ?? {};
  return publicMetricsSnapshotFromCountsV1({
    routesEvaluated: asCount(row.routes_evaluated),
    routesExecuted: asCount(row.routes_executed),
    routeProofsVerified: asCount(row.route_proofs_verified),
    routeProofsCompleted: asCount(row.route_proofs_completed),
    x402SpentUsdc: typeof row.x402_spent_usdc === 'string' ? row.x402_spent_usdc : '0',
    x402IntelligencePurchased: asCount(row.x402_intelligence_purchased),
    x402IntelligenceSold: asCount(row.x402_intelligence_sold),
    b20LaunchesMeasured: asCount(row.b20_launches_measured),
    uniqueBaseWallets: asCount(row.unique_base_wallets),
  }, now);
}
