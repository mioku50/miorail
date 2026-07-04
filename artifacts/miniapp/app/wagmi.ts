import { cookieStorage, createConfig, createStorage, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { baseAccount, coinbaseWallet, injected } from "wagmi/connectors";

// Standard web-app wallet config (no OnchainKit / MiniKit). The Base Account SDK
// (`baseAccount` connector) is the default wallet — passkey sign-in, automatic
// wallet context inside Base App, and a popup connect flow in a normal browser.
// Coinbase Wallet and injected browser wallets are fallbacks. No-custody: this
// provides wallet context / identity only — no signing or broadcast from this UI
// (execution stays via the Base MCP approval URL).
export const wagmiConfig = createConfig({
  chains: [base, baseSepolia],
  connectors: [
    baseAccount({ appName: "Miorail" }),
    coinbaseWallet({ appName: "Miorail" }),
    injected(),
  ],
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
  },
});
