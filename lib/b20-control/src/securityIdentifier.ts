import { B20_SELECTORS_V1, decodeStringV1, selectorV1 } from './pinned.js';
import { callManyV1, type B20ReaderV1 } from './reader.js';

// ---------------------------------------------------------------------------
// The ISIN a B20 declares about itself.
//
// Miorail's `representation_underlying` binds a token address to an underlying
// key like `security:isin:US67066G1040`, and until now that binding was a
// REVIEWED mapping: correct, but asserted by us. B20 tokens carry arbitrary
// key/value metadata on chain, and the Coinbase representations use it to
// publish their own security identifier — so the binding can be cross-checked
// against the issuer's own statement instead of resting on our review.
//
// Measured 2026-08-31, and every one matched the reviewed key exactly:
//
//   NVDAc  US67066G1040      AAPLc  US0378331005
//   TSLAc  US88160R1014      MSFTc  US5949181045
//
// TSLAc and MSFTc are the interesting pair: production measures them and the
// reviewed corpus does not contain them, so this is also the evidence that
// binds the Coinbase addresses nobody has reviewed yet — with proof rather than
// with a second manual pass.
//
// THE KEY IS LOWERCASE
//
// `extraMetadata("isin")` answers. `extraMetadata("ISIN")` returns an EMPTY
// STRING — not a revert, which is what makes it dangerous: a caller using the
// obvious spelling gets a well-formed answer meaning nothing, and an absent
// identifier is indistinguishable from a token that has none. Both spellings
// are read here and disagreement is reported rather than silently resolved.
//
// AN ISSUER STRING IS NOT AN IDENTITY UNTIL IT IS CHECKED
//
// This is metadata the issuer can write, and it is about to be used to say
// which company a contract represents. So the value is validated for ISIN shape
// AND check digit before it is allowed to mean anything. A malformed value is
// reported as malformed, never passed through as an identifier.
// ---------------------------------------------------------------------------

/** `extraMetadata(string)`. Computed, not copied. */
export const B20_EXTRA_METADATA_SELECTOR_V1 = selectorV1('extraMetadata(string)');

/** The key the reviewed representations actually answer on. Lowercase, and the
 * uppercase spelling is read alongside it only to catch a disagreement. */
export const B20_ISIN_METADATA_KEYS_V1 = ['isin', 'ISIN'] as const;

export type B20SecurityIdentifierV1 =
  | { ok: true; isin: string; key: string }
  /** The token answered, and published nothing. A real, final state. */
  | { ok: false; reason: 'not_published' }
  /** It published something that is not an ISIN. Never passed through. */
  | { ok: false; reason: 'malformed'; value: string }
  /** Two keys, two different identifiers. Refused rather than picked between. */
  | { ok: false; reason: 'conflicting'; value: string }
  /** The read did not complete. NOT the same as "publishes nothing". */
  | { ok: false; reason: 'unavailable' };

function encodeStringArgV1(selector: string, value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  const body = bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64 || 64, '0');
  const offset = (32).toString(16).padStart(64, '0');
  const length = bytes.length.toString(16).padStart(64, '0');
  return `0x${selector}${offset}${length}${body}`;
}

/**
 * Is this a well-formed ISIN, by its own check digit?
 *
 * ISO 6166: two letters, nine alphanumerics, one check digit, validated with
 * Luhn over the digit expansion of every character. Worth doing rather than
 * pattern-matching the length: this string is about to be treated as the
 * identity of a security, and a typo that passes a regex fails here.
 */
export function isValidIsinV1(value: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(value)) return false;
  const expanded = [...value]
    .map((character) =>
      /[0-9]/.test(character)
        ? character
        : String(character.charCodeAt(0) - 'A'.charCodeAt(0) + 10),
    )
    .join('');
  let sum = 0;
  let double = true;
  for (let index = expanded.length - 2; index >= 0; index -= 1) {
    const digit = Number(expanded[index]);
    const scaled = double ? digit * 2 : digit;
    sum += scaled > 9 ? scaled - 9 : scaled;
    double = !double;
  }
  return (10 - (sum % 10)) % 10 === Number(expanded[expanded.length - 1]);
}

/** The reviewed corpus keys underlyings this way, so a cross-check compares
 * like with like instead of parsing a key at the call site. */
export function underlyingKeyForIsinV1(isin: string): string {
  return `security:isin:${isin}`;
}

