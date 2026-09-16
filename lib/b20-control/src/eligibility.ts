import {
  B20_POLICY_REGISTRY_V1,
  B20_SELECTORS_V1,
  decodeBoolV1,
  decodeUintV1,
  encodeNoArgsV1,
  encodeUintArgV1,
  encodeWordArgV1,
  policyTypeFromIdV1,
  type B20PolicyTypeV1,
} from './pinned.js';
import { callManyV1, type B20ReaderV1 } from './reader.js';

// ---------------------------------------------------------------------------
// The token's own transfer rules — the third axis.
//
// Stocks already answers two questions about a representation: is there a route
// for cash, and does the money come back if you take it. Both are about the
// market. Neither is about the holder, and for a regulated asset that is where
// a surprise lives: a B20 carries transfer policies, and a policy can deny one
// address while the market is perfectly healthy.
//
// Measured on Base 2026-08-31, at one block, on NVDAc and TSLAc: all three
// transfer scopes on both tokens point at policy id 5, whose type byte is 0x00
// — a live BLOCKLIST, not ALWAYS_ALLOW. Both an ordinary holder address and the
// KyberSwap router came back authorized, and `isPaused` answered `false` for
// transfer, mint and burn on both. So this is a real, readable surface, and
// nobody had asked it.
//
// THREE SCOPES, NOT TWO, AND THEY ARE ABOUT TWO DIFFERENT ADDRESSES
//
//   transfer_sender    the wallet, giving the token up
//   transfer_receiver  the wallet, taking the token in
//   transfer_executor  whoever CALLS `transferFrom` — a router or a spender,
//                      which on a sell is not the wallet at all
//
// The executor scope is therefore asked about the executor's address, and when
// this step does not yet know which contract would move the token it is
// `not_established` — never assumed to be the wallet, and never assumed open.
// A sell that a wallet is perfectly authorized to make can still be refused
// because the router doing the moving is not.
//
// WHY THIS CAN BE ANSWERED AT ALL
//
// `IPolicyRegistry.isAuthorized` is documented never to revert for any
// combination of policy id and account, and it held across every case tried:
// ALWAYS_ALLOW authorizes everyone, ALWAYS_BLOCK denies everyone, an absent
// blocklist authorizes and an absent allowlist denies. That guarantee is what
// makes a verdict here safe to render — the read either answers or the
// transport failed, with no third outcome to misread.
//
// TWO RULES THIS FILE DOES NOT BEND
//
//   1. A failed read is `not_established`, never `denied`. Telling a holder
//      their address is blocked because our RPC was throttled would be the
//      worst false positive this product could produce. That applies to the
//      pause read too: unread is not unpaused.
//
//   2. The scopes stay apart. They are separate policy slots on the token, they
//      can disagree, they are about different addresses, and one collapsed
//      "can trade" bit would hide which of the three applies.
//
// THE READ IS EVIDENCE. It states what the registry said and lets the reader
// decide, and it says nothing about whether a route exists or what it costs — a
// wallet can be perfectly authorized to hold something it cannot sell. One
// function at the bottom of this file turns that evidence into a precondition
// for one action; it is the only thing here that decides anything, and it can
// only ever decide on a MEASURED denial.
// ---------------------------------------------------------------------------

/** The transfer scopes that decide whether one transfer may happen. */
export const B20_ELIGIBILITY_SCOPES_V1 = [
  'transfer_sender',
  'transfer_receiver',
  'transfer_executor',
] as const;
export type B20EligibilityScopeV1 = (typeof B20_ELIGIBILITY_SCOPES_V1)[number];

/** Whose address a scope is about. The executor is a contract on a
 * `transferFrom`, so a surface must never present its verdict as the wallet's. */
export const B20_ELIGIBILITY_SCOPE_SUBJECT_V1: Readonly<
  Record<B20EligibilityScopeV1, 'wallet' | 'executor'>
> = {
  transfer_sender: 'wallet',
  transfer_receiver: 'wallet',
  transfer_executor: 'executor',
};

/**
 * What the registry said about one scope.
 *
 * `not_established` covers every way an answer failed to arrive, and is the
 * only value that may be produced without a completed read.
 */
export type B20EligibilityVerdictV1 = 'authorized' | 'denied' | 'not_established';

