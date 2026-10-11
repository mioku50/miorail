import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { baseAccount, injected } from 'wagmi/connectors';
import { ShareHostProviderV1, ThemeProvider } from '@mioagent/ui';
import './index.css';
import App from './app/App';
import { AuthProvider } from './app/AuthProvider';
import { AppErrorBoundary } from './app/AppErrorBoundary';
import { detectBaseAppEarly } from './lib/detectBaseAppEarly';
import { detectFarcasterHostV1, type FarcasterHostV1 } from './lib/miniAppHost';

const queryClient = new QueryClient();

// The remote font stylesheet must never hold up the module that mounts React.
// It starts as print-only in the HTML and becomes active once it has arrived.
const optionalFonts = document.getElementById('miorail-fonts') as HTMLLinkElement | null;
if (optionalFonts) {
  const activateFonts = () => { optionalFonts.media = 'all'; };
  if (optionalFonts.sheet) activateFonts();
  else optionalFonts.addEventListener('load', activateFonts, { once: true });
}

// T48a.1: detect Base App BEFORE building the wagmi config. Base App injects
// the active Base Account as an EIP-1193 provider (including via EIP-6963
// announce), so inside Base App we build the connector list WITHOUT
// `baseAccount()` at all — not just a selection preference. That way
// keys.coinbase.com is structurally unreachable from the embedded webview:
// there is no baseAccount connector instance left that could open it.
// Outside Base App (normal desktop browser), `baseAccount()` remains in the
// config as the only sign-in path for users without a wallet extension.
// No-custody: this provides wallet context / signing only; the server never
// signs or broadcasts.
const inBaseApp = detectBaseAppEarly({
  userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  ethereum: typeof window === 'undefined' ? undefined : (window as any).ethereum,
});

// Inside Farcaster the same holds for its own wallet, which the mini app SDK
// announces over EIP-6963 once it is loaded: no Base Account popup either.
// See lib/miniAppHost.ts.
function start(farcaster: FarcasterHostV1 | null): void {
  const config = createConfig({
    chains: [base, baseSepolia],
    connectors: inBaseApp || farcaster
      ? [injected()]
      : [injected(), baseAccount({ appName: 'Miorail' })],
    transports: {
      [base.id]: http(),
      [baseSepolia.id]: http(),
    },
  });

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppErrorBoundary>
        <ThemeProvider>
          <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>
              <ShareHostProviderV1 value={farcaster?.share ?? null}>
                <AuthProvider><App /></AuthProvider>
              </ShareHostProviderV1>
            </QueryClientProvider>
          </WagmiProvider>
        </ThemeProvider>
      </AppErrorBoundary>
    </StrictMode>,
  );
  // Farcaster keeps its splash screen up until the page says it is drawn.
  farcaster?.ready();
}

// A browser tab is never a frame, so it starts at once without the SDK.
void (inBaseApp ? Promise.resolve(null) : detectFarcasterHostV1(window)).then(start);
