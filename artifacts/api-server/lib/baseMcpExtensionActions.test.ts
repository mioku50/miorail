import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';
import type { Request } from 'express';
import { canonicalUsdcForBaseChain } from '@mioagent/security/baseGuards';
import { baseMcpRuntimeSnapshotV1 } from './baseMcpRuntimeSnapshot.js';
import {
  baseMcpExtensionActionRuntime,
  classifyBaseMcpExtensionIntentV1,
  listBaseMcpActionReceiptsV1,
  prepareBaseMcpSendActionV1,
  prepareBaseMcpX402ActionV1,
  reconcileBaseMcpActionV1,
} from './baseMcpExtensionActions.js';
import {
  InMemoryBaseMcpActionReceiptRepositoryV1,
  baseMcpActionStatusTransitionAllowedV1,
} from './baseMcpActionReceipts.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const TX_HASH = `0x${'a'.repeat(64)}` as const;
const USDC = canonicalUsdcForBaseChain(8453).toLowerCase();

const original = { ...baseMcpExtensionActionRuntime };
const originalSendMax = process.env.BASE_MCP_ACTION_SEND_MAX_USDC;
const originalSendMaxEth = process.env.BASE_MCP_ACTION_SEND_MAX_ETH;
const originalX402Max = process.env.BASE_MCP_ACTION_X402_MAX_USDC;
const originalX402Hosts = process.env.BASE_MCP_ACTION_X402_ALLOWED_HOSTS;
const originalX402Ttl = process.env.BASE_MCP_ACTION_X402_TTL_SECONDS;

afterEach(() => {
  Object.assign(baseMcpExtensionActionRuntime, original);
  if (originalSendMax === undefined) delete process.env.BASE_MCP_ACTION_SEND_MAX_USDC;
  else process.env.BASE_MCP_ACTION_SEND_MAX_USDC = originalSendMax;
  if (originalSendMaxEth === undefined) delete process.env.BASE_MCP_ACTION_SEND_MAX_ETH;
  else process.env.BASE_MCP_ACTION_SEND_MAX_ETH = originalSendMaxEth;
  if (originalX402Max === undefined) delete process.env.BASE_MCP_ACTION_X402_MAX_USDC;
  else process.env.BASE_MCP_ACTION_X402_MAX_USDC = originalX402Max;
  if (originalX402Hosts === undefined) delete process.env.BASE_MCP_ACTION_X402_ALLOWED_HOSTS;
  else process.env.BASE_MCP_ACTION_X402_ALLOWED_HOSTS = originalX402Hosts;
  if (originalX402Ttl === undefined) delete process.env.BASE_MCP_ACTION_X402_TTL_SECONDS;
  else process.env.BASE_MCP_ACTION_X402_TTL_SECONDS = originalX402Ttl;
});