export interface B20ScopeEligibilityV1 {
  scope: B20EligibilityScopeV1;
  subject: 'wallet' | 'executor';
  /** The address this verdict is about, lowercased, or null when there was
   * none to ask about. */
  account: string | null;
  verdict: B20EligibilityVerdictV1;
  /** The policy the token points this scope at, as decimal. Null when the
   * token did not answer — a token with no policy slot is a real state. */
  policyId: string | null;
  policyType: B20PolicyTypeV1 | null;
  /** Why, when the verdict is `not_established`. Never a provider or endpoint
   * detail: an RPC URL must not reach evidence. */
  reason: string | null;
}

/** Whether the contract itself is currently refusing transfers. Separate from
 * every per-address verdict: a pause denies everyone at once, and reading one
 * as the other would name the wrong cause. */
export interface B20TransferPauseV1 {
  state: 'paused' | 'not_paused' | 'not_established';
  reason: string | null;
}

export interface B20TransferEligibilityV1 {
  tokenAddress: string;
  wallet: string;
  /** The contract that would actually move the token on a `transferFrom`, when
   * this step knows it. Null is an ordinary state — a review page usually does
   * not yet know which router the calls will target. */
  executor: string | null;
  /** The single block every verdict here was read at. Two verdicts from two
   * blocks are two facts, and this surface states one. */
  blockTag: string;
  blockNumber: string | null;
  transferPause: B20TransferPauseV1;
  scopes: B20ScopeEligibilityV1[];
}

const SCOPE_SELECTOR_V1: Readonly<Record<B20EligibilityScopeV1, string>> = {
  transfer_sender: B20_SELECTORS_V1.transferSenderPolicy,
  transfer_receiver: B20_SELECTORS_V1.transferReceiverPolicy,
  transfer_executor: B20_SELECTORS_V1.transferExecutorPolicy,
};

/** `PausableFeature.Transfer`. Ordinal 0 in the spec's append-only enum. */
const TRANSFER_PAUSE_ORDINAL_V1 = 0n;

const ADDRESS_V1 = /^0x[0-9a-fA-F]{40}$/;

function encodeIsAuthorizedV1(policyId: bigint, account: string): string {
  const id = policyId.toString(16).padStart(64, '0');
  const padded = account.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return `0x${B20_SELECTORS_V1.isAuthorized}${id}${padded}`;
}

function unresolvedV1(
  scope: B20EligibilityScopeV1,
  account: string | null,
  reason: string,
): B20ScopeEligibilityV1 {
  return {
    scope,
    subject: B20_ELIGIBILITY_SCOPE_SUBJECT_V1[scope],
    account,
    verdict: 'not_established',
    policyId: null,
    policyType: null,
    reason,
  };
}

/**
 * Whether one wallet may send and receive one exact B20, and whether the
 * contract would let anyone.
 *
 * Four round trips at one block: the pause flag, the scope keys off the token,
 * the policy id each scope points at, then the registry's verdict for the
 * address that scope is about. The scope keys are READ rather than hardcoded
 * for the same reason the inspector reads them — they are view functions, and a
 * guessed constant queries the wrong scope while looking entirely correct.
 */
