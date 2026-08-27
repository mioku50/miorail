import { stableHashV1, type HashV1 } from '@mioagent/route-domain';
import { z } from 'zod';

import {
  MarketRealityEvidenceSnapshotContractV1Schema,
  type MarketRealityEvidenceSnapshotV1,
} from './marketRealitySnapshot.js';

export function hashMarketRealityEvidenceSnapshotV1(
  value: Omit<MarketRealityEvidenceSnapshotV1, 'snapshotHash'>,
): HashV1 {
  return stableHashV1('market-reality-evidence-snapshot/v1', value);
}

/** Storage/write-boundary schema. Browser/API contracts use the structurally
 * identical crypto-free contract schema; persisted evidence additionally has
 * to prove its stable content hash here. */
export const MarketRealityEvidenceSnapshotV1Schema =
  MarketRealityEvidenceSnapshotContractV1Schema.superRefine((row, ctx) => {
    const { snapshotHash: _snapshotHash, ...content } = row;
    if (row.snapshotHash !== hashMarketRealityEvidenceSnapshotV1(content)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshotHash'],
        message: 'market-reality snapshot hash mismatch',
      });
    }
  });
