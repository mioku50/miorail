import assert from 'node:assert/strict';
import test from 'node:test';

import { swapPrepareOutcomeMetaV1 } from './swapPrepareLog.js';

// ---------------------------------------------------------------------------
// A prepare that produced no calls is logged in closed codes, so "Approve does
// nothing" can be read back from the server — without logging a provider's
// words or an address.
// ---------------------------------------------------------------------------

test('a kernel refusal logs each failed check id and our own code, never the detail', () => {
  const meta = swapPrepareOutcomeMetaV1({
    outcome: 'blocked',
    routeRunId: 'run-1',
    safety: {
      verdict: 'blocked',
      checks: [
        { id: 'chain_base_mainnet', description: 'Base mainnet', status: 'passed', detail: null },
        {
          id: 'provider_guard_uniswap',
          description: 'Uniswap guard',
          status: 'failed',
          detail: 'uniswap_permit2_not_exact: Permit2 approval must match token, router, amount and expiry',
        },
        {
          id: 'contract_security',
          description: 'Contract security',
          status: 'failed',
          detail: '0xb20000000000000000000078ee7ce2fe4908108c: GoPlus reported high-risk contract flags',
        },
      ],
      blockedReason: 'provider_guard_uniswap: …',
    } as never,
    simulation: { status: 'passed' } as never,
  });
  assert.deepEqual(meta, {
    outcome: 'blocked',
    routeRunId: 'run-1',
    failedChecks: [
      { id: 'provider_guard_uniswap', code: 'uniswap_permit2_not_exact' },
      // An address in front of the colon is not a code, and is not logged.
      { id: 'contract_security', code: null },
    ],
    simulation: 'passed',
  });
  assert.doesNotMatch(JSON.stringify(meta), /Permit2 approval must|GoPlus|0xb2/);
});

test('a refresh logs its reason and the build error code, not the sentence', () => {
  assert.deepEqual(
    swapPrepareOutcomeMetaV1({
      outcome: 'refresh_required',
      routeRunId: 'run-2',
      reason: 'provider_build_failed' as never,
      detail: 'uniswap could not prepare a fresh transaction (uniswap_router_not_pinned)',
    }),
    { outcome: 'refresh_required', routeRunId: 'run-2', reason: 'provider_build_failed', errorCode: 'uniswap_router_not_pinned' },
  );
  assert.equal(
    swapPrepareOutcomeMetaV1({
      outcome: 'refresh_required',
      routeRunId: 'run-3',
      reason: 'quote_expired' as never,
      detail: 'Freshly built transaction quote is already expired',
    }).errorCode,
    null,
  );
});

test('an unsupported route logs its reason only', () => {
  assert.deepEqual(
    swapPrepareOutcomeMetaV1({ outcome: 'unsupported', reason: 'unsupported_pair', detail: 'anything at all' }),
    { outcome: 'unsupported', reason: 'unsupported_pair' },
  );
});
