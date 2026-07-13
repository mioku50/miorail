// T48a.1: early, synchronous BaseApp detection — run BEFORE `createConfig` so
// the wagmi connector list can be built without `baseAccount()` at all when
// we are inside Base App. Excluding the connector structurally (rather than
// only steering connector *selection* later) means keys.coinbase.com is
// physically unreachable from inside the embedded webview: there is no
// baseAccount connector instance to open it.
//
// This is deliberately a superset of `isBaseAppEnvironment` (lib/baseAppEnvironment.ts):
// that helper only fires once wagmi already resolved an `injected` connector
// and is used for diagnostics/backend hints. This helper runs before wagmi
// exists at all, so it inspects `window.ethereum` directly, including
// EIP-6963 `providers[]` fan-out some hosts expose alongside the primary
// provider object.
//
// Best-effort: an unknown host that injects non-standard flags will not be
// detected here, but that is safe by construction — the desktop-oriented
// config (`[injected(), baseAccount()]`) is still a strict superset that
// supports every environment this function fails to recognize.
export interface DetectBaseAppEarlyInput {
  userAgent?: string;
  ethereum?: unknown;
}

interface MaybeProviderFlags {
  isCoinbaseWallet?: boolean;
  isBaseApp?: boolean;
  providers?: unknown[];
}

const BASE_APP_UA_PATTERN = /baseapp|coinbasewallet|cbwallet/i;

function hasBaseAppFlags(provider: unknown): provider is MaybeProviderFlags {
  if (!provider || typeof provider !== 'object') return false;
  const flags = provider as MaybeProviderFlags;
  return flags.isCoinbaseWallet === true || flags.isBaseApp === true;
}

export function detectBaseAppEarly(input: DetectBaseAppEarlyInput): boolean {
  const userAgent = String(input.userAgent || '');
  if (BASE_APP_UA_PATTERN.test(userAgent)) return true;

  const ethereum = input.ethereum;
  if (hasBaseAppFlags(ethereum)) return true;

  const providers = (ethereum as MaybeProviderFlags | undefined)?.providers;
  if (Array.isArray(providers)) {
    return providers.some((provider) => hasBaseAppFlags(provider));
  }

  return false;
}