export async function readB20TransferEligibilityV1(input: {
  reader: B20ReaderV1;
  tokenAddress: string;
  wallet: string;
  /** The address that would call `transferFrom`, when it is known. */
  executor?: string | null;
  blockTag: string;
  blockNumber?: string | null;
}): Promise<B20TransferEligibilityV1> {
  const executor = input.executor && ADDRESS_V1.test(input.executor) ? input.executor : null;
  const walletKnown = ADDRESS_V1.test(input.wallet);
  const accountFor = (scope: B20EligibilityScopeV1): string | null =>
    B20_ELIGIBILITY_SCOPE_SUBJECT_V1[scope] === 'executor'
      ? (executor?.toLowerCase() ?? null)
      : walletKnown
        ? input.wallet.toLowerCase()
        : null;

  const base = {
    tokenAddress: input.tokenAddress.toLowerCase(),
    wallet: input.wallet.toLowerCase(),
    executor: executor?.toLowerCase() ?? null,
    blockTag: input.blockTag,
    blockNumber: input.blockNumber ?? null,
  };

  const pauseRead = await callManyV1(input.reader, [
    {
      to: input.tokenAddress,
      data: encodeUintArgV1(B20_SELECTORS_V1.isPaused, TRANSFER_PAUSE_ORDINAL_V1),
      blockTag: input.blockTag,
    },
  ]);
  const pausedBool = pauseRead[0]?.ok ? decodeBoolV1(pauseRead[0].value) : null;
  const transferPause: B20TransferPauseV1 =
    pausedBool === null
      ? {
          state: 'not_established',
          // Unread is not unpaused. Rendering a green "transfers are open" from
          // a throttled RPC would be the same false positive as a wrong denial,
          // pointing the other way.
          reason: 'Whether transfers are paused on this contract was not read.',
        }
      : { state: pausedBool ? 'paused' : 'not_paused', reason: null };

  if (!walletKnown && executor === null) {
    return {
      ...base,
      transferPause,
      scopes: B20_ELIGIBILITY_SCOPES_V1.map((scope) =>
        unresolvedV1(scope, null, 'No wallet address was supplied to check.'),
      ),
    };
  }

  const scopeReads = await callManyV1(
    input.reader,
    B20_ELIGIBILITY_SCOPES_V1.map((scope) => ({
      to: input.tokenAddress,
      data: encodeNoArgsV1(SCOPE_SELECTOR_V1[scope]),
      blockTag: input.blockTag,
    })),
  );

  const policyReads = await callManyV1(
    input.reader,
    B20_ELIGIBILITY_SCOPES_V1.map((_scope, index) => {
      const read = scopeReads[index];
      // A token that will not name its scope cannot be asked for its policy.
      // The call still has to occupy this slot so the arrays stay aligned.
      const key = read?.ok ? read.value : `0x${'0'.repeat(64)}`;
      return {
        to: input.tokenAddress,
        data: encodeWordArgV1(B20_SELECTORS_V1.policyId, key),
        blockTag: input.blockTag,
      };
    }),
  );

  const resolved: { scope: B20EligibilityScopeV1; policyId: bigint; account: string }[] = [];
  const scopes: B20ScopeEligibilityV1[] = B20_ELIGIBILITY_SCOPES_V1.map((scope, index) => {
    const account = accountFor(scope);
    const scopeRead = scopeReads[index];
    if (!scopeRead?.ok) {
      return unresolvedV1(scope, account, 'This token did not name that transfer policy scope.');
    }
    const policyRead = policyReads[index];
    if (!policyRead?.ok) {
      return unresolvedV1(scope, account, 'The token did not answer which policy governs that scope.');
    }
    const policyId = decodeUintV1(policyRead.value);
    if (policyId === null) {
      return unresolvedV1(scope, account, 'The policy identifier could not be read.');
    }
    const partial = {
      scope,
      subject: B20_ELIGIBILITY_SCOPE_SUBJECT_V1[scope],
      account,
      policyId: policyId.toString(),
      policyType: policyTypeFromIdV1(policyId),
    };
    if (account === null) {
      // The policy IS known — it is the address that is not. Carrying the
      // policy forward keeps the honest half of the answer, and the reason
      // says which half is missing rather than implying the token was silent.
      return {
        ...partial,
        verdict: 'not_established' as const,
        reason:
          B20_ELIGIBILITY_SCOPE_SUBJECT_V1[scope] === 'executor'
            ? 'The contract that would move this token is not known at this step, so its permission was not checked.'
            : 'No wallet address was supplied to check.',
      };
    }
    resolved.push({ scope, policyId, account });
    return { ...partial, verdict: 'not_established' as const, reason: null };
  });

  if (resolved.length === 0) return { ...base, transferPause, scopes };

  const verdicts = await callManyV1(
    input.reader,
    resolved.map((entry) => ({
      to: B20_POLICY_REGISTRY_V1,
      data: encodeIsAuthorizedV1(entry.policyId, entry.account),
      blockTag: input.blockTag,
    })),
  );

  for (const [index, entry] of resolved.entries()) {
    const target = scopes.find((row) => row.scope === entry.scope);
    if (!target) continue;
    const read = verdicts[index];
    if (!read?.ok) {
      // The registry is documented never to revert, so reaching here means the
      // transport failed. That is OURS, and it is never a denial.
      target.reason = 'The policy registry did not answer, so nothing was established.';
      continue;
    }
    const authorized = decodeBoolV1(read.value);
    if (authorized === null) {
      target.reason = 'The policy registry answered in a shape this build cannot read.';
      continue;
    }
    target.verdict = authorized ? 'authorized' : 'denied';
    target.reason = null;
  }

  return { ...base, transferPause, scopes };
}

