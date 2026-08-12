import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { TokenIdentityReaderV1 } from '@mioagent/intent-core';
import {
  identifiedAssetRefV1,
  resolveSwapIntentV2,
  resolveSwapIntentWithLlmV2,
  type SwapIntentExtractionV2,
} from '../src/index.js';
import { swapExtraction, testContext } from './fixtures.js';

// ---------------------------------------------------------------------------
// A token the user named by ADDRESS, all the way into a route intent.
//
// The module that identifies one was written first and wired to nothing. These
// hold the wiring down, and the thing they mostly assert is a NEGATIVE: what
// the identification is still not allowed to do.
// ---------------------------------------------------------------------------

const MIO = '0xb200000000000000000000578f3ae29d9e6e0101';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function mioAsset() {
  return identifiedAssetRefV1({
    address: MIO as `0x${string}`,
    displayAddress: MIO as `0x${string}`,
    symbol: 'MIO',
    decimals: 18,
  });
}

function llm(extraction: SwapIntentExtractionV2 | null) {
  return {
    generate: async () => ({
      message: { content: extraction === null ? 'not json' : JSON.stringify(extraction) },
    }),
  } as never;
}

function reader(overrides: Partial<TokenIdentityReaderV1> = {}): TokenIdentityReaderV1 {
  return {
    readSymbol: async () => 'MIO',
    readDecimals: async () => 18,
    ...overrides,
  };
}

describe('an address the user typed can become a swap side', () => {
  test('without identification the address is refused, exactly as before', () => {
    const result = resolveSwapIntentV2({
      message: `swap my 10000 ${MIO} to USDC`,
      extraction: swapExtraction({ amount: '10000', fromAsset: MIO, toAsset: 'USDC' }),
      context: testContext(),
    });
    assert.equal(result.outcome, 'rejected');
    assert.ok(result.issues.some((entry) => entry.code === 'asset_address_unsafe'));
  });

  test('with identification the same request becomes a ready intent', () => {
    const result = resolveSwapIntentV2({
      message: `swap my 10000 ${MIO} to USDC`,
      extraction: swapExtraction({ amount: '10000', fromAsset: MIO, toAsset: 'USDC' }),
      context: testContext(),
      identifiedAssets: [mioAsset()],
    });
    assert.equal(result.outcome, 'ready');
    assert.equal(result.routeIntent?.fromAsset?.address, MIO);
    // Eighteen decimals came off the contract, so the amount scales by them.
    assert.equal(result.routeIntent?.amount.amountAtomic, '10000000000000000000000');
    assert.equal(result.routeIntent?.toAsset?.address, USDC);
  });

  test('the identified token is reachable by address, never by the symbol it claims', () => {
    // The contract answers "USDC". That buys it nothing: a symbol resolves
    // against the trusted table only, so this names canonical USDC on both
    // sides and is refused as a same-asset pair rather than routed.
    const impostor = identifiedAssetRefV1({
      address: MIO as `0x${string}`,
      displayAddress: MIO as `0x${string}`,
      symbol: 'USDC',
      decimals: 18,
    });
    const result = resolveSwapIntentV2({
      message: 'swap 100 USDC to USDC',
      extraction: swapExtraction({ amount: '100', fromAsset: 'USDC', toAsset: 'USDC' }),
      context: testContext(),
      identifiedAssets: [impostor],
    });
    assert.notEqual(result.outcome, 'ready');
  });

  test('an address that was NOT identified is still refused, even beside one that was', () => {
    const other = '0x1234567890abcdef1234567890abcdef12345678';
    const result = resolveSwapIntentV2({
      message: `swap my 1 ${MIO} to ${other}`,
      extraction: swapExtraction({ amount: '1', fromAsset: MIO, toAsset: other }),
      context: testContext(),
      identifiedAssets: [mioAsset()],
    });
    assert.equal(result.outcome, 'rejected');
    assert.ok(result.issues.some((entry) => entry.code === 'asset_address_unsafe'));
  });

  test('«переведи мои 10000 … в USDC» is a conversion, not an unsupported goal', () => {
    // The transfer verb only means "send" when the sentence does not name a
    // pair. An identified token is half of a pair, so it must count as one.
    const result = resolveSwapIntentV2({
      message: `переведи мои 10000 ${MIO} в USDC`,
      extraction: swapExtraction({ amount: '10000', fromAsset: MIO, toAsset: 'USDC' }),
      context: testContext(),
      identifiedAssets: [mioAsset()],
    });
    assert.equal(result.outcome, 'ready');
  });
});

describe('only the chain gets to say what an address is', () => {
  test('the reader is asked about the address in the message, and the intent uses its answer', async () => {
    const asked: string[] = [];
    const result = await resolveSwapIntentWithLlmV2({
      llm: llm(swapExtraction({ amount: '10000', fromAsset: MIO, toAsset: 'USDC' })),
      message: `свап мои 10000 токенов ${MIO} на USDC`,
      context: testContext(),
      identifyToken: reader({
        readSymbol: async (address) => {
          asked.push(address);
          return 'MIO';
        },
      }),
    });
    assert.deepEqual(asked, [MIO]);
    assert.equal(result.outcome, 'ready');
    assert.equal(result.routeIntent?.fromAsset?.symbol, 'MIO');
  });

  test('an address the model invented is never read, because it is not in the message', async () => {
    const invented = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const asked: string[] = [];
    const result = await resolveSwapIntentWithLlmV2({
      // The user names no address at all. The extractor answers with one.
      llm: llm(swapExtraction({ amount: '100', fromAsset: invented, toAsset: 'USDC' })),
      message: 'swap my 100 MIO to USDC',
      context: testContext(),
      identifyToken: reader({
        readSymbol: async (address) => {
          asked.push(address);
          return 'MIO';
        },
      }),
    });
    assert.deepEqual(asked, [], 'only addresses the user typed may be read');
    assert.notEqual(result.outcome, 'ready');
  });

  test('a contract that will not answer produces no asset, and the address stays refused', async () => {
    const result = await resolveSwapIntentWithLlmV2({
      llm: llm(swapExtraction({ amount: '1', fromAsset: MIO, toAsset: 'USDC' })),
      message: `swap 1 ${MIO} to USDC`,
      context: testContext(),
      identifyToken: reader({ readDecimals: async () => null }),
    });
    assert.equal(result.outcome, 'rejected');
    assert.ok(result.issues.some((entry) => entry.code === 'asset_address_unsafe'));
  });

  test('a canonical address is never sent to the chain — it is already pinned', async () => {
    const asked: string[] = [];
    const result = await resolveSwapIntentWithLlmV2({
      llm: llm(swapExtraction({ amount: '1', fromAsset: USDC, toAsset: 'ETH' })),
      message: `swap 1 ${USDC} to ETH`,
      context: testContext(),
      identifyToken: reader({
        readSymbol: async (address) => {
          asked.push(address);
          return 'NOT-USDC';
        },
      }),
    });
    assert.deepEqual(asked, []);
    assert.equal(result.outcome, 'ready');
    assert.equal(result.routeIntent?.fromAsset?.symbol, 'USDC');
  });
});
