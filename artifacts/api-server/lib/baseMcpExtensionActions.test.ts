import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';
import type { Request } from 'express';
import { canonicalUsdcForBaseChain } from '@mioagent/security/baseGuards';
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
const originalX402Max = process.env.BASE_MCP_ACTION_X402_MAX_USDC;
const originalX402Hosts = process.env.BASE_MCP_ACTION_X402_ALLOWED_HOSTS;
const originalX402Ttl = process.env.BASE_MCP_ACTION_X402_TTL_SECONDS;

afterEach(() => {
  Object.assign(baseMcpExtensionActionRuntime, original);
  if (originalSendMax === undefined) delete process.env.BASE_MCP_ACTION_SEND_MAX_USDC;
  else process.env.BASE_MCP_ACTION_SEND_MAX_USDC = originalSendMax;
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
    const flaunch = classifyBaseMcpExtensionIntentV1('Buy this Flaunch token with 0.001 ETH');
    assert.equal(flaunch.kind, 'needs_input');
    if (flaunch.kind === 'needs_input') assert.equal(flaunch.errorCode, 'base_mcp_flaunch_action_adapter_required');
  });

  test('provider-native reads remain in Extensions and a released Aerodrome swap hands off', () => {
    const balancer = classifyBaseMcpExtensionIntentV1('Show the best Balancer pool for ETH yield on Base');
    assert.equal(balancer.kind, 'read');
    if (balancer.kind === 'read') assert.equal(balancer.providerId, 'balancer');

    const bitrefill = classifyBaseMcpExtensionIntentV1('Find a 20 USD Steam US gift card on Bitrefill');
    assert.equal(bitrefill.kind, 'read');
    if (bitrefill.kind === 'read') assert.equal(bitrefill.providerId, 'bitrefill');

    const aerodrome = classifyBaseMcpExtensionIntentV1('Swap 0.001 ETH to USDC on Aerodrome');
    assert.equal(aerodrome.kind, 'handoff');
    if (aerodrome.kind === 'handoff') assert.equal(aerodrome.provider, 'aerodrome');
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
    const incomplete = classifyBaseMcpExtensionIntentV1('Send 5 ETH to alice.base.eth');
    assert.equal(incomplete.kind, 'needs_input');
    assert.equal(classifyBaseMcpExtensionIntentV1('Sign this EIP-712 message').kind, 'needs_input');
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
