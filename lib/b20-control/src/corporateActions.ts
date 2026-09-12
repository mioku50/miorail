import { keccakWordV1 } from './pinned.js';

// ---------------------------------------------------------------------------
// The onchain bracket around a corporate action.
//
// Base wraps every holder-impacting operation on a tokenized stock in one
// call: `announce(internalCalls, id, description, uri)` emits `Announcement`,
// runs the inner calls atomically, then emits `EndAnnouncement`. A dividend, a
// split, a batch mint and a multiplier change all arrive inside that bracket,
// and the docs say plainly what it is for -- "integrators index these to catch
// corporate actions as they execute".
//
// Nothing has executed yet. Every Coinbase tokenized stock still reads a
// multiplier of exactly 1.0, no `Announcement` has been emitted, and that is
// the reason this exists NOW rather than after the first dividend. A feed
// started on the day of the first corporate action can only report the event
// it was built for; it cannot say whether it was the first. A feed started
// while the record is empty can, because the emptiness is measured.
//
// HOW THE SIGNATURES WERE ESTABLISHED
//
// Base publishes topic0 for each event in its errors-and-events index and does
// NOT publish the Solidity signature anywhere this corpus carries. So the
// signature here was RECOVERED: candidate shapes were hashed until one matched
// the published topic, and the test beside this file re-derives each topic
// from the signature it claims. That is the opposite of the failure recorded
// in `b20-multiplier-is-per-issuer` -- a name guessed to fit a selector nobody
// had verified. Here the hash is the authority and the name is the thing being
// checked against it.
//
// WHAT THE DECODER REFUSES TO DO
//
// Base publishes the topic but not which parameters are indexed, and an
// indexed `string` is stored as a hash of itself -- unrecoverable. So the
// decoder reads the arguments only when the log's own shape supports it, and
// otherwise reports `topic_only`: the event happened, at this block, in this
// transaction, and its arguments were somewhere this build cannot read. The
// raw topics and data are stored either way, so a later reader that learns the
// layout can decode a log this one could not.
//
// An argument that does not decode exactly is not carried. A description
// assembled from bytes that did not line up would be a corporate action in the
// issuer's voice, invented by us.
// ---------------------------------------------------------------------------

/**
 * The block before any Coinbase tokenized stock existed on Base.
 *
 * Measured 2026-09-12 with `eth_getCode`: all thirteen answer `0x` at this
 * height, and the earliest of them (AAPLc) first carries code at 49,145,246 —
 * 2026-07-26T15:30:39Z, two minutes before NVDAc. Reading the corporate-action
 * tail from here covers the entire life of every one of them.
 *
 * It is a START, not a claim on its own. What makes "nothing has ever been
 * announced" a measurement rather than an assumption is a stored cursor that
 * began here and a stored range it has covered since.
 */
export const B20_TOKENIZED_STOCK_GENESIS_BLOCK_V1 = 49_145_000;

export const B20_CORPORATE_ACTION_EVENTS_V1 = [
  'announcement',
  'end_announcement',
  'multiplier_updated',
  'ui_multiplier_updated',
] as const;
export type B20CorporateActionEventV1 = (typeof B20_CORPORATE_ACTION_EVENTS_V1)[number];

/**
 * The signature each event's topic0 is the hash of.
 *
 * `MultiplierUpdated` is the deprecated setter's event and `UIMultiplierUpdated`
 * is the scheduled one; both are read, because a token that emits either has
 * changed the number of shares one unit redeems for, and which setter the
 * issuer used is not the holder's problem.
 */
export const B20_CORPORATE_ACTION_SIGNATURES_V1: Readonly<
  Record<B20CorporateActionEventV1, string>
> = {
  announcement: 'Announcement(address,string,string,string)',
  end_announcement: 'EndAnnouncement(string)',
  multiplier_updated: 'MultiplierUpdated(uint256)',
  ui_multiplier_updated: 'UIMultiplierUpdated(uint256,uint256,uint256)',
};

/** topic0 for each event, computed from the signature above. Base publishes
 * the same four values in its errors-and-events index; the test asserts them
 * literally, so a signature edit that changed a topic would fail rather than
 * quietly start reading a different event. */
export const B20_CORPORATE_ACTION_TOPICS_V1: Readonly<
  Record<B20CorporateActionEventV1, `0x${string}`>
> = {
  announcement: keccakWordV1(B20_CORPORATE_ACTION_SIGNATURES_V1.announcement),
  end_announcement: keccakWordV1(B20_CORPORATE_ACTION_SIGNATURES_V1.end_announcement),
  multiplier_updated: keccakWordV1(B20_CORPORATE_ACTION_SIGNATURES_V1.multiplier_updated),
  ui_multiplier_updated: keccakWordV1(B20_CORPORATE_ACTION_SIGNATURES_V1.ui_multiplier_updated),
};

/** Every topic0 this tail asks a node for, in one list. */
export const B20_CORPORATE_ACTION_TOPIC_LIST_V1: readonly string[] =
  B20_CORPORATE_ACTION_EVENTS_V1.map((event) => B20_CORPORATE_ACTION_TOPICS_V1[event]);

