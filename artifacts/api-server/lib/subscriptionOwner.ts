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
