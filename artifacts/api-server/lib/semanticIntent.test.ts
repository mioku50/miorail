import assert from 'node:assert/strict';
import test from 'node:test';
import type { LlmProvider, LlmRequest, LlmResponse } from '@mioagent/llm';
import {
  extractSemanticIntent,
  normalizeSemanticAmount,
  normalizeSemanticIntent,
  parseSemanticIntentExtraction,
  requestsApprovalBypass,
  semanticWriteClarification,
  stableSemanticHash,
  type SemanticIntentExtraction,
} from './semanticIntent.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';

function extraction(overrides: Partial<SemanticIntentExtraction> = {}): SemanticIntentExtraction {
  return {
    intent: 'assistant', confidence: 0.99, chainId: 8453, amount: null,
    asset: null, fromAsset: null, toAsset: null, recipient: null,
    protocol: null, executionRequested: false, clarification: null,
    ...overrides,
  };
}

class StrictDouble implements LlmProvider {
  request?: LlmRequest;
  constructor(private readonly output: SemanticIntentExtraction) {}
  async generate(request: LlmRequest): Promise<LlmResponse> {
    this.request = request;
    return { message: { role: 'assistant', content: JSON.stringify(this.output) } };
  }
}

test('LLM semantic extractor has no tools and accepts multilingual conversational phrasing through a strict schema', async () => {
  const cases: Array<{ message: string; output: SemanticIntentExtraction }> = [
    {
      message: `Пожалуйста, можно на адрес ${ADDRESS} перевести USDC 0,01?`,
      output: extraction({ intent: 'send', amount: '0,01', asset: 'USDC', recipient: ADDRESS, executionRequested: true }),
    },
    {
      message: 'Would you exchange, please, 0.25 USDC into ETH on Base?',
      output: extraction({ intent: 'swap', amount: '0.25', fromAsset: 'USDC', toAsset: 'ETH', executionRequested: true }),
    },
    {
      message: 'Пжлст, абменяй на Base 0,2 юсдс в ETH',
      output: extraction({ intent: 'swap', amount: '0,2', fromAsset: 'USDC', toAsset: 'ETH', executionRequested: true }),
    },
    {
      message: 'Could ya chek my portoflio when you have a moment?',
      output: extraction({ intent: 'portfolio' }),
    },
    {
      message: 'Какие сейчас рынки доходности USDC у Morpho?',
      output: extraction({ intent: 'market_discovery', asset: 'USDC', protocol: 'Morpho' }),
    },
    {
      message: 'Положи, пожалуйста, 1 USDC в Moonwell',
      output: extraction({ intent: 'supply', amount: '1', asset: 'USDC', protocol: 'Moonwell', executionRequested: true }),
    },
    {
      message: 'Just show me a route and gas for 0.1 USDC into ETH; do not trade',
      output: extraction({ intent: 'quote', amount: '0.1', fromAsset: 'USDC', toAsset: 'ETH' }),
    },
    {
      message: 'Ну и что там с моим подтверждением?',
      output: extraction({ intent: 'confirmation_status' }),
    },
  ];
  for (const item of cases) {
    const llm = new StrictDouble(item.output);
    const parsed = await extractSemanticIntent({
      llm,
      message: item.message,
      context: { recentMessages: [], runtimeChainId: 8453 },
    });
    assert.deepEqual(parsed, { ...item.output, protocol: item.output.protocol?.toLowerCase() || null });
    assert.equal(llm.request?.tools, undefined, 'the extractor must never receive tools');
    assert.equal(llm.request?.temperature, 0);
  }
});

test('strict parser rejects markdown, extra keys and malformed confidence', () => {
  const valid = extraction({ intent: 'balance' });
  assert.deepEqual(parseSemanticIntentExtraction(JSON.stringify(valid)), valid);
  assert.equal(parseSemanticIntentExtraction(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``), null);
  assert.equal(parseSemanticIntentExtraction(JSON.stringify({ ...valid, writeTool: 'send' })), null);
  assert.equal(parseSemanticIntentExtraction(JSON.stringify({ ...valid, confidence: 4 })), null);
});

