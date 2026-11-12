import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { baseAccount, injected, walletConnect } from 'wagmi/connectors';
import { ShareHostProviderV1, ThemeProvider } from '@mioagent/ui';
import './index.css';
import App from './app/App';
import { AuthProvider } from './app/AuthProvider';
import { AppErrorBoundary } from './app/AppErrorBoundary';
import { detectBaseAppEarly } from './lib/detectBaseAppEarly';
import { BASE_ACCOUNT_PREFERENCE_V1 } from './lib/baseAccountPreference';
import { detectFarcasterHostV1, type FarcasterHostV1 } from './lib/miniAppHost';
import { isMobileBrowserV1 } from './lib/walletChoices';
import { viewportForScreenV1 } from './lib/phoneScale';

const queryClient = new QueryClient();

// index.html draws phones at three quarters; a tablet keeps the size it is
// made for. A desktop browser reads neither. See lib/phoneScale.ts.
const viewportTag = document.querySelector('meta[name="viewport"]');
const wantedViewport = viewportForScreenV1(window.screen);
if (viewportTag && viewportTag.getAttribute('content') !== wantedViewport) viewportTag.setAttribute('content', wantedViewport);

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

// A phone browser with no wallet of its own (Safari, Chrome) gets MetaMask by
// WalletConnect, which keeps the page in that browser (2026-11-03). Only
// there: the connector loads and starts WalletConnect as the page opens, which
// nobody else needs. The project id is public by design (it names the
// project to the relay) and is the one the chat card uses.
const WALLETCONNECT_PROJECT_ID_V1 = ((import.meta.env?.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ?? '').trim();
const phoneWithoutWallet = typeof window !== 'undefined' && !(window as any).ethereum
  && isMobileBrowserV1({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints });

function pairedWalletsV1() {
  if (!/^[0-9a-f]{32}$/.test(WALLETCONNECT_PROJECT_ID_V1) || !phoneWithoutWallet) return [];
  const origin = window.location.origin;
  return [walletConnect({
    projectId: WALLETCONNECT_PROJECT_ID_V1,
    // The page draws its own pairing link: no modal, and none of its code is loaded.
    showQrModal: false,
    metadata: { name: 'Still', description: 'Borrow against what you hold on Base, without selling it.', url: origin, icons: [`${origin}/still-icon.png`] },
  })];
}

// Inside Farcaster the same holds for its own wallet, which the mini app SDK
// announces over EIP-6963 once it is loaded: no Base Account popup either.
// See lib/miniAppHost.ts.
function start(farcaster: FarcasterHostV1 | null): void {
  const config = createConfig({
    chains: [base, baseSepolia],
    connectors: inBaseApp || farcaster
      ? [injected()]
      : [injected(), baseAccount({ appName: 'Miorail', preference: BASE_ACCOUNT_PREFERENCE_V1 }), ...pairedWalletsV1()],
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
