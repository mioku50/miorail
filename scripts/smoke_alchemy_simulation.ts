import assert from 'node:assert/strict';
import {
  ALCHEMY_BASE_MAINNET_HOST_V1,
  ALCHEMY_SIMULATION_PROVIDER_ID_V1,
  SimulationProviderResponseV1Schema,
  buildAlchemySafeRequestV1,
  createAlchemySimulationProviderV1,
  createSimulationProviderFromConfigV1,
  resolveSimulationProviderConfigV1,
} from '@mioagent/paid-intelligence';
import { hashApprovedCallsV1, type ExecutionCallV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T63B §9 — FREE smoke test for the Alchemy eth_simulateV1 adapter.
//
// "Free" in two senses: it costs no USDC (no x402 challenge, no Spend
// Permission, no charge row) and, by default, no Alchemy quota either — the
// offline section runs the full adapter against recorded payloads.
//
// Run offline (default, no key needed):
//   pnpm smoke:alchemy-sim
// Run the read-only live probe as well (uses one Alchemy request):
//   ALCHEMY_BASE_API_KEY=... SMOKE_ALCHEMY_LIVE=true pnpm smoke:alchemy-sim
//
// The live probe simulates a single read-only WETH `deposit()` call from a
// burn address. It signs nothing, broadcasts nothing, and moves no funds.
// ---------------------------------------------------------------------------

const WALLET = '0x000000000000000000000000000000000000dEaD' as const;
const WETH_BASE = '0x4200000000000000000000000000000000000006' as const;
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function ok(message: string): void {
  console.log(`   ✔ ${message}`);
}

function nativeAsset() {
  return {
    assetId: 'eip155:8453/native',
    chainId: 8453 as const,
    kind: 'native' as const,
    address: null,
    symbol: 'ETH',
    decimals: 18,
  };
}

/** Two calls, in order: wrap 0.001 ETH, then a no-op read on WETH. */
function smokeCalls(): ExecutionCallV1[] {
  return [
    {
      index: 0,
      callType: 'deposit',
      to: WETH_BASE,
      valueWei: '1000000000000000',
      data: '0xd0e30db0', // deposit()
      asset: nativeAsset(),
      amountAtomic: '1000000000000000',
      recipient: WALLET,
      spender: null,
    },
    {
      index: 1,
      callType: 'other',
      to: WETH_BASE,
      valueWei: '0',
      data: '0x18160ddd', // totalSupply()
      asset: null,
      amountAtomic: null,
      recipient: null,
      spender: null,
    },
  ];
}

function requestFor(calls: ExecutionCallV1[]) {
  return {
    chainId: 8453 as const,
    walletAddress: WALLET,
    blueprintHash: `0x${'1'.repeat(64)}`,
    callsHash: hashApprovedCallsV1(calls),
    calls,
  };
}

function topicAddress(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

function recordedFetch(calls: unknown[]): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const id = JSON.parse(String(init?.body)).id as string;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: [{ number: '0x2ed1f16', calls }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

async function offlineChecks(): Promise<void> {
  const calls = smokeCalls();

  console.log('1️⃣ Request mapping — persisted calls → JSON-RPC, in order, no secrets');
  const safe = buildAlchemySafeRequestV1(WALLET, calls);
  assert.ok(safe, 'safe request must build');
  assert.equal(safe.method, 'eth_simulateV1');
  assert.equal(safe.chainId, 8453);
  assert.deepEqual(safe.calls.map((call) => call.to), [WETH_BASE, WETH_BASE]);
  assert.equal(safe.calls[0].value, '0x38d7ea4c68000');
  assert.equal(BigInt(safe.calls[0].value).toString(), calls[0].valueWei);
  assert.equal(safe.calls[1].value, '0x0');
  ok('calls map 1:1 in Blueprint order with canonical hex quantities');

  console.log('2️⃣ Response validation — success, revert, and fail-closed rejections');
  const provider = createAlchemySimulationProviderV1({
    apiKey: 'smoke-offline-key',
    fetchImpl: recordedFetch([
      {
        status: '0x1',
        gasUsed: '0x11170',
        logs: [
          {
            address: USDC_BASE,
            topics: [TRANSFER_TOPIC, topicAddress('0x2222222222222222222222222222222222222222'), topicAddress(WALLET)],
            data: `0x${(1_250_000n).toString(16).padStart(64, '0')}`,
          },
        ],
      },
      { status: '0x1', gasUsed: '0x5208', logs: [] },
    ]),
  });
  const success = await provider.simulate(requestFor(calls));
  assert.equal(success.ok, true, 'recorded success payload must validate');
  const body = SimulationProviderResponseV1Schema.parse(success.ok ? success.body : null);
  assert.equal(body.status, 'success');
  assert.equal(body.blockNumber, 0x2ed1f16);
  assert.equal(body.gasUsed, String(0x11170 + 0x5208));
  assert.deepEqual(body.callResults?.map((entry) => entry.index), [0, 1]);
  assert.equal(body.assetChanges?.status, 'available');
  assert.equal(body.assetChanges?.changes[0].amountAtomic, '1250000');
  ok('success payload → gas total, per-call results, decoded ERC-20 Transfer');

  const reverted = await createAlchemySimulationProviderV1({
    apiKey: 'smoke-offline-key',
    fetchImpl: recordedFetch([
      { status: '0x1', gasUsed: '0x5208', logs: [] },
      { status: '0x0', gasUsed: '0x5208', logs: [], error: { message: 'STF' } },
    ]),
  }).simulate(requestFor(calls));
  const revertedBody = SimulationProviderResponseV1Schema.parse(reverted.ok ? reverted.body : null);
  assert.equal(revertedBody.status, 'reverted');
  assert.equal(revertedBody.failedCallIndex, 1);
  assert.equal(revertedBody.assetChanges?.status, 'unavailable');
  ok('a reverted call reverts the run, names the index, and claims no asset changes');

  for (const [label, calls_, expected] of [
    ['unknown status', [{ status: '0x2', gasUsed: '0x5208' }, { status: '0x1', gasUsed: '0x5208' }], 'provider_invalid_schema'],
    ['invalid gas', [{ status: '0x1', gasUsed: '145000' }, { status: '0x1', gasUsed: '0x5208' }], 'provider_invalid_schema'],
    ['call-count mismatch', [{ status: '0x1', gasUsed: '0x5208' }], 'provider_call_count_mismatch'],
  ] as const) {
    const result = await createAlchemySimulationProviderV1({
      apiKey: 'smoke-offline-key',
      fetchImpl: recordedFetch([...calls_]),
    }).simulate(requestFor(calls));
    assert.equal(result.ok, false, `${label} must fail closed`);
    assert.equal(result.ok === false ? result.errorCode : '', expected);
  }
  ok('unknown status / invalid gas / call-count mismatch all fail closed');

  console.log('3️⃣ Secret handling — the API key never leaves the endpoint');
  const key = 'super-secret-smoke-key';
  const leaky = await createAlchemySimulationProviderV1({
    apiKey: key,
    fetchImpl: (async () => new Response('{}', { status: 502 })) as unknown as typeof fetch,
  }).simulate(requestFor(calls));
  assert.equal(leaky.ok, false);
  assert.doesNotMatch(JSON.stringify(leaky), new RegExp(key), 'failure detail must not carry the key');
  assert.doesNotMatch(JSON.stringify(buildAlchemySafeRequestV1(WALLET, calls)), new RegExp(key));
  ok('failure details and the hashable safe request are key-free');

  console.log('4️⃣ Registry — server config selects one provider, unknown ids fail closed');
  const configured = resolveSimulationProviderConfigV1({
    MIORAIL_SIMULATION_PROVIDER_ID: ALCHEMY_SIMULATION_PROVIDER_ID_V1,
    ALCHEMY_BASE_API_KEY: 'registry-key',
  } as NodeJS.ProcessEnv);
  assert.equal(configured.configured, true);
  assert.equal(configured.url, undefined);
  assert.doesNotMatch(JSON.stringify(configured), /registry-key/);
  const unknown = resolveSimulationProviderConfigV1({
    MIORAIL_SIMULATION_PROVIDER_ID: 'not-a-provider',
  } as NodeJS.ProcessEnv);
  assert.equal(unknown.configured, false);
  assert.equal(unknown.missingReason, 'unknown_provider');
  assert.equal(createSimulationProviderFromConfigV1(unknown), null);
  ok('alchemy-eth-simulate-v1 resolves; an unknown id resolves to nothing');
}

async function liveProbe(): Promise<void> {
  const apiKey = process.env.ALCHEMY_BASE_API_KEY?.trim();
  if (!apiKey) {
    console.log('5️⃣ Live probe SKIPPED — set ALCHEMY_BASE_API_KEY and SMOKE_ALCHEMY_LIVE=true to run it');
    return;
  }
  console.log(`5️⃣ Live probe — one read-only eth_simulateV1 against ${ALCHEMY_BASE_MAINNET_HOST_V1}`);
  const calls = smokeCalls();
  const result = await createAlchemySimulationProviderV1({ apiKey }).simulate(requestFor(calls));
  if (!result.ok) {
    // A live provider failure is reported, not thrown: the smoke test proves
    // the adapter's typed failure model works just as much as its happy path.
    console.log(`   ⚠ live simulation returned a typed failure: ${result.errorCode} (${result.detail})`);
    return;
  }
  const body = SimulationProviderResponseV1Schema.parse(result.body);
  assert.ok(body.blockNumber > 0, 'live response must carry a real block');
  assert.equal(body.callResults?.length, calls.length, 'every Blueprint call must be simulated');
  console.log(
    `   ✔ block ${body.blockNumber}, status ${body.status}, gas ${body.gasUsed}, ` +
      `assetChanges ${body.assetChanges?.status ?? 'n/a'}`,
  );
  assert.doesNotMatch(JSON.stringify(body), new RegExp(apiKey), 'the key must not appear in the response');
}

async function main(): Promise<void> {
  console.log('⚡ T63B smoke: Alchemy Base eth_simulateV1 adapter (free — no payment, no charge row)');
  await offlineChecks();
  if (String(process.env.SMOKE_ALCHEMY_LIVE ?? '').trim().toLowerCase() === 'true') {
    await liveProbe();
  } else {
    console.log('5️⃣ Live probe skipped (set SMOKE_ALCHEMY_LIVE=true to enable)');
  }
  console.log('✅ T63B Alchemy simulation smoke test passed');
}

main().catch((error) => {
  console.error('❌ T63B Alchemy simulation smoke test failed');
  console.error(error);
  process.exit(1);
});
