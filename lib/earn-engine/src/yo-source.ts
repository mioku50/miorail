import { PINNED_BASE_USDC_V1 } from './pinned-config.js';
import {
  BASE_MAINNET_CHAIN_ID_V1,
  YO_LIVE_PROVIDER_V1,
  resolveFreshnessTtlMsV1,
  type EarnChainReaderV1,
} from './live-types.js';
import {
  liveRequestHashV1,
  liveResponseHashV1,
  normalizeLiveAddressV1,
  parseAtomicIntegerV1,
} from './live-normalization.js';
import type { EarnDataSourceObserveInput, EarnDataSourceV1, EarnObservationResultV1 } from './types.js';

export interface YoEarnDataSourceOptionsV1 {
  chainReader?: EarnChainReaderV1 | null;
  freshnessTtlMs?: number;
  providerId?: string;
  providerDisplayName?: string;
}

export function createYoEarnDataSourceV1(options: YoEarnDataSourceOptionsV1 = {}): EarnDataSourceV1 {
  const providerId = options.providerId ?? YO_LIVE_PROVIDER_V1.id;
  const providerDisplayName = options.providerDisplayName ?? YO_LIVE_PROVIDER_V1.displayName;
  const freshnessTtlMs = resolveFreshnessTtlMsV1(options.freshnessTtlMs);
  const chainReader = options.chainReader ?? null;
  return {
    id: providerId,
    async observe(input: EarnDataSourceObserveInput): Promise<EarnObservationResultV1> {
      if (input.protocol !== 'yo') return { ok: false, reason: 'unsupported_protocol' };
      if (!chainReader?.readYoVaultSnapshot) return { ok: false, reason: 'provider_unreachable' };
      let snapshot;
      try {
        snapshot = await chainReader.readYoVaultSnapshot({
          vault: input.venue.target,
          amountAtomic: input.amountAtomic,
        });
      } catch {
        return { ok: false, reason: 'provider_unreachable' };
      }
      if (normalizeLiveAddressV1(snapshot.underlyingAsset) !== PINNED_BASE_USDC_V1) {
        return { ok: false, reason: 'pinned_asset_mismatch' };
      }
      const blockNumber = parseAtomicIntegerV1(snapshot.blockNumber);
      const totalAssetsAtomic = parseAtomicIntegerV1(snapshot.totalAssetsAtomic);
      const totalSupplyAtomic = parseAtomicIntegerV1(snapshot.totalSupplyAtomic);
      const expectedPositionAtomic = parseAtomicIntegerV1(snapshot.expectedSharesAtomic);
      if (
        blockNumber === null || totalAssetsAtomic === null || totalSupplyAtomic === null ||
        expectedPositionAtomic === null || BigInt(expectedPositionAtomic) <= 0n
      ) return { ok: false, reason: 'provider_invalid_response' };
      const observedAt = input.now.toISOString();
      const expiresAt = new Date(input.now.getTime() + freshnessTtlMs).toISOString();
      const response = {
        vault: input.venue.target,
        asset: snapshot.underlyingAsset,
        blockNumber,
        totalAssetsAtomic,
        totalSupplyAtomic,
        expectedPositionAtomic,
      };
      return {
        ok: true,
        observation: {
          // YO does not expose a canonical onchain APY. No data — no score.
          baseApyBps: null,
          rewardApyBps: null,
          netApyBps: null,
          availableLiquidityAtomic: null,
          totalAssetsAtomic,
          expectedPositionAtomic,
          fees: { performanceFeeBps: null, managementFeeBps: null },
          withdrawalTerms: {
            model: 'async_redeem',
            instant: false,
            noticePeriodSeconds: 86_400,
          },
          blockNumber,
          observedAt,
          expiresAt,
          requestHash: liveRequestHashV1({
            providerId,
            method: 'eth_call',
            endpoint: 'base-rpc',
            chainId: BASE_MAINNET_CHAIN_ID_V1,
            market: input.venue.target,
            asset: PINNED_BASE_USDC_V1,
            amountAtomic: input.amountAtomic,
          }),
          responseHash: liveResponseHashV1({ providerId, body: JSON.stringify(response) }),
          sourceIndependence: 'unknown',
          providerId,
          providerDisplayName,
          providerKind: 'protocol',
          providerOperator: YO_LIVE_PROVIDER_V1.operator,
        },
      };
    },
  };
}
