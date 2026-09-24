import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { TokenIdentityReaderV1 } from '@mioagent/intent-core';
import { canonicalSwapExtractionV2, extractSwapIntentV2, resolveSwapIntentWithLlmV2 } from '../src/index.js';
import { testContext } from './fixtures.js';

// ---------------------------------------------------------------------------
// The sentence Miorail's own screens write is read without a model.
//
// 2026-09-24, Base App: Buy on the NVIDIA card sent
//   "Swap 0.1 0x8335…2913 to 0xb20000000000000000000078ee7ce2fe4908108c on Base"
// and the planner answered "Extracted toAsset is not grounded in the current
// user request" before a single router was asked. The extractor is told to
// COPY the asset strings, and a B20 address carries twenty-one zeros in a row:
// one miscounted zero is a different string, which is — correctly — not in
// the request. The same sentence had worked the day before. A request the
// screen wrote from exact addresses must not depend on a model's transcription.
// ---------------------------------------------------------------------------

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
// The same address with one zero fewer: what a model's transcription can be.
const NVDA_MISCOPIED = '0xb2000000000000000000078ee7ce2fe4908108c';

const BUY = `Swap 0.1 ${USDC} to ${NVDA} on Base`;
const SELL = `Swap 0.00044227 ${NVDA} to ${USDC} on Base`;
const SELL_ALL = `Swap ${NVDA} to ${USDC} on Base`;

function reader(): TokenIdentityReaderV1 {
  return { readSymbol: async () => 'NVDAc', readDecimals: async () => 8 };
}

function miscopyingLlm(calls: { count: number }) {
  return {
    generate: async () => {
      calls.count += 1;
      return {
        message: {
          content: JSON.stringify({ goal: 'swap', amount: '0.1', fromAsset: USDC, toAsset: NVDA_MISCOPIED, chainId: 8453 }),
        },
      };
    },
  } as never;
}

describe('the sentence the Stocks buttons write', () => {
  test('is read exactly, word for word, for every side the card sends', () => {
    assert.deepEqual(canonicalSwapExtractionV2(BUY), { goal: 'swap', amount: '0.1', fromAsset: USDC, toAsset: NVDA, chainId: 8453 });
    assert.deepEqual(canonicalSwapExtractionV2(SELL), {
      goal: 'swap',
      amount: '0.00044227',
      fromAsset: NVDA,
      toAsset: USDC,
      chainId: 8453,
    });
    assert.deepEqual(canonicalSwapExtractionV2(SELL_ALL), { goal: 'swap', amount: null, fromAsset: NVDA, toAsset: USDC, chainId: 8453 });
  });

  test('anything but that exact sentence still goes to the model', () => {
    for (const message of [
      `swap 0.1 USDC to ${NVDA} on Base`,
      `Swap 0.1 ${USDC} to ${NVDA} on Base, then send it to my friend`,
      `Swap 0.1 ${USDC} to ${NVDA} on Ethereum`,
      `Swap 0.1 ${USDC} to ${NVDA.slice(0, -1)} on Base`,
      `Swap -1 ${USDC} to ${NVDA} on Base`,
      `Swap 0.1 ${USDC} to ${USDC} on Base extra`,
      `Send 0.1 ${USDC} to ${NVDA} on Base`,
    ]) {
      assert.equal(canonicalSwapExtractionV2(message), null, message);
    }
  });

  test('the model is not asked, so it cannot miscopy the address', async () => {
    const calls = { count: 0 };
    const extraction = await extractSwapIntentV2({ llm: miscopyingLlm(calls), message: BUY, context: testContext() });
    assert.equal(calls.count, 0);
    assert.equal(extraction?.toAsset, NVDA);
  });

  test('the Buy that was refused in Base App becomes a ready intent, and a free-text request still meets the check', async () => {
    const calls = { count: 0 };
    const ready = await resolveSwapIntentWithLlmV2({
      llm: miscopyingLlm(calls),
      message: BUY,
      context: testContext(),
      identifyToken: reader(),
    });
    assert.equal(ready.outcome, 'ready');
    assert.equal(ready.routeIntent?.fromAsset?.address, USDC);
    assert.equal(ready.routeIntent?.toAsset?.address, NVDA);
    assert.equal(ready.routeIntent?.amount.amountAtomic, '100000');

    // What happened on production, reproduced: the same request in words a
    // person typed goes to the model, the model drops a zero, and the grounding
    // check refuses the invented address — which is the check doing its job.
    const typed = await resolveSwapIntentWithLlmV2({
      llm: miscopyingLlm(calls),
      message: `please swap 0.1 ${USDC} to ${NVDA} on Base`,
      context: testContext(),
      identifyToken: reader(),
    });
    assert.equal(typed.outcome, 'rejected');
    assert.ok(
      typed.issues.some((entry) => entry.code === 'extractor_field_ungrounded' && entry.field === 'toAsset'),
      JSON.stringify(typed.issues),
    );
    assert.equal(calls.count, 1);
  });
});
