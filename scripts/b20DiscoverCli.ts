import {
  LAUNCH_CONFIRMATIONS_V1,
  LAUNCH_MAX_LAUNCHES_V1,
  LAUNCH_MAX_RANGE_V1,
  LAUNCH_REWIND_DEPTH_V1,
} from '@mioagent/b20-control';
import type { B20DiscoverRunResultV1 } from '@mioagent/route-storage';

import type { DiscoverPassConfigV1, DiscoverPassOutcomeV1 } from './b20DiscoverRun.js';

// Argument parsing, exit codes and the printed summary for `pnpm b20:discover`,
// kept separate from the pass itself so all three can be tested without a
// database, an endpoint or a clock.
//
// Every default here bounds something a timer would otherwise spend without
// asking: how many blocks one call may ask for, how many launches one commit
// may carry, how long a pass may take, how far a reorg sends us back.

export interface B20DiscoverArgsV1 extends DiscoverPassConfigV1 {
  dryRun: boolean;
  help: boolean;
}

export class B20DiscoverArgError extends Error {}

export const B20_DISCOVER_DEFAULTS_V1 = {
  maxRange: LAUNCH_MAX_RANGE_V1,
  maxLaunches: LAUNCH_MAX_LAUNCHES_V1,
  confirmations: LAUNCH_CONFIRMATIONS_V1,
  rewindDepth: LAUNCH_REWIND_DEPTH_V1,
  /** Ten minutes. A pass is three RPC calls, so this is a hung-endpoint
   * backstop rather than a work budget. */
  maxRuntimeMs: 10 * 60 * 1000,
  /** Longer than a pass can take, short enough that a killed worker frees the
   * cursor within one timer interval. */
  leaseTtlMs: 15 * 60 * 1000,
} as const;

/**
 * Exit codes, so a timer can tell "nothing to do" from "somebody must look".
 *
 * `run_already_active` gets its own non-alarming code: two overlapping timer
 * firings are expected, and turning that into a page would train an operator
 * to ignore the one that matters.
 */
export const B20_DISCOVER_EXIT_CODES_V1: Record<B20DiscoverRunResultV1, number> = {
  success: 0,
  nothing_confirmed: 0,
  budget_exhausted: 0,
  reorg_rewound: 0,
  endpoint_unavailable: 1,
  storage_unavailable: 1,
  /** The event shape changed. The feed is stopped until somebody looks. */
  decoder_mismatch: 2,
  run_already_active: 3,
  configuration_required: 4,
};

/** Results that mean the cursor did not move and nothing was stored. */
export const B20_DISCOVER_REFUSALS_V1: readonly B20DiscoverRunResultV1[] = [
  'endpoint_unavailable',
  'decoder_mismatch',
  'storage_unavailable',
  'configuration_required',
  'run_already_active',
];

export function parseB20DiscoverArgsV1(argv: readonly string[], env: NodeJS.ProcessEnv = {}): B20DiscoverArgsV1 {
  const args: B20DiscoverArgsV1 = {
    maxRange: B20_DISCOVER_DEFAULTS_V1.maxRange,
    maxLaunches: B20_DISCOVER_DEFAULTS_V1.maxLaunches,
    confirmations: B20_DISCOVER_DEFAULTS_V1.confirmations,
    maxRuntimeMs: B20_DISCOVER_DEFAULTS_V1.maxRuntimeMs,
    rewindDepth: B20_DISCOVER_DEFAULTS_V1.rewindDepth,
    leaseTtlMs: B20_DISCOVER_DEFAULTS_V1.leaseTtlMs,
    startBlock: parseStartBlockV1(env.B20_DISCOVER_START_BLOCK),
    dryRun: false,
    help: false,
  };

  for (const argument of argv) {
    if (argument === '--') continue;
    if (argument === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      args.help = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (!match) throw new B20DiscoverArgError(`unrecognised argument: ${argument}`);
    const [, name, value] = match as unknown as [string, string, string];
    switch (name) {
      case 'max-range':
        args.maxRange = positiveIntV1('--max-range', value);
        break;
      case 'max-launches':
        args.maxLaunches = positiveIntV1('--max-launches', value);
        break;
      case 'confirmations':
        args.confirmations = nonNegativeIntV1('--confirmations', value);
        break;
      case 'rewind-depth':
        args.rewindDepth = positiveIntV1('--rewind-depth', value);
        break;
      case 'max-runtime':
        args.maxRuntimeMs = parseDurationMsV1('--max-runtime', value);
        break;
      case 'lease-ttl':
        args.leaseTtlMs = parseDurationMsV1('--lease-ttl', value);
        break;
      case 'start-block':
        args.startBlock = nonNegativeIntV1('--start-block', value);
        break;
      default:
        throw new B20DiscoverArgError(`unrecognised argument: --${name}`);
    }
  }
  return args;
}

/** §4 — a configured start block, or null. Never a guess: an unreadable value
 * must not silently become "somewhere recent". */
export function parseStartBlockV1(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!/^\d+$/.test(value)) {
    throw new B20DiscoverArgError('B20_DISCOVER_START_BLOCK must be a non-negative block number');
  }
  const block = Number(value);
  if (!Number.isSafeInteger(block)) {
    throw new B20DiscoverArgError('B20_DISCOVER_START_BLOCK is not a usable block number');
  }
  return block;
}