/**
 * What identifier this exact contract publishes about itself.
 *
 * Both key spellings in one batch at one block. An empty answer from one and a
 * value from the other is the ordinary case and resolves to the value; two
 * DIFFERENT values is refused, because choosing between an issuer's two
 * contradictory statements is not a decision this layer may make.
 */
export async function readB20SecurityIdentifierV1(input: {
  reader: B20ReaderV1;
  tokenAddress: string;
  blockTag: string;
}): Promise<B20SecurityIdentifierV1> {
  const reads = await callManyV1(
    input.reader,
    B20_ISIN_METADATA_KEYS_V1.map((key) => ({
      to: input.tokenAddress,
      data: encodeStringArgV1(B20_EXTRA_METADATA_SELECTOR_V1, key),
      blockTag: input.blockTag,
    })),
  );

  const published: { key: string; value: string }[] = [];
  let sawAnswer = false;
  for (const [index, read] of reads.entries()) {
    if (!read?.ok) continue;
    sawAnswer = true;
    const decoded = decodeStringV1(read.value);
    if (decoded === null) continue;
    const trimmed = decoded.trim();
    if (trimmed.length === 0) continue;
    published.push({ key: B20_ISIN_METADATA_KEYS_V1[index]!, value: trimmed.toUpperCase() });
  }

  if (!sawAnswer) return { ok: false, reason: 'unavailable' };
  if (published.length === 0) return { ok: false, reason: 'not_published' };

  const distinct = [...new Set(published.map((entry) => entry.value))];
  if (distinct.length > 1) return { ok: false, reason: 'conflicting', value: distinct.join(' / ') };

  const value = distinct[0]!;
  if (!isValidIsinV1(value)) return { ok: false, reason: 'malformed', value };
  return { ok: true, isin: value, key: published[0]!.key };
}

/**
 * Does the chain agree with the reviewed binding?
 *
 * Three outcomes, and the middle one is why this exists at all. `contradicted`
 * is not a coverage gap to be filled later — it means our reviewed mapping and
 * the issuer's own on-chain statement name different securities for the same
 * address, and nothing downstream may quietly prefer one.
 */
export type B20BindingCrossCheckV1 =
  | { status: 'confirmed'; underlyingKey: string }
  | { status: 'contradicted'; reviewedUnderlyingKey: string; onchainUnderlyingKey: string }
  /** Either the chain published nothing usable, or nothing was reviewed to
   * compare it against. Both leave the binding exactly as strong as it was. */
  | { status: 'not_established'; reason: string };

export function crossCheckUnderlyingBindingV1(input: {
  onchain: B20SecurityIdentifierV1;
  /** `security:isin:...`, or null where the corpus holds no binding yet — which
   * is the case this was built for. */
  reviewedUnderlyingKey: string | null;
}): B20BindingCrossCheckV1 {
  if (!input.onchain.ok) {
    const reason =
      input.onchain.reason === 'unavailable'
        ? 'The contract was not read, so its published identifier is unknown.'
        : input.onchain.reason === 'not_published'
          ? 'This contract publishes no security identifier on chain.'
          : input.onchain.reason === 'conflicting'
            ? 'This contract publishes two different security identifiers.'
            : 'This contract publishes a value that is not a valid ISIN.';
    return { status: 'not_established', reason };
  }
  const onchainUnderlyingKey = underlyingKeyForIsinV1(input.onchain.isin);
  if (input.reviewedUnderlyingKey === null) {
    // The token names itself and nothing has reviewed it. That is evidence for
    // a binding, not a confirmation of one — an issuer agreeing with itself
    // proves nothing about our corpus.
    return {
      status: 'not_established',
      reason: `This contract publishes ${input.onchain.isin}, and no reviewed binding exists to check it against.`,
    };
  }
  return input.reviewedUnderlyingKey === onchainUnderlyingKey
    ? { status: 'confirmed', underlyingKey: onchainUnderlyingKey }
    : {
        status: 'contradicted',
        reviewedUnderlyingKey: input.reviewedUnderlyingKey,
        onchainUnderlyingKey,
      };
}

/** Kept so a caller can see this module reads only the base surface it was
 * given, and never a method that moves an asset. */
export const B20_SECURITY_IDENTIFIER_READS_V1 = [
  B20_EXTRA_METADATA_SELECTOR_V1,
  B20_SELECTORS_V1.symbol,
] as const;