// ---------------------------------------------------------------------------
// Phase 17.5 — the same evidence, asked as a precondition.
//
// Everything above is deliberately not a gate: it states what the registry said
// and lets the reader decide. That was right while the only thing downstream of
// it was another page. It stopped being enough the moment a Stocks card grew
// `Prepare buy` / `Prepare sell`, because the step after those hands out a
// clearance — the authority to ask this server for an unsigned request — and
// that step was not asking the token whether this wallet may move it at all.
//
// So the read stays exactly as it is, and ONE function turns it into a verdict
// about ONE action. Two rules decide the whole shape:
//
//   1. ONLY A MEASURED DENIAL REFUSES. `not_established` never does, and a read
//      that did not happen never does. A throttled RPC telling a holder they
//      are blocked is the worst false positive this product could produce, and
//      it would be indistinguishable from the real thing. This gate therefore
//      fails OPEN, and every surface that renders it has to say so — it is the
//      issuer's own rule, enforced where the issuer publishes it, and it is not
//      a jurisdiction check, an eligibility ruling, or a substitute for either.
//
//   2. ONLY THE SCOPE THAT GOVERNS THIS DIRECTION COUNTS. A buy puts the token
//      INTO the wallet, so the receiver policy governs and the sender policy is
//      about a transfer nobody is making. Refusing a purchase because the
//      wallet may not SEND would be refusing on a rule that does not apply —
//      the same error as reading a router's verdict as the wallet's.
//
// The executor scope can never refuse here, and that is not an oversight: at
// this step no router has been chosen, so its verdict is `not_established`
// about a null address. It is checked where the executor is known, or not at
// all — never guessed.
// ---------------------------------------------------------------------------

/** Which wallet scope governs a direction. A buy receives, a sell sends. */
export const B20_DIRECTION_SCOPE_V1: Readonly<
  Record<'buy' | 'sell', Extract<B20EligibilityScopeV1, 'transfer_sender' | 'transfer_receiver'>>
> = {
  buy: 'transfer_receiver',
  sell: 'transfer_sender',
};

export type B20TransferGateCauseV1 = 'transfers_paused' | 'wallet_not_authorized';

export interface B20TransferGateV1 {
  direction: 'buy' | 'sell';
  /** The scope whose verdict was consulted. Named so a refusal can say which
   * rule refused rather than asserting a general one. */
  governingScope: 'transfer_sender' | 'transfer_receiver';
  /**
   * `denied` is the ONLY value that may stop anything. `not_established` is a
   * question that was not answered, and it is a state this product renders
   * rather than resolves.
   */
  state: B20EligibilityVerdictV1;
  cause: B20TransferGateCauseV1 | null;
  /** The block the governing verdict was read at, so a refusal is checkable. */
  blockTag: string | null;
  detail: string;
}

const GATE_DETAIL_V1: Readonly<Record<B20TransferGateCauseV1, Record<'buy' | 'sell', string>>> = {
  transfers_paused: {
    buy: 'This token’s own contract is refusing all transfers right now, so it cannot be delivered to any wallet — including one that is otherwise authorized. That is the issuer’s pause, not a Miorail rule and not a statement about you.',
    sell: 'This token’s own contract is refusing all transfers right now, so no holder can move it — including one that is otherwise authorized. That is the issuer’s pause, not a Miorail rule and not a statement about you.',
  },
  wallet_not_authorized: {
    buy: 'The issuer’s policy registry answered that this exact wallet is not authorized to receive this exact token. Miorail cannot carry an action the token itself would refuse, so nothing was prepared. This is the issuer’s rule for this address, read on chain — Miorail does not set it and cannot lift it.',
    sell: 'The issuer’s policy registry answered that this exact wallet is not authorized to send this exact token. Miorail cannot carry an action the token itself would refuse, so nothing was prepared. This is the issuer’s rule for this address, read on chain — Miorail does not set it and cannot lift it.',
  },
};

