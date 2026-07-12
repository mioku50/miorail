import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { AutonomousExecutionGateway, InMemoryAutonomyPolicyRepository } from '@mioagent/autonomy';
import { PrepareActionRequestSchema } from '@mioagent/api-zod';
import { ToolAggregator, type ToolDef, type ToolProvider } from '@mioagent/tools';
import { executionSecurityRuntime } from './executionSecurity.js';
import {
  detectMoonwellWriteIntent,
  moonwellWriteRuntime,
  runDirectMoonwellWrite,
} from './streamMoonwellWriteRouting.js';

const WALLET = '0x1234567890123456789012345678901234567890';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const M_USDC = '0x3333333333333333333333333333333333333333';

function erc20Approve(spender: string, usdc: number): string {
  return `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${BigInt(usdc * 1_000_000).toString(16).padStart(64, '0')}`;
}

function mintCalldata(usdc: number): string {
  return `0xa0712d68${BigInt(usdc * 1_000_000).toString(16).padStart(64, '0')}`;
}

function preparedBatch(usdc: number): string {
  return JSON.stringify({
    transactions: [
      { step: 'approve', to: USDC, data: erc20Approve(M_USDC, usdc), value: '0x0', chainId: 8453 },
      { step: 'moonwell-supply', to: M_USDC, data: mintCalldata(usdc), value: '0x0', chainId: 8453 },
    ],
  });
}
const originalGetProvider = executionSecurityRuntime.getProvider;
const originalGetRepository = moonwellWriteRuntime.getRepository;
const originalInsertAction = moonwellWriteRuntime.insertAction;

afterEach(() => {
  executionSecurityRuntime.getProvider = originalGetProvider;
  moonwellWriteRuntime.getRepository = originalGetRepository;
  moonwellWriteRuntime.insertAction = originalInsertAction;
});

class MoonwellProvider implements ToolProvider {
  id = 'moonwell-http';
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(
    private readonly health: string = JSON.stringify({ healthFactor: 1.8 }),
    private readonly prepare: string = preparedBatch(100),
  ) {}
  private readonly tools: ToolDef[] = [
    { name: 'moonwell_get_health', description: 'health', inputSchema: { type: 'object' } },
    { name: 'moonwell_prepare_supply', description: 'prepare', inputSchema: { type: 'object' } },
    { name: 'moonwell_prepare_borrow', description: 'prepare', inputSchema: { type: 'object' } },
    { name: 'moonwell_prepare_withdraw', description: 'prepare', inputSchema: { type: 'object' } },
    { name: 'moonwell_prepare_repay', description: 'prepare', inputSchema: { type: 'object' } },
  ];
  async listTools() { return this.tools; }
  findTool(name: string) { return this.tools.find((tool) => tool.name === name); }
  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    if (name === 'moonwell_get_health') return { content: this.health, isError: false };
    return { content: this.prepare, isError: false };
  }
}

function usableSecurity() {
  executionSecurityRuntime.getProvider = (() => ({
    providerName: 'goplus',
    status: 'partial',
    statusCode: 'partial',
    authMode: 'public',
    provider: {
      async getTokenSecurity({ tokenAddresses }: { tokenAddresses: string[] }) {
        return tokenAddresses.map((address) => ({
          address,
          provider: 'goplus' as const,
          status: 'ok' as const,
          flags: {},
          rawRiskLabels: [],
          summary: 'usable',
        }));
      },
    },
  })) as typeof executionSecurityRuntime.getProvider;
}

async function readyRepository() {
  const repository = new InMemoryAutonomyPolicyRepository();
  await repository.configure({
    userId: 'default-user',
    chainId: 8453,
    walletAddress: WALLET,
    dailyLimit: 500,
    maxPerAction: 150,
    whitelist: ['0x1111111111111111111111111111111111111111'],
    scope: 'bounded-approval',
    expiresAt: Date.now() + 60_000,
    mainnetOptIn: true,
  });
  moonwellWriteRuntime.getRepository = () => repository;
  return repository;
}

test('Moonwell write intent detector requires moonwell plus a quantified verb', () => {
  assert.deepEqual(detectMoonwellWriteIntent('Supply 100 USDC to Moonwell'), {
    verb: 'supply', amount: 100, amountText: '100', asset: 'USDC',
  });
  assert.deepEqual(detectMoonwellWriteIntent('moonwell: borrow 50 USDC against my collateral'), {
    verb: 'borrow', amount: 50, amountText: '50', asset: 'USDC',
  });
  assert.equal(detectMoonwellWriteIntent('supply 100 USDC')?.verb, undefined);
  assert.equal(detectMoonwellWriteIntent('Show Moonwell supply markets'), null);
  assert.equal(detectMoonwellWriteIntent('lend 25 USDC on moonwell')?.verb, 'supply');
});