function topicAddress(address: string): `0x${string}` {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function fakeTools(options: {
  initial?: unknown;
  status?: unknown;
  onSend?: () => void;
}) {
  return {
    async listProviderTools() {
      return [{
        providerId: 'base-mcp-dynamic',
        tools: [
          { name: 'send', description: 'send', inputSchema: { type: 'object', properties: {} } },
          { name: 'get_request_status', description: 'status', inputSchema: { type: 'object', properties: { requestId: {} } } },
        ],
      }];
    },
    async callTool(name: string) {
      if (name === 'send') {
        options.onSend?.();
        return { content: JSON.stringify(options.initial ?? {}), isError: false };
      }
      return { content: JSON.stringify(options.status ?? {}), isError: false };
    },
    async close() {},
  } as any;
}

function installHappyRuntime(tools: any, repository = new InMemoryBaseMcpActionReceiptRepositoryV1()) {
  baseMcpExtensionActionRuntime.repository = repository;
  baseMcpExtensionActionRuntime.createTools = async () => tools;
  baseMcpExtensionActionRuntime.verifyWallet = async () => ({ checked: true, match: true, mcpAddresses: [WALLET] });
  baseMcpExtensionActionRuntime.loadTokenSecurityContext = async () => ({
    required: true,
    providerContext: { risk: 'connected', riskProvider: 'goplus', securityProvider: 'goplus' },
    tokenSecurity: [{ address: USDC, provider: 'goplus', status: 'ok', summary: 'canonical USDC', rawRiskLabels: [] }],
  });
  baseMcpExtensionActionRuntime.screenAction = () => ({ allowed: true });
  baseMcpExtensionActionRuntime.now = () => '2026-08-12T12:00:00.000Z';
  return repository;
}

function fakeX402Tools(options: { initial: unknown; status: unknown; completed: unknown; onInitiate?: () => void }) {
  return {
    async listProviderTools() {
      return [{
        providerId: 'base-mcp-dynamic',
        tools: [
          { name: 'initiate_x402_request', inputSchema: { type: 'object', properties: { url: {}, method: {}, maxPayment: {} } } },
          { name: 'get_request_status', inputSchema: { type: 'object', properties: { requestId: {} } } },
          { name: 'complete_x402_request', inputSchema: { type: 'object', properties: { requestId: {} } } },
        ],
      }];
    },
    async callTool(name: string) {
      if (name === 'initiate_x402_request') {
        options.onInitiate?.();
        return { content: JSON.stringify(options.initial), isError: false };
      }
      if (name === 'complete_x402_request') return { content: JSON.stringify(options.completed), isError: false };
      return { content: JSON.stringify(options.status), isError: false };
    },
    async close() {},
  } as any;
}

function prepareX402Input(requestId = 'x402-1') {
  const message = 'Pay x402 GET https://api.venice.ai/api/v1/models, max 0.10 USDC';
  const decision = classifyBaseMcpExtensionIntentV1(message);
  assert.equal(decision.kind, 'x402');
  return {
    req: {} as Request,
    userId: 'tenant-1',
    walletAddress: WALLET,
    sessionSecret: 'secret',
    idempotencyKey: requestId,
    message,
    intent: decision.intent,
  };
}

function prepareInput(requestId = 'request-1') {
  const decision = classifyBaseMcpExtensionIntentV1(`Send 5 USDC to ${RECIPIENT}`);
  assert.equal(decision.kind, 'send');
  return {
    req: {} as Request,
    userId: 'tenant-1',
    walletAddress: WALLET,
    sessionSecret: 'secret',
    idempotencyKey: requestId,
    message: `Send 5 USDC to ${RECIPIENT}`,
    intent: decision.intent,
  };
}

describe('deterministic Base MCP Extensions intent router', () => {
  test('generic swap/yield hand off, while an unreleased named provider stays out of Routes', () => {
    assert.equal(classifyBaseMcpExtensionIntentV1('Swap 100 USDC to ETH').kind, 'handoff');
    assert.equal(classifyBaseMcpExtensionIntentV1('Find the best yield for USDC').kind, 'handoff');
    const launch = classifyBaseMcpExtensionIntentV1('Launch a memecoin on Flaunch');
    assert.equal(launch.kind, 'needs_input');
    if (launch.kind === 'needs_input') assert.equal(launch.errorCode, 'base_mcp_flaunch_action_adapter_required');
  });

  test('a buy or a sell is a trade and goes to Swap AI', () => {
    const token = '0x1111111111111111111111111111111111111111';
    for (const message of [
      'Buy BRETT with 50 USDC',
      'Sell 10 DEGEN',
      `Buy ${token} with 0.001 ETH`,
      `Купи ${token} на 5 USDC`,
      'Продай 100 DEGEN за USDC',
    ]) {
      const decision = classifyBaseMcpExtensionIntentV1(message);
      assert.equal(decision.kind, 'handoff', message);
      if (decision.kind === 'handoff') assert.equal(decision.provider, null, message);
    }
  });

  test('a question about a trade stays a read', () => {
    for (const message of [
      'What did I buy last week?',
      'When did I sell 10 DEGEN?',
      'Should I buy 100 DEGEN?',
      'Сколько я купил 0x1111111111111111111111111111111111111111?',
      'Did I buy anything?',
    ]) {
      assert.equal(classifyBaseMcpExtensionIntentV1(message).kind, 'read', message);
    }
  });

  test('a launchpad token is named by its address, never picked by Miorail', () => {
    const unnamed = classifyBaseMcpExtensionIntentV1('Buy this Flaunch token with 0.001 ETH');
    assert.equal(unnamed.kind, 'needs_input');
    if (unnamed.kind === 'needs_input') {
      assert.equal(unnamed.errorCode, 'base_mcp_token_address_required');
      assert.match(unnamed.reply, /Show the newest Flaunch coins on Base/);
    }
    const bankr = classifyBaseMcpExtensionIntentV1('Buy this Bankr token with 0.001 ETH');
    assert.equal(bankr.kind, 'needs_input');
    if (bankr.kind === 'needs_input') assert.match(bankr.reply, /Show the latest Bankr launches on Base/);

    const named = classifyBaseMcpExtensionIntentV1('Buy 0x2222222222222222222222222222222222222222 with 0.001 ETH on Flaunch');
    assert.equal(named.kind, 'handoff');
    if (named.kind === 'handoff') assert.equal(named.provider, 'flaunch');
  });

  test('without the operator\'s GMGN key a quote is paused, before any token is asked for', () => {
    const previous = process.env.GMGN_API_KEY;
    delete process.env.GMGN_API_KEY;
    try {
      const paused = classifyBaseMcpExtensionIntentV1('Get a GMGN quote to swap 10 USDC for this Base token');
      assert.equal(paused.kind, 'needs_input');
      if (paused.kind === 'needs_input') {
        assert.equal(paused.errorCode, 'base_mcp_gmgn_quotes_paused');
        assert.match(paused.reply, /GMGN quotes are paused/);
        assert.doesNotMatch(paused.reply, /Review screen/);
      }
    } finally {
      if (previous === undefined) delete process.env.GMGN_API_KEY; else process.env.GMGN_API_KEY = previous;
    }
  });

  test('a GMGN quote asks for the missing token and preserves a supplied pair', (t) => {
    const previous = process.env.GMGN_API_KEY;
    process.env.GMGN_API_KEY = 'gmgn-operator-fixture';
    t.after(() => { if (previous === undefined) delete process.env.GMGN_API_KEY; else process.env.GMGN_API_KEY = previous; });
    const unnamed = classifyBaseMcpExtensionIntentV1('Get a GMGN quote to swap 10 USDC for this Base token');
    assert.equal(unnamed.kind, 'needs_input');
    if (unnamed.kind === 'needs_input') {
      assert.equal(unnamed.errorCode, 'base_mcp_token_address_required');
      assert.match(unnamed.reply, /Get a GMGN quote/);
      assert.match(unnamed.reply, /Show trending Base tokens on GMGN/);
    }
    const message = `Get a GMGN quote to swap 10 USDC for ${RECIPIENT}`;
    const named = classifyBaseMcpExtensionIntentV1(message);
    assert.deepEqual(named, { kind: 'handoff', originalMessage: message, provider: 'gmgn' });
    assert.equal(classifyBaseMcpExtensionIntentV1('Buy WETH with 10 USDC on GMGN').kind, 'needs_input');
  });

  test('provider-native reads remain in Extensions and a released Aerodrome swap hands off', () => {
    const balancer = classifyBaseMcpExtensionIntentV1('Show the best Balancer pool for ETH yield on Base');
    assert.equal(balancer.kind, 'read');
    if (balancer.kind === 'read') assert.equal(balancer.providerId, 'balancer');

    const bitrefill = classifyBaseMcpExtensionIntentV1('Find a 20 USD Steam US gift card on Bitrefill');
    assert.equal(bitrefill.kind, 'read');
    if (bitrefill.kind === 'read') assert.equal(bitrefill.providerId, 'bitrefill');

    // Aerodrome's calldata is written by this server, so the handoff depends on
    // a simulator being able to execute it. The runtime is stated rather than
    // read from the machine running the suite.
    const aerodrome = classifyBaseMcpExtensionIntentV1('Swap 0.001 ETH to USDC on Aerodrome', {
      ...baseMcpRuntimeSnapshotV1({}),
      singleCallSimulationAvailable: true,
      batchSimulationAvailable: true,
    });
    assert.equal(aerodrome.kind, 'handoff');
    if (aerodrome.kind === 'handoff') assert.equal(aerodrome.provider, 'aerodrome');
  });

  test('a swap this runtime cannot sign is refused here, not in Swap AI', () => {
    // The production dead end: the console offered ROUTES AI, the user walked
    // five screens, and the Safety Kernel refused for want of a simulation
    // nobody could run. The refusal now arrives at the first screen, with the
    // reason attached.
    const decision = classifyBaseMcpExtensionIntentV1('Swap 100 USDC for WETH on Base through Balancer', {
      ...baseMcpRuntimeSnapshotV1({}),
      singleCallSimulationAvailable: false,
      batchSimulationAvailable: false,
    });
    assert.equal(decision.kind, 'needs_input');
    if (decision.kind === 'needs_input') {
      assert.equal(decision.errorCode, 'base_mcp_balancer_route_unavailable');
      assert.match(decision.reply, /simulation/i);
      // It must not read as "nobody built this" — the adapter exists.
      assert.doesNotMatch(decision.reply, /no typed action adapter/i);
      assert.match(decision.reply, /without naming a provider/i);
    }
  });

  test('only an exact reviewed Virtuals create prompt enters its typed action vertical', () => {
    const create = classifyBaseMcpExtensionIntentV1(
      'Create a Virtuals agent called Mio Researcher to summarize Base research',
    );
    assert.equal(create.kind, 'virtuals_create');
    if (create.kind === 'virtuals_create') {
      assert.equal(create.intent.agentName, 'Mio Researcher');
      assert.equal(create.intent.agentDescription, 'summarize Base research');
    }
    const incomplete = classifyBaseMcpExtensionIntentV1('Create a Virtuals agent');
    assert.equal(incomplete.kind, 'needs_input');
  });

  test('an exact USDC send is normalized to atomic facts', () => {
    const decision = classifyBaseMcpExtensionIntentV1(`Переведи 5,250000 USDC на ${RECIPIENT}`);
    assert.equal(decision.kind, 'send');
    assert.equal(decision.intent.amount, '5.25');
    assert.equal(decision.intent.amountAtomic, '5250000');
    assert.equal(decision.intent.recipient, RECIPIENT);
  });

  test('Base names enter deterministic resolution while unsupported writes need input', () => {
    const named = classifyBaseMcpExtensionIntentV1('Send 5 USDC to alice.base.eth');
    assert.equal(named.kind, 'send_name');
    assert.equal(named.intent.recipientName, 'alice.base.eth');
    const ether = classifyBaseMcpExtensionIntentV1('Send 5 ETH to alice.base.eth');
    assert.equal(ether.kind, 'send_name');
    assert.deepEqual(ether.intent.asset, { symbol: 'ETH', address: null, decimals: 18 });
    const unsupported = classifyBaseMcpExtensionIntentV1('Send 5 DEGEN to alice.base.eth');
    assert.equal(unsupported.kind, 'needs_input');
    assert.equal(classifyBaseMcpExtensionIntentV1('Sign this EIP-712 message').kind, 'needs_input');
  });

  test('an ETH send is read in 18 decimals, in English or Russian', () => {
    const english = classifyBaseMcpExtensionIntentV1(`send 0.0001 ETH to ${RECIPIENT}`);
    assert.equal(english.kind, 'send');
    assert.deepEqual(english.intent.asset, { symbol: 'ETH', address: null, decimals: 18 });
    assert.equal(english.intent.amount, '0.0001');
    assert.equal(english.intent.amountAtomic, '100000000000000');
    assert.equal(english.note, null);
    const russian = classifyBaseMcpExtensionIntentV1(`Отправь 0,000000000000000001 eth на ${RECIPIENT}`);
    assert.equal(russian.kind, 'send');
    assert.equal(russian.intent.amountAtomic, '1');
    // The amount may touch its symbol.
    const joined = classifyBaseMcpExtensionIntentV1(`Send 0.5ETH to ${RECIPIENT}`);
    assert.equal(joined.kind, 'send');
    assert.equal(joined.intent.amountAtomic, '500000000000000000');
  });

  test('"Sent" as the whole command is a send, said so; a sentence about something sent stays a question', () => {
    // 2026-10-19 on prod: «Sent 0.0001 eth to 0x…» reached the read model,
    // which spent its eight tool calls looking for a past transfer.
    const typo = classifyBaseMcpExtensionIntentV1(`Sent 0.0001 eth to ${RECIPIENT}`);
    assert.equal(typo.kind, 'send');
    assert.equal(typo.intent.amountAtomic, '100000000000000');
    assert.equal(typo.note, 'Read “Sent” as “Send”.');
    for (const question of [
      `I sent 0.0001 ETH to ${RECIPIENT} yesterday`,
      `Sent 0.0001 ETH to ${RECIPIENT} — did it arrive?`,
      'Was my USDC sent?',
      'Show my last transfer',
      'How do I send ETH?',
      'Как отправить USDC?',
    ]) {
      assert.equal(classifyBaseMcpExtensionIntentV1(question).kind, 'read', question);
    }
  });

  test('a send missing its facts, in an asset not sent here, or in too many decimals says what works', () => {
    const needsInput = (message: string) => {
      const decision = classifyBaseMcpExtensionIntentV1(message);
      assert.equal(decision.kind, 'needs_input', message);
      return decision;
    };
    const missing = needsInput('Send ETH');
    assert.equal(missing.errorCode, 'base_mcp_send_exact_input_required');
    assert.match(missing.reply, /Send 0\.001 ETH to 0x…/);
    assert.doesNotMatch(missing.reply, /V1|vertical|released/);
    const other = needsInput(`Send 5 DAI to ${RECIPIENT}`);
    assert.equal(other.errorCode, 'base_mcp_send_asset_unsupported');
    assert.match(other.reply, /does not send DAI yet: it sends ETH and USDC on Base/);
    // WETH is a token, not the chain's own ETH.
    assert.equal(needsInput(`Send 1 WETH to ${RECIPIENT}`).errorCode, 'base_mcp_send_asset_unsupported');
    assert.match(needsInput(`Отправь 5 DAI на ${RECIPIENT}`).reply, /эта консоль пока не делает/);
    const precise = needsInput(`Send 1.1234567 USDC to ${RECIPIENT}`);
    assert.equal(precise.errorCode, 'base_mcp_send_amount_invalid');
    assert.match(precise.reply, /at most 6 decimal places for USDC/);
    assert.equal(needsInput(`Send 0 ETH to ${RECIPIENT}`).errorCode, 'base_mcp_send_amount_invalid');
  });

  test('reviewed x402 GET is normalized and Avantis writes become a provider handoff', () => {
    const x402 = classifyBaseMcpExtensionIntentV1('Pay x402 GET https://api.venice.ai/api/v1/models, max 0.10 USDC');
    assert.equal(x402.kind, 'x402');
    assert.equal(x402.intent.maxPaymentAtomic, '100000');
    const perps = classifyBaseMcpExtensionIntentV1('Open a 10x long BTC/USD with 100 USDC on Avantis');
    assert.equal(perps.kind, 'provider_handoff');
    assert.equal(perps.handoff.path, 'https://www.avantisfi.com/trade?asset=BTC-USD');
    const ambiguous = classifyBaseMcpExtensionIntentV1('Open a long on Avantis');
    assert.equal(ambiguous.kind, 'needs_input');
    assert.equal(ambiguous.errorCode, 'base_mcp_avantis_market_required');
  });
});

test('x402 initiation returns approval and completion stores only a response hash', async () => {
  const tools = fakeX402Tools({
    initial: {
      approvalUrl: 'https://keys.coinbase.com/approve/x402-1',
      requestId: 'provider-x402-1',
      status: 'approval_required',
    },
    // Production Base MCP nests the post-approval state in MCP text and calls
    // it `signed`; that state must unlock complete_x402_request.
    status: {
      content: [{
        type: 'text',
        text: JSON.stringify({ requestId: 'provider-x402-1', status: 'signed', signature: '[redacted]' }),
      }],
    },
    completed: { status: 200, body: { result: 'paid intelligence', authorization: 'Bearer secret' } },
  });
  const repository = installHappyRuntime(tools);
  const prepared = await prepareBaseMcpX402ActionV1(prepareX402Input());
  assert.equal(prepared.receipt?.actionType, 'x402');
  assert.equal(prepared.receipt?.status, 'approval_required');
  assert.equal(prepared.approvalUrl, 'https://keys.coinbase.com/approve/x402-1');

  const reconciled = await reconcileBaseMcpActionV1({
    req: {} as Request,
    userId: 'tenant-1',
    walletAddress: WALLET,
    sessionSecret: 'secret',
    receiptId: prepared.receipt!.id,
  });
  assert.equal(reconciled.receipt?.status, 'completed');
  assert.equal(reconciled.receipt?.reconciliationState, 'provider_confirmed');
  if (reconciled.receipt?.actionType === 'x402') assert.match(reconciled.receipt.responseHash || '', /^0x[0-9a-f]{64}$/);
  assert.doesNotMatch(reconciled.resultPreview || '', /Bearer secret/);
  const stored = (await repository.list('tenant-1'))[0];
  assert.equal(stored.responseHash, reconciled.receipt?.actionType === 'x402' ? reconciled.receipt.responseHash : null);
  assert.doesNotMatch(JSON.stringify(stored), /paid intelligence|Bearer secret/);
});

test('stale x402 approvals are finalized instead of remaining pending forever', async () => {
  process.env.BASE_MCP_ACTION_X402_TTL_SECONDS = '60';
  const repository = new InMemoryBaseMcpActionReceiptRepositoryV1();
  installHappyRuntime(fakeX402Tools({ initial: {}, status: {}, completed: {} }), repository);
  const input = prepareX402Input('stale-x402');
  const created = await repository.create({
    tenantId: input.userId,
    walletAddress: WALLET,
    idempotencyKey: input.idempotencyKey!,
    actionType: 'x402',
    intent: input.intent,
    now: '2026-08-12T10:00:00.000Z',
  });
  await repository.update({
    id: created.receipt.id,
    tenantId: input.userId,
    status: 'approval_required',
    reconciliationState: 'not_started',
    providerRequestId: 'provider-stale-x402',
    now: '2026-08-12T10:00:01.000Z',
  });
  baseMcpExtensionActionRuntime.now = () => '2026-08-12T12:00:00.000Z';

  const listed = await listBaseMcpActionReceiptsV1(input.userId);

  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.status, 'failed');
  assert.equal(listed[0]?.reconciliationState, 'unavailable');
  assert.equal(listed[0]?.errorCode, 'base_mcp_x402_expired');
  const stored = await repository.get(created.receipt.id, input.userId);
  assert.equal(stored?.finalizedAt, '2026-08-12T12:00:00.000Z');
});

