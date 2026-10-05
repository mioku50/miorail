"use client";
import { ReactNode, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { ThemeProvider } from "@mioagent/ui";
import { wagmiConfig } from "./wagmi";

// Standard web-app providers (the previous OnchainKit wrapper was removed).
// WagmiProvider must wrap QueryClientProvider. ThemeProvider (dark-first) is
// shared with the web interface via @mioagent/ui.
export function RootProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  useEffect(() => {
    const fonts = document.getElementById("miorail-fonts") as HTMLLinkElement | null;
    if (!fonts) return;
    const activate = () => { fonts.media = "all"; };
    if (fonts.sheet) activate();
    else fonts.addEventListener("load", activate, { once: true });
    return () => fonts.removeEventListener("load", activate);
  }, []);
  return (
    <ThemeProvider>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}
