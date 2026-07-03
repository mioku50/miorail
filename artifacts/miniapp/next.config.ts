import type { NextConfig } from "next";

const API_URL = process.env.MIOAGENT_API_URL || "http://localhost:8080";

const nextConfig: NextConfig = {
  // Workspace packages ship TS source; Next.js must transpile them.
  transpilePackages: ["@mioagent/api-client-react", "@mioagent/api-spec", "@mioagent/ui"],
  webpack: (config) => {
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
  // Proxy /api to the MioAgent api-server so the shared data hooks hit the same
  // backend as the web interface (no logic fork).
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;
