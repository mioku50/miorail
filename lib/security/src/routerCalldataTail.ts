/**
 * Nothing, or exactly one ERC-8021 attribution suffix (schema 0): ASCII codes,
 * their length, a zero byte, the sixteen-byte marker. A router reads nothing
 * after its own arguments, so this is the one tail a decoded call may carry;
 * anything else behind the arguments is unexplained and refused.
 *
 * `tail` is lowercase hex without `0x`.
 */
export function attributionSuffixOrNothingV1(tail: string): boolean {
  if (tail === '') return true;
  const match = /^((?:[0-9a-f]{2}){1,64})([0-9a-f]{2})00(?:8021){8}$/.exec(tail);
  if (!match) return false;
  const codes = match[1]!;
  if (parseInt(match[2]!, 16) !== codes.length / 2) return false;
  return (codes.match(/.{2}/g) ?? []).every((byte) => {
    const value = parseInt(byte, 16);
    return value >= 0x21 && value <= 0x7e;
  });
}

/**
 * The tail without the one attribution suffix it may end with, read backwards
 * from the marker; the tail itself when it ends with none; null when it ends
 * with the marker but not with a whole suffix.
 */
function beforeAttributionSuffixV1(tail: string): string | null {
  const marker = '8021'.repeat(8);
  if (!tail.endsWith(marker)) return tail;
  const body = tail.slice(0, -marker.length);
  if (body.length < 6 || !body.endsWith('00')) return null;
  const length = parseInt(body.slice(-4, -2), 16);
  const start = body.length - 4 - length * 2;
  if (length < 1 || start < 0) return null;
  return attributionSuffixOrNothingV1(tail.slice(start)) ? tail.slice(0, start) : null;
}

/**
 * Uniswap's own tag. The Trading API ends every Universal Router call it
 * builds with bytes the router never reads: ASCII "unix", a millisecond
 * timestamp (8 bytes), then 10 more. Measured 2026-11-14 (audit SW-1): the
 * operator's own 2026-09-23 buy, built by /swap_5792 for router 2.0, and three
 * API-built calls on Base that day for router 2.1.2 all carry exactly these 22
 * bytes. Without this, every Uniswap build was refused as not canonical. The
 * tag may be followed by one attribution suffix; up to 24 bytes after the
 * timestamp are accepted, so a longer tag still reads as Uniswap's.
 */
export function uniswapTagOrAttributionV1(tail: string): boolean {
  const rest = beforeAttributionSuffixV1(tail);
  if (rest === null) return false;
  return rest === '' || /^756e6978[0-9a-f]{16}(?:[0-9a-f]{2}){0,24}$/.test(rest);
}

/**
 * Whether `data` is exactly the canonical encoding `encoded`, optionally
 * followed by one attribution suffix (or another tail `tailAllowed` names). A
 * decoder that reads a call differently from the contract is the whole risk
 * of decoding: re-encoding what was decoded and requiring the same bytes means
 * dirty high bits and odd offsets are refused instead of read one way here and
 * another onchain. Bytes after the canonical arguments are never read by the
 * router; only the tails named here are let through.
 */
export function sameCanonicalCallV1(
  data: string,
  encoded: string,
  tailAllowed: (tail: string) => boolean = attributionSuffixOrNothingV1,
): boolean {
  const actual = data.toLowerCase();
  const expected = encoded.toLowerCase();
  return actual.startsWith(expected) && tailAllowed(actual.slice(expected.length));
}