test('x402 refuses an unapproved host and an over-cap payment before tools or storage', async () => {
  let toolsCreated = false;
  const repository = installHappyRuntime(fakeX402Tools({ initial: {}, status: {}, completed: {} }));
  baseMcpExtensionActionRuntime.createTools = async () => {
    toolsCreated = true;
    return fakeX402Tools({ initial: {}, status: {}, completed: {} });
  };
  const badHost = prepareX402Input('bad-host');
  badHost.intent.url = 'https://evil.example/paid';
  const refusedHost = await prepareBaseMcpX402ActionV1(badHost);
  assert.equal(refusedHost.errorCode, 'base_mcp_x402_host_not_approved');

  process.env.BASE_MCP_ACTION_X402_MAX_USDC = '0.05';
  const refusedCap = await prepareBaseMcpX402ActionV1(prepareX402Input('bad-cap'));
  assert.equal(refusedCap.errorCode, 'base_mcp_x402_capability_limit_exceeded');
  assert.equal(toolsCreated, false);
  assert.equal((await repository.list('tenant-1')).length, 0);
});

test('x402 refuses credential-like query parameters before persistence', async () => {
  let toolsCreated = false;
  const repository = installHappyRuntime(fakeX402Tools({ initial: {}, status: {}, completed: {} }));
  baseMcpExtensionActionRuntime.createTools = async () => {
    toolsCreated = true;
    return fakeX402Tools({ initial: {}, status: {}, completed: {} });
  };
  const input = prepareX402Input('secret-url');
  input.intent.url = 'https://api.venice.ai/api/v1/models?api_key=must-not-persist';
  const result = await prepareBaseMcpX402ActionV1(input);
  assert.equal(result.errorCode, 'base_mcp_x402_url_contains_secret');
  assert.equal(toolsCreated, false);
  assert.equal((await repository.list('tenant-1')).length, 0);
});

