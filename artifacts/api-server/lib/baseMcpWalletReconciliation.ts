// T44: Base MCP is an OAuth integration into a Base Account that may not be
// the wallet authenticated in the SIWE session. `get_wallets` was previously
// used only as an address fallback and never reconciled against the tenant
// wallet. This helper verifies the two agree; callers decide what a mismatch
// means (OAuth callback: warn but keep the connection; send/swap: block).

import {
  BaseMcpClient,
  createBaseMcpHttpTransport,
  type BaseMcpOAuthProvider,
} from '@mioagent/mcp';
import { createBaseMcpOAuthProviderForUser } from './baseMcpOAuthStore.js';

export const BASE_MCP_WALLET_MISMATCH_ERROR_CODE = 'base_mcp_wallet_mismatch';
export const BASE_MCP_WALLET_MISMATCH_MESSAGE =
  'Base MCP connected to a different wallet than your session wallet. Reconnect Base MCP with the same account.';

const ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}/g;

export interface BaseMcpWalletMatchResult {
  match: boolean;
  mcpAddresses: string[];
  /** false when get_wallets was unavailable or failed, so no verdict exists. */
  checked: boolean;
}

/** Aggregator-shaped client (ToolAggregator satisfies this). */
export interface WalletToolCaller {
  listTools(): Promise<Array<{ name: string }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
}

/** MCP SDK-shaped client (BaseMcpClient satisfies this). */
export interface WalletSdkClient {
  getClient(): {
    callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  };
}

function unverified(): BaseMcpWalletMatchResult {
  return { match: true, mcpAddresses: [], checked: false };
}

// The zero address is the dev/test single-user placeholder, not a real
// session wallet — verifying against it is meaningless.
function isRealWalletAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address) && address !== '0x0000000000000000000000000000000000000000';
}

export function extractWalletAddresses(payload: unknown): string[] {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload) || '';
  const matches = serialized.match(ADDRESS_PATTERN) || [];
  return [...new Set(matches.map((address) => address.toLowerCase()))];
}

function compare(tenantAddress: string, mcpAddresses: string[]): BaseMcpWalletMatchResult {
  if (mcpAddresses.length === 0) return unverified();
  const tenant = tenantAddress.toLowerCase();
  return { match: mcpAddresses.includes(tenant), mcpAddresses, checked: true };
}

/**
 * Calls Base MCP `get_wallets` through the given client and compares the
 * returned addresses (lowercased) with the tenant/session wallet. A missing
 * tool or a failed call returns `checked: false, match: true` — only a
 * VERIFIED mismatch should block anything; an unverifiable state must not
 * break read paths or OAuth.
 */
export async function verifyBaseMcpWalletMatch(
  client: WalletToolCaller | WalletSdkClient,
  tenantAddress: string | undefined,
): Promise<BaseMcpWalletMatchResult> {
  if (!tenantAddress || !/^0x[a-fA-F0-9]{40}$/.test(tenantAddress)) return unverified();

  try {
    if ('getClient' in client) {
      const result = await client.getClient().callTool({ name: 'get_wallets', arguments: {} });
      return compare(tenantAddress, extractWalletAddresses(result));
    }
    const inventory = await client.listTools();
    if (!inventory.some((tool) => tool.name === 'get_wallets')) return unverified();
    const called = await client.callTool('get_wallets', {});
    if (called.isError) return unverified();
    return compare(tenantAddress, extractWalletAddresses(called.content));
  } catch {
    return unverified();
  }
}

export const baseMcpWalletReconciliationRuntime = {
  createClient: () => new BaseMcpClient(),
  createTransport: (serverUrl: URL, oauthProvider: BaseMcpOAuthProvider) =>
    createBaseMcpHttpTransport(serverUrl, oauthProvider),
  createOAuthProvider: createBaseMcpOAuthProviderForUser,
};

// The wallet check is strictly best-effort and must never mutate stored OAuth
// state: a transient connect failure right after a successful token exchange
// would otherwise let the SDK auth flow invalidate the fresh tokens.
function nonDestructiveProvider(provider: BaseMcpOAuthProvider): BaseMcpOAuthProvider {
  const noop = async () => undefined;
  return new Proxy(provider as object, {
    get(target, prop, receiver) {
      if (['saveTokens', 'saveClientInformation', 'saveCodeVerifier', 'invalidateCredentials', 'redirectToAuthorization'].includes(String(prop))) {
        return noop;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as BaseMcpOAuthProvider;
}

function reconciliationTimeoutMs(): number {
  const parsed = Number(process.env.BASE_MCP_TIMEOUT_MS || 2500);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30_000) : 2500;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * OAuth-callback variant: opens a short-lived Base MCP connection with the
 * freshly stored credentials and reconciles get_wallets with the session
 * wallet. Never throws and never mutates OAuth state — a mismatch must not
 * break the OAuth flow, only be reported to the UI.
 */
export async function verifyBaseMcpWalletMatchViaOAuth(input: {
  userId: string;
  sessionSecret: string;
  redirectUrl: string;
  serverUrl: URL;
  tenantAddress?: string;
}): Promise<BaseMcpWalletMatchResult> {
  if (!input.tenantAddress || !isRealWalletAddress(input.tenantAddress)) return unverified();
  const client = baseMcpWalletReconciliationRuntime.createClient();
  try {
    const provider = nonDestructiveProvider(baseMcpWalletReconciliationRuntime.createOAuthProvider({
      userId: input.userId,
      sessionSecret: input.sessionSecret,
      redirectUrl: input.redirectUrl,
    }));
    await withTimeout(
      client.connect(baseMcpWalletReconciliationRuntime.createTransport(input.serverUrl, provider)),
      reconciliationTimeoutMs(),
    );
    return await withTimeout(verifyBaseMcpWalletMatch(client, input.tenantAddress), reconciliationTimeoutMs());
  } catch {
    return unverified();
  } finally {
    await client.close().catch(() => undefined);
  }
}
