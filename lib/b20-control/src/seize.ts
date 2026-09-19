import {
  B20_POLICY_REGISTRY_V1,
  B20_SELECTORS_V1,
  decodeBoolV1,
  decodeUintV1,
  encodeNoArgsV1,
  encodeUintArgV1,
  encodeWordArgV1,
  policyTypeFromIdV1,
  selectorV1,
  type B20PolicyTypeV1,
} from './pinned.js';
import { callManyV1, type B20ReaderV1 } from './reader.js';

// ---------------------------------------------------------------------------
// Administrative seizure: what the issuer CAN do, kept apart from what it HAS
// done.
//
// Cobalt (mainnet 2026-09-30) adds `seizeWithMemo(from, to, amount, memo)`. It
// is not a transfer a holder can make and not a burn: the balance moves to a
// destination and `totalSupply` is unchanged. It skips allowance AND it skips
// all three transfer policies, so everything Miorail already reads about
// whether a wallet may move a token says NOTHING about whether that balance
// can be taken from it.
//
// THE POLARITY IS INVERTED, AND THIS IS THE WHOLE FILE
//
// `SEIZE_EXEMPT_POLICY` is an EXEMPTION. An account AUTHORIZED by it is exempt
// — it cannot be seized. An account the policy does not authorize is the one
// that can. And an unset slot reads as always-allow, which authorizes
// everybody, which means NOBODY IS SEIZABLE until an issuer configures it.
//
// So the naive sentence — "the policy authorizes this address, so it is
// allowed" — is exactly backwards here, and it is the same shape as the
// sentence that is correct on every other policy slot in this codebase. That
// is why this lives in its own module with its own vocabulary instead of
// reusing the eligibility reader: sharing the code would have meant sharing
// the polarity.
//
// WHY THERE IS NO SINGLE VERDICT
//
// Whether a given seize would succeed depends on the role the caller holds,
// the SEIZE pause bit, the exemption policy, the destination policy, the
// balance, and the documented precedence between them. Miorail cannot hold the
// caller's role — `b20-watch-over-launch-feed` records that role membership is
// not enumerable — so a green "you are safe" would be unprovable and a red
// "they can take it" would be a claim about a call nobody made. This module
// reports the configuration it measured, per address, and leaves the reader to
// read it.
//
// AND CAPABILITY IS NOT OCCURRENCE. `seizeConfiguration` says what is set up.
// `Seized` logs say what happened. They are separate types here so that no
// surface can accidentally render one as the other: a token where seizure is
// configured and has never been used, and a token where it has been used, are
// different facts and a holder is owed both.
// ---------------------------------------------------------------------------

/** `PausableFeature.SEIZE`. Ordinal 3, appended at Cobalt; `1 << 3`. */
export const B20_SEIZE_PAUSE_ORDINAL_V1 = 3n;

export const B20_SEIZE_SELECTORS_V1 = {
  /** `seizeWithMemo(address,address,uint256,bytes32)`. Never called — dialling
   * it is how this build asks whether the surface exists at all. */
  seizeWithMemo: selectorV1('seizeWithMemo(address,address,uint256,bytes32)'),
  seizeRole: selectorV1('SEIZE_ROLE()'),
  seizeExemptPolicy: selectorV1('SEIZE_EXEMPT_POLICY()'),
  seizeReceiverPolicy: selectorV1('SEIZE_RECEIVER_POLICY()'),
} as const;

/** `Seized(caller, from, to, amount)` — note the caller comes FIRST. */
export const B20_SEIZED_EVENT_SIGNATURE_V1 = 'Seized(address,address,address,uint256)' as const;

/**
 * Whether this deployment has the seize surface at all.
 *
 * `available` — the token answered the policy-slot getters.
 * `not_on_this_deployment` — it reverted with its own selector, which is how
 *   the B20 precompile says "no such function". Before Cobalt this is every
 *   token, and it is a fact about the network, not a failure of ours.
 * `not_established` — the read did not complete. Ours, and never presented as
 *   either of the above.
 */
export type B20SeizeSurfaceV1 = 'available' | 'not_on_this_deployment' | 'not_established';

/** Whether an issuer has actually switched seizure on.
 *
 * `armed` — `SEIZE_EXEMPT_POLICY` names a real policy, so some set of accounts
 *   is seizable. WHICH accounts is a separate, per-address question.
 * `unconfigured` — the slot is unset (always-allow), so every account is
 *   exempt and `seizeWithMemo` reverts `AccountNotSeizable` for everyone.
 * `not_established` — unread.
 */
export type B20SeizeArmingV1 = 'armed' | 'unconfigured' | 'not_established';

export interface B20SeizePolicySlotV1 {
  /** Decimal policy id as the token published it, or null when unread. */
  policyId: string | null;
  policyType: B20PolicyTypeV1 | null;
  /** Whether the registry has it. An id that does not exist answers
   * `isAuthorized` with `true`, so this is load-bearing here too. */
  exists: boolean | null;
  reason: string | null;
}

