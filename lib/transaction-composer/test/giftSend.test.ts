import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  ExecutionBlueprintV1Schema,
  hashApprovedCallsV1,
  hashExecutionBlueprintV1,
  type AssetRefV1,
  type ExecutionBlueprintV1,
  type SimulationStateV1,
} from '@mioagent/route-domain';
import { InMemoryRouteStorageRepository } from '@mioagent/route-storage';

import {
  GIFT_SEND_PROVIDER_V1,
  approveExecutionBlueprintV1,
  approveGiftSendBlueprintV1,
  approveRouteBlueprintV1,
  encodeGiftTransferV1,
  giftSendIntentV1,
  prepareGiftSendV1,
  routeProofIdV1,
  runGiftSendKernelV1,
  runSafetyKernel,
  type GiftSendPrepareInputV1,
  type SwapSimulationRequestV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// A gift from holdings: one transfer, and the kernel that owns it.
// ---------------------------------------------------------------------------

const WALLET = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70' as const;
const TENANT = `eip155:8453:${WALLET}`;
const FRIEND = '0x8e525bfce1c0ffee00000000000000000000beef' as const;
const NOW = new Date('2026-09-24T12:00:00.000Z');
const AMOUNT = '44227';

const NVDA: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0xb20000000000000000000078ee7ce2fe4908108c',
  chainId: 8453,
  kind: 'erc20',
  address: '0xb20000000000000000000078ee7ce2fe4908108c',
  symbol: 'NVDAc',
  decimals: 8,
};

const PASSED: SimulationStateV1 = {
  status: 'passed',
  observedAt: NOW.toISOString(),
  blockNumber: '51700000',
  requestHash: `0x${'5'.repeat(64)}`,
  responseHash: `0x${'6'.repeat(64)}`,
  errorCode: null,
};

function simulator(state: SimulationStateV1 = PASSED) {
  const requests: SwapSimulationRequestV1[] = [];
  return {
    requests,
    simulate: async (request: SwapSimulationRequestV1) => {
      requests.push(request);
      return state;
    },
  };
}

function input(over: Partial<GiftSendPrepareInputV1> = {}): GiftSendPrepareInputV1 {
  return {
    tenantId: TENANT,
    walletAddress: WALLET,
    requestId: 'gift-send-1',
    token: NVDA,
    amountAtomic: AMOUNT,
    recipient: FRIEND,
    observations: {
      balance: { balanceAtomic: AMOUNT, blockNumber: '51700000' },
      valuation: { usdcAtomic: '98000', provider: 'uniswap', observedAt: NOW.toISOString() },
    },
    reviewedStock: true,
    now: NOW,
    ...over,
  };
}

async function prepared(repo = new InMemoryRouteStorageRepository(), over: Partial<GiftSendPrepareInputV1> = {}) {
  const sim = simulator();
  const result = await prepareGiftSendV1({ repository: repo, simulate: sim.simulate }, input(over));
  assert.equal(result.outcome, 'prepared', JSON.stringify(result));
  if (result.outcome !== 'prepared') throw new Error('not prepared');
  return { repo, sim, result };
}

/** A stored send Blueprint with its calls replaced and every hash made to fit,
 * so only the kernel's own reading of the bytes can catch it. */
function reshaped(blueprint: ExecutionBlueprintV1, calls: ExecutionBlueprintV1['calls']): ExecutionBlueprintV1 {
  const draft = { ...blueprint, calls, callsHash: hashApprovedCallsV1(calls) };
  return ExecutionBlueprintV1Schema.parse({ ...draft, blueprintHash: hashExecutionBlueprintV1(draft) });
}