function positiveIntV1(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new B20DiscoverArgError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeIntV1(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new B20DiscoverArgError(`${name} must be a non-negative integer`);
  return value;
}

/** `30s`, `10m`, `2h`, `1d` or plain milliseconds. */
export function parseDurationMsV1(name: string, raw: string): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!match) throw new B20DiscoverArgError(`${name} must be a duration like 30s, 10m, 2h or 1d`);
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) throw new B20DiscoverArgError(`${name} must be greater than zero`);
  const unit = match[2] ?? 'ms';
  return value * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1);
}

const number = (value: string | null): string =>
  value === null ? '—' : Number(value).toLocaleString('en-US');

/**
 * §13 — what one run prints.
 *
 * A refusal says what did NOT happen, in as many words: which state, that the
 * cursor is unchanged, and that nothing from the refused range was stored.
 * "Error: something went wrong" would leave an operator unable to tell a
 * five-minute outage from a feed that has silently stopped.
 */
export function formatB20DiscoverSummaryV1(outcome: DiscoverPassOutcomeV1): string {
  if (B20_DISCOVER_REFUSALS_V1.includes(outcome.result)) {
    const lines = [
      'B20 Discover stopped',
      `State: ${outcome.result}`,
      `Cursor unchanged: ${number(outcome.startCursorBlock)}`,
    ];
    if (outcome.refusal) lines.push(`Decoder refusal: ${outcome.refusal}`);
    lines.push('No launches from the refused range were stored.');
    if (outcome.result === 'configuration_required') {
      lines.push('Set B20_DISCOVER_START_BLOCK to the first block this feed should read.');
    }
    return lines.join('\n');
  }

  if (outcome.result === 'reorg_rewound') {
    return [
      'B20 Discover rewound',
      `State: reorg_rewound`,
      `Cursor: ${number(outcome.startCursorBlock)} → ${number(outcome.endCursorBlock)}`,
      `Launches marked non-canonical: ${outcome.markedNonCanonical}`,
      'The blocks above the rewind point will be read again.',
    ].join('\n');
  }

  return [
    'B20 Discover ingestion',
    `Start cursor: ${number(outcome.startCursorBlock)}`,
    `Confirmed head: ${number(outcome.confirmedHead)}`,
    `Scanned: ${
      outcome.scannedFromBlock === null
        ? 'nothing past the confirmation window'
        : `${number(outcome.scannedFromBlock)}–${number(outcome.scannedToBlock)}`
    }`,
    `Launches decoded: ${outcome.launchesRead}`,
    `New launches stored: ${outcome.launchesInserted}`,
    `Duplicates: ${outcome.duplicates}`,
    `End cursor: ${number(outcome.endCursorBlock)}`,
    `Budget exhausted: ${outcome.budgetExhausted ? 'yes — the remainder is not_checked' : 'no'}`,
  ].join('\n');
}

export function printB20DiscoverUsageV1(): void {
  console.log(`
Usage: pnpm b20:discover [-- <options>]

Reads new B20Created logs from the pinned factory and stores them, advancing a
durable cursor. Read-only against Base: there is no signer in this process and
nothing it does can move an asset.

One invocation performs ONE bounded pass and exits, so it is safe on a timer.
Two overlapping runs do not both advance the cursor — the second exits
run_already_active.

Options:
  --max-range=<n>       Widest eth_getLogs window (default ${B20_DISCOVER_DEFAULTS_V1.maxRange})
  --max-launches=<n>    Soft cap per pass, applied at block boundaries (default ${B20_DISCOVER_DEFAULTS_V1.maxLaunches})
  --confirmations=<n>   Blocks left below the head (default ${B20_DISCOVER_DEFAULTS_V1.confirmations})
  --rewind-depth=<n>    How far a reorg sends the cursor back (default ${B20_DISCOVER_DEFAULTS_V1.rewindDepth})
  --max-runtime=<dur>   Wall clock for one pass (default 10m)
  --lease-ttl=<dur>     How long a crashed worker holds the cursor (default 15m)
  --start-block=<n>     Bootstrap block, used ONLY when no cursor exists
  --dry-run             Report what would be read. Nothing is written.
  --help                This message.

Requires BASE_MAINNET_RPC_URL and, on a cold start, B20_DISCOVER_START_BLOCK —
there is no "recent enough" default, because a guess would silently define away
every launch before it.

Exit codes: 0 ok · 1 endpoint or storage unavailable · 2 decoder mismatch
(the event shape changed; the feed is stopped until somebody looks) ·
3 another run holds the cursor · 4 start block not configured.
`);
}
