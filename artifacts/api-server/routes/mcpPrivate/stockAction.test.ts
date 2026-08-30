import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  issueStockActionDraftV1,
  verifyStockActionDraftV1,
} from '../../lib/stockActionDraft.js';
import {
  STOCKS_BENCH_ADDRESSES_V1,
  STOCKS_BENCH_CORPUS_V1,
  STOCKS_BENCH_NOW_V1,
} from '../../lib/stocksBenchCorpus.js';
import { miorailPrepareStockActionV1, stockActionRuntime } from './tools.js';
import { createMiorailPrivateMcpServerV1 } from './server.js';
import type { McpPrivateIdentityV1 } from './session.js';

/** The refusal CODE, which is what an assistant branches on. The message is
 * copy and may be reworded; the code is the contract. */
const refusedWith = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

// ---------------------------------------------------------------------------
// Connected Intelligence 1 — the trust boundary, checked where it can break.
//
// The tool is thin on purpose: every hard rule it enforces already lives in
// `stockExecutionHandoffV1`. What is checked here is the part a contract cannot
// hold — that the tool cannot be talked past, that its response carries no
// financial term, and that nothing on this path becomes executable.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const OTHER_WALLET = '0x2222222222222222222222222222222222222222' as const;
const SECRET = 'stock-action-test-secret';
const NOW = new Date(STOCKS_BENCH_NOW_V1);

// The SAME canonical answers the narrator benchmark runs on. Hand-building a
// MarketRealityResponseV2 here would produce a second idea of what one looks
// like, and the rule under test reads the real schema.
const CASE = (id: string) => STOCKS_BENCH_CORPUS_V1.find((row) => row.id === id)!.reality;
/** J — one security, three representations, mixed states. */
const MIXED = CASE('J');
/** E — the zero-supply wrapper, alone in its answer. */
const ZERO_SUPPLY = CASE('E');

const COINBASE = STOCKS_BENCH_ADDRESSES_V1.COINBASE_NVDA;
const BACKED = STOCKS_BENCH_ADDRESSES_V1.BACKED_NVDA;
const WRAPPER = STOCKS_BENCH_ADDRESSES_V1.BACKED_WRAPPER;
const UNDERLYING = STOCKS_BENCH_ADDRESSES_V1.UNDERLYING;
const representationIn = (reality: typeof MIXED, address: string) =>
  reality.representations.find((row) => row.tokenAddress === address)!;
const POLICY = representationIn(MIXED, COINBASE).routePolicyKey!;

const IDENTITY: McpPrivateIdentityV1 = {
  tenantId: `eip155:8453:${WALLET}`,
  walletAddress: WALLET,
  chainId: 8453,
  tokenId: 'test-token',
  source: 'handoff_token',
};

/** The identity a caller must state, taken from the canonical answer itself. */
function argsFor(reality: typeof MIXED, address: string) {
  const representation = representationIn(reality, address);
  return {
    chainId: 8453,
    tokenAddress: representation.tokenAddress,
    underlyingKey: reality.question.underlyingKey,
    issuerId: representation.issuerId,
    issuerInstrumentKey: representation.issuerInstrumentKey,
    representationKind: representation.representationKind,
    direction: reality.question.direction,
    requestedCashAtomic: reality.question.requestedCashAtomic,
    destination: 'USDC' as const,
    routePolicyKey: representation.routePolicyKey ?? POLICY,
  };
}

const ARGS = argsFor(MIXED, COINBASE);

const original = { ...stockActionRuntime };
let flags = process.env.MIORAIL_ROUTE_INTELLIGENCE_V1;

function stub(reality: unknown, over: Partial<typeof stockActionRuntime> = {}) {
  process.env.MIORAIL_ROUTE_INTELLIGENCE_V1 = 'true';
  stockActionRuntime.assembleMarketReality = async () => reality;
  stockActionRuntime.now = () => NOW;
  stockActionRuntime.secret = () => SECRET;
  stockActionRuntime.origin = () => 'https://miorail.xyz';
  Object.assign(stockActionRuntime, over);
}

afterEach(() => {
  Object.assign(stockActionRuntime, original);
  if (flags === undefined) delete process.env.MIORAIL_ROUTE_INTELLIGENCE_V1;
  else process.env.MIORAIL_ROUTE_INTELLIGENCE_V1 = flags;
  flags = process.env.MIORAIL_ROUTE_INTELLIGENCE_V1;
});