/** What was measured about ONE address, for ONE of the two gates. */
export interface B20SeizeAddressCheckV1 {
  address: string;
  /** For the exemption gate: `exempt` means the policy authorizes it, so it
   * CANNOT be seized. `seizable` means the policy does not. For the receiver
   * gate: `permitted` / `refused`. `not_established` where nothing was read. */
  outcome: 'exempt' | 'seizable' | 'permitted' | 'refused' | 'not_established';
  reason: string | null;
}

export interface B20SeizeConfigurationV1 {
  tokenAddress: string;
  blockTag: string;
  surface: B20SeizeSurfaceV1;
  arming: B20SeizeArmingV1;
  /** Whether the SEIZE pause bit is set. Independent of BURN and TRANSFER. */
  pause: 'paused' | 'not_paused' | 'not_established';
  exemptPolicy: B20SeizePolicySlotV1;
  receiverPolicy: B20SeizePolicySlotV1;
  /** The holder asked about, against `SEIZE_EXEMPT_POLICY`. */
  holder: B20SeizeAddressCheckV1 | null;
  /** The destination asked about, against `SEIZE_RECEIVER_POLICY`. */
  receiver: B20SeizeAddressCheckV1 | null;
}

function unreadSlotV1(reason: string): B20SeizePolicySlotV1 {
  return { policyId: null, policyType: null, exists: null, reason };
}

/**
 * Read the seize configuration for one token at one block.
 *
 * Every field is separately `not_established`-able, because the interesting
 * case is a partial read and a partial read must not collapse into a
 * reassuring whole.
 */
export async function readB20SeizeConfigurationV1(input: {
  reader: B20ReaderV1;
  tokenAddress: string;
  blockTag: string;
  /** The holder whose exposure is being asked about. */
  holder?: string | null;
  /** The destination a seizure would move the balance to. */
  receiver?: string | null;
}): Promise<B20SeizeConfigurationV1> {
  const tokenAddress = input.tokenAddress.toLowerCase();
  const base = { tokenAddress, blockTag: input.blockTag };

  const [exemptKeyRead, receiverKeyRead, pauseRead] = await callManyV1(input.reader, [
    {
      to: tokenAddress,
      data: encodeNoArgsV1(B20_SEIZE_SELECTORS_V1.seizeExemptPolicy),
      blockTag: input.blockTag,
    },
    {
      to: tokenAddress,
      data: encodeNoArgsV1(B20_SEIZE_SELECTORS_V1.seizeReceiverPolicy),
      blockTag: input.blockTag,
    },
    {
      to: tokenAddress,
      data: encodeUintArgV1(B20_SELECTORS_V1.isPaused, B20_SEIZE_PAUSE_ORDINAL_V1),
      blockTag: input.blockTag,
    },
  ]);

  // The precompile echoes an unknown function's OWN selector as revert data.
  // That is the difference between "this network does not have seize yet" and
  // "our endpoint did not answer", and reporting either as the other is the
  // recurring bug this codebase is organised against.
  const echoedItsOwnSelector =
    exemptKeyRead?.ok === false &&
    typeof exemptKeyRead.revertSelector === 'string' &&
    exemptKeyRead.revertSelector.toLowerCase() === `0x${B20_SEIZE_SELECTORS_V1.seizeExemptPolicy}`;
  if (exemptKeyRead?.ok !== true) {
    const surface: B20SeizeSurfaceV1 =
      echoedItsOwnSelector ||
      (exemptKeyRead?.ok === false &&
        (exemptKeyRead.reason === 'reverted' || exemptKeyRead.reason === 'empty_result'))
        ? 'not_on_this_deployment'
        : 'not_established';
    return {
      ...base,
      surface,
      arming: 'not_established',
      pause: 'not_established',
      exemptPolicy: unreadSlotV1(
        surface === 'not_on_this_deployment'
          ? 'This deployment does not carry the seize surface.'
          : 'The token did not answer which policy exempts an account from seizure.',
      ),
      receiverPolicy: unreadSlotV1(
        surface === 'not_on_this_deployment'
          ? 'This deployment does not carry the seize surface.'
          : 'The token did not answer which policy governs a seizure destination.',
      ),
      holder: null,
      receiver: null,
    };
  }

  const pausedBool = pauseRead?.ok ? decodeBoolV1(pauseRead.value) : null;
  const pause: B20SeizeConfigurationV1['pause'] =
    pausedBool === null ? 'not_established' : pausedBool ? 'paused' : 'not_paused';

  // The scope KEY, then the policy id it points at — the same two-step the
  // transfer scopes use, because the key is a view function and a guessed
  // constant reads the wrong slot while looking entirely correct.
  const keys = [
    { slot: 'exempt' as const, read: exemptKeyRead },
    { slot: 'receiver' as const, read: receiverKeyRead },
  ];
  const policyReads = await callManyV1(
    input.reader,
    keys.map((entry) => ({
      to: tokenAddress,
      data:
        entry.read?.ok === true
          ? encodeWordArgV1(B20_SELECTORS_V1.policyId, entry.read.value)
          : encodeWordArgV1(B20_SELECTORS_V1.policyId, `0x${'00'.repeat(32)}`),
      blockTag: input.blockTag,
    })),
  );

  const slots: Record<'exempt' | 'receiver', B20SeizePolicySlotV1> = {
    exempt: unreadSlotV1('The token did not answer which policy exempts an account from seizure.'),
    receiver: unreadSlotV1('The token did not answer which policy governs a seizure destination.'),
  };
  const ids: Partial<Record<'exempt' | 'receiver', bigint>> = {};

  for (const [index, entry] of keys.entries()) {
    if (entry.read?.ok !== true) continue;
    const read = policyReads[index];
    if (!read?.ok) {
      slots[entry.slot] = unreadSlotV1('The token did not answer which policy governs that slot.');
      continue;
    }
    const policyId = decodeUintV1(read.value);
    if (policyId === null) {
      slots[entry.slot] = unreadSlotV1('The policy identifier could not be read.');
      continue;
    }
    ids[entry.slot] = policyId;
    slots[entry.slot] = {
      policyId: policyId.toString(),
      policyType: policyTypeFromIdV1(policyId),
      exists: null,
      reason: null,
    };
  }

  // Existence, for the same reason it is read on the transfer scopes: a policy
  // the registry never had answers `isAuthorized` with `true`, and `true` on
  // the exemption slot means "exempt", which would tell a holder they are safe
  // because of a policy that is not there.
  const existenceTargets = (['exempt', 'receiver'] as const).filter(
    (slot) => ids[slot] !== undefined,
  );
  if (existenceTargets.length > 0) {
    const existence = await callManyV1(
      input.reader,
      existenceTargets.map((slot) => ({
        to: B20_POLICY_REGISTRY_V1,
        data: `0x${B20_SELECTORS_V1.policyExists}${ids[slot]!.toString(16).padStart(64, '0')}`,
        blockTag: input.blockTag,
      })),
    );
    for (const [index, slot] of existenceTargets.entries()) {
      const read = existence[index];
      const exists = read?.ok ? decodeBoolV1(read.value) : null;
      slots[slot] = {
        ...slots[slot],
        exists,
        reason:
          exists === null
            ? 'The policy registry did not answer whether that policy exists.'
            : exists
              ? null
              : 'The policy this token names for that slot is not in the registry.',
      };
    }
  }

  // ALWAYS_ALLOW on the exemption slot exempts everybody, which is the
  // documented "seize does nothing" state, and it is the state every token is
  // in until an issuer deliberately leaves it.
  const exemptId = ids.exempt;
  const arming: B20SeizeArmingV1 =
    exemptId === undefined
      ? 'not_established'
      : exemptId === 0n
        ? 'unconfigured'
        : slots.exempt.exists === false
          ? 'unconfigured'
          : slots.exempt.exists === null
            ? 'not_established'
            : 'armed';

  const holder = await checkAddressV1({
    reader: input.reader,
    blockTag: input.blockTag,
    address: input.holder ?? null,
    policyId: exemptId ?? null,
    exists: slots.exempt.exists,
    gate: 'exempt',
  });
  const receiver = await checkAddressV1({
    reader: input.reader,
    blockTag: input.blockTag,
    address: input.receiver ?? null,
    policyId: ids.receiver ?? null,
    exists: slots.receiver.exists,
    gate: 'receiver',
  });

  return {
    ...base,
    surface: 'available',
    arming,
    pause,
    exemptPolicy: slots.exempt,
    receiverPolicy: slots.receiver,
    holder,
    receiver,
  };
}