describe('prepare', () => {
  test('builds one exact transfer, simulates it, and stores it on a send run', async () => {
    const { repo, sim, result } = await prepared();
    const { blueprint, review } = result;
    assert.equal(blueprint.goal, 'send');
    assert.equal(blueprint.calls.length, 1);
    const call = blueprint.calls[0]!;
    assert.equal(call.callType, 'transfer');
    assert.equal(call.to, NVDA.address);
    assert.equal(call.valueWei, '0');
    assert.equal(call.data, encodeGiftTransferV1(FRIEND, AMOUNT));
    assert.deepEqual(blueprint.requiredApprovals, []);
    assert.deepEqual(
      blueprint.expectedAssetChanges.map((change) => [change.direction, change.asset.symbol, change.amountAtomic]),
      [['debit', 'NVDAc', AMOUNT]],
    );
    // The simulation ran on exactly these bytes, from this wallet.
    assert.equal(sim.requests.length, 1);
    assert.equal(sim.requests[0]!.callsHash, blueprint.callsHash);
    assert.equal(sim.requests[0]!.walletAddress, WALLET);
    assert.equal(blueprint.simulationState.status, 'passed');

    assert.equal(review.provider.id, GIFT_SEND_PROVIDER_V1.id);
    assert.equal(review.input.amountAtomic, AMOUNT);
    assert.equal(review.expectedOutput.amountAtomic, AMOUNT);
    assert.equal(review.contractSecurity.required, false);
    assert.ok(review.safety.checks.every((check) => check.status === 'passed'));
    assert.deepEqual(
      review.safety.checks.map((check) => check.id),
      [
        'send_goal',
        'send_binding',
        'send_single_transfer',
        'send_reviewed_stock',
        'send_recipient',
        'send_calldata_exact',
        'send_balance',
        'send_not_expired',
        'send_simulation_passed',
      ],
    );

    const run = await repo.getSendRouteRun(result.routeRunId, TENANT);
    assert.equal(run?.intent.goal, 'send');
    assert.equal(run?.intent.toAsset, null);
    const stored = await repo.listBlueprints(result.routeRunId, TENANT);
    assert.deepEqual(stored.map((entry) => entry.blueprint.id), [blueprint.id]);
  });

  test('a replay of the same request returns the same Blueprint and simulates nothing again', async () => {
    const { repo, result } = await prepared();
    const sim = simulator();
    const again = await prepareGiftSendV1({ repository: repo, simulate: sim.simulate }, input());
    assert.equal(again.outcome, 'prepared');
    if (again.outcome !== 'prepared') return;
    assert.equal(again.blueprint.id, result.blueprint.id);
    assert.equal(sim.requests.length, 0);
  });

  test('a balance below the amount is refused, and nothing is stored', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const result = await prepareGiftSendV1(
      { repository: repo, simulate: simulator().simulate },
      input({ observations: { ...input().observations, balance: { balanceAtomic: '44226', blockNumber: '51700000' } } }),
    );
    assert.equal(result.outcome, 'blocked');
    if (result.outcome !== 'blocked') return;
    const balance = result.safety.checks.find((check) => check.id === 'send_balance');
    assert.equal(balance?.status, 'failed');
    assert.match(balance?.detail ?? '', /holds 0\.00044226 NVDAc, less than the 0\.00044227/);
    assert.deepEqual(await repo.listBlueprints(result.routeRunId, TENANT), []);
  });

  test('a transfer that reverts in simulation is refused, and says the token refused it', async () => {
    const reverted: SimulationStateV1 = { ...PASSED, status: 'failed', errorCode: 'execution_reverted' };
    const result = await prepareGiftSendV1(
      { repository: new InMemoryRouteStorageRepository(), simulate: simulator(reverted).simulate },
      input(),
    );
    assert.equal(result.outcome, 'blocked');
    if (result.outcome !== 'blocked') return;
    assert.match(result.safety.blockedReason ?? '', /reverted in simulation/);
    assert.equal(result.simulation?.status, 'failed');
  });

  test('an unsimulated transfer is refused: Miorail writes this calldata itself', async () => {
    const unavailable: SimulationStateV1 = {
      status: 'unavailable',
      observedAt: NOW.toISOString(),
      blockNumber: null,
      requestHash: null,
      responseHash: null,
      errorCode: 'provider_not_configured',
    };
    const result = await prepareGiftSendV1(
      { repository: new InMemoryRouteStorageRepository(), simulate: simulator(unavailable).simulate },
      input(),
    );
    assert.equal(result.outcome, 'blocked');
    if (result.outcome !== 'blocked') return;
    assert.match(result.safety.blockedReason ?? '', /could not be simulated/);
  });

  test('only a reviewed stock, and never to this wallet', async () => {
    const unreviewed = await prepareGiftSendV1(
      { repository: new InMemoryRouteStorageRepository(), simulate: simulator().simulate },
      input({ reviewedStock: false }),
    );
    assert.equal(unreviewed.outcome, 'blocked');
    const toSelf = await prepareGiftSendV1(
      { repository: new InMemoryRouteStorageRepository(), simulate: simulator().simulate },
      input({ recipient: WALLET }),
    );
    assert.equal(toSelf.outcome, 'blocked');
    if (toSelf.outcome !== 'blocked') return;
    assert.equal(toSelf.safety.checks.find((check) => check.id === 'send_recipient')?.status, 'failed');
  });

  test('the swap composer and the swap approve path refuse a send run', async () => {
    const { repo, result } = await prepared();
    await assert.rejects(
      approveExecutionBlueprintV1(
        { repository: repo, contractSecurity: async () => [] },
        {
          tenantId: TENANT,
          walletAddress: WALLET,
          routeRunId: result.routeRunId,
          blueprintId: result.blueprint.id,
          blueprintHash: result.blueprint.blueprintHash,
          now: NOW,
        },
      ),
      /goal is not swap/,
    );
    // And a send intent can never be written as a swap run.
    const intent = giftSendIntentV1({ id: 'gift-send:other', tenantId: TENANT, walletAddress: WALLET, token: NVDA, amountAtomic: AMOUNT, now: NOW });
    await assert.rejects(repo.createRouteRun(intent, 'k'), /createSendRouteRun/);
  });
});