test('send preparation stores an Action Receipt and returns an ephemeral approval URL', async () => {
  const approvalUrl = 'https://keys.coinbase.com/approve/request-1';
  const tools = fakeTools({
    initial: { approvalUrl, requestId: 'provider-request-1', status: 'approval_required' },
  });
  const repository = installHappyRuntime(tools);

  const result = await prepareBaseMcpSendActionV1(prepareInput());
  assert.equal(result.kind, 'action');
  assert.equal(result.approvalUrl, approvalUrl);
  assert.equal(result.receipt?.status, 'approval_required');
  assert.equal(result.receipt?.routeVerified, false);
  assert.equal(result.receipt?.actionType, 'send');
  if (result.receipt?.actionType === 'send') assert.equal(result.receipt.amount, '5');
  const stored = await repository.list('tenant-1');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].providerRequestId, 'provider-request-1');
  assert.doesNotMatch(JSON.stringify(stored[0]), /keys\.coinbase\.com/);
});

test('replaying the same request ID never calls Base MCP send twice', async () => {
  let calls = 0;
  const tools = fakeTools({
    initial: { approvalUrl: 'https://keys.coinbase.com/approve/1', requestId: 'provider-1' },
    onSend: () => { calls += 1; },
  });
  installHappyRuntime(tools);
  const input = prepareInput('same-request');

  const first = await prepareBaseMcpSendActionV1(input);
  const second = await prepareBaseMcpSendActionV1(input);
  assert.equal(calls, 1);
  assert.equal(second.receipt?.id, first.receipt?.id);
  assert.equal(second.approvalUrl, null, 'approval URLs are never recovered from durable storage');
});

