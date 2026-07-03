import type { NextConfig } from "next";

const API_URL = process.env.MIOAGENT_API_URL || "http://localhost:8080";

const nextConfig: NextConfig = {
  // Workspace packages ship TS source; Next.js must transpile them.
  transpilePackages: ["@mioagent/api-client-react", "@mioagent/api-spec", "@mioagent/ui"],
  webpack: (config) => {
    // pino-pretty / lokijs / encoding are optional server deps of the api-client
    // workspace packages — never needed in the browser. `accounts` is an optional
    // peer of @wagmi/core's `tempo` export (pulled in via wagmi/connectors); it is
    // only used by the tempo connector we never import, so webpack must not try to
    // resolve it (the dynamic import's .catch handles the absence at runtime).
    config.externals.push("pino-pretty", "lokijs", "encoding", "accounts");
    // viem 2.53's chains index re-exports the "Tempo" chain, whose ox/_esm/tempo
    // helper uses a dynamic require webpack can't statically analyze. It is never
    // evaluated at runtime (we only use base / baseSepolia) — silence just that
    // benign critical-dependency warning so the build output stays clean.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      (warning: { message?: string; module?: { resource?: string } }) =>
        !!warning.message?.includes("Critical dependency") &&
        !!warning.module?.resource?.includes("ox/_esm/tempo"),
    ];
    return config;
  },
  // Required for the Base Account popup (sign-in / connect). `same-origin` would
  // block the popup; `same-origin-allow-popups` lets it communicate back. See
  // @base-org/account docs.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" }],
      },
    ];
  },
  // Proxy /api to the MioAgent api-server so the shared data hooks hit the same
  // backend as the web interface (no logic fork).
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;