const GATE_OPEN_DETAIL_V1 =
  'The issuer’s policy registry answered for this exact wallet and this exact token at one block, and it did not refuse. It says nothing about the market, about what a sale would cost, or about eligibility to hold the security.';

const GATE_UNKNOWN_DETAIL_V1 =
  'Whether the issuer’s policy permits this exact wallet was not established. Miorail does not read an unanswered question as a refusal, so nothing is blocked on it — and nothing is claimed either.';

/**
 * Turn a transfer-eligibility read into a verdict about one action.
 *
 * `null` — no read at all, because no RPC was reachable or the anchor failed —
 * is `not_established`, exactly like a read that answered nothing. The absence
 * of evidence and the absence of a restriction are the two states this product
 * exists to keep apart, and neither of them is a denial.
 */
export function b20TransferGateV1(input: {
  eligibility: B20TransferEligibilityV1 | null | undefined;
  direction: 'buy' | 'sell';
}): B20TransferGateV1 {
  const governingScope = B20_DIRECTION_SCOPE_V1[input.direction];
  const base = { direction: input.direction, governingScope };
  const eligibility = input.eligibility ?? null;
  if (!eligibility) {
    return { ...base, state: 'not_established', cause: null, blockTag: null, detail: GATE_UNKNOWN_DETAIL_V1 };
  }
  const blockTag = eligibility.blockTag;

  // A pause denies everyone at once, so it outranks every per-address verdict:
  // an authorized wallet still cannot move a token the contract has frozen.
  if (eligibility.transferPause.state === 'paused') {
    return {
      ...base,
      state: 'denied',
      cause: 'transfers_paused',
      blockTag,
      detail: GATE_DETAIL_V1.transfers_paused[input.direction],
    };
  }

  const scope = eligibility.scopes.find((row) => row.scope === governingScope) ?? null;
  if (scope?.verdict === 'denied') {
    return {
      ...base,
      state: 'denied',
      cause: 'wallet_not_authorized',
      blockTag,
      detail: GATE_DETAIL_V1.wallet_not_authorized[input.direction],
    };
  }
  if (scope?.verdict === 'authorized') {
    return { ...base, state: 'authorized', cause: null, blockTag, detail: GATE_OPEN_DETAIL_V1 };
  }
  return { ...base, state: 'not_established', cause: null, blockTag, detail: GATE_UNKNOWN_DETAIL_V1 };
}

/**
 * The one comparison a caller makes.
 *
 * Written out rather than left to each call site: `state !== 'authorized'` is
 * the natural thing to type and it is the bug — it turns every unread policy,
 * every throttled RPC and every non-B20 contract into a refusal.
 */
export function b20TransferGateRefusesV1(gate: B20TransferGateV1): boolean {
  return gate.state === 'denied';
}

// ---------------------------------------------------------------------------
// The executor gate — the check that has an address to ask about.
//
// `b20TransferGateV1` above runs where the router is not yet chosen, so it
// consults the wallet's own scope and says so. One step later the router IS
// chosen: it is the spender in the approval the holder is about to sign, and
// it is the contract that will call `transferFrom`. That is the moment the
// executor scope has a subject, and it is the last moment before a signature.
//
// WHY THIS IS NOT COVERED BY THE APPROVAL ITSELF. `approve()` is not policy
// gated — Base Docs states it separately, and it is the kind of true fact a
// reader turns into a false one. An allowance to a router will be granted to
// an executor the policy refuses, and the revert arrives on the transfer,
// after the wallet has signed twice and paid for both.
//
// MEASURED 2026-09-16: all thirteen Coinbase representations bind policy 5 to
// all three transfer scopes, and policy 5 authorizes every address tried —
// including the zero address and USDC. So this gate has nothing to refuse
// today. That is the finding, not a reason to skip the read: a bound policy
// whose contents can change is exactly the thing you check before signing, and
// `isAuthorized` on a policy id that does NOT exist also answers `true`, which
// is why `policyExists` stays in the read above and why an unread policy here
// is never an allowance.
// ---------------------------------------------------------------------------

/** `approve(address,uint256)`. The only call whose spender this module reads. */
const ERC20_APPROVE_SELECTOR_V1 = '0x095ea7b3';