const EVENT_BY_TOPIC_V1 = new Map<string, B20CorporateActionEventV1>(
  B20_CORPORATE_ACTION_EVENTS_V1.map((event) => [B20_CORPORATE_ACTION_TOPICS_V1[event], event]),
);

/**
 * The longest argument this decoder will carry into a row.
 *
 * Not a guess about issuers: it is the width the stored feed is built for, and
 * a longer one is reported as `topic_only` with the raw log kept, rather than
 * silently shortened into a sentence the issuer did not write.
 */
export const B20_ANNOUNCEMENT_TEXT_MAX_V1 = 2_000;
export const B20_ANNOUNCEMENT_ID_MAX_V1 = 200;

export interface B20CorporateActionV1 {
  event: B20CorporateActionEventV1;
  /**
   * `decoded` — every argument the signature declares came out of the data.
   * `topic_only` — the log named the event and this build could not read its
   * arguments. Never a partial mixture: a row is one or the other.
   */
  payload: 'decoded' | 'topic_only';
  /** The issuer's own announcement id, the string that brackets the action. */
  announcementId: string | null;
  /** Who called `announce`. An operator address, never a holder. */
  caller: string | null;
  description: string | null;
  uri: string | null;
  /** WAD-scaled, as the contract published it. Never pre-divided. */
  multiplierWad: string | null;
}

export interface RawEventLogV1 {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
  blockNumber?: unknown;
  transactionHash?: unknown;
  logIndex?: unknown;
}

const WORD_V1 = 64;

function wordsOfV1(data: string): string[] | null {
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) return null;
  const body = data.slice(2);
  if (body.length % WORD_V1 !== 0) return null;
  return body.length === 0 ? [] : (body.match(/.{64}/g) ?? []);
}

function unsignedV1(word: string | undefined): bigint | null {
  return word === undefined ? null : BigInt(`0x${word}`);
}

function addressOfV1(word: string | undefined): string | null {
  if (word === undefined || !/^0{24}[0-9a-fA-F]{40}$/.test(word)) return null;
  return `0x${word.slice(24).toLowerCase()}`;
}

/**
 * One dynamic `string`, read at a head offset.
 *
 * Every bound is checked because an offset is attacker-chosen bytes as far as
 * this function is concerned: a length that overruns the data would otherwise
 * read whatever followed it in the log and present that as an issuer's words.
 */
function stringAtV1(words: readonly string[], headIndex: number, max: number): string | null {
  const offset = unsignedV1(words[headIndex]);
  if (offset === null || offset % 32n !== 0n) return null;
  const slot = Number(offset / 32n);
  if (!Number.isSafeInteger(slot) || slot >= words.length) return null;
  const length = unsignedV1(words[slot]);
  if (length === null) return null;
  if (length > BigInt(max)) return null;
  const size = Number(length);
  const needed = Math.ceil(size / 32);
  if (slot + 1 + needed > words.length) return null;
  const hex = words.slice(slot + 1, slot + 1 + needed).join('').slice(0, size * 2);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16)),
    );
  } catch {
    // Bytes that are not text are not a description. The raw log still travels.
    return null;
  }
}

function topicOnlyV1(event: B20CorporateActionEventV1): B20CorporateActionV1 {
  return {
    event,
    payload: 'topic_only',
    announcementId: null,
    caller: null,
    description: null,
    uri: null,
    multiplierWad: null,
  };
}

/**
 * One log, if this build recognises it.
 *
 * `null` means the log is not one of the four events -- not that it is
 * malformed. A log that IS one of them always returns a row, because "a
 * corporate action executed in this transaction" is the load-bearing fact and
 * it survives every argument being unreadable.
 */
export function decodeB20CorporateActionLogV1(log: RawEventLogV1): B20CorporateActionV1 | null {
  const topics = Array.isArray(log.topics) ? log.topics.filter((t) => typeof t === 'string') : [];
  const topic0 = typeof topics[0] === 'string' ? topics[0].toLowerCase() : null;
  if (topic0 === null) return null;
  const event = EVENT_BY_TOPIC_V1.get(topic0);
  if (event === undefined) return null;

  const words = wordsOfV1(typeof log.data === 'string' ? log.data : '0x');
  if (words === null) return topicOnlyV1(event);
  // Every argument in `data` means every argument is readable. One in a topic
  // means the layout is not the one Base's hash describes to this build, and a
  // `string` in a topic is a hash of itself either way.
  const indexed = topics.length - 1;

  if (event === 'multiplier_updated') {
    const value = indexed === 0 && words.length === 1 ? unsignedV1(words[0]) : null;
    if (value === null || value <= 0n) return topicOnlyV1(event);
    return { ...topicOnlyV1(event), payload: 'decoded', multiplierWad: value.toString() };
  }

  if (event === 'ui_multiplier_updated') {
    // Three words: the scheduled multiplier and the schedule around it. Only
    // the multiplier is carried; `effectiveAt` is a promise about the future
    // and the feed reports what executed.
    const value = indexed === 0 && words.length === 3 ? unsignedV1(words[0]) : null;
    if (value === null || value <= 0n) return topicOnlyV1(event);
    return { ...topicOnlyV1(event), payload: 'decoded', multiplierWad: value.toString() };
  }

  if (event === 'end_announcement') {
    const id = indexed === 0 ? stringAtV1(words, 0, B20_ANNOUNCEMENT_ID_MAX_V1) : null;
    if (id === null || id.length === 0) return topicOnlyV1(event);
    return { ...topicOnlyV1(event), payload: 'decoded', announcementId: id };
  }

  if (indexed !== 0 || words.length < 4) return topicOnlyV1(event);
  const caller = addressOfV1(words[0]);
  const id = stringAtV1(words, 1, B20_ANNOUNCEMENT_ID_MAX_V1);
  const description = stringAtV1(words, 2, B20_ANNOUNCEMENT_TEXT_MAX_V1);
  const uri = stringAtV1(words, 3, B20_ANNOUNCEMENT_TEXT_MAX_V1);
  if (caller === null || id === null || id.length === 0 || description === null || uri === null) {
    return topicOnlyV1(event);
  }
  return {
    event,
    payload: 'decoded',
    announcementId: id,
    caller,
    description,
    uri,
    multiplierWad: null,
  };
}