describe('a ticker can never select a representation', () => {
  test('an address is the only selector the tool accepts', async () => {
    stub(MIXED);
    for (const notAnAddress of ['NVDA', 'NVDAc', 'nvidia', '', '0xb200']) {
      await assert.rejects(
        () => miorailPrepareStockActionV1(IDENTITY, { ...ARGS, tokenAddress: notAnAddress }),
        refusedWith('representation_not_reviewed'),
        notAnAddress,
      );
    }
  });

  test('an address the answer does not carry is refused, never substituted', async () => {
    stub(MIXED);
    await assert.rejects(
      () =>
        miorailPrepareStockActionV1(IDENTITY, {
          ...ARGS,
          tokenAddress: '0x9999999999999999999999999999999999999999',
        }),
      refusedWith('representation_not_reviewed'),
    );
  });
});

describe('an issuer stays the issuer it is', () => {
  test('exact Coinbase prepares as Coinbase', async () => {
    stub(MIXED);
    const draft = await miorailPrepareStockActionV1(IDENTITY, ARGS);
    const representation = draft.representation as Record<string, string>;
    assert.equal(representation.tokenAddress, COINBASE);
    assert.equal(representation.issuerId, 'coinbase');
    assert.equal(representation.representationKind, 'b20_asset');
  });

  test('exact Backed prepares as Backed, with its own kind', async () => {
    stub(MIXED);
    const draft = await miorailPrepareStockActionV1(IDENTITY, argsFor(MIXED, BACKED));
    const representation = draft.representation as Record<string, string>;
    assert.equal(representation.tokenAddress, BACKED);
    assert.equal(representation.issuerId, 'backed');
    assert.equal(representation.issuerId, representationIn(MIXED, BACKED).issuerId);
  });

  test('a stated identity that disagrees with the evidence is refused, not corrected', async () => {
    stub(MIXED);
    // Correcting here would be Miorail choosing a different contract than the
    // one the conversation was about.
    for (const wrong of [
      { issuerId: 'backed' },
      { representationKind: 'rebasing_erc20' },
      { issuerInstrumentKey: 'backed:btoken:0xdead' },
      { routePolicyKey: `0x${'aa'.repeat(32)}` },
    ]) {
      await assert.rejects(
        () => miorailPrepareStockActionV1(IDENTITY, { ...ARGS, ...wrong }),
        refusedWith('stock_action_identity_mismatch'),
        JSON.stringify(wrong),
      );
    }
  });
});

describe('zero supply refuses, and redirects nowhere', () => {
  test('a wrapper with no outstanding supply cannot be prepared', async () => {
    stub(ZERO_SUPPLY);
    await assert.rejects(
      () => miorailPrepareStockActionV1(IDENTITY, argsFor(ZERO_SUPPLY, WRAPPER)),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'zero_supply_representation');
        // Never the wrapper's underlying, never another issuer, never the
        // Coinbase card sitting beside it in the same answer.
        const message = (error as Error).message;
        assert.doesNotMatch(message, new RegExp(COINBASE, 'i'));
        assert.doesNotMatch(message, new RegExp(BACKED, 'i'));
        return true;
      },
    );
  });
});

