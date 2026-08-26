import { stableHashV1 } from '@mioagent/route-domain';
import type { B20BlockAnchorV1, B20ReaderV1 } from '@mioagent/b20-control';

// ---------------------------------------------------------------------------
// The pinned Dinari identity root on Base.
//
// WHY A ROOT NEEDS AN ENVIRONMENT, NOT JUST AN ADDRESS
//
// Dinari publishes deployment manifests in its own contracts repository, keyed
// by release, then by ENVIRONMENT, then by chain id. Measured 2026-08-26, two
// of those manifests name a Base factory and the two live contracts disagree
// about the same token:
//
//   releases/v0.4.0  production.8453  0xbce6…bc4d   isTokenDShare(AAPL) = true
//   releases/v1.0.0  staging.8453     0x4cdb…15a9   isTokenDShare(AAPL) = false
//
// The newest manifest names no PRODUCTION Base factory at all — v1.0.0's
// production map contains Plume only. So "the latest release" is the wrong
// selector; the right one is "the latest release that names a production
// deployment on this chain", and the pin below records exactly which file and
// which key that was, so a future re-pin is a visible decision rather than a
// silent drift onto a staging contract.
//
// WHAT THE ROOT CANNOT DO
//
// `getDShares()` reverts, on both factories, although BOTH published ABIs
// declare it. There is no enumerable membership list. This is therefore a
// verify-a-candidate root and never a trust-a-list root: every row in the
// registry exists because somebody asked about that exact address.
//
// `isTokenWrappedDShare(address)` reverts as well, so a wrapper is outside
// this root's reach and gets no membership from it. That is why the wrapped
// dShares measured in Phase 9A.5 are evidence and not representations.
// ---------------------------------------------------------------------------

/** `isTokenDShare(address)`. */
export const DINARI_MEMBERSHIP_SELECTOR_V1 = '0x25f28f16' as const;

export interface PinnedIssuerRootV1 {
  rootKey: string;
  issuerId: 'dinari';
  chainId: 8453;
  rootAddress: string;
  predicateSelector: string;
  /** The manifest this address was taken from, and the key inside it. Stored
   * with every check so a row can be re-derived from the source it came from. */
  provenance: {
    repository: string;
    path: string;
    environment: 'production' | 'staging';
    chainKey: string;
    /** Where a human reads the same file. Shown, never fetched by a worker. */
    humanUrl: string;
  };
}

export const DINARI_BASE_ROOT_V1: PinnedIssuerRootV1 = {
  rootKey: 'dinari_dshare_factory_v0_4_0_production',
  issuerId: 'dinari',
  chainId: 8453,
  rootAddress: '0xbce6410a175a1c9b1a25d38d7e1a900f8393bc4d',
  predicateSelector: DINARI_MEMBERSHIP_SELECTOR_V1,
  provenance: {
    repository: 'dinaricrypto/sbt-contracts',
    path: 'releases/v0.4.0/dshare_factory.json',
    environment: 'production',
    chainKey: '8453',
    humanUrl:
      'https://github.com/dinaricrypto/sbt-contracts/blob/main/releases/v0.4.0/dshare_factory.json',
  },
};

/**
 * The other live Base factory, recorded so it cannot be mistaken for this one.
 *
 * Not a root. It answers the same selector and refutes the production tokens,
 * which is exactly the shape of an answer that would look like a refutation of
 * Dinari itself if the environment were dropped from the pin.
 */
export const DINARI_BASE_STAGING_FACTORY_V1 = '0x4cdbd5a0938be8c57ded76880f774db67dc915a9' as const;

export const DINARI_MEMBERSHIP_OUTCOMES_V1 = ['established', 'refuted', 'unread'] as const;
export type DinariMembershipOutcomeV1 = (typeof DINARI_MEMBERSHIP_OUTCOMES_V1)[number];

export type IssuerMembershipReadV1 =
  | {
      outcome: 'established' | 'refuted';
      tokenAddress: string;
      rootKey: string;
      rootAddress: string;
      blockNumber: string;
      blockHash: string;
      evidenceHash: string;
    }
  | {
      outcome: 'unread';
      tokenAddress: string;
      rootKey: string;
      rootAddress: string;
      /** Ours, never the token's. See the note below. */
      reason: string;
    };

const ADDRESS_SHAPE_V1 = /^0x[0-9a-f]{40}$/;

function encodeAddressArgV1(address: string): string {
  return `000000000000000000000000${address.slice(2)}`;
}

/** A single ABI word decoded as a bool. Anything else is not an answer. */
function decodeBoolV1(raw: string): boolean | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  const value = BigInt(raw);
  if (value === 0n) return false;
  if (value === 1n) return true;
  return null;
}

/**
 * Ask the pinned root about one address.
 *
 * `refuted` means the root ANSWERED and said no — a real, storable fact about
 * that address. `unread` means we could not ask, and it writes nothing, because
 * an endpoint that would not answer has never been evidence about a token here.
 * That distinction has shipped as a bug in this repository three times under
 * three different names, so it is a separate value rather than a falsy one.
 */
export async function readDinariMembershipV1(
  reader: B20ReaderV1,
  input: { tokenAddress: string; anchor: B20BlockAnchorV1 },
  root: PinnedIssuerRootV1 = DINARI_BASE_ROOT_V1,
): Promise<IssuerMembershipReadV1> {
  const tokenAddress = input.tokenAddress.toLowerCase();
  const base = { tokenAddress, rootKey: root.rootKey, rootAddress: root.rootAddress } as const;
  if (!ADDRESS_SHAPE_V1.test(tokenAddress)) {
    return { ...base, outcome: 'unread', reason: 'not_an_address' };
  }
  const read = await reader.call({
    to: root.rootAddress,
    data: `${root.predicateSelector}${encodeAddressArgV1(tokenAddress)}`,
    blockTag: input.anchor.blockTag,
  });
  if (!read.ok) {
    // A revert here is not "no". The factory implements this selector on both
    // deployments; a revert means the call did not reach a working root, and
    // reporting that as a refutation would delist an issuer over an outage.
    return { ...base, outcome: 'unread', reason: read.reason };
  }
  const answer = decodeBoolV1(read.value);
  if (answer === null) return { ...base, outcome: 'unread', reason: 'unreadable_answer' };
  return {
    ...base,
    outcome: answer ? 'established' : 'refuted',
    blockNumber: input.anchor.blockNumber,
    blockHash: input.anchor.blockHash,
    evidenceHash: stableHashV1('issuer-membership-read/v1', {
      root: root.rootAddress,
      selector: root.predicateSelector,
      token: tokenAddress,
      block: input.anchor.blockHash,
      answer,
    }),
  };
}
