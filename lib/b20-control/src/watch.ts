import type { B20ControlFieldKeyV1, B20ControlSnapshotV1 } from './contracts.js';

// ---------------------------------------------------------------------------
// T67F — B20 Control Watch: what changed about a token between two snapshots.
//
// The premise. A B20 token's launch is the least interesting thing about it.
// What matters is that its controls can change AFTER someone is holding it:
// transfers can be paused, a supply cap can be raised, the rebase multiplier
// can rescale every balance, and `updateName` can rename the token — rotating
// its EIP-712 domain — so a token can be renamed into another one's ticker.
// Nothing outside B20 has this shape, so nothing outside Miorail watches it.
//
// This module is a pure diff. It takes two snapshots the system already stores
// (b20_control_snapshots, one row per tenant + token + block) and says what
// moved. No indexer, no cursor, no reorg handling: the storage is a
// side effect of inspection that already happens.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE
//
// A change is only reported when BOTH sides were read from the chain. A field
// that went from `exact_chain_read` to `unavailable` is not a change in the
// token — it is a change in our ability to see it, and reporting it as
// "supply cap removed" would be a fabrication with an evidence hash attached
// to it. Those cases get their own category and are never alerts.
//
// WHAT THIS CANNOT SEE, AND WHY
//
// Role holders. B20 answers `hasRole(role, address)` for an address you already
// suspect and offers no way to enumerate holders, so "MINT_ROLE was granted"
// is not observable and is not claimed here. What IS observable is the
// consequence: total supply rising, a cap moving, a pause landing. The watch
// reports the effect it can prove and stays silent about the cause it cannot.
// ---------------------------------------------------------------------------

/** How much a change should interrupt someone. Ordering, not a score. */
export type B20ChangeSeverityV1 =
  /** Something a holder's position is directly exposed to right now. */
  | 'acute'
  /** A real change in what the token permits, without immediate exposure. */
  | 'material'
  /** Changed, and benign on its own. */
  | 'informational';

export type B20ChangeKindV1 =
  | 'transfers_paused'
  | 'transfers_unpaused'
  | 'pause_state_changed'
  | 'supply_increased'
  | 'supply_decreased'
  | 'supply_cap_raised'
  | 'supply_cap_lowered'
  | 'supply_cap_removed'
  | 'supply_cap_introduced'
  | 'rebase_multiplier_changed'
  | 'name_changed'
  | 'symbol_changed'
  | 'transfer_policy_changed'
  | 'mint_policy_changed'
  | 'metadata_uri_changed'
  | 'field_changed';

export interface B20ControlChangeV1 {
  kind: B20ChangeKindV1;
  fieldKey: B20ControlFieldKeyV1;
  label: string;
  severity: B20ChangeSeverityV1;
  before: string;
  after: string;
  /** One sentence a holder can act on. Says what changed and what it means for
   * someone holding the token — never what it predicts. */
  detail: string;
  /** Both evidence records, so the claim is checkable at both blocks. */
  evidenceBefore: string | null;
  evidenceAfter: string | null;
}

/** A field whose readability changed. Deliberately NOT a change: it says
 * something about Miorail's view, not about the token. */
export interface B20ObservationGapV1 {
  fieldKey: B20ControlFieldKeyV1;
  label: string;
  direction: 'became_unreadable' | 'became_readable';
  reason: string | null;
}

export interface B20ControlWatchV1 {
  tokenAddress: string;
  /** Null when there is no earlier snapshot to compare against. */
  fromBlock: string | null;
  toBlock: string | null;
  fromObservedAt: string | null;
  toObservedAt: string;
  /** Ordered: acute first, then material, then informational. */
  changes: B20ControlChangeV1[];
  gaps: B20ObservationGapV1[];
  /** Why there is no comparison, when there is none. */
  status: 'compared' | 'first_observation' | 'not_comparable';
  notComparableReason: string | null;
}

const SEVERITY_ORDER_V1: Record<B20ChangeSeverityV1, number> = {
  acute: 0,
  material: 1,
  informational: 2,
};