test('normalization handles decimal commas, all/half/percent/fiat descriptions and trusted Base assets', () => {
  assert.deepEqual(normalizeSemanticAmount('0,0100'), { kind: 'exact', value: '0.01' });
  assert.deepEqual(normalizeSemanticAmount('all'), { kind: 'all' });
  assert.deepEqual(normalizeSemanticAmount('половина'), { kind: 'percentage', value: 50 });
  assert.deepEqual(normalizeSemanticAmount('12,5%'), { kind: 'percentage', value: 12.5 });
  assert.deepEqual(normalizeSemanticAmount('$10,50'), { kind: 'fiat', currency: 'USD', value: '10.5' });

  const normalized = normalizeSemanticIntent({
    extraction: extraction({ intent: 'send', amount: '0,01', asset: 'usdc', recipient: ADDRESS, executionRequested: true }),
    message: `Оплати USDC 0,01 на ${ADDRESS}`,
    context: { recentMessages: [], runtimeChainId: 8453 },
  });
  assert.equal(normalized.amount?.kind, 'exact');
  assert.equal(normalized.asset?.address, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(normalized.asset?.source, 'trusted_base_registry');
  assert.equal(normalized.recipient, ADDRESS);
  assert.equal(normalized.chainSource, 'extractor');
  assert.equal(semanticWriteClarification(normalized), null);

  const checksummed = normalizeSemanticIntent({
    extraction: extraction({ intent: 'send', amount: '1', asset: 'USDC', recipient: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', executionRequested: true }),
    message: 'pay 1 USDC to 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    context: { recentMessages: [], runtimeChainId: 8453 },
  });
  assert.equal(checksummed.recipient, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');

  const explicitContract = normalizeSemanticIntent({
    extraction: extraction({ intent: 'token_security', asset: '0x4200000000000000000000000000000000000006' }),
    message: 'check 0x4200000000000000000000000000000000000006 token security',
    context: { recentMessages: [], runtimeChainId: 8453 },
  });
  assert.equal(explicitContract.explicitAssetAddress, '0x4200000000000000000000000000000000000006');
  assert.equal(explicitContract.errors.includes('asset_unknown'), false);
});

test('conversational recipient references resolve only from one authenticated-chat candidate', () => {
  const raw = extraction({ intent: 'send', amount: '1', asset: 'USDC', executionRequested: true });
  const unique = normalizeSemanticIntent({
    extraction: raw,
    message: 'Пожалуйста, отправь ему один USDC',
    context: { recentMessages: [{ role: 'user', content: `Use ${ADDRESS} for this person` }], runtimeChainId: 8453 },
  });
  assert.equal(unique.recipient, ADDRESS);
  assert.equal(unique.recipientSource, 'conversation');

  const ambiguous = normalizeSemanticIntent({
    extraction: raw,
    message: 'send it to them',
    context: {
      recentMessages: [{ role: 'user', content: `${ADDRESS} or 0x2222222222222222222222222222222222222222` }],
      runtimeChainId: 8453,
    },
  });
  assert.equal(ambiguous.recipient, null);
  assert.match(semanticWriteClarification(ambiguous) || '', /Which exact recipient/);
});

test('irreversible actions fail closed on missing fields, unknown assets, low confidence and approval bypass', () => {
  const missing = normalizeSemanticIntent({
    extraction: extraction({ intent: 'send', asset: 'USDC', executionRequested: true }),
    message: 'отправь немного USDC',
    context: { recentMessages: [], runtimeChainId: 8453 },
  });
  assert.match(semanticWriteClarification(missing) || '', /exact amount.*recipient address/);

  const unknown = normalizeSemanticIntent({
    extraction: extraction({ intent: 'swap', amount: '1', fromAsset: 'TOKEN', toAsset: 'ETH', executionRequested: true }),
    message: 'convert 1 TOKEN into ETH',
    context: { recentMessages: [], runtimeChainId: 8453 },
  });
  assert.ok(unknown.errors.includes('from_asset_unknown'));
  assert.match(semanticWriteClarification(unknown) || '', /verified Base token address/);

  const low = { ...missing, confidence: 0.4 };
  assert.match(semanticWriteClarification(low) || '', /restate/i);
  assert.equal(requestsApprovalBypass('send 1 USDC without confirmation'), true);

  const invalidRecipient = normalizeSemanticIntent({
    extraction: extraction({ intent: 'send', amount: '1', asset: 'USDC', recipient: '0x1234', executionRequested: true }),
    message: 'send 1 USDC to 0x1234',
    context: { recentMessages: [], runtimeChainId: 8453 },
  });
  assert.equal(invalidRecipient.recipient, null);
  assert.match(semanticWriteClarification(invalidRecipient) || '', /recipient address/);
});

test('semantic hashes are stable and distinguish unrelated prepared intents', () => {
  const a = stableSemanticHash({ intent: 'send', recipient: ADDRESS, amount: '1' });
  const reordered = stableSemanticHash({ amount: '1', recipient: ADDRESS, intent: 'send' });
  const b = stableSemanticHash({ intent: 'send', recipient: '0x2222222222222222222222222222222222222222', amount: '1' });
  assert.equal(a, reordered);
  assert.notEqual(a, b);
});