test('Action Receipt state is monotonic when status checks race', async () => {
  assert.equal(baseMcpActionStatusTransitionAllowedV1('reconciling', 'pending'), false);
  assert.equal(baseMcpActionStatusTransitionAllowedV1('completed', 'reconciling'), false);
  assert.equal(baseMcpActionStatusTransitionAllowedV1('approval_required', 'pending'), true);

  const repository = new InMemoryBaseMcpActionReceiptRepositoryV1();
  const input = prepareInput('monotonic-request');
  const created = await repository.create({
    tenantId: input.userId,
    walletAddress: WALLET,
    idempotencyKey: input.idempotencyKey!,
    actionType: 'send',
    intent: input.intent,
    now: '2026-08-12T12:00:00.000Z',
  });
  await repository.update({
    id: created.receipt.id,
    tenantId: input.userId,
    status: 'completed',
    reconciliationState: 'matched',
    now: '2026-08-12T12:01:00.000Z',
  });
  const stale = await repository.update({
    id: created.receipt.id,
    tenantId: input.userId,
    status: 'pending',
    reconciliationState: 'pending',
    now: '2026-08-12T12:00:30.000Z',
  });
  assert.equal(stale?.status, 'completed');
  assert.equal(stale?.reconciliationState, 'matched');
  assert.equal(stale?.updatedAt, '2026-08-12T12:01:00.000Z');
});

