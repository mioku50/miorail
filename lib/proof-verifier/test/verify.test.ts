import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  RouteProofV1Schema,
  ZERO_HASH_V1,
  hashApprovedCallsV1,
  hashRouteProofV1,
  nextRouteProofEventV1,
  sealPublicProofBundleV1,
  type ExecutionCallV1,
  type PublicRouteProofBundleV1,
  type RouteProofEventV1,
  type RouteProofV1,
} from '@mioagent/route-domain';

import { verifyPublicProofBundleV1 } from '../src/verify.js';
import { runProofVerifyCliV1 } from '../src/cli.js';

const PUBLIC_ID = 'a'.repeat(48);
const WALLET = '0x1111111111111111111111111111111111111111';
const WETH = '0x4200000000000000000000000000000000000006';
const NOW = new Date('2026-07-27T12:00:00.000Z');

function hash(seed: string): `0x${string}` {
  return `0x${seed.repeat(64).slice(0, 64)}` as `0x${string}`;
}

const asset = {
  assetId: `eip155:8453/erc20:${WETH}`,
  chainId: 8453 as const,
  kind: 'erc20' as const,
  address: WETH as `0x${string}`,
  symbol: 'WETH',
  decimals: 18,
};

const approvedCalls: ExecutionCallV1[] = [
  {
    index: 0,
    callType: 'swap',
    to: WETH as `0x${string}`,
    valueWei: '0',
    data: '0xcac88ea9',
    asset: null,
    amountAtomic: null,
    recipient: null,
    spender: null,
  },
];

function proofFixture(finalStatus: RouteProofV1['finalStatus'] = 'completed'): RouteProofV1 {
  const nowIso = NOW.toISOString();
  const receipts: RouteProofV1['receipts'] =
    finalStatus === 'cancelled'
      ? []
      : finalStatus === 'partial_failure'
        ? [
            { transactionHash: hash('1'), status: 'success', blockNumber: '49000000', gasUsed: '120000' },
            { transactionHash: hash('2'), status: 'reverted', blockNumber: '49000000', gasUsed: '80000' },
          ]
        : finalStatus === 'completed'
          ? [{ transactionHash: hash('1'), status: 'success', blockNumber: '49000000', gasUsed: '120000' }]
          : [{ transactionHash: hash('1'), status: 'reverted', blockNumber: '49000000', gasUsed: '80000' }];
  const settled = finalStatus !== 'cancelled';
  const draft: RouteProofV1 = {
    schemaVersion: 'route-proof/v1',
    id: 'route-proof:fixture',
    tenantId: `eip155:8453:${WALLET}`,
    walletAddress: WALLET as `0x${string}`,
    chainId: 8453,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: finalStatus,
    intentHash: hash('a'),
    selectedCandidateHash: hash('b'),
    evidenceSetHash: hash('c'),
    blueprintHash: hash('d'),
    approvedCallsHash: hashApprovedCallsV1(approvedCalls),
    proofHash: ZERO_HASH_V1,
    approvedCalls,
    expectedResult: {
      assetChanges: [
        {
          asset,
          direction: 'credit',
          amountAtomic: '1000000000000000000',
          minimumAmountAtomic: '990000000000000000',
          maximumAmountAtomic: null,
        },
      ],
      outputAmountAtomic: '1000000000000000000',
      outputAsset: asset,
    },
    actualResult: settled
      ? {
          assetChanges: [
            { asset, direction: 'credit', amountAtomic: '999000000000000000', minimumAmountAtomic: null, maximumAmountAtomic: null },
          ],
          outputAmountAtomic: '999000000000000000',
          outputAsset: asset,
        }
      : null,
    estimatedGas: { gasUnits: '200000', maxFeePerGasWei: '1000000', estimatedCostNative: '200000000000', estimatedCostUsd: '0.01' },
    actualGas: settled
      ? { gasUnits: '198000', maxFeePerGasWei: '1000000', estimatedCostNative: '198000000000', estimatedCostUsd: '0.0099' }
      : null,
    deviation: settled
      ? { outputBps: -10, gasCostUsd: '-0.0001', withinTolerance: true }
      : { outputBps: null, gasCostUsd: null, withinTolerance: null },
    transactionHashes: receipts.map((receipt) => receipt.transactionHash),
    receipts,
    finalStatus,
    reconciliationState: finalStatus === 'cancelled' ? 'pending' : 'matched',
  };
  return RouteProofV1Schema.parse({ ...draft, proofHash: hashRouteProofV1(draft) });
}

function eventsFor(proof: RouteProofV1): RouteProofEventV1[] {
  const events: RouteProofEventV1[] = [];
  for (const [eventType, payload] of [
    ['blueprint_created', { blueprintId: 'blueprint-1' }],
    ['calls_approved', { approvedCallsHash: proof.approvedCallsHash }],
    ['submitted', { batchId: 'batch-1', status: 'submitted' }],
  ] as const) {
    const event = nextRouteProofEventV1({ proof, existingEvents: events, eventType, payload, now: NOW });
    if (event) events.push(event);
  }
  return events;
}

