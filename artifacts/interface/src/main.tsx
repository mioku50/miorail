import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { baseAccount, injected } from 'wagmi/connectors';
import { ThemeProvider } from '@mioagent/ui';
import './index.css';
import App from './app/App';
import { WalletAuthGate } from './app/WalletAuthGate';

const queryClient = new QueryClient();

// Base App injects the active Base Account as an EIP-1193 provider. Prefer it
// so the embedded app never opens the Base Account popup/keys site. The
// baseAccount connector remains the explicit fallback for a normal browser.
// No-custody: this provides wallet context / signing only; the server never
// signs or broadcasts.
const config = createConfig({
  chains: [base, baseSepolia],
  connectors: [
    injected(),
    baseAccount({ appName: 'Miorail' }),
  ],
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
          <WalletAuthGate><App /></WalletAuthGate>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  </StrictMode>,
);
