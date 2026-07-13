import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { baseAccount, injected } from 'wagmi/connectors';
import { ThemeProvider } from '@mioagent/ui';
import './index.css';
import App from './app/App';
import { AuthProvider } from './app/AuthProvider';
import { detectBaseAppEarly } from './lib/detectBaseAppEarly';

const queryClient = new QueryClient();

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

const config = createConfig({
  chains: [base, baseSepolia],
  connectors: inBaseApp
    ? [injected()]
    : [injected(), baseAccount({ appName: 'Miorail' })],
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider><App /></AuthProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  </StrictMode>,
);