describe('the assistant learns what is reviewed, never what it costs', () => {
  /**
   * The payload's DATA, without the two prose fields.
   *
   * `nextStep` and `caveats` exist to forbid exactly the things scanned for
   * here, so they name them; scanning them would fail the test for saying "do
   * not state a price". What must be clean is everything the assistant could
   * mistake for a fact.
   */
  const dataOnly = (draft: Record<string, unknown>) => {
    const { nextStep: _nextStep, caveats: _caveats, ...rest } = draft;
    return rest;
  };

  test('the response carries no financial term at all', async () => {
    stub(MIXED);
    const draft = await miorailPrepareStockActionV1(IDENTITY, ARGS);
    const serialised = JSON.stringify(dataOnly(draft));
    for (const forbidden of [
      'cashBack',
      'returnedCash',
      'effectivePrice',
      'referencePrice',
      'premium',
      'discount',
      'quote',
      'best',
      'cheaper',
      'recommend',
    ]) {
      assert.ok(
        !new RegExp(forbidden, 'i').test(serialised),
        `the prepare response carries "${forbidden}"`,
      );
    }
    // Structural, not textual: the payload's shape is the contract. A field
    // that could carry a term cannot be added without this failing, which is
    // stronger than scanning prose for words.
    assert.deepEqual(Object.keys(dataOnly(draft)).sort(), [
      'actionDraftId',
      'createsApproval',
      'createsCalldata',
      'createsTransaction',
      'currentTermsIncluded',
      'expiresAt',
      'question',
      'representation',
      'reviewRequired',
      'reviewUrl',
      'schemaVersion',
    ]);
    assert.deepEqual(Object.keys(draft.representation as object).sort(), [
      'caip10',
      'chainId',
      'issuerId',
      'issuerInstrumentKey',
      'representationKind',
      'tokenAddress',
      'underlyingKey',
    ]);
    // The question is the user's own, and the only size in the payload is the
    // one they asked about.
    assert.deepEqual(Object.keys(draft.question as object).sort(), [
      'destination',
      'direction',
      'requestedCashAtomic',
      'routePolicyKey',
      'sizeBasis',
    ]);
    assert.equal(
      (draft.question as Record<string, string>).requestedCashAtomic,
      ARGS.requestedCashAtomic,
    );
    assert.equal(draft.currentTermsIncluded, false);
    assert.equal(draft.reviewRequired, true);
  });

  test('the response carries nothing executable', async () => {
    stub(MIXED);
    const draft = await miorailPrepareStockActionV1(IDENTITY, ARGS);
    const serialised = JSON.stringify(dataOnly(draft));
    for (const forbidden of [
      'calldata',
      'wallet_sendCalls',
      'sendCalls',
      'rawTransaction',
      'signature',
      '"to"',
      '"data"',
      '"value"',
    ]) {
      assert.ok(!serialised.includes(forbidden), `the prepare response carries ${forbidden}`);
    }
    // The three literals a reader of the payload can check for themselves,
    // rather than trusting a description of it.
    assert.equal(draft.createsApproval, false);
    assert.equal(draft.createsCalldata, false);
    assert.equal(draft.createsTransaction, false);
    // "approval" may appear ONLY as one of those denials.
    const approvals = [...serialised.matchAll(/approval/gi)].length;
    assert.equal(approvals, 1, 'approval is named once, as createsApproval:false');
  });

  test('the review link is the only thing that can carry the reader forward', async () => {
    stub(MIXED);
    const draft = await miorailPrepareStockActionV1(IDENTITY, ARGS);
    assert.match(String(draft.reviewUrl), /^https:\/\/miorail\.xyz\/action\/miorail-stock-action-v1\./);
    assert.ok(typeof draft.expiresAt === 'string');
  });
});

