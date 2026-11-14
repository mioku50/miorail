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
 * Whether `data` is exactly the canonical encoding `encoded`, optionally
 * followed by one attribution suffix. A decoder that reads a call differently
 * from the contract is the whole risk of decoding: re-encoding what was decoded
 * and requiring the same bytes means dirty high bits, odd offsets and hidden
 * trailing data are refused instead of read one way here and another onchain.
 */
export function sameCanonicalCallV1(data: string, encoded: string): boolean {
  const actual = data.toLowerCase();
  const expected = encoded.toLowerCase();
  return actual.startsWith(expected) && attributionSuffixOrNothingV1(actual.slice(expected.length));
}