function readableFields(snapshot: B20ControlSnapshotV1): Map<B20ControlFieldKeyV1, { value: string; label: string; evidenceHash: string | null }> {
  const map = new Map<B20ControlFieldKeyV1, { value: string; label: string; evidenceHash: string | null }>();
  for (const field of snapshot.fields) {
    // `exact_chain_read` is the only status that carries a value. Every other
    // status means "no value", and comparing against one would be comparing
    // against a reason string.
    if (field.status !== 'exact_chain_read' || field.value === null) continue;
    map.set(field.key, { value: field.value, label: field.label, evidenceHash: field.evidenceHash });
  }
  return map;
}

/** Parses the numeric part of a value like "1,000,000" or "12345 (no cap)".
 * Returns null when the value is not a plain integer, which is the signal to
 * fall back to a textual comparison rather than to guess a direction. */
function integerValueV1(value: string): bigint | null {
  const cleaned = value.replace(/[,_\s]/g, '');
  return /^[0-9]+$/.test(cleaned) ? BigInt(cleaned) : null;
}

interface ClassifierV1 {
  label: string;
  classify: (before: string, after: string) => Omit<B20ControlChangeV1, 'fieldKey' | 'label' | 'before' | 'after' | 'evidenceBefore' | 'evidenceAfter'>;
}

const NO_CAP_V1 = /no cap/i;

const CLASSIFIERS_V1: Partial<Record<B20ControlFieldKeyV1, ClassifierV1>> = {
  paused_features: {
    label: 'Paused features',
    classify: (before, after) => {
      const wasOpen = /none paused/i.test(before);
      const isOpen = /none paused/i.test(after);
      const nowPausesTransfers = /transfer/i.test(after);
      const didPauseTransfers = /transfer/i.test(before);
      if (!didPauseTransfers && nowPausesTransfers) {
        return {
          kind: 'transfers_paused',
          severity: 'acute',
          detail:
            'Transfers of this token are paused. While the pause is in place you cannot move or sell this token; the pause applies to this token only.',
        };
      }
      if (didPauseTransfers && !nowPausesTransfers) {
        return {
          kind: 'transfers_unpaused',
          severity: 'material',
          detail: 'Transfers of this token are no longer paused. It can be moved again.',
        };
      }
      return {
        kind: 'pause_state_changed',
        severity: wasOpen === isOpen ? 'material' : 'material',
        detail: 'Which of this token’s features are paused has changed. Transfers are not among the paused features.',
      };
    },
  },
  total_supply: {
    label: 'Total supply',
    classify: (before, after) => {
      const from = integerValueV1(before);
      const to = integerValueV1(after);
      if (from !== null && to !== null && to > from) {
        return {
          kind: 'supply_increased',
          severity: 'material',
          // The cause is not claimed. A mint is the usual explanation and this
          // module cannot see who did it, so it reports the effect.
          detail:
            'New supply exists that did not exist at the previous reading. Each existing unit is now a smaller share of the total.',
        };
      }
      if (from !== null && to !== null && to < from) {
        return {
          kind: 'supply_decreased',
          severity: 'informational',
          detail: 'Total supply is lower than at the previous reading — tokens were burned.',
        };
      }
      return { kind: 'field_changed', severity: 'informational', detail: 'Total supply changed.' };
    },
  },
  supply_cap: {
    label: 'Supply cap',
    classify: (before, after) => {
      const hadCap = !NO_CAP_V1.test(before);
      const hasCap = !NO_CAP_V1.test(after);
      if (hadCap && !hasCap) {
        return {
          kind: 'supply_cap_removed',
          severity: 'acute',
          detail:
            'This token no longer has a supply cap. There is now no on-chain ceiling on how much of it can be created.',
        };
      }
      if (!hadCap && hasCap) {
        return {
          kind: 'supply_cap_introduced',
          severity: 'informational',
          detail: 'A supply cap now limits how much of this token can exist.',
        };
      }
      const from = integerValueV1(before);
      const to = integerValueV1(after);
      if (from !== null && to !== null && to > from) {
        return {
          kind: 'supply_cap_raised',
          severity: 'acute',
          detail:
            'The ceiling on how much of this token can exist has been raised. More can now be created than when you last looked.',
        };
      }
      if (from !== null && to !== null && to < from) {
        return {
          kind: 'supply_cap_lowered',
          severity: 'informational',
          detail: 'The ceiling on how much of this token can exist has been lowered.',
        };
      }
      return { kind: 'field_changed', severity: 'material', detail: 'The supply cap changed.' };
    },
  },
  rebase_multiplier: {
    label: 'Rebase multiplier',
    classify: () => ({
      kind: 'rebase_multiplier_changed',
      severity: 'acute',
      // This is the quietest way a balance can change, which is why it is acute:
      // the number in a wallet moves with no transaction against the account.
      detail:
        'The rebase multiplier changed, which rescales every balance this token reports — including yours. No transfer is involved and nothing appears in your transaction history.',
    }),
  },
  token_name: {
    label: 'Name',
    classify: () => ({
      kind: 'name_changed',
      severity: 'acute',
      detail:
        'This token was renamed. Renaming also rotates its EIP-712 signing domain, and a token can be renamed into another token’s identity — the address is the identity, the name is not.',
    }),
  },
  token_symbol: {
    label: 'Symbol',
    classify: () => ({
      kind: 'symbol_changed',
      severity: 'acute',
      detail:
        'This token’s ticker changed. A ticker can be changed to match a different, better-known token; only the contract address identifies it.',
    }),
  },
  contract_uri: {
    label: 'Contract URI',
    classify: () => ({
      kind: 'metadata_uri_changed',
      severity: 'informational',
      detail: 'The off-chain metadata URI changed. Metadata is not evidence of identity.',
    }),
  },
};

