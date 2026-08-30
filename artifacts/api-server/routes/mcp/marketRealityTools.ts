import {
  MarketRealityAgentChangesInputV1Schema,
  MarketRealityAgentChangesOutputV1Schema,
  MarketRealityAgentComparisonInputV1Schema,
  MarketRealityAgentRepresentationsInputV1Schema,
  MarketRealityAgentRepresentationsOutputV1Schema,
  compareMarketRealityForAgentV1,
  getMarketRealityChangesForAgentV1,
  getMarketRealityRepresentationsForAgentV1,
  type MarketRealityAgentChangesInputV1,
  type MarketRealityAgentComparisonInputV1,
  type MarketRealityAgentRepresentationsInputV1,
} from '@mioagent/rwa-market-reality';

import { rwaMarketRealityRuntime } from '../rwaMarketReality.js';
import { McpPublicError } from './tools.js';
import { z } from 'zod';

export {
  MarketRealityAgentChangesInputV1Schema,
  MarketRealityAgentChangesOutputV1Schema,
  MarketRealityAgentComparisonInputV1Schema,
  MarketRealityAgentRepresentationsInputV1Schema,
  MarketRealityAgentRepresentationsOutputV1Schema,
};

/**
 * MCP-compatible advertised envelope for the canonical comparison.
 *
 * The full payload is parsed by `MarketRealityAgentComparisonOutputV1Schema`
 * before it reaches the protocol. Advertising that same nested schema through
 * SDK 1.29 serializes Zod's URL validator as `^https\:\/\/`, which AJV rejects
 * in Unicode mode while listing tools. Keep the protocol envelope exact and
 * point clients at the nested canonical discriminator instead of weakening or
 * duplicating the product contract.
 */
export const MarketRealityAgentComparisonMcpOutputV1Schema = z
  .object({
    schemaVersion: z.literal('miorail-agent-market-reality/v1'),
    chain: z.literal('base'),
    quoteOnly: z.literal(true),
    executionEvidenceIncluded: z.literal(false),
    /** Read this first. See `MarketRealityAgentSummaryV1Schema` for the exact
     * shape; advertised loosely here for the same AJV reason as below. */
    miorailSummary: z.object({ summary: z.string() }).passthrough(),
    comparison: z.object({ schemaVersion: z.literal('market-reality/v2') }).passthrough(),
  })
  .strict();

function depsV1() {
  return {
    underlyings: rwaMarketRealityRuntime.underlyings(),
    cashExit: rwaMarketRealityRuntime.cashExit(),
    ratios: rwaMarketRealityRuntime.ratios(),
    supplies: rwaMarketRealityRuntime.supplies(),
    now: rwaMarketRealityRuntime.now,
    reference: rwaMarketRealityRuntime.reference(),
  };
}

async function storageReadyV1(): Promise<void> {
  if (!(await rwaMarketRealityRuntime.migrationAvailable())) {
    throw new McpPublicError(
      'market_reality_storage_unavailable',
      'Miorail could not read its Market Reality evidence store. This is not a statement about any representation.',
    );
  }
}

export async function miorailGetRepresentationsV1(input: MarketRealityAgentRepresentationsInputV1) {
  await storageReadyV1();
  return getMarketRealityRepresentationsForAgentV1(depsV1(), input);
}

export async function miorailCompareMarketRealityV1(input: MarketRealityAgentComparisonInputV1) {
  await storageReadyV1();
  return compareMarketRealityForAgentV1(depsV1(), input);
}

export async function miorailGetMarketChangesV1(input: MarketRealityAgentChangesInputV1) {
  await storageReadyV1();
  try {
    return await getMarketRealityChangesForAgentV1(depsV1(), input);
  } catch (error) {
    if (error instanceof Error && error.message === 'representation_not_reviewed') {
      throw new McpPublicError(
        'representation_not_reviewed',
        'No reviewed underlying binding exists for that exact Base address. Miorail did not substitute a ticker or another representation.',
      );
    }
    throw error;
  }
}