test('reusing a request ID for different action facts is a conflict and never calls a second tool', async () => {
  let calls = 0;
  const tools = fakeTools({
    initial: { approvalUrl: 'https://keys.coinbase.com/approve/1', requestId: 'provider-1' },
    onSend: () => { calls += 1; },
  });
  installHappyRuntime(tools);
  await prepareBaseMcpSendActionV1(prepareInput('conflict-request'));
  const changed = prepareInput('conflict-request');
  changed.intent.amount = '6';
  changed.intent.amountAtomic = '6000000';
  const result = await prepareBaseMcpSendActionV1(changed);
  assert.equal(result.kind, 'failed');
  assert.equal(result.errorCode, 'base_mcp_action_idempotency_conflict');
  assert.equal(calls, 1);
});

test('completion becomes completed only after exact USDC Transfer reconciliation', async () => {
  const tools = fakeTools({
    initial: { approvalUrl: 'https://keys.coinbase.com/approve/1', requestId: 'provider-1' },
    status: { status: 'completed', requestId: 'provider-1', txHash: TX_HASH },
  });
  installHappyRuntime(tools);
  baseMcpExtensionActionRuntime.createReceiptReader = () => ({
    async getTransaction() { return null; },
    async getTransactionReceipt() {
      return {
        transactionHash: TX_HASH,
        status: 'success' as const,
        blockNumber: 12_345n,
        gasUsed: 50_000n,
        effectiveGasPriceWei: 1n,
        logs: [{
          address: USDC as `0x${string}`,
          topics: [
            '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            topicAddress(WALLET),
            topicAddress(RECIPIENT),
          ],
          data: `0x${(5_000_000n).toString(16).padStart(64, '0')}` as `0x${string}`,
        }],
      };
    },
  });

  const prepared = await prepareBaseMcpSendActionV1(prepareInput());
  const reconciled = await reconcileBaseMcpActionV1({
    req: {} as Request,
    userId: 'tenant-1',
    walletAddress: WALLET,
    sessionSecret: 'secret',
    receiptId: prepared.receipt!.id,
  });
  assert.equal(reconciled.receipt?.status, 'completed');
  assert.equal(reconciled.receipt?.reconciliationState, 'matched');
  assert.equal(reconciled.receipt?.transactionHash, TX_HASH);
  assert.equal(reconciled.receipt?.blockNumber, '12345');
});

