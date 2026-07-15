import {
  type AssetRefV1,
  type LiquiditySourceRefV1,
  type PoolRefV1,
} from '@mioagent/route-domain';
import { normalizeAddress, parseUnsignedAtomic } from './normalization.js';

export interface RouteProvenanceV1 {
  pools: PoolRefV1[];
  liquiditySources: LiquiditySourceRefV1[];
}

function canonicalProtocol(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
  return normalized || fallback;
}

function visitObjects(value: unknown, output: Record<string, unknown>[], depth = 0): void {
  if (depth > 10) return;
  if (Array.isArray(value)) {
    for (const item of value) visitObjects(item, output, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  output.push(record);
  for (const inner of Object.values(record)) visitObjects(inner, output, depth + 1);
}

function poolAddress(record: Record<string, unknown>): `0x${string}` | null {
  const direct = normalizeAddress(record.poolAddress ?? record.pool);
  if (direct) return direct;
  const nested = record.pool;
  if (nested && typeof nested === 'object') {
    return normalizeAddress((nested as Record<string, unknown>).address);
  }
  return null;
}

export function extractRouteProvenance(
  route: unknown,
  assets: readonly [AssetRefV1, AssetRefV1],
  fallbackProtocol: string,
): RouteProvenanceV1 {
  const records: Record<string, unknown>[] = [];
  visitObjects(route, records);
  const pools = new Map<string, PoolRefV1>();
  const sources = new Map<string, LiquiditySourceRefV1>();

  for (const record of records) {
    const protocolValue =
      record.protocol ?? record.exchange ?? record.dex ?? record.poolType ?? record.source;
    const address = poolAddress(record);
    if (!address && typeof protocolValue !== 'string') continue;
    const protocol = canonicalProtocol(
      protocolValue,
      fallbackProtocol,
    );
    const feeAtomic = parseUnsignedAtomic(record.feeBps ?? record.fee);
    const feeBps = feeAtomic === null || BigInt(feeAtomic) > 10_000n ? null : Number(feeAtomic);
    const sourceKey = address
      ? `eip155:8453/${protocol}:${address}`
      : `eip155:8453/${protocol}:unknown`;
    if (address && !pools.has(sourceKey)) {
      pools.set(sourceKey, {
        chainId: 8453,
        address,
        protocol,
        feeBps,
        assets: [...assets],
      });
    }
    if (!sources.has(sourceKey)) {
      sources.set(sourceKey, {
        sourceKey,
        chainId: 8453,
        protocol,
        poolAddress: address,
        assets: [...assets],
        upstreamProvider: protocol,
      });
    }
  }

  return {
    pools: [...pools.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, value]) => value),
    liquiditySources: [...sources.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, value]) => value),
  };
}
