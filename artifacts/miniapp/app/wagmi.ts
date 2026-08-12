import { cookieStorage, createConfig, createStorage, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { baseAccount, injected } from "wagmi/connectors";

// Standard web-app wallet config (no OnchainKit / MiniKit). The Base Account SDK
// Base App supplies an injected EIP-1193 provider, so it must be first. The
// Base Account SDK connector is the explicit popup fallback in a normal browser.
// No-custody: the wallet owns every signature and broadcast. Miorail surfaces
// may request explicit approval for exact server-prepared calls; the server
// never signs or broadcasts and Base MCP remains a separate approval path.
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