describe('the Gift Send kernel reads the bytes', () => {
  async function kernelOver(calls: ExecutionBlueprintV1['calls']) {
    const { repo, result } = await prepared();
    const run = await repo.getSendRouteRun(result.routeRunId, TENANT);
    return runGiftSendKernelV1({
      blueprint: reshaped(result.blueprint, calls),
      intent: run!.intent,
      walletAddress: WALLET,
      recipient: FRIEND,
      reviewedStock: true,
      balanceAtomic: AMOUNT,
      now: NOW,
    });
  }

  test('labels that disagree with the calldata are refused', async () => {
    const { result } = await prepared();
    const call = result.blueprint.calls[0]!;
    const other = '0x9999999999999999999999999999999999999999';
    const verdict = await kernelOver([{ ...call, data: encodeGiftTransferV1(other, AMOUNT) }]);
    assert.equal(verdict.verdict, 'blocked');
    assert.equal(verdict.checks.find((check) => check.id === 'send_calldata_exact')?.status, 'failed');
  });

  test('one unit more than declared is refused', async () => {
    const { result } = await prepared();
    const call = result.blueprint.calls[0]!;
    const verdict = await kernelOver([{ ...call, data: encodeGiftTransferV1(FRIEND, '44228'), amountAtomic: '44228' }]);
    assert.equal(verdict.checks.find((check) => check.id === 'send_calldata_exact')?.status, 'failed');
  });

  test('a second call, an approval, or attached ETH is refused', async () => {
    const { result } = await prepared();
    const call = result.blueprint.calls[0]!;
    const twice = await kernelOver([call, { ...call, index: 1 }]);
    assert.equal(twice.checks.find((check) => check.id === 'send_single_transfer')?.status, 'failed');
    const withValue = await kernelOver([{ ...call, valueWei: '1' }]);
    assert.equal(withValue.checks.find((check) => check.id === 'send_single_transfer')?.status, 'failed');
    const approval = await kernelOver([{ ...call, callType: 'approval', spender: FRIEND }]);
    assert.equal(approval.verdict, 'blocked');
  });

  test('the swap kernel refuses the same single transfer outright', async () => {
    const { repo, result } = await prepared();
    const run = await repo.getSendRouteRun(result.routeRunId, TENANT);
    const swapVerdict = runSafetyKernel({
      provider: 'uniswap',
      routerAddress: '0x6ff5693b99212da76ad316178a184ab56d299b43',
      chainId: 8453,
      walletAddress: WALLET,
      intent: run!.intent,
      calls: result.blueprint.calls,
      quoteExpiry: result.blueprint.quoteExpiry,
      now: NOW,
      contractSecurityRequired: false,
      contractSecurityProvider: 'none',
      contractSecurityResults: [],
      contractSecurityAddresses: [],
      simulationAcceptable: true,
      simulationDetail: 'ok',
      intentHash: result.blueprint.intentHash,
      selectedCandidateHash: result.blueprint.selectedCandidateHash,
    }).result;
    assert.equal(swapVerdict.verdict, 'blocked');
  });
});

