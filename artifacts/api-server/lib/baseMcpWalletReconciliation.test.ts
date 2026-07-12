import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { InMemoryAutonomyPolicyRepository } from '@mioagent/autonomy';
import { ToolAggregator, type ToolDef, type ToolProvider } from '@mioagent/tools';
import {
  extractWalletAddresses,
  verifyBaseMcpWalletMatch,
} from './baseMcpWalletReconciliation.js';
import { executionSecurityRuntime } from './executionSecurity.js';
import { baseMcpSendRuntime, runDirectBaseMcpSend } from './streamBaseMcpSendRouting.js';

const TENANT = '0x1234567890123456789012345678901234567890';
const OTHER = '0x9999999999999999999999999999999999999999';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

class FakeWalletProvider implements ToolProvider {
  id = 'base-mcp-dynamic';
  constructor(
    private readonly walletsPayload: string | null,
    private readonly walletsIsError = false,
    private readonly extraTools: ToolDef[] = [],
  ) {}
  private get tools(): ToolDef[] {
    const list = [...this.extraTools];
    if (this.walletsPayload !== null || this.walletsIsError) {
      list.push({ name: 'get_wallets', description: 'Wallet inventory', inputSchema: { type: 'object' } });
    }
    return list;
  }
  async listTools() { return this.tools; }
  findTool(name: string) { return this.tools.find((tool) => tool.name === name); }
  async callTool(name: string) {
    if (name === 'get_wallets') {
      if (this.walletsIsError) return { content: JSON.stringify({ errorCode: 'boom' }), isError: true };
      return { content: this.walletsPayload || '{}', isError: false };
    }
    return { content: JSON.stringify({ link: 'https://wallet.base.org/approve/x' }), isError: false };
  }
}

test('extractWalletAddresses dedupes and lowercases addresses from arbitrary payload shapes', () => {
  const payload = JSON.stringify({
    wallets: [{ address: TENANT.toUpperCase().replace('0X', '0x') }, { address: TENANT }],
    note: `also ${OTHER}`,
  });
  assert.deepEqual(extractWalletAddresses(payload), [TENANT, OTHER]);
});

test('verifyBaseMcpWalletMatch confirms a match against the tenant wallet', async () => {
  const tools = new ToolAggregator();
  tools.registerProvider(new FakeWalletProvider(JSON.stringify({ wallets: [{ address: TENANT }] })));
  const result = await verifyBaseMcpWalletMatch(tools, TENANT);
  assert.deepEqual(result, { match: true, mcpAddresses: [TENANT], checked: true });
});

test('verifyBaseMcpWalletMatch reports a verified mismatch', async () => {
  const tools = new ToolAggregator();
  tools.registerProvider(new FakeWalletProvider(JSON.stringify({ wallets: [{ address: OTHER }] })));
  const result = await verifyBaseMcpWalletMatch(tools, TENANT);
  assert.deepEqual(result, { match: false, mcpAddresses: [OTHER], checked: true });
});

test('verifyBaseMcpWalletMatch stays unverified when get_wallets is missing, empty, or failing', async () => {
  const missing = new ToolAggregator();
  missing.registerProvider(new FakeWalletProvider(null));
  assert.deepEqual(await verifyBaseMcpWalletMatch(missing, TENANT), { match: true, mcpAddresses: [], checked: false });

  const empty = new ToolAggregator();
  empty.registerProvider(new FakeWalletProvider(JSON.stringify({ wallets: [] })));
  assert.deepEqual(await verifyBaseMcpWalletMatch(empty, TENANT), { match: true, mcpAddresses: [], checked: false });

  const failing = new ToolAggregator();
  failing.registerProvider(new FakeWalletProvider(null, true));
  assert.deepEqual(await verifyBaseMcpWalletMatch(failing, TENANT), { match: true, mcpAddresses: [], checked: false });
});

test('verifyBaseMcpWalletMatch supports MCP SDK-shaped clients', async () => {
  const sdkClient = {
    getClient: () => ({
      callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ address: OTHER }) }] }),
    }),
  };
  const result = await verifyBaseMcpWalletMatch(sdkClient, TENANT);
  assert.deepEqual(result, { match: false, mcpAddresses: [OTHER], checked: true });
});

// Integration: a verified mismatch blocks the Base MCP send route before any
// reservation or tool call.
const originalGetProvider = executionSecurityRuntime.getProvider;
const originalGetRepository = baseMcpSendRuntime.getRepository;

afterEach(() => {
  executionSecurityRuntime.getProvider = originalGetProvider;
  baseMcpSendRuntime.getRepository = originalGetRepository;
});

test('runDirectBaseMcpSend blocks on a verified Base MCP wallet mismatch', async () => {
  executionSecurityRuntime.getProvider = () => ({
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
  }) as any;
  const repository = new InMemoryAutonomyPolicyRepository();
  await repository.configure({
    userId: 'default-user',
    chainId: 8453,
    walletAddress: TENANT,
    dailyLimit: 10,
    maxPerAction: 2,
    whitelist: [RECIPIENT],
    scope: 'bounded-approval',
    expiresAt: Date.now() + 60_000,
    mainnetOptIn: true,
  });
  baseMcpSendRuntime.getRepository = () => repository;

  const tools = new ToolAggregator();
  tools.registerProvider(new FakeWalletProvider(
    JSON.stringify({ wallets: [{ address: OTHER }] }),
    false,
    [{ name: 'send', description: 'Send a token', inputSchema: { type: 'object', properties: { amount: { type: 'string' } } } }],
  ));

  const result = await runDirectBaseMcpSend({
    message: `send 0.25 USDC to ${RECIPIENT}`,
    walletAddress: TENANT,
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.equal(result?.errorCode, 'base_mcp_wallet_mismatch');
  assert.match(result?.content || '', /Reconnect Base MCP with the same account/);
  assert.equal((await repository.getByUser('default-user', 8453))?.reservedToday, 0);
});
