import { base } from '@base-org/account/node';

// ---------------------------------------------------------------------------
// The CDP subscription-owner wallet, and the RPC endpoint to reach it with.
//
// This block used to live inside `routes/x402/index.ts`, which made it a route
// module that libraries imported: `spendPermissionVerifier.ts` and
// `intelligenceBudgetCharger.ts` both reach for it, and both are libraries. The
// dependency pointed the wrong way, and it dragged Express — and Express's
// session type augmentation — into every consumer, including a smoke script
// that has no HTTP surface at all.
//
// Nothing about the behaviour changed in the move. `routes/x402/index.ts`
// re-exports these names, so every existing importer still resolves, and the
// wallet cache is still a single module-level map: two caches would let the
// verifier and the charger disagree about who the spender is, which is the one
// disagreement this system cannot survive.
// ---------------------------------------------------------------------------

export interface SubscriptionOwnerWallet {
  address: string;
  walletName: string;
  eoaAddress?: string;
}

export class SubscriptionOwnerUnavailableError extends Error {
  constructor(
    message: string,
    readonly errorCode: string,
    readonly missingConfig: string[] = [],
  ) {
    super(message);
  }
}

const subscriptionOwnerWalletCache = new Map<string, { wallet: SubscriptionOwnerWallet; expiresAt: number }>();

export function subscriptionWalletName(env: NodeJS.ProcessEnv = process.env): string {
  return env.BASE_SUBSCRIPTION_WALLET_NAME ||
    env.CDP_SUBSCRIPTION_WALLET_NAME ||
    'miorail-fuel-subscription-owner';
}

function missingSubscriptionOwnerConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ['CDP_API_KEY_ID', env.CDP_API_KEY_ID],
    ['CDP_API_KEY_SECRET', env.CDP_API_KEY_SECRET],
    ['CDP_WALLET_SECRET', env.CDP_WALLET_SECRET],
  ].filter(([, value]) => !value).map(([name]) => String(name));
}

function isAddress(value?: string | null): boolean {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

export async function getSubscriptionOwnerWallet(env: NodeJS.ProcessEnv = process.env): Promise<SubscriptionOwnerWallet> {
  const missingConfig = missingSubscriptionOwnerConfig(env);
  if (missingConfig.length > 0) {
    throw new SubscriptionOwnerUnavailableError(
      'CDP subscription owner wallet config is incomplete.',
      'subscription_owner_missing_config',
      missingConfig,
    );
  }

  const walletName = subscriptionWalletName(env);
  const cached = subscriptionOwnerWalletCache.get(walletName);
  if (cached && cached.expiresAt > Date.now()) return cached.wallet;

  try {
    const wallet = await base.subscription.getOrCreateSubscriptionOwnerWallet({ walletName });
    if (!isAddress(wallet.address)) {
      throw new SubscriptionOwnerUnavailableError(
        'CDP subscription owner wallet returned an invalid address.',
        'subscription_owner_invalid_address',
      );
    }
    const publicWallet = {
      address: wallet.address,
      walletName: wallet.walletName || walletName,
      eoaAddress: wallet.eoaAddress,
    };
    subscriptionOwnerWalletCache.set(walletName, {
      wallet: publicWallet,
      expiresAt: Date.now() + 5 * 60_000,
    });
    return publicWallet;
  } catch (error) {
    if (error instanceof SubscriptionOwnerUnavailableError) throw error;
    throw new SubscriptionOwnerUnavailableError(
      'CDP subscription owner wallet is unavailable.',
      'subscription_owner_unavailable',
    );
  }
}

export function rpcUrlForNetwork(network?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (network === 'eip155:84532') {
    return env.BASE_SEPOLIA_RPC_URL || env.BASE_RPC_URL || 'https://sepolia.base.org';
  }
  if (network === 'eip155:8453' || !network) {
    return env.BASE_MAINNET_RPC_URL || env.BASE_RPC_URL || 'https://mainnet.base.org';
  }
  return undefined;
}

export interface SubscriptionOwnerReadiness {
  ready: boolean;
  deployed: boolean;
  nativeBalancePresent: boolean;
  gasSponsored: boolean;
  errorCode?:
    | 'subscription_owner_gas_unavailable'
    | 'subscription_owner_deploy_funding_required'
    | 'subscription_owner_rpc_unavailable';
}

async function rpcHexResult(rpcUrl: string, method: 'eth_getCode' | 'eth_getBalance', address: string): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: method,
      method,
      params: [address, 'latest'],
    }),
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
  const body = await response.json() as { result?: unknown; error?: unknown };
  if (body.error || typeof body.result !== 'string') throw new Error(`RPC ${method} returned an invalid response`);
  return body.result;
}

/**
 * Whether this wallet can pay for the transaction it is about to be asked to
 * send. `base.subscription.charge` is a real transaction sent by the
 * subscription owner, so either a paymaster sponsors it or the wallet holds
 * native ETH. Neither, and the charge fails after the user has already granted
 * the permission.
 */
export async function checkSubscriptionOwnerReadiness(
  wallet: SubscriptionOwnerWallet,
  network: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubscriptionOwnerReadiness> {
  const rpcUrl = rpcUrlForNetwork(network, env);
  if (!rpcUrl) {
    return {
      ready: false,
      deployed: false,
      nativeBalancePresent: false,
      gasSponsored: Boolean(env.PAYMASTER_URL),
      errorCode: 'subscription_owner_rpc_unavailable',
    };
  }

  try {
    const [code, balance] = await Promise.all([
      rpcHexResult(rpcUrl, 'eth_getCode', wallet.address),
      rpcHexResult(rpcUrl, 'eth_getBalance', wallet.address),
    ]);
    const deployed = code !== '0x' && code !== '0x0';
    const nativeBalancePresent = BigInt(balance) > 0n;
    const gasSponsored = Boolean(env.PAYMASTER_URL);
    const ready = gasSponsored || nativeBalancePresent;
    return {
      ready,
      deployed,
      nativeBalancePresent,
      gasSponsored,
      ...(!ready
        ? {
            errorCode: deployed
              ? ('subscription_owner_gas_unavailable' as const)
              : ('subscription_owner_deploy_funding_required' as const),
          }
        : {}),
    };
  } catch {
    return {
      ready: false,
      deployed: false,
      nativeBalancePresent: false,
      gasSponsored: Boolean(env.PAYMASTER_URL),
      errorCode: 'subscription_owner_rpc_unavailable',
    };
  }
}