test('a successful receipt with different transfer facts fails reconciliation', async () => {
  const tools = fakeTools({
    initial: { approvalUrl: 'https://keys.coinbase.com/approve/1', requestId: 'provider-1' },
    status: { status: 'completed', requestId: 'provider-1', txHash: TX_HASH },
  });
  installHappyRuntime(tools);
  baseMcpExtensionActionRuntime.createReceiptReader = () => ({
    async getTransaction() { return null; },
    async getTransactionReceipt() {
      return {
        transactionHash: TX_HASH,
        status: 'success' as const,
        blockNumber: 100n,
        gasUsed: 1n,
        effectiveGasPriceWei: 1n,
        logs: [],
      };
    },
  });
  const prepared = await prepareBaseMcpSendActionV1(prepareInput());
  const reconciled = await reconcileBaseMcpActionV1({
    req: {} as Request,
    userId: 'tenant-1',
    walletAddress: WALLET,
    sessionSecret: 'secret',
    receiptId: prepared.receipt!.id,
  });
  assert.equal(reconciled.receipt?.status, 'failed');
  assert.equal(reconciled.receipt?.reconciliationState, 'mismatched');
  assert.equal(reconciled.receipt?.errorCode, 'base_mcp_transfer_facts_mismatch');
});

test('an approval URL without a durable request ID is withheld and finalized failed', async () => {
  const tools = fakeTools({ initial: { approvalUrl: 'https://keys.coinbase.com/approve/missing-id' } });
  installHappyRuntime(tools);
  const result = await prepareBaseMcpSendActionV1(prepareInput());
  assert.equal(result.kind, 'failed');
  assert.equal(result.approvalUrl, null);
  assert.equal(result.receipt?.status, 'failed');
  assert.equal(result.receipt?.errorCode, 'base_mcp_request_id_missing');
});

test('capability policy refuses a transfer above the server amount ceiling before storage or tools', async () => {
  process.env.BASE_MCP_ACTION_SEND_MAX_USDC = '4.99';
  let toolsCreated = false;
  const repository = new InMemoryBaseMcpActionReceiptRepositoryV1();
  installHappyRuntime(fakeTools({}), repository);
  baseMcpExtensionActionRuntime.createTools = async () => {
    toolsCreated = true;
    return fakeTools({});
  };
  const result = await prepareBaseMcpSendActionV1(prepareInput());
  assert.equal(result.errorCode, 'base_mcp_send_capability_limit_exceeded');
  assert.equal(result.receipt, null);
  assert.equal(toolsCreated, false);
  assert.equal((await repository.list('tenant-1')).length, 0);
});

test('Virtuals sign-in is an exact separate action, without smuggled agent creation', () => {
  for (const message of ['Sign in to Virtuals', 'Log me into Virtuals', 'Войди в Virtuals']) {
    const result = classifyBaseMcpExtensionIntentV1(message); assert.equal(result.kind, 'virtuals_sign_in');
    if (result.kind === 'virtuals_sign_in') assert.deepEqual(result.intent, { operation: 'sign_in' });
  }
  assert.notEqual(classifyBaseMcpExtensionIntentV1('Sign in to Virtuals and create a card').kind, 'virtuals_sign_in');
});

function fakeNativeTools(options: { initial?: unknown; status?: unknown; isError?: boolean; onSend?: () => void }) {
  return {
    async listProviderTools() {
      return [
        { providerId: 'base-mcp-prepared-claim', tools: [{ name: 'prepared_native_send', description: 'send', inputSchema: { type: 'object', properties: {} } }] },
        { providerId: 'base-mcp-dynamic', tools: [{ name: 'get_request_status', description: 'status', inputSchema: { type: 'object', properties: { requestId: {} } } }] },
      ];
    },
    async callTool(name: string) {
      if (name === 'prepared_native_send') {
        options.onSend?.();
        return { content: JSON.stringify(options.initial ?? {}), isError: options.isError ?? false };
      }
      return { content: JSON.stringify(options.status ?? {}), isError: false };
    },
    async close() {},
  } as any;
}

function prepareNativeInput(requestId = 'eth-request-1') {
  const message = `Send 0.0001 ETH to ${RECIPIENT}`;
  const decision = classifyBaseMcpExtensionIntentV1(message);
  assert.equal(decision.kind, 'send');
  return { req: {} as Request, userId: 'tenant-1', walletAddress: WALLET, sessionSecret: 'secret', idempotencyKey: requestId, message, intent: decision.intent };
}

