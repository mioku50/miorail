import test, { afterEach } from 'node:test';
import assert from 'node:assert';
import { attachBaseMcpToolProbeStatus, clearBaseMcpStatusForTests } from './baseMcpStatus.js';
import {
  baseMcpToolProbeRuntime,
  probeBaseMcpTools,
} from './baseMcpToolProbe.js';

const originalGetAuthStatus = baseMcpToolProbeRuntime.getBaseMcpAuthStatus;
const originalMarkNeedsReauth = baseMcpToolProbeRuntime.markBaseMcpNeedsReauth;
const originalCreateOAuthProvider = baseMcpToolProbeRuntime.createOAuthProvider;
const originalCreateClient = baseMcpToolProbeRuntime.createClient;
const originalCreateTransport = baseMcpToolProbeRuntime.createTransport;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  baseMcpToolProbeRuntime.getBaseMcpAuthStatus = originalGetAuthStatus;
  baseMcpToolProbeRuntime.markBaseMcpNeedsReauth = originalMarkNeedsReauth;
  baseMcpToolProbeRuntime.createOAuthProvider = originalCreateOAuthProvider;
  baseMcpToolProbeRuntime.createClient = originalCreateClient;
  baseMcpToolProbeRuntime.createTransport = originalCreateTransport;
  clearBaseMcpStatusForTests();
});

test('probeBaseMcpTools lists sanitized tools without invoking send_calls or callTool', async () => {
  const origEnabled = process.env.BASE_MCP_ENABLED;
  const origUrl = process.env.BASE_MCP_SERVER_URL;
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org/private/path?token=secret';

  let connected = false;
  let closed = false;
  let callToolInvoked = false;
  baseMcpToolProbeRuntime.getBaseMcpAuthStatus = async () => ({
    connected: true,
    needsReauth: false,
    userScoped: true,
  });
  baseMcpToolProbeRuntime.createOAuthProvider = () => ({}) as any;
  baseMcpToolProbeRuntime.createTransport = () => ({}) as any;
  baseMcpToolProbeRuntime.createClient = () => ({
    connect: async () => {
      connected = true;
    },
    close: async () => {
      closed = true;
    },
    getClient: () => ({
      listTools: async () => ({
        tools: [
          { name: 'get_wallets', description: '  Wallet inventory\nread only  ', inputSchema: { secret: 'hidden' } },
          { name: 'send_calls', description: 'Write tool is listed but not invoked.' },
          { name: '', description: 'ignored' },
        ],
      }),
      callTool: async () => {
        callToolInvoked = true;
        throw new Error('callTool must not be used by probe');
      },
    }),
  } as any);

  const result = await probeBaseMcpTools({
    userId: 'user-1',
    sessionSecret: 'session-secret',
    redirectUrl: 'https://miorail.xyz/api/mcp/base/callback',
  });

  assert.strictEqual(result.status, 'connected');
  assert.strictEqual(result.endpointHost, 'mcp.base.org');
  assert.strictEqual(result.toolsCount, 2);
  assert.deepStrictEqual(result.tools, [
    { name: 'get_wallets', description: 'Wallet inventory read only' },
    { name: 'send_calls', description: 'Write tool is listed but not invoked.' },
  ]);
  assert.strictEqual(JSON.stringify(result).includes('private/path'), false);
  assert.strictEqual(JSON.stringify(result).includes('token=secret'), false);
  assert.strictEqual(connected, true);
  assert.strictEqual(closed, true);
  assert.strictEqual(callToolInvoked, false);

  const status = attachBaseMcpToolProbeStatus({
    status: 'connected',
    provider: 'base-mcp',
    configured: true,
    enabled: true,
    endpointHost: 'mcp.base.org',
  });
  assert.strictEqual(status.toolsCount, 2);
  assert.strictEqual(status.lastToolProbeAt, result.checkedAt);

  restoreEnv('BASE_MCP_ENABLED', origEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', origUrl);
});

test('probeBaseMcpTools returns needs_reauth without connecting when token is missing', async () => {
  const origEnabled = process.env.BASE_MCP_ENABLED;
  const origUrl = process.env.BASE_MCP_SERVER_URL;
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org';

  let createdClient = false;
  baseMcpToolProbeRuntime.getBaseMcpAuthStatus = async () => ({
    connected: false,
    needsReauth: true,
    userScoped: true,
  });
  baseMcpToolProbeRuntime.createClient = () => {
    createdClient = true;
    return originalCreateClient();
  };

  const result = await probeBaseMcpTools({
    userId: 'user-1',
    sessionSecret: 'session-secret',
    redirectUrl: 'https://miorail.xyz/api/mcp/base/callback',
  });

  assert.strictEqual(result.status, 'needs_reauth');
  assert.strictEqual(result.toolsCount, 0);
  assert.deepStrictEqual(result.tools, []);
  assert.strictEqual(createdClient, false);

  restoreEnv('BASE_MCP_ENABLED', origEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', origUrl);
});

test('probeBaseMcpTools classifies network failures as unreachable', async () => {
  const origEnabled = process.env.BASE_MCP_ENABLED;
  const origUrl = process.env.BASE_MCP_SERVER_URL;
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org';

  baseMcpToolProbeRuntime.getBaseMcpAuthStatus = async () => ({
    connected: true,
    needsReauth: false,
    userScoped: true,
  });
  baseMcpToolProbeRuntime.createOAuthProvider = () => ({}) as any;
  baseMcpToolProbeRuntime.createTransport = () => ({}) as any;
  baseMcpToolProbeRuntime.createClient = () => ({
    connect: async () => {
      throw new Error('fetch failed');
    },
    close: async () => undefined,
    getClient: () => ({
      listTools: async () => ({ tools: [] }),
    }),
  } as any);

  const result = await probeBaseMcpTools({
    userId: 'user-1',
    sessionSecret: 'session-secret',
    redirectUrl: 'https://miorail.xyz/api/mcp/base/callback',
  });

  assert.strictEqual(result.status, 'unreachable');
  assert.strictEqual(result.errorCode, 'network_error');

  restoreEnv('BASE_MCP_ENABLED', origEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', origUrl);
});

test('probeBaseMcpTools marks needs_reauth on auth failure', async () => {
  const origEnabled = process.env.BASE_MCP_ENABLED;
  const origUrl = process.env.BASE_MCP_SERVER_URL;
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org';

  let markedUserId: string | undefined;
  baseMcpToolProbeRuntime.getBaseMcpAuthStatus = async () => ({
    connected: true,
    needsReauth: false,
    userScoped: true,
  });
  baseMcpToolProbeRuntime.markBaseMcpNeedsReauth = async ({ userId }) => {
    markedUserId = userId;
  };
  baseMcpToolProbeRuntime.createOAuthProvider = () => ({}) as any;
  baseMcpToolProbeRuntime.createTransport = () => ({}) as any;
  baseMcpToolProbeRuntime.createClient = () => ({
    connect: async () => {
      throw new Error('Unauthorized');
    },
    close: async () => undefined,
    getClient: () => ({
      listTools: async () => ({ tools: [] }),
    }),
  } as any);

  const result = await probeBaseMcpTools({
    userId: 'user-1',
    sessionSecret: 'session-secret',
    redirectUrl: 'https://miorail.xyz/api/mcp/base/callback',
  });

  assert.strictEqual(result.status, 'needs_reauth');
  assert.strictEqual(markedUserId, 'user-1');

  restoreEnv('BASE_MCP_ENABLED', origEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', origUrl);
});
