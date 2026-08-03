import { keccakWordV1, B20_FACTORY_V1, B20_CHAIN_ID_V1 } from './pinned.js';

// ---------------------------------------------------------------------------
// T69 §1 — decoding a B20 launch.
//
// The signature below is DERIVED, not documented. It was recovered by matching
// keccak-256 candidates against the topic0 actually observed on Base
// (docs/B20_INTERFACE_RESEARCH.md §4.1.1): the hash match is exact, so the
// signature is certain, but the parameter NAMES are inferred from the types and
// from what the decoded values plainly are. Base documents no event here.
//
// That is the whole reason this file is shaped the way it is. Undocumented
// behaviour can change without notice, and the only acceptable failure mode is
// "no launch feed" — never "a launch with wrong fields". So every decode is
// total: it either produces a fully-formed launch or a NAMED refusal, and there
// is no path that returns a token with a guessed name, a defaulted variant or a
// zero-filled symbol.
//
// A refusal here is an OPERATOR state. It is deliberately not recorded against
// a token, because "the factory's event shape changed" is a fact about Miorail's
// decoder, not a fact about somebody's token.
// ---------------------------------------------------------------------------

export const B20_CREATED_SIGNATURE_V1 = 'B20Created(address,uint8,string,string,uint8,bytes)';

/** topic0, computed from the signature rather than copied. A pasted hash that
 * drifts from the signature would silently match nothing, and an empty log
 * stream reads exactly like a quiet week. */
export const B20_CREATED_TOPIC_V1 = keccakWordV1(B20_CREATED_SIGNATURE_V1);

/** The decoder's own version. Persisted with every launch so a future change to
 * this file is visible in the data rather than inferred from a deploy date. */
export const B20_LAUNCH_DECODER_VERSION_V1 = 'b20-created/v1';

export const B20_LAUNCH_VARIANTS_V1 = { 0: 'asset', 1: 'stablecoin' } as const;
export type B20LaunchVariantV1 = (typeof B20_LAUNCH_VARIANTS_V1)[keyof typeof B20_LAUNCH_VARIANTS_V1];

/**
 * Why a log could not become a launch.
 *
 * Every one of these stops the READER. None of them is written against a token:
 * a decoder that cannot read an event knows nothing about the token in it.
 */
export type B20LaunchDecodeRefusalV1 =
  | 'wrong_emitter'
  | 'wrong_topic'
  | 'topic_count_mismatch'
  | 'malformed_indexed_token'
  | 'unknown_variant'
  | 'malformed_data'
  | 'string_out_of_bounds'
  | 'decimals_out_of_range'
  | 'missing_block_identity';

export const B20_LAUNCH_REFUSAL_COPY_V1: Record<B20LaunchDecodeRefusalV1, string> = {
  wrong_emitter: 'A log from an address that is not the pinned B20 Factory.',
  wrong_topic: 'A log whose topic0 is not B20Created.',
  topic_count_mismatch:
    'B20Created carries exactly three topics. A different count means the event shape changed.',
  malformed_indexed_token: 'The indexed token topic is not a left-padded address.',
  unknown_variant: 'The variant is neither ASSET (0) nor STABLECOIN (1).',
  malformed_data: 'The non-indexed data does not decode as the recorded ABI head.',
  string_out_of_bounds: 'A string offset or length points outside the log data.',
  decimals_out_of_range: 'Decimals outside 0–255, which the uint8 type cannot hold.',
  missing_block_identity: 'A log with no block number, block hash, transaction hash or log index.',
};

export interface RawLogV1 {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string | null;
  blockHash: string | null;
  transactionHash: string | null;
  logIndex: string | null;
  removed?: boolean;
}

export interface B20LaunchV1 {
  chainId: 8453;
  factoryAddress: string;
  tokenAddress: string;
  variant: B20LaunchVariantV1;
  name: string;
  symbol: string;
  /** From the event. Null only when the event omitted a readable value, which
   * the decoder reports rather than defaulting to 18. */
  decimals: number | null;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  decoderVersion: string;
}

export type B20LaunchDecodeResultV1 =
  | { ok: true; launch: B20LaunchV1 }
  | { ok: false; refusal: B20LaunchDecodeRefusalV1 };

const HEX_WORD = 64;

/** Control characters would render as invisible damage in a card, so they are
 * removed rather than displayed. The result is still the token's own text. */
function stripControlCharsV1(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += char;
  }
  return out.trim();
}

function hexBody(value: string): string {
  return value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
}

function wordAt(data: string, index: number): string | null {
  const start = index * HEX_WORD;
  return data.length >= start + HEX_WORD ? data.slice(start, start + HEX_WORD) : null;
}

/** A 32-byte word as a bigint, or null when the word is absent. */
function uintAt(data: string, index: number): bigint | null {
  const word = wordAt(data, index);
  if (word === null || !/^[0-9a-f]{64}$/i.test(word)) return null;
  return BigInt(`0x${word}`);
}