describe('a draft belongs to one wallet', () => {
  test('the tenant comes from the proved identity, never from the arguments', async () => {
    stub(MIXED);
    // There is no argument on this tool that names a wallet; passing one is
    // simply ignored, and the draft still binds to the proved identity.
    const draft = await miorailPrepareStockActionV1(IDENTITY, {
      ...ARGS,
      walletAddress: OTHER_WALLET,
      tenantId: `eip155:8453:${OTHER_WALLET}`,
    } as never);
    const url = String(draft.reviewUrl);
    const encoded = decodeURIComponent(url.split('/action/')[1] ?? '');
    const verified = verifyStockActionDraftV1({ draft: encoded, secret: SECRET, now: NOW });
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.equal(verified.claims.walletAddress, WALLET);
    assert.equal(verified.claims.tenantId, `eip155:8453:${WALLET}`);
  });

  test('another wallet cannot open it', () => {
    const issued = issueStockActionDraftV1({
      tenantId: `eip155:8453:${WALLET}`,
      walletAddress: WALLET,
      secret: SECRET,
      now: NOW,
      handoff: {
        schemaVersion: 'stock-execution-handoff/v1',
        intent: 'inspect_route',
        chainId: 8453,
        tokenAddress: COINBASE,
        caip10: `eip155:8453:${COINBASE}`,
        underlyingKey: UNDERLYING,
        issuerId: 'coinbase',
        issuerInstrumentKey: `coinbase:b20_address:${COINBASE}`,
        representationKind: 'b20_asset',
        direction: 'sell',
        requestedCashAtomic: '1000000000',
        cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        destination: 'USDC',
        routePolicyKey: POLICY,
        approvedSources: ['kyberswap'],
        evidenceState: 'fresh_quote',
        quoteExpiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
        sizeBasis: 'cash_equivalent_requires_replan',
        createsApproval: false,
        createsCalldata: false,
        createsTransaction: false,
        quoteIsExecutionEvidence: false,
      } as never,
    });

    const foreign = verifyStockActionDraftV1({
      draft: issued.draft,
      secret: SECRET,
      now: NOW,
      expectTenantId: `eip155:8453:${OTHER_WALLET}`,
    });
    assert.equal(foreign.ok, false);
    if (foreign.ok) return;
    assert.equal(foreign.reason, 'stock_action_draft_wrong_wallet');

    // And the owner still can.
    const owner = verifyStockActionDraftV1({
      draft: issued.draft,
      secret: SECRET,
      now: NOW,
      expectTenantId: `eip155:8453:${WALLET}`,
    });
    assert.equal(owner.ok, true);
  });

  test('a draft expires, and a forged one never verifies', () => {
    const issued = issueStockActionDraftV1({
      tenantId: `eip155:8453:${WALLET}`,
      walletAddress: WALLET,
      secret: SECRET,
      now: NOW,
      ttlMs: 60_000,
      handoff: {
        schemaVersion: 'stock-execution-handoff/v1',
        intent: 'inspect_route',
        chainId: 8453,
        tokenAddress: COINBASE,
        caip10: `eip155:8453:${COINBASE}`,
        underlyingKey: UNDERLYING,
        issuerId: 'coinbase',
        issuerInstrumentKey: `coinbase:b20_address:${COINBASE}`,
        representationKind: 'b20_asset',
        direction: 'buy',
        requestedCashAtomic: '1000000000',
        cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        destination: 'USDC',
        routePolicyKey: POLICY,
        approvedSources: ['kyberswap'],
        evidenceState: 'no_quote',
        quoteExpiresAt: null,
        sizeBasis: 'exact_cash_in',
        createsApproval: false,
        createsCalldata: false,
        createsTransaction: false,
        quoteIsExecutionEvidence: false,
      } as never,
    });

    const late = verifyStockActionDraftV1({
      draft: issued.draft,
      secret: SECRET,
      now: new Date(NOW.getTime() + 61_000),
    });
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.reason, 'stock_action_draft_expired');

    const wrongKey = verifyStockActionDraftV1({
      draft: issued.draft,
      secret: 'a different secret',
      now: NOW,
    });
    assert.equal(wrongKey.ok, false);
    if (!wrongKey.ok) assert.equal(wrongKey.reason, 'stock_action_draft_bad_signature');

    // And a draft carries no live terms to go stale in the first place.
    const body = issued.draft.split('.')[1] ?? '';
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    for (const forbidden of ['returnedCashAtomic', 'evidenceState', 'quoteExpiresAt', 'price']) {
      assert.ok(!(forbidden in claims), `the draft remembers ${forbidden}`);
    }
  });
});

describe('the existing execution boundary is unchanged', () => {
  test('the private surface still gates the executable action behind the B20 path', async () => {
    const client = new Client({ name: 'probe', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      createMiorailPrivateMcpServerV1(IDENTITY).connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    // The new primitive is added; nothing is removed or renamed.
    assert.deepEqual(names, [
      'miorail_check_exit_profile',
      'miorail_get_base_mcp_action',
      'miorail_get_execution_status',
      'miorail_prepare_b20_entry',
      'miorail_prepare_stock_action',
      'miorail_record_base_mcp_submission',
    ]);

    // And the stock prepare offers no argument that could reach the executable
    // surface: `miorail_get_base_mcp_action` still consumes an entry plan id
    // that only the B20 clearance path can produce.
    const tools = (await client.listTools()).tools;
    const stock = tools.find((tool) => tool.name === 'miorail_prepare_stock_action')!;
    const action = tools.find((tool) => tool.name === 'miorail_get_base_mcp_action')!;
    const stockArgs = Object.keys(
      (stock.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    const actionArgs = Object.keys(
      (action.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    assert.ok(!stockArgs.some((name) => actionArgs.includes(name)));
    await client.close();
  });

  test('the tool description forbids the assistant from quoting terms', async () => {
    const client = new Client({ name: 'probe', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      createMiorailPrivateMcpServerV1(IDENTITY).connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const stock = (await client.listTools()).tools.find(
      (tool) => tool.name === 'miorail_prepare_stock_action',
    )!;
    const description = String(stock.description ?? '');
    assert.match(description, /no price/i);
    assert.match(description, /ticker cannot select/i);
    assert.match(description, /zero outstanding supply refuses/i);
    assert.match(description, /creates nothing executable/i);
    await client.close();
  });
});
