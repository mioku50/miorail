import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { coinbaseWallet, injected } from 'wagmi/connectors';
import { ThemeProvider } from '@mioagent/ui';
import './index.css';
import App from './app/App';

const queryClient = new QueryClient();

const config = createConfig({
  chains: [base, baseSepolia],
  connectors: [injected(), coinbaseWallet({ appName: 'Miorail' })],
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