test('read-only mainnet blocks Moonwell writes before any tool call', async () => {
  const provider = new MoonwellProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectMoonwellWrite({
    message: 'supply 100 USDC to moonwell',
    walletAddress: WALLET,
    tools,
    userConfirmedEnabled: false,
    userId: 'default-user',
  });
  assert.equal(result?.errorCode, 'mainnet_readonly');
  assert.equal(provider.calls.length, 0);
});

test('missing or mismatched autonomy policy blocks the Moonwell write', async () => {
  usableSecurity();
  moonwellWriteRuntime.getRepository = () => new InMemoryAutonomyPolicyRepository();
  const provider = new MoonwellProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectMoonwellWrite({
    message: 'supply 100 USDC to moonwell',
    walletAddress: WALLET,
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.equal(result?.errorCode, 'mainnet_policy_not_ready');
  assert.equal(provider.calls.length, 0);
});

test('amount above maxPerAction blocks the Moonwell write', async () => {
  usableSecurity();
  await readyRepository();
  const provider = new MoonwellProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectMoonwellWrite({
    message: 'supply 151 USDC to moonwell',
    walletAddress: WALLET,
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.equal(result?.errorCode, 'moonwell_max_per_action_exceeded');
  assert.equal(provider.calls.length, 0);
});

test('non-USDC assets are blocked because the policy accounts USDC only', async () => {
  usableSecurity();
  await readyRepository();
  const provider = new MoonwellProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectMoonwellWrite({
    message: 'supply 1 ETH to moonwell',
    walletAddress: WALLET,
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.equal(result?.errorCode, 'moonwell_policy_asset_unsupported');
  assert.equal(provider.calls.length, 0);
});

test('missing GoPlus verdict blocks the Moonwell write', async () => {
  executionSecurityRuntime.getProvider = (() => ({
    providerName: 'none',
    status: 'missing',
    statusCode: 'missing',
    authMode: 'public',
    provider: { async getTokenSecurity() { return []; } },
  })) as typeof executionSecurityRuntime.getProvider;
  await readyRepository();
  const provider = new MoonwellProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectMoonwellWrite({
    message: 'supply 100 USDC to moonwell',
    walletAddress: WALLET,
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.equal(result?.errorCode, 'moonwell_token_security_unavailable');
  assert.equal(provider.calls.length, 0);
});

test('supply prepares ordered transactions and records an action with the unsigned payload', async () => {
  usableSecurity();
  await readyRepository();
  const inserted: any[] = [];
  moonwellWriteRuntime.insertAction = async (row) => { inserted.push(row); };
  const provider = new MoonwellProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectMoonwellWrite({
    message: 'supply 100 USDC to moonwell',
    walletAddress: WALLET,
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.equal(result?.kind, 'moonwell_write');
  assert.ok(result?.actionId);
  // T44b: the strict guard accepts the server-prepared batch — no error code,
  // and the record is user-confirmable.
  assert.equal(result?.errorCode, undefined);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].metadata.userConfirmable, true);
  assert.equal(inserted[0].metadata.simulationResult.success, true);
  const payload = JSON.parse(inserted[0].executionPayload);
  assert.equal(payload.chain, 'eip155:8453');
  assert.equal(payload.actionType, 'moonwell_supply');
  assert.equal(payload.calls.length, 2);
  assert.equal(payload.calls[0].to, USDC);
  // Prepare is called via the server-side tool, never via Base MCP send_calls.
  assert.deepEqual(provider.calls.map((call) => call.name), ['moonwell_prepare_supply']);
  assert.equal(provider.calls[0].args.amountDecimal, '100');
  assert.equal(provider.calls[0].args.from, WALLET);
  // No external approvalUrl in the native flow.
  assert.equal('approvalUrl' in (result || {}), false);
  assert.doesNotMatch(result?.content || '', /approvalUrl/i);
});

test('borrow reads the health factor first and includes it in the reply', async () => {
  usableSecurity();
  await readyRepository();
  moonwellWriteRuntime.insertAction = async () => {};
  const provider = new MoonwellProvider(JSON.stringify({ healthFactor: 1.31 }), preparedBatch(50));
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectMoonwellWrite({
    message: 'borrow 50 USDC on moonwell',
    walletAddress: WALLET,
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.deepEqual(provider.calls.map((call) => call.name), ['moonwell_get_health', 'moonwell_prepare_borrow']);
  assert.match(result?.content || '', /health factor: 1\.31 \(caution\)/i);
});

test('borrow is blocked when the health factor cannot be read', async () => {
  usableSecurity();
  await readyRepository();
  class BrokenHealthProvider extends MoonwellProvider {
    async callTool(name: string, args: Record<string, unknown>) {
      if (name === 'moonwell_get_health') return { content: JSON.stringify({ errorCode: 'moonwell_timeout' }), isError: true };
      return super.callTool(name, args);
    }
  }
  const tools = new ToolAggregator();
  tools.registerProvider(new BrokenHealthProvider());
  const result = await runDirectMoonwellWrite({
    message: 'withdraw 10 USDC from moonwell',
    walletAddress: WALLET,
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.equal(result?.errorCode, 'moonwell_health_unavailable');
});

test('T44b integration: detector → action record → gateway prepare returns executable payload and reserves budget', async () => {
  usableSecurity();
  const repository = await readyRepository();
  const inserted: any[] = [];
  moonwellWriteRuntime.insertAction = async (row) => { inserted.push(row); };
  const tools = new ToolAggregator();
  tools.registerProvider(new MoonwellProvider());

  // 1) Detector + route create the action record with the server-stored payload.
  const routed = await runDirectMoonwellWrite({
    message: 'supply 100 USDC to moonwell',
    walletAddress: WALLET,
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.equal(routed?.errorCode, undefined);
  assert.equal(inserted.length, 1);
  const stored = inserted[0];
  const storedPayload = JSON.parse(stored.executionPayload);

  // 2) /prepare consumes ONLY the stored record: client input carries just
  // actionId + walletAddress; any client-supplied calls are stripped by the
  // request schema before the route runs.
  const parsedRequest = PrepareActionRequestSchema.parse({
    actionId: stored.id,
    walletAddress: WALLET,
    calls: [{ to: '0x9999999999999999999999999999999999999999', data: '0xdeadbeef' }],
    executionPayload: 'client-injected',
  } as Record<string, unknown>);
  assert.deepEqual(Object.keys(parsedRequest).sort(), ['actionId', 'walletAddress']);

  // 3) The gateway (same call the route makes on mainnet) validates the
  // stored payload via the strict Moonwell guard and reserves the amount.
  const gateway = new AutonomousExecutionGateway({ repository, mainnetExecutionEnabled: true });
  const prepared = await gateway.prepare({
    userId: 'default-user',
    actionId: stored.id,
    chainEnv: 'mainnet',
    walletAddress: WALLET,
    actionType: storedPayload.actionType,
    calls: storedPayload.calls,
    instruction: stored.metadata.instruction,
    providerContext: { risk: 'connected', riskProvider: 'goplus', securityProvider: 'goplus' },
    tokenSecurity: [{ address: USDC, provider: 'goplus', status: 'ok' }],
    moonwell: { amountDecimal: String(stored.metadata.moonwell.amountDecimal) },
  });
  assert.equal(prepared.success, true, prepared.error);
  assert.equal(prepared.status, 'approval_required');
  assert.equal(prepared.spendAmountUsdc, 100);
  assert.equal(prepared.requiresUserApproval, true);
  assert.equal(prepared.broadcasted, false);
  assert.deepEqual(prepared.sendCallsRequest?.calls, storedPayload.calls);
  assert.equal(prepared.sendCallsRequest?.chainId, '0x2105');
  const policy = await repository.getByUser('default-user', 8453);
  assert.equal(policy?.reservedToday, 100);
});

test('a prepare response with non-Base chainId is rejected', async () => {
  usableSecurity();
  await readyRepository();
  moonwellWriteRuntime.insertAction = async () => {};
  const provider = new MoonwellProvider(
    JSON.stringify({ healthFactor: 2 }),
    JSON.stringify({ transactions: [{ step: 'approve', to: '0x2222222222222222222222222222222222222222', chainId: 10 }] }),
  );
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectMoonwellWrite({
    message: 'repay 5 USDC on moonwell',
    walletAddress: WALLET,
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.equal(result?.errorCode, 'moonwell_prepare_wrong_chain');
});