const POLICY_FIELDS_V1: Partial<Record<B20ControlFieldKeyV1, { label: string; kind: B20ChangeKindV1; subject: string }>> = {
  transfer_sender_policy: { label: 'Transfer — sender policy', kind: 'transfer_policy_changed', subject: 'who may send it' },
  transfer_receiver_policy: { label: 'Transfer — receiver policy', kind: 'transfer_policy_changed', subject: 'who may receive it' },
  transfer_executor_policy: { label: 'Transfer — executor policy', kind: 'transfer_policy_changed', subject: 'who may execute a transfer of it' },
  mint_receiver_policy: { label: 'Mint — receiver policy', kind: 'mint_policy_changed', subject: 'who may be minted to' },
};

function classifyV1(
  key: B20ControlFieldKeyV1,
  label: string,
  before: string,
  after: string,
): Omit<B20ControlChangeV1, 'fieldKey' | 'label' | 'before' | 'after' | 'evidenceBefore' | 'evidenceAfter'> {
  const classifier = CLASSIFIERS_V1[key];
  if (classifier) return classifier.classify(before, after);

  const policy = POLICY_FIELDS_V1[key];
  if (policy) {
    return {
      kind: policy.kind,
      severity: 'acute',
      detail: `The policy controlling ${policy.subject} changed. Transfers that were permitted before may now be refused, or the reverse.`,
    };
  }
  // An unknown field that moved is still reported. Saying "something changed"
  // with both values shown beats silence, and beats inventing a meaning.
  return {
    kind: 'field_changed',
    severity: 'material',
    detail: `${label} changed between the two readings.`,
  };
}

/**
 * What changed about one token between two snapshots of it.
 *
 * `previous` is whatever Miorail last read; `current` is the reading just
 * taken. Both must be the same token — comparing two tokens would produce a
 * confident diff of unrelated facts, so it is refused rather than filtered.
 */
