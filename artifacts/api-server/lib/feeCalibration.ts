import { client } from '@mioagent/db';
import { logger } from '@mioagent/utils';

// ---------------------------------------------------------------------------
// What a person's operation costs beyond the swap a provider prices.
//
// A provider's gas figure is for its swap alone. The person's wallet runs more:
// the approval, its own signature check and the bundler's share. On 2026-10-19
// the route screen said "≈ $0.0048" and the operation cost $0.0077. The three
// proofs that record a person's own operation ran 143,860, 165,780 and 212,896
// gas above the provider's figure.
//
// So the difference is MEASURED, never assumed: the median of (operation gas −
// provider estimate) over the latest completed proofs that recorded an
// operation's own gas — `feePaidBy` is set on exactly those. The person's own
// operations are used when there are any, since their wallet is the one that
// will run; otherwise the latest anyone made. Only two numbers leave here.
// ---------------------------------------------------------------------------

export interface FeeCalibrationV1 {
  /** Gas the operation adds to the provider's swap figure. */
  overheadGasUnits: string;
  samples: number;
  basis: 'your_operations' | 'recent_operations';
}

export interface FeeSampleV1 {
  estimated: string | null;
  actual: string | null;
  own: boolean;
}

const POSITIVE_INTEGER_V1 = /^[1-9][0-9]*$/;
export const FEE_CALIBRATION_SAMPLES_V1 = 10;

function medianV1(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2n;
}

export function feeCalibrationFromSamplesV1(samples: readonly FeeSampleV1[]): FeeCalibrationV1 | null {
  const usable = samples.filter(
    (sample) => POSITIVE_INTEGER_V1.test(sample.estimated ?? '') && POSITIVE_INTEGER_V1.test(sample.actual ?? ''),
  );
  const own = usable.filter((sample) => sample.own);
  const chosen = (own.length > 0 ? own : usable).slice(0, FEE_CALIBRATION_SAMPLES_V1);
  if (chosen.length === 0) return null;
  const overhead = medianV1(chosen.map((sample) => BigInt(sample.actual!) - BigInt(sample.estimated!)));
  // A provider that over-estimated is not a wallet that costs less than nothing.
  if (overhead <= 0n) return null;
  return {
    overheadGasUnits: overhead.toString(),
    samples: chosen.length,
    basis: own.length > 0 ? 'your_operations' : 'recent_operations',
  };
}

type FeeSampleReaderV1 = (tenantId: string) => Promise<FeeSampleV1[]>;

const readSamplesFromDatabaseV1: FeeSampleReaderV1 = async (tenantId) => {
  const rows = await client`
    SELECT user_id = ${tenantId} AS own,
           payload->'estimatedGas'->>'gasUnits' AS estimated,
           payload->'actualGas'->>'gasUnits' AS actual
    FROM route_proofs
    WHERE payload->>'finalStatus' = 'completed' AND payload->>'feePaidBy' IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return rows.map((row) => ({
    own: row.own === true,
    estimated: typeof row.estimated === 'string' ? row.estimated : null,
    actual: typeof row.actual === 'string' ? row.actual : null,
  }));
};

const CACHE_MS_V1 = 10 * 60_000;
const cachedV1 = new Map<string, { until: number; value: FeeCalibrationV1 | null }>();

/** Never throws: a calibration is a refinement of a figure, not a condition of
 * showing one. */
export async function readFeeCalibrationV1(
  tenantId: string,
  readSamples: FeeSampleReaderV1 = readSamplesFromDatabaseV1,
  now: () => number = Date.now,
): Promise<FeeCalibrationV1 | null> {
  const hit = cachedV1.get(tenantId);
  if (hit && hit.until > now()) return hit.value;
  try {
    const value = feeCalibrationFromSamplesV1(await readSamples(tenantId));
    cachedV1.set(tenantId, { until: now() + CACHE_MS_V1, value });
    return value;
  } catch (error) {
    logger.warn('Fee calibration could not be read', { reason: error instanceof Error ? error.name : 'unknown' });
    return null;
  }
}

/** Test seam. */
export function resetFeeCalibrationCacheV1(): void {
  cachedV1.clear();
}
