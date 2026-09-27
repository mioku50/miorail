import type { B20BlockHeaderV1, B20ReaderV1, B20RpcResultV1 } from './reader.js';

// ---------------------------------------------------------------------------
// The last block at or before an instant, found by the chain's own timestamps.
//
// A block time is not a constant to extrapolate with. Base has made two-second
// blocks and Cobalt shortens them, so arithmetic only says where to look first.
// The search keeps a bracket of real headers, the lower one at or before the
// instant and the upper one after it. It narrows the bracket by interpolating
// between their timestamps, which lands almost exactly while the block time
// holds still, and falls back to halving whenever a step fails to halve it. The
// answer's timestamp is at or before the instant; the next block's is after.
//
// Each header is asked once. At most one search per token and record date is
// ever made, because migration 0075 keeps the answer.
// ---------------------------------------------------------------------------

/** Where the search looks first: Base's two-second blocks before Cobalt. */
const GUESS_SECONDS_PER_BLOCK_V1 = 2;

export async function b20BlockAtOrBeforeV1(
  reader: B20ReaderV1,
  atMs: number,
): Promise<B20RpcResultV1<B20BlockHeaderV1>> {
  if (!reader.readBlockHeader) return { ok: false, reason: 'not_configured', detail: 'the reader reads no block headers' };
  const at = Math.floor(atMs / 1000);
  const header = async (tag: number | 'latest'): Promise<B20RpcResultV1<B20BlockHeaderV1>> => {
    const read = await reader.readBlockHeader!(tag === 'latest' ? 'latest' : `0x${tag.toString(16)}`);
    if (!read.ok) return read;
    if (!read.value || (tag !== 'latest' && read.value.blockNumber !== tag)) {
      return { ok: false, reason: 'invalid_response', detail: 'the endpoint returned no header, or another block' };
    }
    return { ok: true, value: read.value, raw: read.raw };
  };

  const headRead = await header('latest');
  if (!headRead.ok) return headRead;
  let hi = headRead.value;
  if (hi.timestamp <= at) return headRead;

  // The first probe: two-second blocks back from the head. Right before
  // Cobalt, and still a bracket edge after it.
  const guess = Math.max(1, hi.blockNumber - Math.round((hi.timestamp - at) / GUESS_SECONDS_PER_BLOCK_V1));
  const guessRead = await header(guess);
  if (!guessRead.ok) return guessRead;
  let lo: B20BlockHeaderV1;
  if (guessRead.value.timestamp <= at) {
    lo = guessRead.value;
  } else {
    hi = guessRead.value;
    const firstRead = await header(1);
    if (!firstRead.ok) return firstRead;
    if (firstRead.value.timestamp > at) return { ok: false, reason: 'empty_result', detail: 'the instant is before the first block' };
    lo = firstRead.value;
  }

  let interpolate = true;
  while (hi.blockNumber - lo.blockNumber > 1) {
    const width = hi.blockNumber - lo.blockNumber;
    const span = hi.timestamp - lo.timestamp;
    const probe = interpolate && span > 0
      ? lo.blockNumber + Math.floor(((at - lo.timestamp) * width) / span)
      : lo.blockNumber + Math.floor(width / 2);
    const read = await header(Math.min(hi.blockNumber - 1, Math.max(lo.blockNumber + 1, probe)));
    if (!read.ok) return read;
    if (read.value.timestamp <= at) lo = read.value;
    else hi = read.value;
    // Interpolation earns the next step only by at least halving this one.
    interpolate = hi.blockNumber - lo.blockNumber <= width / 2 ? true : !interpolate;
  }
  return { ok: true, value: lo, raw: lo.blockHash };
}