/**
 * The executor, taken from the approval the holder is about to sign.
 *
 * Only an approval ON THE REVIEWED TOKEN establishes one. A sell approves the
 * token and the spender is the contract that will call `transferFrom`; a buy
 * approves the CASH asset, and the contract that delivers the token is not
 * named anywhere in the batch. So a buy returns null, and null is
 * `not_established` rather than a guess — the same rule the scope read has
 * followed since it was written.
 */
export function b20ExecutorFromApprovalV1(input: {
  tokenAddress: string;
  calls: readonly { to?: unknown; data?: unknown }[];
}): string | null {
  const token = input.tokenAddress.toLowerCase();
  if (!ADDRESS_V1.test(token)) return null;
  const spenders = new Set<string>();
  for (const call of input.calls) {
    const to = typeof call?.to === 'string' ? call.to.toLowerCase() : null;
    const data = typeof call?.data === 'string' ? call.data.toLowerCase() : null;
    if (to !== token || data === null) continue;
    if (!data.startsWith(ERC20_APPROVE_SELECTOR_V1) || data.length !== 10 + 128) continue;
    const spender = `0x${data.slice(10 + 24, 10 + 64)}`;
    if (ADDRESS_V1.test(spender)) spenders.add(spender);
  }
  // Two different spenders in one batch is not a question this can answer with
  // one verdict, and answering the first one would label the second's risk
  // with the first one's result.
  return spenders.size === 1 ? [...spenders][0]! : null;
}

export interface B20ExecutorGateV1 {
  /** The address the verdict is about, or null when the batch established none. */
  executor: string | null;
  state: B20EligibilityVerdictV1;
  cause: 'executor_not_authorized' | null;
  blockTag: string | null;
  detail: string;
}

const EXECUTOR_GATE_DENIED_V1 =
  'The issuer’s policy registry answered that the contract this batch would authorize to move the token is not itself authorized to move it. The approval would be granted and the transfer would then revert, after the wallet had signed. Nothing was released. This is the issuer’s rule for that contract, read on chain — Miorail does not set it and cannot lift it.';

const EXECUTOR_GATE_OPEN_V1 =
  'The issuer’s policy registry answered for the exact contract this batch authorizes, at one block, and it did not refuse. It says nothing about whether the route will fill or what it will cost.';

const EXECUTOR_GATE_UNKNOWN_V1 =
  'Which contract will move the token was not established by this batch, or the issuer’s policy for it was not read. Miorail does not read an unanswered question as a refusal, so nothing is blocked on it — and nothing is claimed either. An approval is not policy gated, so a granted allowance proves nothing here.';

/**
 * Turn the executor scope of one read into a verdict about one release.
 *
 * Same two rules as the wallet gate, for the same reasons: only a MEASURED
 * denial refuses, and only the scope that governs this question is consulted.
 * A wallet verdict may never arrive here — it is about a different address.
 */
export function b20ExecutorGateV1(input: {
  eligibility: B20TransferEligibilityV1 | null | undefined;
}): B20ExecutorGateV1 {
  const eligibility = input.eligibility ?? null;
  if (!eligibility) {
    return {
      executor: null,
      state: 'not_established',
      cause: null,
      blockTag: null,
      detail: EXECUTOR_GATE_UNKNOWN_V1,
    };
  }
  const scope = eligibility.scopes.find((row) => row.scope === 'transfer_executor') ?? null;
  const base = { executor: eligibility.executor, blockTag: eligibility.blockTag };
  if (scope?.verdict === 'denied') {
    return { ...base, state: 'denied', cause: 'executor_not_authorized', detail: EXECUTOR_GATE_DENIED_V1 };
  }
  if (scope?.verdict === 'authorized' && eligibility.executor !== null) {
    return { ...base, state: 'authorized', cause: null, detail: EXECUTOR_GATE_OPEN_V1 };
  }
  return { ...base, state: 'not_established', cause: null, detail: EXECUTOR_GATE_UNKNOWN_V1 };
}

/** The one comparison a caller makes. Written out for the same reason
 * `b20TransferGateRefusesV1` is: `!== 'authorized'` is the natural thing to
 * type and it turns every unread policy into a refusal. */
export function b20ExecutorGateRefusesV1(gate: B20ExecutorGateV1): boolean {
  return gate.state === 'denied';
}
