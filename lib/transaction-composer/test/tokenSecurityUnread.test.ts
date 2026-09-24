import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssetRefV1, ExecutionCallV1 } from '@mioagent/route-domain';

import { classifySwapCallV1 } from '../src/blueprint.js';
import { narrowUniswapApprovalsV1 } from '../src/adapters/uniswap.js';
import { runSafetyKernel } from '../src/safetyKernel.js';
import { NOW, USDC_BASE, WALLET, makeIntent } from './fixtures.js';

// ---------------------------------------------------------------------------
// 2026-09-24: a buy of NVDAc was refused with "No usable GoPlus verdict for
// the input token". The input token was USDC and had a verdict; the unread one
// was NVDAc, and it was unread because GoPlus was rate-limiting us. The
// refusal still blocks — an unread verdict is not a clean one — but it now
// names the token it is about and says what actually happened.
// ---------------------------------------------------------------------------

const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43' as const;
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const;
const NVDA_BASE: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0xb20000000000000000000078ee7ce2fe4908108c',
  chainId: 8453,
  kind: 'erc20',
  address: '0xb20000000000000000000078ee7ce2fe4908108c',
  symbol: 'NVDAc',
  decimals: 8,
};
const intent = makeIntent({ toAsset: NVDA_BASE, amountDecimal: '0.1', verificationDepth: 'enhanced' });
const quoteExpiry = new Date(NOW.getTime() + 10 * 60_000).toISOString();
const THROTTLED =
  'GoPlus is rate-limiting Miorail right now, so this token’s contract risk was not read. This says nothing about the token; try again in a minute.';

function calls(): ExecutionCallV1[] {
  const expirySec = Math.floor(Date.parse(quoteExpiry) / 1000);
  const word = (value: bigint | string) =>
    (typeof value === 'string' ? value.replace(/^0x/, '').toLowerCase() : value.toString(16)).padStart(64, '0');
  const amount = BigInt(intent.amount.amountAtomic);
  const raw = narrowUniswapApprovalsV1(
    [
      { to: USDC_BASE.address!, value: '0', data: `0x095ea7b3${word(PERMIT2)}${word((1n << 256n) - 1n)}` },
      { to: PERMIT2, value: '0', data: `0x87517c45${word(USDC_BASE.address!)}${word(ROUTER)}${word(amount)}${word(BigInt(expirySec))}` },
      { to: ROUTER, value: '0', data: '0x3593564c' },
    ],
    { inputToken: USDC_BASE.address!, amountAtomic: intent.amount.amountAtomic, expiresAtSec: expirySec },
  );
  return raw.map((call, index) =>
    classifySwapCallV1({ index, call: call as never, routerAddress: ROUTER, inputAsset: USDC_BASE, walletAddress: WALLET }),
  );
}

function kernel(nvdaVerdict: { status: 'ok' | 'failed' | 'unknown'; summary: string }) {
  return runSafetyKernel({
    provider: 'uniswap',
    routerAddress: ROUTER,
    chainId: 8453,
    walletAddress: WALLET,
    intent,
    calls: calls(),
    quoteExpiry,
    now: NOW,
    contractSecurityRequired: true,
    contractSecurityProvider: 'goplus',
    contractSecurityResults: [
      { address: USDC_BASE.address!, provider: 'goplus', status: 'warning', summary: 'GoPlus reported warning-level contract flags: Proxy contract.' },
      { address: NVDA_BASE.address!, provider: 'goplus', ...nvdaVerdict },
    ],
    contractSecurityAddresses: [USDC_BASE.address as `0x${string}`, NVDA_BASE.address as `0x${string}`],
    simulationAcceptable: true,
    simulationDetail: 'ok',
    intentHash: intent.intentHash,
    selectedCandidateHash: `0x${'1'.repeat(64)}`,
  }).result;
}

test('a throttled verdict still blocks, and says which token and why', () => {
  const result = kernel({ status: 'failed', summary: THROTTLED });
  assert.equal(result.verdict, 'blocked');
  const detail = result.checks.find((entry) => entry.id === 'contract_token_security')?.detail ?? '';
  assert.match(detail, /^NVDAc 0xb20000000000000000000078ee7ce2fe4908108c: GoPlus is rate-limiting Miorail/);
  assert.match(detail, /says nothing about the token/);
  assert.doesNotMatch(detail, /USDC/, 'the token that had a verdict is not the one named');
  assert.doesNotMatch(detail, /input token/);
});

test('a readable verdict on both sides passes, as before', () => {
  const result = kernel({ status: 'ok', summary: 'No major warnings detected by configured providers.' });
  assert.equal(result.checks.find((entry) => entry.id === 'contract_token_security')?.status, 'passed');
});
