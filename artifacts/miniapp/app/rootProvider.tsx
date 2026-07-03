"use client";
import { ReactNode, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { ThemeProvider } from "@mioagent/ui";
import { wagmiConfig } from "./wagmi";

// Standard web-app providers (the previous OnchainKit wrapper was removed).
// WagmiProvider must wrap QueryClientProvider. ThemeProvider (dark-first) is
// shared with the web interface via @mioagent/ui.
export function RootProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <ThemeProvider>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}
