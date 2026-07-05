import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { baseAccount, coinbaseWallet, injected } from 'wagmi/connectors';
import { ThemeProvider } from '@mioagent/ui';
import './index.css';
import App from './app/App';

const queryClient = new QueryClient();

// T19: Base Account is the default wallet — it hosts the user-confirmed
// `wallet_sendCalls` flow. Coinbase Wallet and injected browsers are fallbacks.
// No-custody: this provides wallet context / signing only; the server never
// broadcasts.
const config = createConfig({
  chains: [base, baseSepolia],
  connectors: [
    baseAccount({ appName: 'Miorail' }),
    coinbaseWallet({ appName: 'Miorail' }),
    injected(),
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
          <App />
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  </StrictMode>,
);
