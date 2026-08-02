// Argument parsing for `pnpm b20:sweep`, kept separate so it can be tested
// without a database, an endpoint or a clock.
//
// Every default here is a spending decision. The sweep reads a metered
// endpoint on a timer with nobody watching, so the flags that bound it —
// how many tokens, how old, how long — have defaults that are safe to leave
// alone rather than values an operator is expected to discover.

export interface B20SweepArgsV1 {
  /** Most tokens to read in one run. */
  limit: number;
  /** A token read more recently than this is left alone. */
  minAgeMs: number;
  /** Wall-clock budget. Past it the run stops and the rest keep their place in
   * the queue — an unread token is not a read one. */
  budgetMs: number;
  dryRun: boolean;
  help: boolean;
}

export class B20SweepArgError extends Error {}

export const B20_SWEEP_DEFAULTS_V1 = {
  /** One run's worth of tokens. At ~27s per card on the public endpoint this is
   * already more than the default budget can reach; on a keyed endpoint it is
   * a couple of minutes. */
  limit: 50,
  /** Control changes happen on the order of hours. Reading a token every hour
   * is frequent enough to catch one the same day and cheap enough to leave
   * running. */
  minAgeMs: 60 * 60 * 1000,
  /** Fifteen minutes. A sweep is a background job, not a request, but it still
   * has to end — a run that overlaps the next one would double the read rate
   * against an endpoint that is already the binding constraint. */
  budgetMs: 15 * 60 * 1000,
} as const;

/** `30s`, `10m`, `2h`, `1d` or a plain number of milliseconds. */
export function parseDurationMsV1(name: string, raw: string): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!match) throw new B20SweepArgError(`${name} must be a duration like 30s, 10m, 2h or 1d`);
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) throw new B20SweepArgError(`${name} must be greater than zero`);
  const unit = match[2] ?? 'ms';
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1;
  return value * scale;
}

export function parseB20SweepArgsV1(argv: readonly string[]): B20SweepArgsV1 {
  const args: B20SweepArgsV1 = {
    limit: B20_SWEEP_DEFAULTS_V1.limit,
    minAgeMs: B20_SWEEP_DEFAULTS_V1.minAgeMs,
    budgetMs: B20_SWEEP_DEFAULTS_V1.budgetMs,
    dryRun: false,
    help: false,
  };
  for (const argument of argv) {
    // `pnpm b20:sweep -- --dry-run` forwards the separator itself.
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
    if (!match) throw new B20SweepArgError(`unrecognised argument: ${argument}`);
    const [, name, value] = match as unknown as [string, string, string];
    switch (name) {
      case 'limit': {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new B20SweepArgError('--limit must be a positive integer');
        }
        args.limit = limit;
        break;
      }
      case 'min-age':
        args.minAgeMs = parseDurationMsV1('--min-age', value);
        break;
      case 'budget':
        args.budgetMs = parseDurationMsV1('--budget', value);
        break;
      default:
        throw new B20SweepArgError(`unrecognised argument: --${name}`);
    }
  }
  return args;
}

export function printB20SweepUsageV1(): void {
  console.log(`
Usage: pnpm b20:sweep [-- <options>]

Reads the B20 control state of every watched token that has gone unread for
long enough, and stores what it finds. Read-only against the chain: there is no
signer in this process and nothing it does can move an asset.

Options:
  --limit=<n>        Most tokens to read in one run (default ${B20_SWEEP_DEFAULTS_V1.limit})
  --min-age=<dur>    Leave tokens read more recently than this alone (default 1h)
  --budget=<dur>     Stop after this long; the rest keep their place (default 15m)
  --dry-run          List what would be read. The chain is not touched.
  --help             This message.

Durations are 30s, 10m, 2h, 1d or plain milliseconds.

Requires BASE_MAINNET_RPC_URL. On the public endpoint one token costs ~27
seconds of paced reads, so a keyed endpoint is what makes this worth running
often.
`);
}