// ---------------------------------------------------------------------------
// From a node's answer to rows worth storing.
// ---------------------------------------------------------------------------

export interface B20CorporateActionObservationV1 {
  /** The token that emitted it. Always one of the addresses we asked about. */
  tokenAddress: string;
  action: B20CorporateActionV1;
  blockNumber: number;
  /** The block's own timestamp: when the action EXECUTED. */
  blockTime: string;
  transactionHash: string;
  logIndex: number;
  /** The log, verbatim, so a later reader can decode what this one could not. */
  topics: string[];
  data: string;
}

export interface B20CorporateActionReadingV1 {
  observations: B20CorporateActionObservationV1[];
  /**
   * Logs that are one of the four events and could not be turned into a row.
   *
   * Two causes, both OURS: a block whose timestamp we did not read, and a log
   * whose block, transaction or index did not parse. A caller must treat a
   * non-zero count as a failed pass and leave the cursor where it was — an
   * announcement dropped because we could not date it would be invisible
   * forever, and the cursor would have moved past it.
   */
  undated: number;
  /** Logs from an address nobody asked about. Counted, never stored. */
  foreign: number;
}

const HEX_NUMBER_V1 = /^0x[0-9a-fA-F]+$/;

function numberFromHexV1(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string' || !HEX_NUMBER_V1.test(value)) return null;
  const parsed = Number(BigInt(value));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * One pass's logs, as rows.
 *
 * The address filter is not defensive decoration: `eth_getLogs` is asked for a
 * list of addresses, and a node that answered with one outside that list is a
 * node we do not understand. Storing its answer under a tracked asset's name
 * is the recurring failure this repository is organised against.
 */
export function b20CorporateActionObservationsV1(input: {
  logs: readonly RawEventLogV1[];
  blockTimes: ReadonlyMap<number, string>;
  tokens: Iterable<string>;
}): B20CorporateActionReadingV1 {
  const tracked = new Set([...input.tokens].map((token) => token.toLowerCase()));
  const observations: B20CorporateActionObservationV1[] = [];
  let undated = 0;
  let foreign = 0;

  for (const log of input.logs) {
    const action = decodeB20CorporateActionLogV1(log);
    if (action === null) continue;
    const address = typeof log.address === 'string' ? log.address.toLowerCase() : null;
    if (address === null || !tracked.has(address)) {
      foreign += 1;
      continue;
    }
    const blockNumber = numberFromHexV1(log.blockNumber);
    const logIndex = numberFromHexV1(log.logIndex);
    const transactionHash =
      typeof log.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)
        ? log.transactionHash.toLowerCase()
        : null;
    const blockTime = blockNumber === null ? undefined : input.blockTimes.get(blockNumber);
    if (
      blockNumber === null ||
      blockNumber <= 0 ||
      logIndex === null ||
      transactionHash === null ||
      blockTime === undefined
    ) {
      undated += 1;
      continue;
    }
    const topics = (Array.isArray(log.topics) ? log.topics : [])
      .filter((topic): topic is string => typeof topic === 'string')
      .map((topic) => topic.toLowerCase());
    observations.push({
      tokenAddress: address,
      action,
      blockNumber,
      blockTime,
      transactionHash,
      logIndex,
      topics,
      data: typeof log.data === 'string' ? log.data.toLowerCase() : '0x',
    });
  }

  return { observations, undated, foreign };
}

/** Every block a recognised log sits in — the set `blockTimes` must cover. */
export function b20CorporateActionBlocksV1(logs: readonly RawEventLogV1[]): number[] {
  const blocks = new Set<number>();
  for (const log of logs) {
    if (decodeB20CorporateActionLogV1(log) === null) continue;
    const blockNumber = numberFromHexV1(log.blockNumber);
    if (blockNumber !== null && blockNumber > 0) blocks.add(blockNumber);
  }
  return [...blocks].sort((a, b) => a - b);
}