export function diffB20SnapshotsV1(
  previous: B20ControlSnapshotV1 | null,
  current: B20ControlSnapshotV1,
): B20ControlWatchV1 {
  const base: Omit<B20ControlWatchV1, 'changes' | 'gaps' | 'status' | 'notComparableReason'> = {
    tokenAddress: current.tokenAddress,
    fromBlock: previous?.blockNumber ?? null,
    toBlock: current.blockNumber,
    fromObservedAt: previous?.observedAt ?? null,
    toObservedAt: current.observedAt,
  };

  if (!previous) {
    return {
      ...base,
      changes: [],
      gaps: [],
      status: 'first_observation',
      notComparableReason: null,
    };
  }
  if (previous.tokenAddress.toLowerCase() !== current.tokenAddress.toLowerCase()) {
    return {
      ...base,
      changes: [],
      gaps: [],
      status: 'not_comparable',
      notComparableReason: 'The two readings are of different tokens.',
    };
  }
  // Same block ⟹ same facts by construction: a snapshot is scoped to exactly
  // one block, so two readings at one block cannot differ without one of them
  // being wrong.
  if (
    previous.blockNumber !== null &&
    previous.blockNumber === current.blockNumber
  ) {
    return {
      ...base,
      changes: [],
      gaps: [],
      status: 'compared',
      notComparableReason: null,
    };
  }

  const before = readableFields(previous);
  const after = readableFields(current);
  const changes: B20ControlChangeV1[] = [];
  const gaps: B20ObservationGapV1[] = [];

  for (const [key, now] of after) {
    const then = before.get(key);
    if (!then) {
      gaps.push({
        fieldKey: key,
        label: now.label,
        direction: 'became_readable',
        reason: null,
      });
      continue;
    }
    if (then.value === now.value) continue;
    changes.push({
      ...classifyV1(key, now.label, then.value, now.value),
      fieldKey: key,
      label: now.label,
      before: then.value,
      after: now.value,
      evidenceBefore: then.evidenceHash,
      evidenceAfter: now.evidenceHash,
    });
  }

  for (const [key, then] of before) {
    if (after.has(key)) continue;
    // The field was readable and is not any more. This is NOT "the cap was
    // removed" — it is "we could not read the cap this time", and presenting
    // it as a change would attach an evidence hash to a fabrication.
    const currentField = current.fields.find((field) => field.key === key);
    gaps.push({
      fieldKey: key,
      label: then.label,
      direction: 'became_unreadable',
      reason: currentField?.reason ?? null,
    });
  }

  changes.sort(
    (left, right) =>
      SEVERITY_ORDER_V1[left.severity] - SEVERITY_ORDER_V1[right.severity] ||
      left.fieldKey.localeCompare(right.fieldKey),
  );

  return { ...base, changes, gaps, status: 'compared', notComparableReason: null };
}

/** The one-line summary. Counts, never a verdict: "3 changes" is a fact and
 * "this token is now risky" is not something a diff can know. */
export function b20WatchSummaryV1(watch: B20ControlWatchV1): string {
  if (watch.status === 'first_observation') {
    return 'First reading of this token — there is nothing to compare it against yet.';
  }
  if (watch.status === 'not_comparable') {
    return watch.notComparableReason ?? 'These readings cannot be compared.';
  }
  if (watch.changes.length === 0) {
    return watch.fromBlock
      ? `No control changed between block ${watch.fromBlock} and block ${watch.toBlock ?? 'unknown'}.`
      : 'No control changed since the previous reading.';
  }
  const acute = watch.changes.filter((change) => change.severity === 'acute').length;
  const total = `${watch.changes.length} control${watch.changes.length === 1 ? '' : 's'} changed`;
  return acute > 0 ? `${total} · ${acute} affecting holders directly` : total;
}

/** Whether anything here should interrupt a user mid-flow. Only acute changes
 * qualify: a metadata URI edit must never look like a paused transfer. */
export function b20WatchNeedsAttentionV1(watch: B20ControlWatchV1): boolean {
  return watch.changes.some((change) => change.severity === 'acute');
}

// ---------------------------------------------------------------------------
// T68 — the exit-relevant controls, extracted from a snapshot.
//
// Lives here rather than in the route because it is knowledge about what the
// field VALUES mean, and those strings are produced two files away. A route
// that re-derived "does `TRANSFER` in paused_features mean I cannot sell" would
// be a second, silently diverging definition of the only question that matters.
// ---------------------------------------------------------------------------