function bundleFor(finalStatus: RouteProofV1['finalStatus'] = 'completed'): PublicRouteProofBundleV1 {
  const proof = proofFixture(finalStatus);
  return sealPublicProofBundleV1<PublicRouteProofBundleV1>({
    schemaVersion: 'public-proof-bundle/v1',
    publicProofId: PUBLIC_ID,
    proofFamily: 'route',
    issuedAt: NOW.toISOString(),
    provider: null,
    proof,
    events: eventsFor(proof),
  });
}

/** Re-seals after tampering, so a test isolates the check it names instead of
 * always tripping the bundle hash first. The draft is deliberately loose —
 * tampering means writing shapes the contracts refuse, which is the point. */
type LooseBundle = Record<string, unknown> & { proof: Record<string, unknown>; events: Record<string, unknown>[] };

function reseal(bundle: PublicRouteProofBundleV1, mutate: (draft: LooseBundle) => void): unknown {
  const draft = JSON.parse(JSON.stringify(bundle)) as LooseBundle;
  mutate(draft);
  delete draft.bundleHash;
  return sealPublicProofBundleV1<PublicRouteProofBundleV1>(draft as never);
}

function outcome(bundle: unknown, key: string): string {
  const result = verifyPublicProofBundleV1(bundle);
  return result.checks.find((check) => check.key === key)?.outcome ?? 'missing';
}

