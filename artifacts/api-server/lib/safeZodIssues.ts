// ---------------------------------------------------------------------------
// T73-LIVE-DB §4 — a ZodError you can act on, without leaking what it wrapped.
//
// Production said this, and only this:
//
//   { where: "b20-opportunity-feed", error: "ZodError" }
//
// Which narrows the cause to "some field somewhere in a page of launches did
// not match its schema". The endpoint had been 500ing for hours and nobody
// could tell whether it was a timestamp, a numeric, a null or a missing column
// — so the next step was always to reproduce it by hand.
//
// The obvious fix — log the ZodError — is wrong. Zod's own message embeds the
// RECEIVED VALUE, and the values crossing this particular boundary include
// wallet addresses, route hashes and token identities. So this extracts the
// SHAPE of each failure and never the content: where it was, what was wanted,
// and what kind of thing arrived.
//
// `receivedType` is deliberately a category rather than a value. "Date" is the
// entire diagnosis when a schema wanted an ISO string; the actual instant it
// held adds nothing and belongs to a user.
// ---------------------------------------------------------------------------

export interface SafeZodIssueV1 {
  /** Zod's own code: invalid_type, invalid_string, too_small, … */
  code: string;
  /** Dotted path, with array indices. `rows.0.observation.measuredAt`. */
  path: string;
  /** What the schema wanted, when Zod says so. */
  expected?: string;
  /** A CATEGORY of what arrived. Never the value itself. */
  receivedType: string;
}

/** The bounded vocabulary. Anything unrecognised becomes its typeof, which is
 * already a category — there is no branch here that can return a value. */
export function safeValueCategoryV1(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'InvalidDate' : 'Date';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'number') return Number.isInteger(value) ? 'number(int)' : 'number(float)';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return typeof value;
}

/**
 * An error message with every value-shaped thing removed.
 *
 * A viem error is the reason this exists: its message quotes the arguments the
 * call was made with, and for a spend permission those arguments are a wallet
 * address, a token, a salt and a signature. The sentence is worth keeping; the
 * substitutions are not.
 */
export function safeErrorMessageV1(message: string, limit = 300): string {
  return message
    .replace(/0x[0-9a-fA-F]{8,}/g, '0x…')
    .replace(/https?:\/\/\S+/g, '(url)')
    .replace(/\s+/g, ' ')
    .slice(0, limit);
}

/**
 * Where a throw came from, as one frame, with no absolute path.
 *
 * A stack answers "which line" — the single most useful thing about an
 * unexpected error — but it also prints the deploy's directory layout. This
 * keeps the repo-relative tail and drops everything above it, and skips
 * node_modules frames so the frame named is one somebody here can open.
 */
export function firstOwnFrameV1(stack: string | undefined): string | null {
  if (!stack) return null;
  for (const line of stack.split('\n').slice(1)) {
    if (line.includes('node_modules') || line.includes('node:internal')) continue;
    const match = /\(?((?:[\w.-]+\/)*[\w.-]+\.[cm]?[jt]s:\d+:\d+)\)?\s*$/.exec(line.trim());
    if (match) return match[1]!.split('/').slice(-3).join('/');
  }
  return null;
}

interface ZodLikeIssueV1 {
  code?: unknown;
  path?: unknown;
  expected?: unknown;
  received?: unknown;
}

/** Walks the parsed input to recover what actually sat at an issue's path.
 * Zod reports `received` only for `invalid_type`, and the interesting failures
 * are the ones where it does not. */
function valueAtPathV1(root: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = root;
  for (const step of path) {
    if (current === null || current === undefined) return current;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}

/**
 * Extracts safe diagnostics from anything that looks like a ZodError.
 *
 * Takes the parsed INPUT as well, because the received category is the single
 * most useful field and Zod does not always carry it. Bounded at eight issues:
 * a schema mismatch repeats identically down a page of fifty rows, and the
 * ninth copy tells an operator nothing the first did not.
 */
export function safeZodIssuesV1(error: unknown, input?: unknown, limit = 8): SafeZodIssueV1[] | null {
  const issues = (error as { issues?: unknown })?.issues;
  if (!Array.isArray(issues)) return null;

  return issues.slice(0, limit).map((raw): SafeZodIssueV1 => {
    const issue = raw as ZodLikeIssueV1;
    const path = Array.isArray(issue.path) ? (issue.path as (string | number)[]) : [];
    // Zod's `received` is a type name for invalid_type; for everything else the
    // real value has to be recovered from the input to be categorised.
    const received =
      typeof issue.received === 'string' && issue.received.length > 0
        ? issue.received
        : safeValueCategoryV1(valueAtPathV1(input, path));
    return {
      code: typeof issue.code === 'string' ? issue.code : 'unknown',
      path: path.length === 0 ? '(root)' : path.join('.'),
      ...(typeof issue.expected === 'string' ? { expected: issue.expected } : {}),
      receivedType: received,
    };
  });
}