export interface B20ExitControlsV1 {
  factoryConfirmed: boolean;
  /** Transfers are paused right now — nothing can be sold. */
  transfersPaused: boolean;
  /** A transfer policy is active, so specific addresses can be refused. B20
   * offers no way to enumerate one, so this is "a gate exists", never "you are
   * on it". */
  transferPolicyActive: boolean;
  /** Every field that this variant supports was read from the chain. A partial
   * read never clears a token. */
  controlsFullyRead: boolean;
  /** A cap exists. `false` means supply is unbounded on chain. */
  supplyCapped: boolean;
  /** The block all of the above was read at. */
  blockNumber: string | null;
}

/** Open policies are reported as `ALWAYS_ALLOW…`; anything else is a gate. */
const OPEN_POLICY_PREFIX_V1 = 'ALWAYS_ALLOW';
const NO_CAP_MARKER_V1 = 'no cap';
const NONE_PAUSED_V1 = 'none paused';

const TRANSFER_POLICY_KEYS_V1 = [
  'transfer_sender_policy',
  'transfer_receiver_policy',
  'transfer_executor_policy',
] as const;

export function exitControlsFromSnapshotV1(snapshot: B20ControlSnapshotV1): B20ExitControlsV1 {
  const value = (key: string): string | null => {
    const field = snapshot.fields.find((entry) => entry.key === key);
    return field?.status === 'exact_chain_read' ? field.value : null;
  };

  const paused = value('paused_features');
  const cap = value('supply_cap');

  // `unavailable` is the only status that means a read FAILED. A field that is
  // `unsupported_by_variant` or `not_enumerable` was never going to answer, and
  // treating those as failures would make every stablecoin permanently
  // unreadable.
  const controlsFullyRead = !snapshot.fields.some((field) => field.status === 'unavailable');

  return {
    factoryConfirmed:
      snapshot.detection.outcome === 'b20' || snapshot.detection.outcome === 'b20_uninitialised',
    // Only a TRANSFER pause stops a sale. A mint or burn pause does not, and
    // conflating them would refuse tokens that can be exited perfectly well.
    transfersPaused: paused !== null && paused !== NONE_PAUSED_V1 && paused.includes('TRANSFER'),
    transferPolicyActive: TRANSFER_POLICY_KEYS_V1.some((key) => {
      const policy = value(key);
      return policy !== null && !policy.startsWith(OPEN_POLICY_PREFIX_V1);
    }),
    controlsFullyRead,
    supplyCapped: cap !== null && !cap.includes(NO_CAP_MARKER_V1),
    blockNumber: snapshot.blockNumber,
  };
}

// ---------------------------------------------------------------------------
// T68 — the holder's own balance, read from the token.
//
// This exists because a third-party balance indexer does not see B20 tokens.
// They are precompiles at `0xB200…` addresses whose `eth_getCode` returns a
// single byte, so a provider that discovers tokens by scanning deployments
// never lists one — a wallet holding a B20 token is reported as holding
// nothing. The B20 surface therefore reads the balance itself, from the token,
// at the same block as the controls, and does not ask anyone else.
// ---------------------------------------------------------------------------

/** `balanceOf(address)`. */
export const B20_BALANCE_OF_SELECTOR_V1 = '0x70a08231';

export function b20BalanceOfCalldataV1(holder: string): string {
  return `${B20_BALANCE_OF_SELECTOR_V1}${holder.toLowerCase().replace('0x', '').padStart(64, '0')}`;
}

/** Decodes a 32-byte uint. Null when the read failed or was not 32 bytes —
 * never 0, because "the read failed" and "you hold none" are different facts
 * and a wallet showing 0 for the first is a lie about a position. */
export function decodeB20BalanceV1(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const body = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (body.length !== 64 || !/^[0-9a-fA-F]+$/.test(body)) return null;
  return BigInt(`0x${body}`).toString();
}

/** The decimals this snapshot read, so a balance can be formatted without a
 * second source. Null when the field did not answer. */
export function b20DecimalsFromSnapshotV1(snapshot: B20ControlSnapshotV1): number | null {
  const field = snapshot.fields.find((entry) => entry.key === 'token_decimals');
  if (field?.status !== 'exact_chain_read' || field.value === null) return null;
  const parsed = Number.parseInt(field.value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 36 ? parsed : null;
}
