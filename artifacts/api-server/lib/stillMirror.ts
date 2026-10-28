import {
  createEarningsCalendar,
  createMirrorService,
  createNames,
  createProviders,
  type MirrorOutcome,
  type MirrorService,
} from '@mioagent/still-engine';

import { BASE_PUBLIC_RPC_V1 } from './aerodromeClaimReader.js';
import { ethereumMainnetRpcUrlV1 } from './baseNameResolver.js';
import { baseRpcUrlV1 } from './earnPreflight.js';

// ---------------------------------------------------------------------------
// Still's Mirror inside the API: what a wallet could borrow through Still
// without selling, by Still's own terms (lib/still-engine).
//
// It reads the way the rest of the API reads: the configured Base endpoint
// first, and Base's public endpoint as the second opinion when that one
// refuses. A check is a few Multicall3 batches at one block. The universe is
// held ten minutes and a complete report twenty seconds.
//
// Dividends are not read here. Miorail's Stocks calendar is their one source:
// Still's own reader was removed on 2026-10-26, after the two agreed on every
// event they shared.
// ---------------------------------------------------------------------------

export function stillRpcUrlsV1(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([baseRpcUrlV1(env), BASE_PUBLIC_RPC_V1])];
}

export function createStillMirrorServiceV1(env: NodeJS.ProcessEnv = process.env): MirrorService {
  const providers = createProviders(stillRpcUrlsV1(env), 'miorail-still/1');
  // Name lookups are one call per name, cached ten minutes, on Ethereum L1.
  const names = createNames(ethereumMainnetRpcUrlV1(env) ?? undefined, providers, 'miorail-still/1');
  return createMirrorService({ providers, names, calendar: createEarningsCalendar() });
}

/** One status per outcome, for every door that serves the Mirror. */
export const STILL_OUTCOME_STATUS_V1: Record<MirrorOutcome['outcome'], 200 | 400 | 404 | 503> = {
  report: 200,
  invalid_subject: 400,
  name_not_found: 404,
  // Both are our failure, never a fact about the wallet or the name.
  names_unavailable: 503,
  chain_unavailable: 503,
};

let service: MirrorService | null = null;

export const stillMirrorRuntimeV1 = {
  /** One service per process: it holds the universe, report and name caches. */
  service(): MirrorService {
    service ??= createStillMirrorServiceV1();
    return service;
  },
};
