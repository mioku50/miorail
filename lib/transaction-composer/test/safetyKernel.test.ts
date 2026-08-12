import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, erc20Abi } from 'viem';
import type { AssetRefV1, ExecutionCallV1 } from '@mioagent/route-domain';
import { runSafetyKernel, swapTokenSecurityAddressesV1, tokenSecurityRefusalV1 } from '../src/safetyKernel.js';
import { ETH_BASE, NOW, USDC_BASE, WALLET, makeIntent } from './fixtures.js';

const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43' as const;

function approvalCall(amountAtomic: bigint, spender: `0x${string}` = ROUTER): ExecutionCallV1 {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amountAtomic] });
  return {
    index: 0,
    callType: 'approval',
    to: USDC_BASE.address as `0x${string}`,
    valueWei: '0',
    data,
    asset: USDC_BASE,
    amountAtomic: amountAtomic.toString(),
    recipient: null,
    spender,
  };
}

function swapCall(index = 1): ExecutionCallV1 {
  return {
    index,
    callType: 'swap',
    to: ROUTER,
    valueWei: '0',
    data: '0x12345678',
    asset: null,
    amountAtomic: null,
    recipient: WALLET,
    spender: null,
  };
}

function baseArgs(overrides: Partial<Parameters<typeof runSafetyKernel>[0]> = {}) {
  const intent = makeIntent();
  return {
    provider: 'uniswap' as const,
    routerAddress: ROUTER,
    chainId: 8453,
    walletAddress: WALLET,
    intent,
    calls: [approvalCall(BigInt(intent.amount.amountAtomic)), swapCall()],
    quoteExpiry: new Date(NOW.getTime() + 60_000).toISOString(),
    now: NOW,
    contractSecurityRequired: true,
    contractSecurityProvider: 'goplus',
    contractSecurityResults: [{ address: USDC_BASE.address!, provider: 'goplus' as const, status: 'ok' as const, summary: 'clean' }],
    contractSecurityAddresses: [USDC_BASE.address as `0x${string}`],
    simulationAcceptable: true,
    simulationDetail: 'ok',
    intentHash: intent.intentHash,
    selectedCandidateHash: `0x${'1'.repeat(64)}` as const,
    ...overrides,
  };
}

test('allows a well-formed Uniswap batch with passing contract security', () => {
  const { result } = runSafetyKernel(baseArgs());
  assert.equal(result.verdict, 'allowed');
  assert.equal(result.blockedReason, null);
});

test('blocks an unlimited approval amount', () => {
  const intent = makeIntent();
  const { result } = runSafetyKernel(
    baseArgs({ calls: [approvalCall((1n << 256n) - 1n), swapCall()], intent }),
  );
  assert.equal(result.verdict, 'blocked');
  assert.ok(result.blockedReason);
});

test('blocks an unrecognized call target (call classified as other)', () => {
  const otherCall: ExecutionCallV1 = {
    index: 1,
    callType: 'other',
    to: '0x9999999999999999999999999999999999999999',
    valueWei: '0',
    data: '0xdeadbeef',
    asset: null,
    amountAtomic: null,
    recipient: null,
    spender: null,
  };
  const intent = makeIntent();
  const { result } = runSafetyKernel(
    baseArgs({ calls: [approvalCall(BigInt(intent.amount.amountAtomic)), otherCall], intent }),
  );
  assert.equal(result.verdict, 'blocked');
});

test('blocks an expired quote deadline', () => {
  const { result } = runSafetyKernel(baseArgs({ quoteExpiry: new Date(NOW.getTime() - 1_000).toISOString() }));
  assert.equal(result.verdict, 'blocked');
});

test('blocks when contract security has no usable GoPlus verdict', () => {
  const { result, contractSecurity } = runSafetyKernel(baseArgs({ contractSecurityResults: [] }));
  assert.equal(result.verdict, 'blocked');
  assert.equal(contractSecurity.status, 'blocked');
});

test('standard verification depth accepts unavailable simulation with a warning-worthy check', () => {
  const intent = makeIntent({ verificationDepth: 'standard' });
  const { result } = runSafetyKernel(
    baseArgs({ intent, calls: [approvalCall(BigInt(intent.amount.amountAtomic)), swapCall()], simulationAcceptable: true }),
  );
  assert.equal(result.verdict, 'allowed');
});

test('enhanced verification depth blocks when simulation evidence is unavailable', () => {
  const intent = makeIntent({ verificationDepth: 'enhanced' });
  const { result } = runSafetyKernel(
    baseArgs({
      intent,
      calls: [approvalCall(BigInt(intent.amount.amountAtomic)), swapCall()],
      simulationAcceptable: false,
      simulationDetail: 'Required simulation evidence unavailable for enhanced verification depth',
    }),
  );
  assert.equal(result.verdict, 'blocked');
});