describe('approve', () => {
  function approveInput(result: { routeRunId: string; blueprint: ExecutionBlueprintV1 }, now = NOW) {
    return {
      tenantId: TENANT,
      walletAddress: WALLET,
      routeRunId: result.routeRunId,
      blueprintId: result.blueprint.id,
      blueprintHash: result.blueprint.blueprintHash,
      now,
    };
  }

  test('reads the balance again, approves the one call and opens a pending proof', async () => {
    const { repo, result } = await prepared();
    const reads: string[] = [];
    const deps = {
      repository: repo,
      readBalance: async (read: { tokenAddress: string; walletAddress: string }) => {
        reads.push(`${read.tokenAddress}:${read.walletAddress}`);
        return '50000';
      },
      reviewedStock: async () => true,
    };
    const approved = await approveGiftSendBlueprintV1(deps, approveInput(result));
    assert.equal(approved.outcome, 'approved');
    if (approved.outcome !== 'approved') return;
    assert.deepEqual(reads, [`${NVDA.address}:${WALLET}`]);
    assert.deepEqual(approved.payload.calls, [{ to: NVDA.address, value: '0x0', data: encodeGiftTransferV1(FRIEND, AMOUNT) }]);
    assert.equal(approved.payload.from, WALLET);

    const proof = await repo.getProofProjection(routeProofIdV1(result.blueprint.id), TENANT);
    assert.equal(proof?.finalStatus, 'pending');
    assert.equal(proof?.expectedResult.outputAmountAtomic, AMOUNT);
    assert.equal(proof?.expectedResult.outputAsset?.address, NVDA.address);
    const events = await repo.listProofEvents(proof!.id, TENANT);
    assert.deepEqual(events.map((event) => event.eventType), ['calls_approved']);

    // Idempotent: a second approve changes nothing and reads no balance.
    const again = await approveGiftSendBlueprintV1(deps, approveInput(result));
    assert.equal(again.outcome, 'approved');
    assert.equal(reads.length, 1);
    assert.equal((await repo.listProofEvents(proof!.id, TENANT)).length, 1);
  });

  test('a balance that moved below the amount since prepare is refused', async () => {
    const { repo, result } = await prepared();
    const verdict = await approveGiftSendBlueprintV1(
      { repository: repo, readBalance: async () => '1', reviewedStock: async () => true },
      approveInput(result),
    );
    assert.equal(verdict.outcome, 'blocked');
    const unread = await approveGiftSendBlueprintV1(
      { repository: repo, readBalance: async () => { throw new Error('rpc down'); }, reviewedStock: async () => true },
      approveInput(result),
    );
    assert.equal(unread.outcome, 'blocked');
    if (unread.outcome !== 'blocked') return;
    assert.match(unread.reason, /could not read this wallet’s balance/);
    assert.match(unread.reason, /says nothing about the wallet/);
  });

  test('an expired review cannot be approved', async () => {
    const { repo, result } = await prepared();
    const later = new Date(NOW.getTime() + 5 * 60_000 + 1);
    const verdict = await approveGiftSendBlueprintV1(
      { repository: repo, readBalance: async () => AMOUNT, reviewedStock: async () => true },
      approveInput(result, later),
    );
    assert.equal(verdict.outcome, 'expired');
  });
});

describe('one approve route, two kernels', () => {
  test('a send run is approved by the Gift Send kernel, and never reaches the swap one', async () => {
    const { repo, result } = await prepared();
    let swapAsked = 0;
    const verdict = await approveRouteBlueprintV1(
      {
        repository: repo,
        swap: {
          contractSecurity: async () => {
            swapAsked += 1;
            return [];
          },
        },
        send: { readBalance: async () => AMOUNT, reviewedStock: async () => true },
      },
      {
        tenantId: TENANT,
        walletAddress: WALLET,
        routeRunId: result.routeRunId,
        blueprintId: result.blueprint.id,
        blueprintHash: result.blueprint.blueprintHash,
        now: NOW,
      },
    );
    assert.equal(verdict.outcome, 'approved');
    assert.equal(swapAsked, 0);
  });

  test('any other run goes to the swap path, which knows nothing of sends', async () => {
    const repo = new InMemoryRouteStorageRepository();
    let sendAsked = 0;
    await assert.rejects(
      approveRouteBlueprintV1(
        {
          repository: repo,
          swap: { contractSecurity: async () => [] },
          send: {
            readBalance: async () => {
              sendAsked += 1;
              return AMOUNT;
            },
            reviewedStock: async () => true,
          },
        },
        {
          tenantId: TENANT,
          walletAddress: WALLET,
          routeRunId: 'route-intent-v2:missing',
          blueprintId: 'blueprint:missing',
          blueprintHash: `0x${'1'.repeat(64)}`,
          now: NOW,
        },
      ),
      /Route run does not exist/,
    );
    assert.equal(sendAsked, 0);
  });
});
