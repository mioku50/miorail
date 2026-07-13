import type { Request } from 'express';
import type { BaseMcpWalletMatchResult } from './baseMcpWalletReconciliation.js';

export type WalletEnvironment = 'baseapp' | 'web';
export type ExecutionProvider = 'baseapp_native' | 'base_mcp' | 'none';

export const BASE_MCP_DIFFERENT_WALLET_NOTICE = [
  'Base MCP is connected to another Coinbase wallet.',
  'Miorail will use your current BaseApp wallet for balances and confirmations.',
  'Coinbase wallet-specific MCP tools are disabled for this session.',
].join('\n');

/**
 * This is a routing hint only. It can select the safer native flow, but it can
 * never supply or replace an address: the tenant wallet always comes from the
 * verified SIWE session in tenantAuth.
 */
export function walletEnvironmentFromRequest(req: Request): WalletEnvironment {
  return String(req.headers['x-miorail-wallet-environment'] || '').toLowerCase() === 'baseapp'
    ? 'baseapp'
    : 'web';
}

export function buildWalletContext(input: {
  tenantWallet: string;
  environment: WalletEnvironment;
  match: BaseMcpWalletMatchResult;
  baseMcpUsable: boolean;
}) {
  const walletMatch = input.match.checked ? input.match.match : null;
  const baseMcpWallet = input.match.mcpAddresses[0] || null;
  const walletToolsStatus = !input.baseMcpUsable
    ? 'unavailable' as const
    : walletMatch === false
      ? 'disabled_wallet_mismatch' as const
      : walletMatch === true
        ? 'available' as const
        : 'unverified' as const;
  const executionProvider: ExecutionProvider = input.environment === 'baseapp'
    ? 'baseapp_native'
    : walletMatch === true && input.baseMcpUsable
      ? 'base_mcp'
      : 'none';

  return {
    walletContext: {
      tenantWallet: input.tenantWallet.toLowerCase(),
      baseAppWallet: input.environment === 'baseapp' ? input.tenantWallet.toLowerCase() : null,
      baseMcpWallet,
      walletMatch,
      executionProvider,
    },
    protocolToolsStatus: input.baseMcpUsable ? 'available' as const : 'unavailable' as const,
    walletToolsStatus,
  };
}
