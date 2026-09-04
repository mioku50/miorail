import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
import {
  miorailGetStockBaseMcpActionV1,
  miorailPrepareStockActionV1,
  stockActionRuntime,
} from './tools.js';
import { issueStockActionClearanceV1 } from '../../lib/stockActionClearance.js';
import { createMiorailPrivateMcpServerV1 } from './server.js';
import { mcpAuditRuntime } from './audit.js';
import { InMemoryMcpExecutionAuditRepositoryV1 } from '@mioagent/route-storage';
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
const originalAudit = { ...mcpAuditRuntime };

function stub(reality: unknown, over: Partial<typeof stockActionRuntime> = {}) {
  stockActionRuntime.flags = () => ({ routeIntelligenceV1: true, mcpPrivateExecutionV1: false });
  stockActionRuntime.assembleMarketReality = async () => reality;
  stockActionRuntime.now = () => NOW;
  stockActionRuntime.secret = () => SECRET;
  stockActionRuntime.origin = () => 'https://miorail.xyz';
  Object.assign(stockActionRuntime, over);
}

afterEach(() => {
  Object.assign(stockActionRuntime, original);
  Object.assign(mcpAuditRuntime, originalAudit);
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

/** The read-only B20 tools this surface now shares with the public server. */
const PUBLIC_READ_ONLY_PREFIXES_V1 = [
  'miorail_b20_',
  'miorail_compare_b20_',
  'miorail_discover_',
  'miorail_explain_b20_',
  'miorail_find_b20_',
  'miorail_get_b20_',
  'miorail_list_b20_',
  'miorail_summarise_b20_',
] as const;

describe('the existing execution boundary is unchanged', () => {
  test('the private surface still gates the executable action behind the B20 path', async () => {
    const client = new Client({ name: 'probe', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      createMiorailPrivateMcpServerV1(IDENTITY).connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    // The WALLET-BOUND set, exactly. Since Phase 17.3 this surface also carries
    // the read-only registry — a connected assistant could otherwise prepare a
    // review of a representation it had no way to find — so the assertion is on
    // the tools that can touch a wallet, which is what this boundary is about.
    // Nothing is removed or renamed, and nothing new can execute.
    assert.deepEqual(
      names.filter((name) => name.startsWith('miorail_') && !PUBLIC_READ_ONLY_PREFIXES_V1.some((prefix) => name.startsWith(prefix))),
      [
        'miorail_check_exit_profile',
        'miorail_get_base_mcp_action',
        'miorail_get_execution_status',
        'miorail_get_stock_base_mcp_action',
        'miorail_prepare_b20_entry',
        'miorail_prepare_stock_action',
        'miorail_record_base_mcp_submission',
      ],
    );

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

// ---------------------------------------------------------------------------
// Connected Intelligence 2 — the last mile, and what it refuses.
// ---------------------------------------------------------------------------

describe('a confirmed clearance is the only way to an executable request', () => {
  const CLEARANCE_SECRET = 'stock-clearance-test-secret';
  const handoffFor = (address: string, direction: 'buy' | 'sell') => {
    const representation = representationIn(direction === 'buy' ? MIXED : MIXED, address);
    return {
      schemaVersion: 'stock-execution-handoff/v1',
      intent: 'inspect_route',
      chainId: 8453,
      tokenAddress: address,
      caip10: `eip155:8453:${address}`,
      underlyingKey: UNDERLYING,
      issuerId: representation.issuerId,
      issuerInstrumentKey: representation.issuerInstrumentKey,
      representationKind: representation.representationKind,
      direction,
      requestedCashAtomic: '1000000000',
      cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      destination: 'USDC',
      routePolicyKey: representation.routePolicyKey ?? POLICY,
      approvedSources: ['kyberswap'],
      evidenceState: 'fresh_quote',
      quoteExpiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
      sizeBasis: direction === 'buy' ? 'exact_cash_in' : 'cash_equivalent_requires_replan',
      createsApproval: false,
      createsCalldata: false,
      createsTransaction: false,
      quoteIsExecutionEvidence: false,
    } as never;
  };

  const clearanceFor = (
    address: string = COINBASE,
    direction: 'buy' | 'sell' = 'buy',
    wallet: string = WALLET,
  ) =>
    issueStockActionClearanceV1({
      tenantId: `eip155:8453:${wallet}`,
      walletAddress: wallet,
      actionDraftId: 'draft-1',
      handoff: handoffFor(address, direction),
      secret: CLEARANCE_SECRET,
      now: NOW,
    }).clearance;

  const executionStub = (over: Partial<typeof stockActionRuntime> = {}) => {
    stockActionRuntime.flags = () => ({ routeIntelligenceV1: true, mcpPrivateExecutionV1: true });
    stockActionRuntime.now = () => NOW;
    stockActionRuntime.secret = () => CLEARANCE_SECRET;
    stockActionRuntime.readToken = async () => ({ ok: true, decimals: 18, symbol: 'NVDAc' });
    // The audit row is mandatory: no row, no bytes. Files in this package share
    // a process, so the repository has to be supplied here rather than
    // inherited from whichever neighbour ran last.
    mcpAuditRuntime.available = async () => true;
    mcpAuditRuntime.audit = () => new InMemoryMcpExecutionAuditRepositoryV1();
    mcpAuditRuntime.now = () => NOW;
    stockActionRuntime.planAndPrepare = async () =>
      ({
        outcome: 'prepared',
        routeRunId: 'run-1',
        blueprint: {
          id: 'bp-1',
          blueprintHash: `0x${'cd'.repeat(32)}`,
          chainId: 8453,
          walletAddress: WALLET,
          status: 'ready_for_review',
          // The shape a persisted Blueprint really has. It used to read
          // `value: '0x0'` — the WIRE key — so every test here exercised a call
          // production never produces, and the release path handed the stored
          // record straight to a schema that wanted three different keys.
          // `ExecutionCallV1Schema` requires `valueWei`, and it is decimal.
          calls: [
            {
              index: 0,
              callType: 'swap' as const,
              to: '0x00',
              valueWei: '0',
              data: '0x',
              asset: null,
              amountAtomic: null,
              recipient: null,
              spender: null,
            },
          ],
        },
        review: {},
      }) as never;
    Object.assign(stockActionRuntime, over);
  };

  test('no clearance, no action', async () => {
    executionStub();
    await assert.rejects(
      () => miorailGetStockBaseMcpActionV1(IDENTITY, { clearance: '', requestId: 'r1' }),
      refusedWith('stock_clearance_missing'),
    );
  });

  test('another wallet’s confirmation is refused, not resolved', async () => {
    executionStub();
    await assert.rejects(
      () =>
        miorailGetStockBaseMcpActionV1(IDENTITY, {
          clearance: clearanceFor(COINBASE, 'buy', OTHER_WALLET),
          requestId: 'r1',
        }),
      refusedWith('stock_clearance_wrong_wallet'),
    );
  });

  test('an expired confirmation cannot be spent', async () => {
    executionStub({ now: () => new Date(NOW.getTime() + 60 * 60 * 1000) });
    await assert.rejects(
      () => miorailGetStockBaseMcpActionV1(IDENTITY, { clearance: clearanceFor(), requestId: 'r1' }),
      refusedWith('stock_clearance_expired'),
    );
  });

  test('a confirmed SELL is refused, and the refusal names why', async () => {
    executionStub();
    await assert.rejects(
      () =>
        miorailGetStockBaseMcpActionV1(IDENTITY, {
          clearance: clearanceFor(COINBASE, 'sell'),
          requestId: 'r1',
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'stock_action_sell_requires_exact_size');
        // Not a gap and not a failure: "cash worth" is not a token amount.
        assert.match((error as Error).message, /not a token amount/);
        return true;
      },
    );
  });

  test('decimals are read, never assumed', async () => {
    executionStub({ readToken: async () => ({ ok: false }) });
    await assert.rejects(
      () => miorailGetStockBaseMcpActionV1(IDENTITY, { clearance: clearanceFor(), requestId: 'r1' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'stock_action_token_unreadable');
        assert.match((error as Error).message, /different size entirely/);
        return true;
      },
    );
  });

  test('a market that moved after the confirmation refuses the old request', async () => {
    executionStub({
      planAndPrepare: async () =>
        ({ outcome: 'refresh_required', reason: 'quote_expired', detail: 'moved' }) as never,
    });
    await assert.rejects(
      () => miorailGetStockBaseMcpActionV1(IDENTITY, { clearance: clearanceFor(), requestId: 'r1' }),
      refusedWith('stock_action_refresh_required'),
    );
  });

  test('a Safety Kernel refusal produces nothing executable', async () => {
    // The real shape: `safety`, a SafetyKernelResultV1. The stub said
    // `safetyKernel` and got away with it through `as never` until the refusal
    // path started reading the field.
    executionStub({
      planAndPrepare: async () =>
        ({
          outcome: 'blocked',
          routeRunId: 'run-1',
          safety: {
            schemaVersion: 'safety-kernel-result/v1',
            verdict: 'blocked',
            blockedReason: 'the wallet cannot fund this size',
            checks: [
              { id: 'wallet_balance', description: 'funds the exact size', status: 'failed', detail: null },
              { id: 'router_allowlist', description: 'router is reviewed', status: 'passed', detail: null },
            ],
          },
        }) as never,
    });
    await assert.rejects(
      () => miorailGetStockBaseMcpActionV1(IDENTITY, { clearance: clearanceFor(), requestId: 'r1' }),
      refusedWith('stock_action_blocked'),
    );
  });

  test('a blocked result the logger cannot read still refuses, and never crashes', async () => {
    // Diagnostics must not decide the outcome. A refusal is the safe path, and
    // a logger that throws on an unexpected shape turns it into a 500 — worse
    // than no log at all.
    for (const blocked of [
      { outcome: 'blocked' },
      { outcome: 'blocked', safety: null },
      { outcome: 'blocked', safety: { checks: 'not-an-array' } },
      { outcome: 'blocked', safety: { checks: [null] } },
    ]) {
      executionStub({ planAndPrepare: async () => blocked as never });
      await assert.rejects(
        () =>
          miorailGetStockBaseMcpActionV1(IDENTITY, { clearance: clearanceFor(), requestId: 'r1' }),
        refusedWith('stock_action_blocked'),
        JSON.stringify(blocked),
      );
    }
  });

  test('the exact representation survives to the executable request', async () => {
    executionStub();
    const action = await miorailGetStockBaseMcpActionV1(IDENTITY, {
      clearance: clearanceFor(),
      requestId: 'r1',
    });
    const representation = action.representation as Record<string, string>;
    assert.equal(representation.tokenAddress, COINBASE);
    assert.equal(representation.issuerId, 'coinbase');
    assert.equal(representation.caip10, `eip155:8453:${COINBASE}`);
    // Coinbase stayed Coinbase: the Backed address in the same answer never
    // appears anywhere in the executable response.
    const serialised = JSON.stringify(action);
    assert.ok(!serialised.includes(BACKED));
    assert.ok(!serialised.includes(WRAPPER));
    assert.equal(action.approvalRequired, true);
    assert.equal(action.reviewConfirmed, true);
  });

  test('Backed stays Backed, and never becomes its wrapper', async () => {
    executionStub();
    const action = await miorailGetStockBaseMcpActionV1(IDENTITY, {
      clearance: clearanceFor(BACKED),
      requestId: 'r1',
    });
    const representation = action.representation as Record<string, string>;
    assert.equal(representation.tokenAddress, BACKED);
    assert.equal(representation.issuerId, representationIn(MIXED, BACKED).issuerId);
    const serialised = JSON.stringify(action);
    assert.ok(!serialised.includes(WRAPPER));
    assert.ok(!serialised.includes(COINBASE));
  });

  test('the response states, and never characterises', async () => {
    executionStub();
    const action = await miorailGetStockBaseMcpActionV1(IDENTITY, {
      clearance: clearanceFor(),
      requestId: 'r1',
    });
    const { caveats: _caveats, instructions, ...rest } = action;
    const serialised = JSON.stringify(rest);
    for (const forbidden of [/\bbest\b/i, /\bcheapest\b/i, /\bcheaper\b/i, /recommend/i, /\bgood\b/i]) {
      assert.doesNotMatch(serialised, forbidden, String(forbidden));
    }
    // The instructions may forbid these words, and must.
    assert.match(String(instructions), /Do not describe the terms/);
  });
});

describe('no audit row, no executable bytes', () => {
  test('an unavailable audit refuses the action rather than releasing it', async () => {
    stockActionRuntime.flags = () => ({ routeIntelligenceV1: true, mcpPrivateExecutionV1: true });
    stockActionRuntime.now = () => NOW;
    stockActionRuntime.secret = () => 'audit-test-secret';
    stockActionRuntime.readToken = async () => ({ ok: true, decimals: 18, symbol: 'NVDAc' });
    stockActionRuntime.planAndPrepare = async () =>
      ({
        outcome: 'prepared',
        routeRunId: 'run-1',
        blueprint: {
          id: 'bp-1',
          blueprintHash: `0x${'cd'.repeat(32)}`,
          chainId: 8453,
          walletAddress: WALLET,
          status: 'ready_for_review',
          // The shape a persisted Blueprint really has. It used to read
          // `value: '0x0'` — the WIRE key — so every test here exercised a call
          // production never produces, and the release path handed the stored
          // record straight to a schema that wanted three different keys.
          // `ExecutionCallV1Schema` requires `valueWei`, and it is decimal.
          calls: [
            {
              index: 0,
              callType: 'swap' as const,
              to: '0x00',
              valueWei: '0',
              data: '0x',
              asset: null,
              amountAtomic: null,
              recipient: null,
              spender: null,
            },
          ],
        },
        review: {},
      }) as never;
    // The audit is the record that executable bytes left this server. Without
    // it the honest outcome is a refusal, not a quiet release.
    mcpAuditRuntime.available = async () => false;

    const clearance = issueStockActionClearanceV1({
      tenantId: `eip155:8453:${WALLET}`,
      walletAddress: WALLET,
      actionDraftId: 'draft-1',
      secret: 'audit-test-secret',
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
    }).clearance;

    await assert.rejects(() =>
      miorailGetStockBaseMcpActionV1(IDENTITY, { clearance, requestId: 'r1' }),
    );
  });
});

// ---------------------------------------------------------------------------
// A refusal that records nothing is a refusal nobody can fix.
//
// Production, 2026-09-04: a stock action was blocked, and the only thing on
// file was `failedChecks: ["simulation_evidence"]`. That check has FIVE
// mutually exclusive causes and the id names none of them, so diagnosing it
// took an SSH session, an on-chain balance read and a hand-built batch
// simulation — and still got no further than "one of four".
//
// What may be logged is bounded by a rule that predates this: no `blockedReason`
// and no check `detail`, because a provider message can end up in free text.
// The outcome enum and the simulation error code are unions this codebase
// declares, so they carry no endpoint, key or upstream sentence.
// ---------------------------------------------------------------------------
describe('a blocked stock action records which simulation outcome blocked it', () => {
  // Located the way every other api-server test locates a package file: this
  // package builds to CommonJS, where `import.meta` is not available.
  const cwd = process.cwd();
  const source = readFileSync(
    cwd.endsWith(`${path.sep}artifacts${path.sep}api-server`)
      ? path.join(cwd, 'routes/mcpPrivate/tools.ts')
      : path.join(cwd, 'artifacts/api-server/routes/mcpPrivate/tools.ts'),
    'utf8',
  );

  test('the log carries the outcome, not only the check id', () => {
    const block = /logger\.warn\('Stock action blocked by the Safety Kernel'[\s\S]{0,600}?\}\);/.exec(
      source,
    )?.[0];
    assert.ok(block, 'the blocked path must still log');
    assert.match(block, /failedChecks/);
    assert.match(block, /simulationOutcome/);
    assert.match(block, /simulationErrorCode/);
  });

  test('it still refuses to log free text', () => {
    // Comments stripped FIRST. The block explains at length which fields would
    // leak an endpoint or a key, and matching that explanation fails the rule
    // it states — the same trap the Phase 17.4 label test fell into.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const block = /logger\.warn\('Stock action blocked by the Safety Kernel'[\s\S]{0,400}?\}\);/.exec(
      code,
    )?.[0];
    assert.ok(block, 'the blocked path must still log');
    // The two fields that can carry an upstream sentence.
    assert.doesNotMatch(block, /blockedReason/);
    assert.doesNotMatch(block, /\.detail/);
    // And never an endpoint or a credential.
    assert.doesNotMatch(block, /rpcUrl|endpoint|apiKey|\burl\b/i);
  });
});

// ---------------------------------------------------------------------------
// The tool's own output schema rejected its own success.
//
// A persisted Blueprint call carries Miorail's working fields — index,
// callType, valueWei, asset, amountAtomic, recipient, spender — and this handed
// the record straight out. `send_calls` takes three keys, and the declared
// output contract says so, so a successful release failed output validation on
// a `value` that was never there under that name.
//
// Nobody had seen it because the Safety Kernel blocked every stock action
// before this line could run. Two defects, each hiding the other, and the
// second only appeared the moment the first was fixed.
// ---------------------------------------------------------------------------
describe('released calls are the wire shape, not the stored record', () => {
  const cwd = process.cwd();
  const source = readFileSync(
    cwd.endsWith(`${path.sep}artifacts${path.sep}api-server`)
      ? path.join(cwd, 'routes/mcpPrivate/tools.ts')
      : path.join(cwd, 'artifacts/api-server/routes/mcpPrivate/tools.ts'),
    'utf8',
  );

  test('the blueprint record is never handed out whole', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /calls: prepared\.blueprint\.calls,/);
    assert.match(code, /calls: prepared\.blueprint\.calls\.map/);
  });

  test('value is hex on the wire, as every other submit path writes it', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // The record stores a decimal `valueWei`; `send_calls` takes hex.
    assert.match(code, /value: `0x\$\{BigInt\(call\.valueWei\)\.toString\(16\)\}`/);
  });

  test('the three wire keys and nothing else', () => {
    const block = /calls: prepared\.blueprint\.calls\.map\(\(call\) => \(\{[\s\S]{0,300}?\}\)\)/.exec(
      source,
    )?.[0];
    assert.ok(block, 'the projection must exist');
    for (const forbidden of ['index', 'callType', 'asset', 'amountAtomic', 'recipient', 'spender']) {
      assert.ok(!block.includes(`${forbidden}:`), `${forbidden} is not a wire key`);
    }
    for (const wire of ['to:', 'value:', 'data:']) {
      assert.ok(block.includes(wire), `${wire} is required on the wire`);
    }
  });
});
