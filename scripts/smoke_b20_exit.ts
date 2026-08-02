import { createAerodromeReaderV1 } from '@mioagent/swap-adapters';
import { bpsPercentLabelV1, OPPORTUNITY_REJECTION_COPY_V1 } from '@mioagent/opportunity-rail';

import { analyseExitV1 } from '../artifacts/api-server/lib/exitAnalysis.js';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// T68C — `pnpm smoke:b20-exit` against Base mainnet.
//
// Asks the real Aerodrome Router whether a real position in a real token can be
// exited. Read-only: `getAmountsOut` is a view function, there is no signer in
// this process, and nothing here can move an asset.
//
// It passes whether or not the token qualifies. A token with no pool is a
// correct answer, not a failed smoke — what is being checked is that the
// measurement path works and that its refusals are honest.
// ---------------------------------------------------------------------------

const CANONICAL_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

function required(...names: string[]): string {
  for (const name of names) {
    const value = (process.env[name] ?? '').trim();
    if (value) return value;
  }
  throw new Error(`${names[0]} is not set`);
}

async function main(): Promise<void> {
  console.log('B20 exit check smoke — Base mainnet (8453)');
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  const rpcUrl = required('BASE_MAINNET_RPC_URL', 'BASE_RPC_URL');
  const token = required('SMOKE_B20_TOKEN_ADDRESS').toLowerCase() as `0x${string}`;
  const positionAtomic = (process.env.SMOKE_EXIT_POSITION_ATOMIC ?? '100000000').trim();

  // Never the URL itself.
  line('RPC endpoint', 'configured');
  line('Token', token);
  line('Position', `${positionAtomic} atomic USDC`);
  console.log('');

  const started = Date.now();
  const analysis = await analyseExitV1({
    reader: createAerodromeReaderV1({ rpcUrl, timeoutMs: 15_000 }),
    tokenAddress: token,
    quoteAsset: CANONICAL_USDC,
    profile: { positionAtomic, maxRoundTripBps: 300, maxSlippageBps: 300 },
    // The smoke is about the MEASUREMENT path. Controls are read by
    // smoke:b20-control, and passing an open set here keeps the two smokes
    // testing one thing each.
    controls: {
      factoryConfirmed: true,
      transfersPaused: false,
      transferPolicyActive: false,
      controlsFullyRead: true,
    },
  });

  line('Verdict', analysis.verdict.status);
  if (analysis.verdict.status === 'rejected') {
    line('Reason', OPPORTUNITY_REJECTION_COPY_V1[analysis.verdict.reason]);
  } else if (analysis.verdict.status === 'unmeasured') {
    // The figures below may still be worth reading — they just do not add up to
    // a claim while quotes were going missing.
    line('Reason', 'Too many quotes went unanswered to conclude anything about this token.');
  } else {
    line('Measurement', analysis.verdict.measurement);
    line('Optimistic', String(analysis.verdict.optimistic));
  }
  line('Round trip', analysis.roundTrip ? bpsPercentLabelV1(analysis.roundTrip.costBps) : 'not measured');
  line('Entry route', String(analysis.entryRouteFound));
  line('Exit route', String(analysis.exitRouteFound));
  line('Exit capacity', analysis.exitCapacity.capacityAtomic ?? 'none at this tolerance');
  line('First failing size', analysis.exitCapacity.firstFailingAtomic ?? 'none failed');
  line('Sizes probed', String(analysis.exitCapacity.probeCount));
  line('Depth informative', String(analysis.capacityInformative));
  line('Impact reference', analysis.referenceSizeAtomic ?? 'nothing priced');
  line('Router calls', String(analysis.quotesUsed));
  line('Endpoint degraded', String(analysis.endpointDegraded));
  line('Elapsed', `${Math.round((Date.now() - started) / 100) / 10}s`);

  if (analysis.endpointDegraded) {
    console.log(
      '\n⚠ Some quotes did not come back. That is the endpoint, not the token — an\n' +
        '  incomplete read is not a finding about liquidity. Point BASE_MAINNET_RPC_URL\n' +
        '  at a keyed endpoint for a complete answer.',
    );
  }
  console.log('\nOK — the router answered, nothing was prepared, and no key left this process.');
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
