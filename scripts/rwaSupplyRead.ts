import { stableHashV1 } from '@mioagent/route-domain';
import {
  B20_SELECTORS_V1,
  callManyV1,
  decodeUint8V1,
  decodeUintV1,
  encodeNoArgsV1,
} from '@mioagent/b20-control';
import type { RepresentationSupplyRepositoryV1 } from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// One exact address's outstanding supply, read at one anchored block and kept
// (moved out of rwa_read_representation_ratio.ts on 2026-11-18, so the hourly
// official ingest asks the same pinned totalSupply()/decimals() question).
//
// Supply is universal ERC-20 evidence, unlike issuer-specific representation
// ratios: ticker and issuer never select it. A failed read is stored as
// UNKNOWN, never as zero.
// ---------------------------------------------------------------------------

const CHAIN_ID_V1 = 8453 as const;

type CallReaderV1 = Parameters<typeof callManyV1>[0];

export interface SupplyAnchorV1 {
  blockNumber: string;
  blockHash: string;
  blockTag: string;
}

export interface SupplyReadOutcomeV1 {
  decoded: boolean;
  totalSupply: bigint | null;
  stored: Awaited<ReturnType<RepresentationSupplyRepositoryV1['recordObservation']>>;
  failureCode: string | null;
}

export async function readAndRecordSupplyV1(input: {
  reader: CallReaderV1;
  anchor: SupplyAnchorV1;
  tokenAddress: string;
  supplies: Pick<RepresentationSupplyRepositoryV1, 'recordObservation'>;
  now: Date;
}): Promise<SupplyReadOutcomeV1> {
  const { reader, anchor, tokenAddress } = input;
  const [totalResult, decimalsResult] = await callManyV1(reader, [
    { to: tokenAddress, data: encodeNoArgsV1(B20_SELECTORS_V1.totalSupply), blockTag: anchor.blockTag },
    { to: tokenAddress, data: encodeNoArgsV1(B20_SELECTORS_V1.decimals), blockTag: anchor.blockTag },
  ]);
  const totalSupply = totalResult?.ok ? decodeUintV1(totalResult.value) : null;
  const decimals = decimalsResult?.ok ? decodeUint8V1(decimalsResult.value) : null;
  const successful = totalResult?.ok === true && decimalsResult?.ok === true;
  const decoded = successful && totalSupply !== null && decimals !== null;
  const failureCode = decoded
    ? null
    : successful
      ? 'erc20_supply_decode_failed'
      : `erc20_supply_rpc_${
          [
            totalResult && !totalResult.ok ? totalResult.reason : null,
            decimalsResult && !decimalsResult.ok ? decimalsResult.reason : null,
          ]
            .filter(Boolean)
            .join('_') || 'unavailable'
        }`;
  const evidenceHash = stableHashV1('representation-supply-read/v1', {
    chainId: CHAIN_ID_V1,
    tokenAddress,
    blockNumber: anchor.blockNumber,
    totalSupplyRaw: totalResult?.ok ? totalResult.raw : null,
    decimalsRaw: decimalsResult?.ok ? decimalsResult.raw : null,
    failureCode,
  });
  const stored = await input.supplies.recordObservation({
    chainId: CHAIN_ID_V1,
    tokenAddress,
    totalSupplyAtomic: decoded ? totalSupply!.toString() : null,
    decimals: decoded ? decimals : null,
    blockNumber: anchor.blockNumber,
    blockHash: anchor.blockHash,
    evidenceHash,
    readOutcome: decoded ? 'success' : successful ? 'decode_failure' : 'rpc_failure',
    failureCode,
    observedAt: input.now.toISOString(),
    now: input.now.toISOString(),
  });
  return { decoded, totalSupply: decoded ? totalSupply : null, stored, failureCode };
}

/**
 * The Coinbase contracts whose supply the issuer's own list and Miorail's latest reading disagree on: the list says
 * tokens are outstanding and the reading says none, or the reverse, or there is no successful reading at all.
 * A contract minted between two passes of the supply reader read as empty on the board for up to three hours
 * (VSTc, 2026-11-17, audit STOCK-1); these are read again at once. At most `limit`, the list's order kept.
 */
export function supplyDisagreementsV1(input: {
  listed: readonly { tokenAddress: string; issuerSupplyPositive?: boolean }[];
  stored: readonly { tokenAddress: string; state: string; readOutcome: string }[];
  limit: number;
}): string[] {
  const byAddress = new Map(input.stored.map((row) => [row.tokenAddress.toLowerCase(), row]));
  const out: string[] = [];
  for (const asset of input.listed) {
    if (asset.issuerSupplyPositive === undefined) continue;
    const row = byAddress.get(asset.tokenAddress.toLowerCase());
    const ours = row && row.readOutcome === 'success' ? row.state === 'positive_supply' : null;
    if (ours === null || ours !== asset.issuerSupplyPositive) out.push(asset.tokenAddress.toLowerCase());
    if (out.length >= input.limit) break;
  }
  return out;
}

/** Whether a successful list names so many fewer contracts than the one before that it is a signal, not a change:
 * a tenth of them and at least ten (audit STOCK-1: 377 to 74 in one pass on 2026-11-17). */
export function sharpShrinkV1(previous: number | null, now: number): boolean {
  if (previous === null || previous <= 0) return false;
  const lost = previous - now;
  return lost >= 10 && lost * 10 >= previous;
}