describe('an ETH send', () => {
  test('binds one exact call to the wallet connection and never asks a token check about ETH', async () => {
    const approvalUrl = 'https://keys.coinbase.com/approve/eth-1';
    const repository = installHappyRuntime(fakeNativeTools({ initial: { approvalUrl, requestId: 'provider-eth-1', status: 'approval_required' } }));
    let bound: unknown;
    baseMcpExtensionActionRuntime.createTools = async (_req, _user, _secret, options) => {
      bound = options?.baseMcpPreparedClaim;
      return fakeNativeTools({ initial: { approvalUrl, requestId: 'provider-eth-1', status: 'approval_required' } });
    };
    baseMcpExtensionActionRuntime.loadTokenSecurityContext = async () => assert.fail('ETH has no contract to check');

    const result = await prepareBaseMcpSendActionV1(prepareNativeInput());
    assert.equal(result.kind, 'action');
    assert.equal(result.approvalUrl, approvalUrl);
    assert.equal(result.reply, 'Base MCP prepared 0.0001 ETH. Review and approve the exact transfer in Base Account.');
    assert.deepEqual(bound, {
      actionType: 'native_send',
      walletAddress: WALLET,
      calls: [{ to: RECIPIENT, value: '100000000000000', data: '0x' }],
    });
    assert.equal(result.receipt?.actionType, 'send');
    if (result.receipt?.actionType === 'send') {
      assert.deepEqual(result.receipt.asset, { symbol: 'ETH', address: null, decimals: 18 });
      assert.equal(result.receipt.amount, '0.0001');
      assert.equal(result.receipt.reconciliationBasis, 'native_value_call');
    }
    const stored = await repository.list('tenant-1');
    assert.equal(stored[0].providerRequestId, 'provider-eth-1');
  });

  test('is confirmed only by the chain, from the transfer itself', async () => {
    const tools = fakeNativeTools({
      initial: { approvalUrl: 'https://keys.coinbase.com/approve/eth-1', requestId: 'provider-eth-1' },
      status: { status: 'completed', requestId: 'provider-eth-1', txHash: TX_HASH },
    });
    installHappyRuntime(tools);
    let value = 100_000_000_000_000n;
    baseMcpExtensionActionRuntime.createReceiptReader = () => ({
      async getTransaction() { return { from: WALLET, to: RECIPIENT, value, input: '0x' }; },
      async getTransactionReceipt() {
        return { transactionHash: TX_HASH, status: 'success' as const, blockNumber: 52_000_000n, gasUsed: 21_000n, effectiveGasPriceWei: 1n, logs: [] };
      },
    });
    const reconcile = async (requestId: string) => {
      const prepared = await prepareBaseMcpSendActionV1(prepareNativeInput(requestId));
      return reconcileBaseMcpActionV1({ req: {} as Request, userId: 'tenant-1', walletAddress: WALLET, sessionSecret: 'secret', receiptId: prepared.receipt!.id });
    };

    const matched = await reconcile('eth-matched');
    assert.equal(matched.receipt?.status, 'completed');
    assert.equal(matched.receipt?.reconciliationState, 'matched');
    assert.equal(matched.receipt?.blockNumber, '52000000');
    assert.match(matched.reply, /sent exactly 0\.0001 ETH to the recipient/);

    value = 99_999_999_999_999n;
    const short = await reconcile('eth-short');
    assert.equal(short.receipt?.status, 'failed');
    assert.equal(short.receipt?.errorCode, 'base_mcp_transfer_facts_mismatch');
  });

  test('whose submission gets no answer is pending with an unknown outcome, never failed or resent', async () => {
    let sends = 0;
    const tools = fakeNativeTools({ isError: true, onSend: () => { sends += 1; } });
    installHappyRuntime(tools);
    const input = prepareNativeInput('eth-uncertain');
    const result = await prepareBaseMcpSendActionV1(input);
    assert.equal(result.receipt?.status, 'pending');
    assert.equal(result.errorCode, 'base_mcp_send_outcome_unknown');
    assert.equal(result.approvalUrl, null);
    assert.match(result.reply, /Check your wallet for a waiting approval/);
    await prepareBaseMcpSendActionV1(input);
    assert.equal(sends, 1);
  });

  test('above its own limit is refused before storage or tools, naming the limit', async () => {
    process.env.BASE_MCP_ACTION_SEND_MAX_ETH = '0.00005';
    let toolsCreated = false;
    const repository = new InMemoryBaseMcpActionReceiptRepositoryV1();
    installHappyRuntime(fakeNativeTools({}), repository);
    baseMcpExtensionActionRuntime.createTools = async () => {
      toolsCreated = true;
      return fakeNativeTools({});
    };
    const result = await prepareBaseMcpSendActionV1(prepareNativeInput());
    assert.equal(result.errorCode, 'base_mcp_send_capability_limit_exceeded');
    assert.match(result.reply, /send limit of 0\.00005 ETH/);
    assert.equal(toolsCreated, false);
    assert.equal((await repository.list('tenant-1')).length, 0);
    // The USDC limit is its own.
    process.env.BASE_MCP_ACTION_SEND_MAX_USDC = '4.99';
    delete process.env.BASE_MCP_ACTION_SEND_MAX_ETH;
    const usdc = await prepareBaseMcpSendActionV1(prepareInput());
    assert.match(usdc.reply, /send limit of 4\.99 USDC/);
  });
});
