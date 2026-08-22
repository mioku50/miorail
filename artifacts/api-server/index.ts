import { app } from './app';
import { getMiorailProductMigrationFlags } from './lib/productMigrationConfig';
import { resolveEarnContractPreflightV1 } from './lib/earnPreflight';
import { probeSimulationProviderHealthV1 } from './lib/swapSimulation';

// Bind to loopback unless an operator asks for otherwise. Nginx terminates TLS
// and proxies to 127.0.0.1, so nothing needs to reach this process over the
// network directly. A default of `0.0.0.0` published every route on the public
// interface beside the proxy — same routes, but without the proxy's
// Strict-Transport-Security, X-Forwarded-Proto or rate limiting, and reachable
// on a port no certificate covers.
//
// Read at call time rather than at import: the bind is part of what a caller
// chooses, and a module-load read cannot be exercised by a test.
export function resolveBindV1(env: NodeJS.ProcessEnv = process.env): {
  host: string;
  port: number;
} {
  // An empty value is treated as absent for both: `listen(port, '')` binds every
  // interface, and `Number('')` is 0, which asks the OS for a random port. A
  // blank line in an env file must not silently change either one.
  const rawPort = (env.PORT ?? '').trim();
  const parsedPort = Number(rawPort);
  return {
    host: env.HOST && env.HOST.trim().length > 0 ? env.HOST.trim() : '127.0.0.1',
    port: rawPort.length > 0 && Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3000,
  };
}

// T62.1 §1 — prime the cached earn contract preflight at startup so the first
// earn request consults an in-memory result. Only runs when the earn flag is
// ON (no RPC while the surface is disabled); non-blocking and best-effort — the
// gate re-runs it lazily anyway, and a failure only logs (the gate itself is
// what fails a request closed with a 503).
async function warmEarnContractPreflight(): Promise<void> {
  const flags = getMiorailProductMigrationFlags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.earnRouteV1) return;
  try {
    const verification = await resolveEarnContractPreflightV1();
    if (verification.ok) {
      console.log('Earn contract preflight passed — earn routes enabled');
    } else {
      console.warn(`Earn contract preflight FAILED — earn routes will 503: ${verification.failures.join(', ')}`);
    }
  } catch (error) {
    console.warn(`Earn contract preflight threw: ${(error as Error).message}`);
  }
}

export function startServer() {
  const { host, port } = resolveBindV1();
  const server = app.listen(port, host, () => {
    console.log(`API Server listening on ${host}:${port}`);
    console.log(`API CHAIN_ENV=${process.env.CHAIN_ENV || 'sepolia'}`);
    void warmEarnContractPreflight();
    // Learn at boot whether the simulator can serve requests. A key that is
    // present but out of monthly capacity used to leave every capability read
    // claiming a batch simulation this deployment could not run.
    void probeSimulationProviderHealthV1().then((health) => {
      if (health.batchProven === false) {
        console.warn(`Simulation provider is not serving requests (${health.lastErrorCode}) — provider routes needing a simulation report unavailable`);
      }
    });
  });
  return server;
}

// Start server if run directly
if (require.main === module) {
  startServer();
}

export { app };
