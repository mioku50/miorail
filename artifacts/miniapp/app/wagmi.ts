import { cookieStorage, createConfig, createStorage, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { baseAccount, injected } from "wagmi/connectors";

// Standard web-app wallet config (no OnchainKit / MiniKit). The Base Account SDK
// Base App supplies an injected EIP-1193 provider, so it must be first. The
// Base Account SDK connector is the explicit popup fallback in a normal browser.
// No-custody: this
// provides wallet context / identity only — no signing or broadcast from this UI
// (execution stays via the Base MCP approval URL).
export const wagmiConfig = createConfig({
  chains: [base, baseSepolia],
  connectors: [
    injected(),
    baseAccount({ appName: "Miorail" }),
  ],
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
  },
});
