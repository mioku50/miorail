import { app } from './app';
import { getMiorailProductMigrationFlags } from './lib/productMigrationConfig';
import { resolveEarnContractPreflightV1 } from './lib/earnPreflight';

const port = process.env.PORT || 3000;

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
  const server = app.listen(port, () => {
    console.log(`API Server listening on port ${port}`);
    console.log(`API CHAIN_ENV=${process.env.CHAIN_ENV || 'sepolia'}`);
    void warmEarnContractPreflight();
  });
  return server;
}

// Start server if run directly
if (require.main === module) {
  startServer();
}

export { app };