test('blocks a KyberSwap batch when the router is not pinned', () => {
  const intent = makeIntent();
  const badRouter = '0x2222222222222222222222222222222222222222' as const;
  const { result } = runSafetyKernel(
    baseArgs({
      provider: 'kyberswap',
      routerAddress: badRouter,
      calls: [
        approvalCall(BigInt(intent.amount.amountAtomic), badRouter),
        { ...swapCall(), to: badRouter },
      ],
      intent,
    }),
  );
  assert.equal(result.verdict, 'blocked');
});

// ---------------------------------------------------------------------------
// Token security policy. GoPlus reported these flags all along; the kernel saw
// only an aggregated status, so no token could ever be refused for what its
// contract does to a holder. Widening swaps beyond three known assets makes
// that the whole question, so the rules are pinned here rather than left to a
// provider's one-word verdict.
// ---------------------------------------------------------------------------

test('a token that cannot be sold is refused, whatever its status says', () => {
  for (const flags of [
    { isHoneypot: true },
    { cannotSellAll: true },
    { ownerCanChangeBalance: true },
    { hiddenOwner: true },
    { canTakeBackOwnership: true },
    { selfdestruct: true },
  ]) {
    const refusal = tokenSecurityRefusalV1({ status: 'ok', flags });
    assert.ok(refusal, `${JSON.stringify(flags)} must be refused`);
  }
});

test('a blacklist, a mint function and a proxy are NOT refusals — canonical USDC is all three', () => {
  // This is the rule that keeps the policy usable. Refusing on a blacklist
  // would refuse the safest asset on Base, and a policy that refuses
  // everything gets switched off.
  const usdcLike = {
    hasBlacklist: true,
    isMintable: true,
    isProxy: true,
    isOpenSource: true,
    buyTax: '0',
    sellTax: '0',
  };
  assert.equal(tokenSecurityRefusalV1({ status: 'ok', flags: usdcLike }), null);
});

test('tax is a threshold, and an unreadable tax is not a zero tax', () => {
  assert.equal(tokenSecurityRefusalV1({ status: 'ok', flags: { sellTax: '0.05' } }), null);
  assert.equal(tokenSecurityRefusalV1({ status: 'ok', flags: { sellTax: '10' } }), null);
  assert.match(String(tokenSecurityRefusalV1({ status: 'ok', flags: { sellTax: '40' } })), /sell tax is 40%/);
  assert.match(String(tokenSecurityRefusalV1({ status: 'ok', flags: { buyTax: '99' } })), /buy tax is 99%/);
  // Not silently treated as zero.
  assert.match(String(tokenSecurityRefusalV1({ status: 'ok', flags: { sellTax: 'n/a' } })), /could not be read/);
});

test('no flags at all is not a refusal by itself — the status still governs', () => {
  assert.equal(tokenSecurityRefusalV1({ status: 'ok' }), null);
  assert.equal(tokenSecurityRefusalV1({ status: 'ok', flags: {} }), null);
});

// ---------------------------------------------------------------------------
// Which tokens must earn a security verdict.
//
// It was the input alone. That held only while one side was always canonical
// USDC: the other side was safe by construction. With both sides open, the
// OUTPUT is where the danger lives — a honeypot bought is a honeypot that
// cannot be sold, and the input's verdict says nothing about it.
// ---------------------------------------------------------------------------

test('both sides of a swap are sent for a token-security verdict', () => {
  const mio: AssetRefV1 = {
    assetId: 'eip155:8453/erc20:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    chainId: 8453,
    kind: 'erc20',
    address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    symbol: 'MIO',
    decimals: 18,
  };
  const usdcToMio = swapTokenSecurityAddressesV1(makeIntent({ toAsset: mio }));
  assert.deepEqual(usdcToMio, [USDC_BASE.address, mio.address]);

  // Native ETH has no contract, so it contributes no address — and the token
  // on the other side is still checked.
  const mioToEth = swapTokenSecurityAddressesV1(makeIntent({ fromAsset: mio, toAsset: ETH_BASE }));
  assert.deepEqual(mioToEth, [mio.address]);
});

test('one token is asked about once, however it reaches this helper', () => {
  // A parsed intent cannot hold the same token twice: the schema lowercases
  // every address and then refuses equal assetIds. So this is reached by
  // handing the helper an UNPARSED shape, which is the only way a future
  // caller could — and the point is that it costs one provider request and
  // reports one token, not two.
  const intent = makeIntent();
  const doubled = { ...intent, toAsset: { ...USDC_BASE, address: USDC_BASE.address!.toUpperCase() } };
  assert.deepEqual(swapTokenSecurityAddressesV1(doubled as unknown as typeof intent), [USDC_BASE.address]);
});
