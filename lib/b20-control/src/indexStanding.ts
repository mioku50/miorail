import type { B20DetectionOutcomeV1 } from './contracts.js';

// ---------------------------------------------------------------------------
// Three questions Investigate used to answer with one.
//
// Until 2026-08-16 a missing Discover row was reported as "Not a canonical B20
// launch in Miorail". That sentence is about the TOKEN. The fact behind it is
// about our INDEX. MIO (0xb200…0101) is confirmed by the factory —
// isB20 and isB20Initialized both true — and launched at block 48,661,648, some
// 739,484 blocks before Discover ever began scanning at 49,401,132. Miorail was
// telling a user that its own token was not a B20.
//
// So the axes are kept apart here and downstream:
//
//   B20 identity      — what the factory says
//   Discover index    — whether we ingested the launch
//   measurement       — whether an observation exists
//
// The last one is deliberately NOT part of this type. An indexed launch with no
// observation is `indexed_b20`; the caller reports the missing measurement
// separately, exactly as it did before. Folding it in here would rebuild the
// single status this module exists to take apart.
// ---------------------------------------------------------------------------

export const B20_TOKEN_INDEX_STANDINGS_V1 = [
  /** A canonical launch row exists. Nothing needs to be asked of the chain. */
  'indexed_b20',
  /** The factory confirms the token; Miorail never ingested its launch. */
  'confirmed_b20_not_indexed',
  /** The factory answered, and the answer was no. */
  'not_b20',
  /** Nobody answered. This is not a statement about the token. */
  'identity_check_unavailable',
] as const;

export type B20TokenIndexStandingV1 = (typeof B20_TOKEN_INDEX_STANDINGS_V1)[number];

/**
 * Map an index lookup and a factory detection onto one of four states.
 *
 * `detection` is null when the check was not attempted — the same standing as a
 * check that failed, because both leave the token's identity unestablished.
 * There is no branch that turns silence into `not_b20`; absence of evidence is
 * not evidence of non-B20, and that is the whole point of the type.
 */
export function b20TokenIndexStandingV1(input: {
  indexed: boolean;
  detection: B20DetectionOutcomeV1 | null;
}): B20TokenIndexStandingV1 {
  if (input.indexed) return 'indexed_b20';
  switch (input.detection) {
    // `b20_uninitialised` is isB20 true with isB20Initialized false: created,
    // not finished. The factory still confirms the identity, so calling it
    // "not a B20" would be the same error in a narrower place. The unfinished
    // state is worth saying, and the caller says it from the detection outcome
    // it still holds.
    case 'b20':
    case 'b20_uninitialised':
      return 'confirmed_b20_not_indexed';
    case 'not_b20':
      return 'not_b20';
    // rpc_failure, unavailable_at_block, invalid_address, unsupported_chain and
    // null all mean the same thing to a reader: we did not establish what this
    // address is. Listed rather than defaulted so a new outcome added to the
    // detection enum fails the exhaustiveness check below instead of silently
    // arriving here.
    case 'rpc_failure':
    case 'unavailable_at_block':
    case 'invalid_address':
    case 'unsupported_chain':
    case null:
      return 'identity_check_unavailable';
    default: {
      const exhaustive: never = input.detection;
      void exhaustive;
      return 'identity_check_unavailable';
    }
  }
}

/** True when the factory settled the question either way. */
export function b20IdentityWasEstablishedV1(standing: B20TokenIndexStandingV1): boolean {
  return standing !== 'identity_check_unavailable';
}
