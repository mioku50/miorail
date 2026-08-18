import React from 'react';

import { shortAddressV1 } from './B20WatchScreen';

void React;

// ---------------------------------------------------------------------------
// A B20 token is named by its address. The symbol is what the deployer typed.
//
// On 2026-08-18 a Discover screen showed two cards headed `CHEESEBURGE` — one
// in the feed, one in the exit rail — with different round trips and different
// tested exits. They were two different contracts:
//
//   0xb200…f7b997   round trip 100%     largest tested exit 6.325M
//   0xb200…4e9b01   round trip 4.34%    largest tested exit 11.17M
//
// Neither surface showed an address, so the two read as one token whose own
// numbers contradicted each other.
//
// This is not an edge case. Of 33,541 canonical launches there are 17,021
// distinct symbols: **61.7% share a symbol with another launch**, and the
// crowded ones are crowded badly — `b20` 950 times, `myt` 938, `my token` 899.
// A symbol collision is the ordinary case on this chain.
//
// It is also the exact confusion the fundamental layer exists to refuse — the
// reader who sees `AVANTIS` and concludes "the official Avantis". Miorail says
// loudly that a shared name is not a link, and then, on its own screens, named
// tokens by the shared name alone.
//
// So: wherever a token is identified to a reader, both halves travel. The
// symbol is what they recognise; the address is what makes it that token.
// ---------------------------------------------------------------------------

/**
 * The symbol as the deployer wrote it, and the address that makes it specific.
 *
 * `name` is optional and secondary — it is another deployer-written string, so
 * it identifies nothing on its own either.
 *
 * The address is NOT truncated to a prefix by accident: every B20 token begins
 * `0xb2000000…`, so a leading fragment is identical across the whole universe
 * and it is the tail that separates one launch from another. `shortAddressV1`
 * keeps both ends for exactly that reason.
 */
export function TokenIdentityV1({
  symbol,
  name,
  tokenAddress,
}: {
  symbol: string | null;
  name?: string | null;
  tokenAddress: string;
}) {
  const label = symbol ?? name ?? null;
  return (
    <span className="token-identity">
      {label !== null && <span className="token-symbol">{label}</span>}
      {label !== null && name && name !== symbol ? <span className="sub">{name}</span> : null}
      <span className="token-addr mono" title={tokenAddress}>
        {shortAddressV1(tokenAddress)}
      </span>
    </span>
  );
}