describe('an untouched bundle verifies', () => {
  test('every check passes and nothing is skipped that could be checked', () => {
    const result = verifyPublicProofBundleV1(bundleFor());
    assert.equal(result.valid, true, JSON.stringify(result.checks.filter((c) => c.outcome === 'failed')));
    assert.equal(result.proofFamily, 'route');
    assert.equal(result.bundleHash, bundleFor().bundleHash);
    for (const key of ['schema', 'bundle_hash', 'proof_hash', 'approved_calls_hash', 'event_chain', 'event_hashes']) {
      assert.equal(result.checks.find((check) => check.key === key)?.outcome, 'passed', `${key} must pass`);
    }
  });

  test('the verifier reads nothing but the argument it was given', () => {
    // The guarantee that lets the same code run in a stranger's browser: no
    // fetch, no RPC, no env, no clock, no filesystem.
    const source = readFileSync(resolve(import.meta.dirname, '../src/verify.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const banned of ['fetch(', 'process.env', 'require(', 'node:fs', 'Date.now', 'new Date']) {
      assert.equal(source.includes(banned), false, `a pure verifier must not use ${banned}`);
    }
  });
});

describe('tampering is caught, and the report names what broke', () => {
  test('one changed byte breaks the bundle hash', () => {
    const bundle = bundleFor();
    const tampered = { ...bundle, issuedAt: '2020-01-01T00:00:00.000Z' };
    const result = verifyPublicProofBundleV1(tampered);
    assert.equal(result.valid, false);
    assert.equal(outcome(tampered, 'bundle_hash'), 'failed');
  });

  test('a changed proof breaks the proof hash', () => {
    const tampered = reseal(bundleFor(), (draft) => {
      (draft.proof.actualResult as Record<string, unknown>).outputAmountAtomic = '9999999999999999999';
    });
    assert.equal(outcome(tampered, 'proof_hash'), 'failed');
  });

  test('a changed approved call breaks the approved calls hash', () => {
    const tampered = reseal(bundleFor(), (draft) => {
      (draft.proof.approvedCalls as Record<string, unknown>[])[0]!.to = '0x2222222222222222222222222222222222222222';
    });
    assert.equal(outcome(tampered, 'approved_calls_hash'), 'failed');
  });

  test('a changed event payload breaks its payload hash', () => {
    const tampered = reseal(bundleFor(), (draft) => {
      (draft.events[2]!.payload as Record<string, unknown>).batchId = 'batch-999';
    });
    assert.equal(outcome(tampered, 'event_payload_hashes'), 'failed');
  });

  test('a changed previous-event hash breaks the chain', () => {
    const tampered = reseal(bundleFor(), (draft) => {
      draft.events[2]!.previousEventHash = `0x${'9'.repeat(64)}`;
    });
    assert.equal(outcome(tampered, 'event_chain'), 'failed');
  });

  test('a dropped middle event breaks the indexes and the chain', () => {
    const tampered = reseal(bundleFor(), (draft) => {
      draft.events.splice(1, 1);
    });
    const result = verifyPublicProofBundleV1(tampered);
    assert.equal(result.valid, false);
    assert.equal(outcome(tampered, 'event_indexes'), 'failed');
  });

  test('an event borrowed from another proof is rejected', () => {
    const tampered = reseal(bundleFor(), (draft) => {
      draft.events[0]!.routeProofId = 'route-proof:someone-else';
    });
    assert.equal(outcome(tampered, 'event_binding'), 'failed');
  });

  test('a bundle that is not the right shape fails at the schema and stops', () => {
    const result = verifyPublicProofBundleV1({ schemaVersion: 'public-proof-bundle/v1' });
    assert.equal(result.valid, false);
    assert.equal(result.checks.length, 1, 'nothing is checked against a shape that does not exist');
    assert.equal(result.checks[0]?.key, 'schema');
  });

  test('a bundle malformed past the structural guard is reported, not thrown', () => {
    const broken = { ...bundleFor(), proof: { proofHash: '0xdead' }, events: [] };
    const result = verifyPublicProofBundleV1(broken);
    assert.equal(result.valid, false);
    assert.ok(result.checks.some((check) => check.outcome === 'failed'));
  });

  test('a schema failure still names the field that broke', () => {
    // The whole reason the run does not stop at the schema: "something is
    // wrong" is not an answer a stranger can act on.
    const tampered = reseal(bundleFor(), (draft) => {
      (draft.proof.actualResult as Record<string, unknown>).outputAmountAtomic = '9999999999999999999';
    });
    const result = verifyPublicProofBundleV1(tampered);
    assert.equal(result.checks.find((check) => check.key === 'schema')?.outcome, 'failed');
    assert.equal(result.checks.find((check) => check.key === 'proof_hash')?.outcome, 'failed');
    assert.ok(result.checks.length > 2, 'the report covers more than the schema');
  });

  test('a bundle claiming to be valid is not believed', () => {
    // The verifier recomputes; a flag inside the payload means nothing.
    const tampered = { ...bundleFor(), valid: true, verified: true };
    assert.equal(verifyPublicProofBundleV1(tampered).valid, false);
  });
});

describe('terminal-status invariants', () => {
  test('completed with a reverted receipt is rejected', () => {
    // The schema refuses this too, so it fails at the schema — which is the
    // right answer: such a proof cannot exist in the first place.
    const tampered = reseal(bundleFor(), (draft) => {
      (draft.proof.receipts as Record<string, unknown>[])[0]!.status = 'reverted';
    });
    const result = verifyPublicProofBundleV1(tampered);
    assert.equal(result.valid, false);
  });

  test('partial failure needs both a success and a failure', () => {
    const result = verifyPublicProofBundleV1(bundleFor('partial_failure'));
    assert.equal(result.valid, true);
    const tampered = reseal(bundleFor('partial_failure'), (draft) => {
      (draft.proof.receipts as Record<string, unknown>[])[1]!.status = 'success';
    });
    assert.equal(verifyPublicProofBundleV1(tampered).valid, false);
  });

  test('a cancelled record carrying a transaction hash is rejected', () => {
    // Cancelled means it was never executed. A transaction hash on one is a
    // contradiction, not extra detail.
    const cancelled = bundleFor('cancelled');
    assert.equal(verifyPublicProofBundleV1(cancelled).valid, true);
    const tampered = reseal(cancelled, (draft) => {
      draft.proof.transactionHashes = [hash('1')];
      draft.proof.receipts = [
        { transactionHash: hash('1'), status: 'success', blockNumber: '49000000', gasUsed: '1' },
      ];
    });
    assert.equal(verifyPublicProofBundleV1(tampered).valid, false);
  });
});

describe('the CLI answers the same way, without a running server', () => {
  const file = (content: string) => () => content;

  test('a valid bundle exits 0', () => {
    const result = runProofVerifyCliV1(['bundle.json'], file(JSON.stringify(bundleFor())));
    assert.equal(result.exitCode, 0);
    assert.ok(result.lines.some((line) => line.startsWith('VALID')));
    assert.ok(result.lines.some((line) => line.includes('not an onchain anchor')));
  });

  test('a tampered bundle exits 1', () => {
    const tampered = { ...bundleFor(), issuedAt: '2020-01-01T00:00:00.000Z' };
    const result = runProofVerifyCliV1(['bundle.json'], file(JSON.stringify(tampered)));
    assert.equal(result.exitCode, 1);
    assert.ok(result.lines.some((line) => line.startsWith('INVALID')));
  });

  test('an unreadable file exits 2, not 1', () => {
    // A typo in a filename is not a verdict about somebody's proof.
    const result = runProofVerifyCliV1(['missing.json'], () => {
      throw new Error('ENOENT');
    });
    assert.equal(result.exitCode, 2);
  });

  test('malformed JSON exits 2', () => {
    assert.equal(runProofVerifyCliV1(['bundle.json'], file('{not json')).exitCode, 2);
  });

  test('no path at all prints usage and exits 2', () => {
    const result = runProofVerifyCliV1([], file(''));
    assert.equal(result.exitCode, 2);
    assert.match(result.lines[0] ?? '', /usage/);
  });

  test('the CLI and the browser verifier agree exactly', () => {
    const bundle = bundleFor('partial_failure');
    const direct = verifyPublicProofBundleV1(bundle);
    const cli = runProofVerifyCliV1(['bundle.json'], file(JSON.stringify(bundle)));
    assert.equal(cli.exitCode, direct.valid ? 0 : 1);
  });
});
