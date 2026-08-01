// Shared argument parsing for the two T67C.1 commands. Kept separate so both
// accept exactly the same flags — an operator who learned `--dry-run` on one
// should not discover it means something else on the other.

export interface OutcomeCliArgsV1 {
  dryRun: boolean;
  provider: string | null;
  from: Date | null;
  to: Date | null;
  limit: number | null;
  help: boolean;
}

export class OutcomeCliArgError extends Error {}

const SUPPORTED_PROVIDERS_V1 = ['uniswap', 'kyberswap', 'aerodrome'];

function parseDate(name: string, raw: string): Date {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new OutcomeCliArgError(`${name} is not a valid date: ${raw}`);
  }
  return parsed;
}

export function parseOutcomeCliArgsV1(argv: readonly string[]): OutcomeCliArgsV1 {
  const args: OutcomeCliArgsV1 = {
    dryRun: false,
    provider: null,
    from: null,
    to: null,
    limit: null,
    help: false,
  };
  for (const argument of argv) {
    // `pnpm outcomes:backfill -- --dry-run` forwards the separator itself, so
    // the documented invocation died on its own documentation. Skipped rather
    // than stripped by the caller: every launcher spells this differently and
    // the script is the one place that sees the result.
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
    if (!match) throw new OutcomeCliArgError(`unrecognised argument: ${argument}`);
    const [, name, value] = match as unknown as [string, string, string];
    switch (name) {
      case 'provider':
        if (!SUPPORTED_PROVIDERS_V1.includes(value)) {
          // Refused rather than passed through: an unknown provider would
          // silently match nothing and read as "no history", which is the one
          // answer a filter must never invent.
          throw new OutcomeCliArgError(
            `--provider must be one of ${SUPPORTED_PROVIDERS_V1.join(', ')}`,
          );
        }
        args.provider = value;
        break;
      case 'from':
        args.from = parseDate('--from', value);
        break;
      case 'to':
        args.to = parseDate('--to', value);
        break;
      case 'limit': {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new OutcomeCliArgError('--limit must be a positive integer');
        }
        args.limit = limit;
        break;
      }
      default:
        throw new OutcomeCliArgError(`unrecognised argument: --${name}`);
    }
  }
  if (args.from && args.to && args.from > args.to) {
    throw new OutcomeCliArgError('--from must not be later than --to');
  }
  return args;
}

export function printOutcomeCliUsageV1(command: string): void {
  console.log(
    [
      `usage: pnpm ${command} [-- <options>]`,
      '',
      '  --dry-run              report what would change and write nothing',
      '  --provider=<id>        uniswap | kyberswap | aerodrome',
      '  --from=<iso-date>      lower bound (inclusive)',
      '  --to=<iso-date>        upper bound (inclusive)',
      '  --limit=<n>            stop after n rows',
    ].join('\n'),
  );
}