const ADDRESS_V1 = /^0x[0-9a-fA-F]{40}$/;

async function checkAddressV1(input: {
  reader: B20ReaderV1;
  blockTag: string;
  address: string | null;
  policyId: bigint | null;
  exists: boolean | null;
  gate: 'exempt' | 'receiver';
}): Promise<B20SeizeAddressCheckV1 | null> {
  if (input.address === null || !ADDRESS_V1.test(input.address)) return null;
  const address = input.address.toLowerCase();
  const unread = (reason: string): B20SeizeAddressCheckV1 => ({
    address,
    outcome: 'not_established',
    reason,
  });
  if (input.policyId === null) return unread('The token did not name a policy for that slot.');
  if (input.exists !== true) {
    return unread('The policy this token names for that slot could not be confirmed to exist.');
  }
  const [read] = await callManyV1(input.reader, [
    {
      to: B20_POLICY_REGISTRY_V1,
      data: `0x${B20_SELECTORS_V1.isAuthorized}${input.policyId.toString(16).padStart(64, '0')}${address.slice(2).padStart(64, '0')}`,
      blockTag: input.blockTag,
    },
  ]);
  if (!read?.ok) return unread('The policy registry did not answer.');
  const authorized = decodeBoolV1(read.value);
  if (authorized === null) {
    return unread('The policy registry answered in a shape this build cannot read.');
  }
  // THE INVERSION. On the exemption gate, authorized means EXEMPT — the
  // account cannot be seized. On the receiver gate it means what it says.
  if (input.gate === 'exempt') {
    return { address, outcome: authorized ? 'exempt' : 'seizable', reason: null };
  }
  return { address, outcome: authorized ? 'permitted' : 'refused', reason: null };
}
