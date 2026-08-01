import { createInterface } from 'node:readline/promises';

import {
  O1ClientError,
  o1ConfigFromEnvV1,
  o1OrderUrlV1,
  renderCompatibilityReportV1,
  requestUnsignedOrderV1,
  runCompatibilityGateV1,
  type B20PreflightVerdictV1,
  type O1TradingOrderRequestV1,
} from '@mioagent/o1-compat';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// T67D §4 — `pnpm o1:compat [-- --live --b20=<verdict>]`
//
// Fixtures by default. The gate's verdict does not depend on a live call — the
// blockers are properties of the protocol — so the default path needs no
// network, no token, and no vendor availability.
//
// `--live` requests an UNSIGNED order batch and decodes it. It:
//   * signs nothing, and cannot: there is no signer in this process;
//   * does not substitute the signature placeholder;
//   * does not call /order/complete;
//   * creates no approval and moves no funds.
//
// It is gated three times: the flag, O1_TRADING_COMPAT_LIVE=true, and an
// interactive confirmation printed with the exact parameters. Three gates for a
// read-only call is deliberate — this is the only code path in Miorail that
// talks to a provider whose documented flow wants a private key, and the cost
// of it quietly becoming routine is higher than the cost of typing yes.
// ---------------------------------------------------------------------------

const B20_VERDICTS: B20PreflightVerdictV1[] = [
  'not_run',
  'not_b20',
  'clear',
  'blocked',
  'unsupported_variant',
];

interface ArgsV1 {
  live: boolean;
  b20: B20PreflightVerdictV1;
  yes: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): ArgsV1 {
  const args: ArgsV1 = { live: false, b20: 'not_run', yes: false, help: false };
  for (const argument of argv) {
    if (argument === '--') continue;
    if (argument === '--live') {
      args.live = true;
      continue;
    }
    if (argument === '--yes') {
      args.yes = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      args.help = true;
      continue;
    }
    const match = /^--b20=(.*)$/.exec(argument);
    if (match && B20_VERDICTS.includes(match[1] as B20PreflightVerdictV1)) {
      args.b20 = match[1] as B20PreflightVerdictV1;
      continue;
    }
    throw new Error(`unrecognised argument: ${argument}`);
  }
  return args;
}

function usage(): void {
  console.log(
    [
      'usage: pnpm o1:compat [-- <options>]',
      '',
      '  --b20=<verdict>   not_run (default) | not_b20 | clear | blocked | unsupported_variant',
      '  --live            request an UNSIGNED order batch and decode it',
      '  --yes             skip the interactive confirmation (CI only)',
      '',
      'Without --live the gate runs entirely on pinned fixtures and makes no',
      'network call. See docs/research/O1_TRADING_API_COMPATIBILITY.md.',
    ].join('\n'),
  );
}

/** The live subject. Deliberately small and fixed: this exists to observe the
 * response SHAPE, not to price a trade. */
function liveRequestV1(): O1TradingOrderRequestV1 {
  return {
    schemaVersion: 'o1-trading-order-request/v1',
    networkId: 8453,
    signerAddress: '0x0000000000000000000000000000000000000001',
    tokenAddress: '0x4200000000000000000000000000000000000006',
    quoteTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    uiAmount: '1',
    direction: 'buy',
    slippageBps: 100,
    mevProtection: true,
  };
}

async function confirmLive(request: O1TradingOrderRequestV1): Promise<boolean> {
  console.log('\n   LIVE PROBE — the exact request that will be sent:');
  console.log(`     POST ${o1OrderUrlV1()}`);
  for (const [key, value] of Object.entries(request)) {
    if (key === 'schemaVersion') continue;
    console.log(`       ${key}: ${String(value)}`);
  }
  console.log('     Nothing is signed. No approval is created. No funds move.');
  console.log('     /order/complete is NOT called and is not implemented.\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('   Send this request? [yes/N] ');
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  console.log('T67D o1 Trading API compatibility gate');
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  let request: O1TradingOrderRequestV1 | undefined;
  let response;

  if (args.live) {
    const config = o1ConfigFromEnvV1();
    if (!config.live) {
      console.error('\nFAILED — --live requires O1_TRADING_COMPAT_LIVE=true.');
      process.exitCode = 1;
      return;
    }
    if (!config.configured) {
      console.error(`\nFAILED — --live requires ${config.missing.join(', ')}.`);
      process.exitCode = 1;
      return;
    }
    request = liveRequestV1();
    if (!args.yes && !(await confirmLive(request))) {
      console.log('\nCancelled. Nothing was sent.');
      return;
    }
    try {
      response = await requestUnsignedOrderV1(request);
      console.log(`   · received ${response.transactions.length} unsigned transaction(s)`);
    } catch (error) {
      // A provider failure is not a verdict about compatibility. Report it and
      // fall back to the fixture gate rather than pretending the probe answered.
      const code = error instanceof O1ClientError ? error.code : 'o1_network_error';
      console.warn(`   ⚠ live probe failed (${code}); the report below is fixtures-only`);
      request = undefined;
      response = undefined;
    }
  }

  const report = runCompatibilityGateV1({
    request,
    response,
    b20: args.b20,
    checkedAt: new Date(),
  });

  console.log(`\n${renderCompatibilityReportV1(report)}\n`);

  if (report.verdict === 'incompatible') {
    console.log('o1.exchange stays `documented` / execution disabled / compatibility under_review.');
    console.log('See docs/research/O1_TRADING_API_COMPATIBILITY.md for the recorded sources.');
  }
  // Exit 0: reaching a verdict is the command succeeding. An `incompatible`
  // finding is the answer, not a failure of the tool — a non-zero exit here
  // would make a correct result look like a broken build.
}

main().catch((error: unknown) => {
  console.error('FAILED —', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