/**
 * A dynamic ABI string at `headIndex`.
 *
 * Bounds are checked against the ACTUAL data length rather than assumed, so a
 * truncated or adversarial log produces a refusal instead of a string built
 * from whatever bytes happened to follow.
 */
function stringAt(data: string, headIndex: number): { ok: true; value: string } | { ok: false } {
  const offset = uintAt(data, headIndex);
  if (offset === null) return { ok: false };
  // An offset is a byte count into the data; anything past the end, or too
  // large to be a real offset, is a malformed log rather than an empty string.
  if (offset > BigInt(data.length / 2)) return { ok: false };
  const offsetChars = Number(offset) * 2;
  const lengthWord = data.slice(offsetChars, offsetChars + HEX_WORD);
  if (lengthWord.length < HEX_WORD || !/^[0-9a-f]{64}$/i.test(lengthWord)) return { ok: false };
  const length = Number(BigInt(`0x${lengthWord}`));
  if (!Number.isSafeInteger(length) || length < 0) return { ok: false };
  const start = offsetChars + HEX_WORD;
  const end = start + length * 2;
  if (end > data.length) return { ok: false };
  const bytes = data.slice(start, end);

  const units: number[] = [];
  for (let index = 0; index < bytes.length; index += 2) {
    units.push(Number.parseInt(bytes.slice(index, index + 2), 16));
  }
  let out: string;
  try {
    out = new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(units));
  } catch {
    return { ok: false };
  }
  return { ok: true, value: stripControlCharsV1(out) };
}

/**
 * One log to one launch, or a named refusal.
 *
 * Total by construction: there is no branch that fills in a missing field.
 */
export function decodeB20CreatedV1(log: RawLogV1): B20LaunchDecodeResultV1 {
  const refuse = (refusal: B20LaunchDecodeRefusalV1): B20LaunchDecodeResultV1 => ({
    ok: false,
    refusal,
  });

  if (log.address.toLowerCase() !== B20_FACTORY_V1) return refuse('wrong_emitter');
  if ((log.topics[0] ?? '').toLowerCase() !== B20_CREATED_TOPIC_V1) return refuse('wrong_topic');
  // Three topics: the signature, the indexed token and the indexed variant. A
  // different count is the event shape changing, and that stops the reader.
  if (log.topics.length !== 3) return refuse('topic_count_mismatch');

  const tokenTopic = hexBody(log.topics[1] ?? '').toLowerCase();
  if (!/^0{24}[0-9a-f]{40}$/.test(tokenTopic)) return refuse('malformed_indexed_token');
  const tokenAddress = `0x${tokenTopic.slice(24)}`;

  const variantTopic = hexBody(log.topics[2] ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(variantTopic)) return refuse('unknown_variant');
  const variantNumber = Number(BigInt(`0x${variantTopic}`));
  const variant = B20_LAUNCH_VARIANTS_V1[variantNumber as 0 | 1];
  if (!variant) return refuse('unknown_variant');

  const data = hexBody(log.data).toLowerCase();
  // Odd-length hex is not bytes. Checked before anything divides by two, so a
  // truncated log is a named refusal rather than a thrown conversion error
  // halfway through the reader.
  if (data.length % 2 !== 0 || !/^[0-9a-f]*$/.test(data)) return refuse('malformed_data');
  // Four head words: name offset, symbol offset, decimals, tail offset.
  if (data.length < HEX_WORD * 4) return refuse('malformed_data');

  const name = stringAt(data, 0);
  if (!name.ok) return refuse('string_out_of_bounds');
  const symbol = stringAt(data, 1);
  if (!symbol.ok) return refuse('string_out_of_bounds');

  const decimalsWord = uintAt(data, 2);
  if (decimalsWord === null) return refuse('malformed_data');
  if (decimalsWord > 255n) return refuse('decimals_out_of_range');

  if (!log.blockNumber || !log.blockHash || !log.transactionHash || log.logIndex === null) {
    return refuse('missing_block_identity');
  }
  const blockNumber = BigInt(log.blockNumber).toString();
  const logIndex = Number(BigInt(log.logIndex));
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) return refuse('missing_block_identity');

  return {
    ok: true,
    launch: {
      chainId: B20_CHAIN_ID_V1,
      factoryAddress: B20_FACTORY_V1,
      tokenAddress,
      variant,
      name: name.value,
      symbol: symbol.value,
      decimals: Number(decimalsWord),
      blockNumber,
      blockHash: log.blockHash.toLowerCase(),
      transactionHash: log.transactionHash.toLowerCase(),
      logIndex,
      decoderVersion: B20_LAUNCH_DECODER_VERSION_V1,
    },
  };
}

/** The dedupe identity. One log is one launch, forever. */
export function launchIdV1(input: { transactionHash: string; logIndex: number }): string {
  return `${input.transactionHash.toLowerCase()}:${input.logIndex}`;
}
