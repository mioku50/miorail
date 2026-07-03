import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { coinbaseWallet, injected } from 'wagmi/connectors';
import { ThemeProvider } from './theme/ThemeProvider';
import './index.css';
import App from './app/App';
import { UiPreview } from './ui/_preview';

const queryClient = new QueryClient();

const config = createConfig({
  chains: [base, baseSepolia],
  connectors: [injected(), coinbaseWallet({ appName: 'MioAgent' })],
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
  },
});

// F1 dev preview of ui/ primitives — visit ?dev=ui. Removed in F2.
const isDevUiPreview =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get('dev') === 'ui';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>{isDevUiPreview ? <UiPreview /> : <App />}</QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  </StrictMode>,
);
