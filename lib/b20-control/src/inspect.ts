import {
  B20ControlCardV1Schema,
  B20ControlEvidenceV1Schema,
  B20ControlSnapshotV1Schema,
  B20DetectionResultV1Schema,
  b20TokenIdentityHashV1,
  hashB20CardV1,
  hashB20EvidenceV1,
  hashB20SnapshotV1,
  type B20ControlCardV1,
  type B20ControlEvidenceV1,
  type B20ControlFieldKeyV1,
  type B20ControlFieldV1,
  type B20ControlSnapshotV1,
  type B20ControlStatementV1,
  type B20DetectionResultV1,
  type B20VariantV1,
} from './contracts.js';
import {
  B20_ALWAYS_ALLOW_V1,
  B20_ALWAYS_BLOCK_V1,
  B20_ERROR_SELECTORS_V1,
  B20_FACTORY_V1,
  B20_SELECTORS_V1,
  decodeBytes32V1,
  decodeStringV1,
  decodeUint8ArrayV1,
  decodeUint8V1,
  decodeUintV1,
  encodeNoArgsV1,
  encodeWordArgV1,
  pausableFeatureFromOrdinalV1,
  policyTypeFromIdV1,
  variantFromAddressV1,
} from './pinned.js';
import {
  isSupportedB20ChainV1,
  isWellFormedAddressV1,
  rawResponseHashV1,
  type B20ReaderV1,
  type B20RpcResultV1,
} from './reader.js';
import type { HashV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T67C — assembling the snapshot.
//
// The shape of this file follows one rule: a field exists on the card only if
// a confirmed method answered for it at the pinned block. Everything else is a
// row that states why it is empty. There is no aggregate anywhere — no score,
// no percentage, no verdict — because there is nowhere in the contracts to put
// one and nothing here computes one.
// ---------------------------------------------------------------------------

/** Identifies the interface revision the selectors came from. Recorded on every
 * evidence record so a later reader knows which spec a decode assumed. */
export const B20_SOURCE_VERSION_V1 = 'base-std@6fc07aa (beryl b20 spec, 2026-07-27)';

export interface B20InspectInputV1 {
  tenantId: string;
  chainId: number;
  tokenAddress: string;
  now: Date;
  /** Deterministic id, so the same token at the same block is the same row. */
  snapshotId?: string;
}

export interface B20InspectDepsV1 {
  reader: B20ReaderV1;
}

export interface B20InspectResultV1 {
  snapshot: B20ControlSnapshotV1;
  card: B20ControlCardV1;
}

/** Why a request was refused before any read was attempted. */
export type B20RequestRefusalV1 = 'unsupported_chain' | 'invalid_address';

export class B20RequestError extends Error {
  readonly refusal: B20RequestRefusalV1;
  constructor(refusal: B20RequestRefusalV1, message: string) {
    super(message);
    this.name = 'B20RequestError';
    this.refusal = refusal;
  }
}

/**
 * Whether a request can be answered at all, decided with no network access.
 *
 * Kept separate from inspection because these are the two cases that produce
 * NO snapshot: a snapshot is keyed by chain and address, and neither exists
 * here. The API layer uses this to answer 400 without opening a socket.
 */
export function validateB20InspectRequestV1(chainId: number, tokenAddress: string): B20RequestRefusalV1 | null {
  if (!isSupportedB20ChainV1(chainId)) return 'unsupported_chain';
  if (!isWellFormedAddressV1(tokenAddress)) return 'invalid_address';
  return null;
}

export function refusalDetailV1(refusal: B20RequestRefusalV1): string {
  return refusal === 'unsupported_chain'
    ? 'This card reads Base mainnet (8453) only.'
    : 'That is not a 20-byte address.';
}

export function b20SnapshotIdV1(input: { tenantId: string; chainId: number; tokenAddress: string; blockNumber: string | null }): string {
  const hash = stableIdHashV1({
    tenantId: input.tenantId,
    chainId: input.chainId,
    tokenAddress: input.tokenAddress.toLowerCase(),
    blockNumber: input.blockNumber,
  });
  return `b20-snapshot:${hash.slice(2)}`;
}

function stableIdHashV1(payload: unknown): HashV1 {
  // Imported lazily through the domain helper to keep one hashing implementation.
  return hashB20EvidenceV1({ __id: payload } as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Evidence construction
// ---------------------------------------------------------------------------

interface ReadPlanV1 {
  key: B20ControlFieldKeyV1;
  label: string;
  target: string;
  methodSignature: string;
  selector: string;
  data: `0x${string}`;
  /** Turns raw bytes into a display string, or null when unreadable. */
  decode: (raw: string) => string | null;
  /** Variants this read applies to. Absent means all. */
  variants?: readonly B20VariantV1[];
}

function evidenceFor(input: {
  plan: ReadPlanV1;
  tokenAddress: string;
  blockNumber: string;
  blockHash: HashV1;
  observedAt: string;
  raw: string | null;
  decodedValue: string | null;
  revertSelector: string | null;
}): B20ControlEvidenceV1 {
  const draft = {
    schemaVersion: 'b20-control-evidence/v1' as const,
    evidenceHash: '0x'.padEnd(66, '0'),
    chainId: 8453 as const,
    tokenAddress: input.tokenAddress.toLowerCase(),
    target: input.plan.target.toLowerCase(),
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    methodSignature: input.plan.methodSignature,
    selector: `0x${input.plan.selector}`,
    // A call that never returned bytes still gets a hash — of the empty
    // string — so the record cannot be mistaken for one that was never made.
    rawResponseHash: rawResponseHashV1(input.raw ?? ''),
    decodedValue: input.decodedValue,
    revertSelector: input.revertSelector ? `0x${input.revertSelector}` : null,
    observedAt: input.observedAt,
    verification: 'exact_chain_read' as const,
    sourceVersion: B20_SOURCE_VERSION_V1,
  };
  return B20ControlEvidenceV1Schema.parse({ ...draft, evidenceHash: hashB20EvidenceV1(draft) });
}

// ---------------------------------------------------------------------------
// Field decoders
// ---------------------------------------------------------------------------

function formatPolicyV1(raw: string): string | null {
  const value = decodeUintV1(raw);
  if (value === null) return null;
  if (value === B20_ALWAYS_ALLOW_V1) return 'ALWAYS_ALLOW (no restriction configured)';
  if (value === B20_ALWAYS_BLOCK_V1) return 'ALWAYS_BLOCK (every account denied)';
  const type = policyTypeFromIdV1(value);
  const label =
    type === 'unknown'
      ? 'policy type not documented in the Beryl spec'
      : `${type} policy`;
  return `#${value.toString()} — ${label}`;
}

function formatPausedV1(raw: string): string | null {
  const ordinals = decodeUint8ArrayV1(raw);
  if (ordinals === null) return null;
  if (ordinals.length === 0) return 'none paused';
  // An ordinal beyond the documented enum is reported as unknown rather than
  // mapped to a neighbour — the enum is append-only, so a future member would
  // otherwise be silently renamed to an existing one.
  return ordinals
    .map((ordinal) => pausableFeatureFromOrdinalV1(ordinal) ?? `unknown feature #${ordinal}`)
    .join(', ');
}

function formatUintV1(raw: string): string | null {
  const value = decodeUintV1(raw);
  return value === null ? null : value.toString();
}

function formatSupplyCapV1(raw: string): string | null {
  const value = decodeUintV1(raw);
  if (value === null) return null;
  const noCap = (1n << 128n) - 1n;
  return value === noCap ? `${value.toString()} (uint128 max — no cap)` : value.toString();
}

function formatMultiplierV1(raw: string): string | null {
  const value = decodeUintV1(raw);
  if (value === null) return null;
  const wad = 10n ** 18n;
  return value === wad ? `${value.toString()} (WAD 1.0 — no rebase applied)` : value.toString();
}

function formatStringV1(raw: string): string | null {
  return decodeStringV1(raw);
}

function formatUint8V1(raw: string): string | null {
  const value = decodeUint8V1(raw);
  return value === null ? null : String(value);
}

// ---------------------------------------------------------------------------
// The read plan
// ---------------------------------------------------------------------------

function readPlansV1(tokenAddress: string, scopes: Record<string, HashV1 | null>): ReadPlanV1[] {
  const token = tokenAddress.toLowerCase();
  const plans: ReadPlanV1[] = [
    {
      key: 'token_name',
      label: 'Name',
      target: token,
      methodSignature: 'name()',
      selector: B20_SELECTORS_V1.name,
      data: encodeNoArgsV1(B20_SELECTORS_V1.name),
      decode: formatStringV1,
    },
    {
      key: 'token_symbol',
      label: 'Symbol',
      target: token,
      methodSignature: 'symbol()',
      selector: B20_SELECTORS_V1.symbol,
      data: encodeNoArgsV1(B20_SELECTORS_V1.symbol),
      decode: formatStringV1,
    },
    {
      key: 'token_decimals',
      label: 'Decimals',
      target: token,
      methodSignature: 'decimals()',
      selector: B20_SELECTORS_V1.decimals,
      data: encodeNoArgsV1(B20_SELECTORS_V1.decimals),
      decode: formatUint8V1,
    },
    {
      key: 'total_supply',
      label: 'Total supply',
      target: token,
      methodSignature: 'totalSupply()',
      selector: B20_SELECTORS_V1.totalSupply,
      data: encodeNoArgsV1(B20_SELECTORS_V1.totalSupply),
      decode: formatUintV1,
    },
    {
      key: 'supply_cap',
      label: 'Supply cap',
      target: token,
      methodSignature: 'supplyCap()',
      selector: B20_SELECTORS_V1.supplyCap,
      data: encodeNoArgsV1(B20_SELECTORS_V1.supplyCap),
      decode: formatSupplyCapV1,
    },
    {
      key: 'paused_features',
      label: 'Paused features',
      target: token,
      methodSignature: 'pausedFeatures()',
      selector: B20_SELECTORS_V1.pausedFeatures,
      data: encodeNoArgsV1(B20_SELECTORS_V1.pausedFeatures),
      decode: formatPausedV1,
    },
    {
      key: 'contract_uri',
      label: 'Contract URI',
      target: token,
      methodSignature: 'contractURI()',
      selector: B20_SELECTORS_V1.contractURI,
      data: encodeNoArgsV1(B20_SELECTORS_V1.contractURI),
      decode: formatStringV1,
    },
    {
      key: 'rebase_multiplier',
      label: 'Rebase multiplier',
      target: token,
      methodSignature: 'multiplier()',
      selector: B20_SELECTORS_V1.multiplier,
      data: encodeNoArgsV1(B20_SELECTORS_V1.multiplier),
      decode: formatMultiplierV1,
      variants: ['asset'],
    },
    {
      key: 'stablecoin_currency',
      label: 'Declared currency',
      target: token,
      methodSignature: 'currency()',
      selector: B20_SELECTORS_V1.currency,
      data: encodeNoArgsV1(B20_SELECTORS_V1.currency),
      decode: formatStringV1,
      variants: ['stablecoin'],
    },
  ];

  // Policy scopes are READ from the token, never hardcoded: they are view
  // functions, and a guessed constant would silently query the wrong scope.
  const scopePlans: { key: B20ControlFieldKeyV1; label: string; scopeKey: string }[] = [
    { key: 'transfer_sender_policy', label: 'Transfer — sender policy', scopeKey: 'transferSender' },
    { key: 'transfer_receiver_policy', label: 'Transfer — receiver policy', scopeKey: 'transferReceiver' },
    { key: 'transfer_executor_policy', label: 'Transfer — executor policy', scopeKey: 'transferExecutor' },
    { key: 'mint_receiver_policy', label: 'Mint — receiver policy', scopeKey: 'mintReceiver' },
  ];
  for (const entry of scopePlans) {
    const scope = scopes[entry.scopeKey];
    if (!scope) continue;
    plans.push({
      key: entry.key,
      label: entry.label,
      target: token,
      methodSignature: `policyId(bytes32) [${entry.scopeKey}]`,
      selector: B20_SELECTORS_V1.policyId,
      data: encodeWordArgV1(B20_SELECTORS_V1.policyId, scope),
      decode: formatPolicyV1,
    });
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Field construction
// ---------------------------------------------------------------------------

function unavailableField(
  key: B20ControlFieldKeyV1,
  label: string,
  reason: string,
  status: B20ControlFieldV1['status'] = 'unavailable',
): B20ControlFieldV1 {
  return { key, label, status, value: null, reason, evidenceHash: null };
}

/**
 * Maps one RPC outcome onto a row.
 *
 * A revert carrying `UnsupportedPolicyType` is the token saying it has no such
 * scope, which is a different sentence from "the read failed" — and both are
 * different from a value.
 */
function fieldFromResultV1(
  plan: ReadPlanV1,
  result: B20RpcResultV1<string>,
  evidence: B20ControlEvidenceV1 | null,
): B20ControlFieldV1 {
  if (!result.ok) {
    if (result.reason === 'reverted') {
      const selector = result.revertSelector ?? null;
      if (selector === B20_ERROR_SELECTORS_V1.unsupportedPolicyType) {
        return unavailableField(
          plan.key,
          plan.label,
          'This token does not define that policy scope.',
          'unsupported_by_variant',
        );
      }
      return unavailableField(
        plan.key,
        plan.label,
        'This B20 variant does not provide that value.',
        'unsupported_by_variant',
      );
    }
    if (result.reason === 'empty_result') {
      return unavailableField(
        plan.key,
        plan.label,
        'Nothing was deployed at this address at the observed block.',
      );
    }
    return unavailableField(plan.key, plan.label, `The read did not answer (${result.reason}).`);
  }
  const decoded = plan.decode(result.value);
  if (decoded === null || evidence === null) {
    return unavailableField(plan.key, plan.label, 'The response could not be decoded as the expected type.');
  }
  return {
    key: plan.key,
    label: plan.label,
    status: 'exact_chain_read',
    value: decoded,
    reason: null,
    evidenceHash: evidence.evidenceHash,
  };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/**
 * Plain sentences about what the token's controls PERMIT.
 *
 * Each one is a capability of the token, tied to an observed state where one
 * was read. None of them predicts what an issuer will do, and none of them is
 * a judgement: "an issuer can pause transfers" is a fact about the standard,
 * "this token is unsafe" is not a fact at all.
 */
export function buildStatementsV1(fields: readonly B20ControlFieldV1[]): B20ControlStatementV1[] {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const state = (key: B20ControlFieldKeyV1, constrained: (value: string) => boolean): B20ControlStatementV1['observedState'] => {
    const field = byKey.get(key);
    if (!field || field.status !== 'exact_chain_read' || field.value === null) return 'unknown';
    return constrained(field.value) ? 'constrained' : 'unconstrained';
  };
  const evidence = (key: B20ControlFieldKeyV1): HashV1 | null => byKey.get(key)?.evidenceHash ?? null;
  const isOpenPolicy = (value: string) => !value.startsWith('ALWAYS_ALLOW');

  const statements: B20ControlStatementV1[] = [
    {
      key: 'pause_transfers',
      statement:
        'Whoever holds PAUSE_ROLE can pause transfers of this token. A pause stops transfers of this token only.',
      observedState: state('paused_features', (value) => value !== 'none paused'),
      evidenceHash: evidence('paused_features'),
    },
    {
      key: 'freeze_and_seize',
      statement:
        'Whoever holds BURN_BLOCKED_ROLE can burn the balance of an account that the transfer-sender policy denies. This is the freeze-and-seize path for regulated issuers, and it applies to this token only — it grants no access to any other asset in the wallet.',
      observedState: state('transfer_sender_policy', isOpenPolicy),
      evidenceHash: evidence('transfer_sender_policy'),
    },
    {
      key: 'transfer_gating',
      statement:
        'Transfers can be gated by an allowlist or blocklist policy on the sender, the receiver and the executor.',
      observedState: state('transfer_sender_policy', isOpenPolicy),
      evidenceHash: evidence('transfer_sender_policy'),
    },
    {
      key: 'mint_supply',
      statement:
        'Whoever holds MINT_ROLE can create new supply, up to the supply cap if one is set.',
      observedState: state('supply_cap', (value) => !value.includes('no cap')),
      evidenceHash: evidence('supply_cap'),
    },
    {
      key: 'rename',
      statement:
        'Whoever holds METADATA_ROLE can change this token’s name and symbol. The address is the identity; the name is not.',
      observedState: 'unknown',
      evidenceHash: null,
    },
  ];

  if (byKey.get('rebase_multiplier')?.status === 'exact_chain_read') {
    statements.push({
      key: 'rebase',
      statement:
        'Whoever holds OPERATOR_ROLE can change the rebase multiplier, which scales every balance this token reports.',
      observedState: state('rebase_multiplier', (value) => !value.includes('no rebase applied')),
      evidenceHash: evidence('rebase_multiplier'),
    });
  }
  return statements;
}

/** What this card does not look at. On the screen, not only in a spec. */
export const B20_CARD_BOUNDARIES_V1: readonly string[] = [
  'Holders and holder concentration are not read.',
  'Liquidity, liquidity locks and pool ownership are not read.',
  'Vesting, unlock schedules and price history are not read.',
  'Whether this token can be sold is not assessed.',
  'This card scores nothing. It reports reads at one block.',
];

// ---------------------------------------------------------------------------
// The inspection
// ---------------------------------------------------------------------------

function failedDetection(
  outcome: B20DetectionResultV1['outcome'],
  observedAt: string,
  detail: string | null,
  token: { chainId: 8453; tokenAddress: string } | null,
  anchor: { blockNumber: string; blockHash: HashV1 } | null = null,
): B20DetectionResultV1 {
  return B20DetectionResultV1Schema.parse({
    schemaVersion: 'b20-detection-result/v1',
    outcome,
    token,
    variant: null,
    addressVariantHint: token ? variantFromAddressV1(token.tokenAddress) : null,
    variantActivated: null,
    blockNumber: anchor?.blockNumber ?? null,
    blockHash: anchor?.blockHash ?? null,
    observedAt,
    detail,
  });
}

export async function inspectB20TokenV1(
  deps: B20InspectDepsV1,
  input: B20InspectInputV1,
): Promise<B20InspectResultV1> {
  const observedAt = input.now.toISOString();
  const address = input.tokenAddress.toLowerCase();

  const bail = (detection: B20DetectionResultV1): B20InspectResultV1 => {
    const status =
      detection.outcome === 'not_b20'
        ? ('not_b20' as const)
        : detection.outcome === 'b20' || detection.outcome === 'b20_uninitialised'
          ? ('partial' as const)
          : ('failed' as const);
    return finalise({
      tenantId: input.tenantId,
      address,
      detection,
      status,
      blockNumber: detection.blockNumber,
      blockHash: detection.blockHash,
      fields: [],
      evidence: [],
      observedAt,
      snapshotId: input.snapshotId,
    });
  };

  // Malformed input is a CALLER error, not a fact about a token, and it cannot
  // produce a snapshot at all: a snapshot is keyed by a valid address, and
  // there is no valid address here. It is refused before any socket opens.
  const refusal = validateB20InspectRequestV1(input.chainId, input.tokenAddress);
  if (refusal) throw new B20RequestError(refusal, refusalDetailV1(refusal));
  const token = { chainId: 8453 as const, tokenAddress: address };

  // The block comes FIRST. Every read below is pinned to it, so the snapshot
  // describes one state of the chain rather than a smear across several.
  const anchor = await deps.reader.readBlockAnchor();
  if (!anchor.ok) {
    return bail(failedDetection('rpc_failure', observedAt, `The endpoint did not answer (${anchor.reason}).`, token));
  }
  const { blockNumber, blockHash, blockTag } = anchor.value;

  const isB20 = await deps.reader.readIsB20(address, blockTag);
  if (!isB20.ok) {
    const outcome = isB20.reason === 'empty_result' ? 'unavailable_at_block' : 'rpc_failure';
    return bail(
      failedDetection(
        outcome,
        observedAt,
        outcome === 'unavailable_at_block'
          ? 'The B20 factory returned nothing at this block, so B20 was not active here.'
          : `Detection did not answer (${isB20.reason}).`,
        token,
        { blockNumber, blockHash },
      ),
    );
  }
  if (!isB20.value) {
    return bail(
      failedDetection(
        'not_b20',
        observedAt,
        'The B20 factory does not recognise this address as a B20 token.',
        token,
        { blockNumber, blockHash },
      ),
    );
  }

  const initialised = await deps.reader.readIsB20Initialized(address, blockTag);
  // The address hint is checked AGAINST the factory, never instead of it.
  const variant = variantFromAddressV1(address);
  if (!variant) {
    return bail(
      failedDetection(
        'rpc_failure',
        observedAt,
        'The factory confirmed a B20 token whose address encodes no known variant.',
        token,
        { blockNumber, blockHash },
      ),
    );
  }
  const activated = await deps.reader.readVariantActivated(variant, blockTag);

  const detection = B20DetectionResultV1Schema.parse({
    schemaVersion: 'b20-detection-result/v1',
    outcome: initialised.ok && initialised.value === false ? 'b20_uninitialised' : 'b20',
    token,
    variant,
    addressVariantHint: variant,
    variantActivated: activated.ok ? activated.value : null,
    blockNumber,
    blockHash,
    observedAt,
    detail: null,
  });

  // Policy scopes, read from the token itself.
  const scopeReads: [string, string, string][] = [
    ['transferSender', 'TRANSFER_SENDER_POLICY()', B20_SELECTORS_V1.transferSenderPolicy],
    ['transferReceiver', 'TRANSFER_RECEIVER_POLICY()', B20_SELECTORS_V1.transferReceiverPolicy],
    ['transferExecutor', 'TRANSFER_EXECUTOR_POLICY()', B20_SELECTORS_V1.transferExecutorPolicy],
    ['mintReceiver', 'MINT_RECEIVER_POLICY()', B20_SELECTORS_V1.mintReceiverPolicy],
  ];
  const scopes: Record<string, HashV1 | null> = {};
  for (const [name, , selector] of scopeReads) {
    const result = await deps.reader.call({ to: address, data: encodeNoArgsV1(selector), blockTag });
    scopes[name] = result.ok ? decodeBytes32V1(result.value) : null;
  }

  const fields: B20ControlFieldV1[] = [];
  const evidence: B20ControlEvidenceV1[] = [];

  fields.push({
    key: 'token_variant',
    label: 'B20 variant',
    status: 'exact_chain_read',
    value: variant,
    reason: null,
    evidenceHash: null,
  });

  for (const plan of readPlansV1(address, scopes)) {
    if (plan.variants && !plan.variants.includes(variant)) {
      fields.push(
        unavailableField(
          plan.key,
          plan.label,
          `Not part of the ${variant} variant.`,
          'unsupported_by_variant',
        ),
      );
      continue;
    }
    const result = await deps.reader.call({ to: plan.target, data: plan.data, blockTag });
    let record: B20ControlEvidenceV1 | null = null;
    if (result.ok) {
      const decoded = plan.decode(result.value);
      record = evidenceFor({
        plan,
        tokenAddress: address,
        blockNumber,
        blockHash,
        observedAt,
        raw: result.value,
        decodedValue: decoded,
        revertSelector: null,
      });
      if (decoded !== null) evidence.push(record);
    }
    fields.push(fieldFromResultV1(plan, result, record));
  }

  // The two rows that exist only to say what cannot be read. Leaving them out
  // would let a reader assume the card had checked. They are `not_enumerable`
  // rather than `unavailable`: no read failed here, the interface simply has no
  // method that could answer, and a retry or a better endpoint changes nothing.
  fields.push(
    unavailableField(
      'admin_role_holder',
      'Who holds DEFAULT_ADMIN_ROLE',
      'B20 exposes hasRole(role, account) and no way to list role holders. Naming an issuer would require an address to check, and this card has none.',
      'not_enumerable',
    ),
    unavailableField(
      'freeze_and_seize',
      'Accounts currently blocked',
      'Policy membership is queried per account and cannot be enumerated. Whether a specific account is blocked is answerable; the full list is not.',
      'not_enumerable',
    ),
  );

  // The variant row is the one field derived from the address rather than a
  // call, so it carries no evidence hash and the schema forbids that on an
  // exact read. Restate it as what it is.
  const variantIndex = fields.findIndex((field) => field.key === 'token_variant');
  const variantEvidence = evidenceFor({
    plan: {
      key: 'token_variant',
      label: 'B20 variant',
      target: B20_FACTORY_V1,
      methodSignature: 'isB20(address)',
      selector: B20_SELECTORS_V1.isB20,
      data: encodeNoArgsV1(B20_SELECTORS_V1.isB20),
      decode: () => variant,
    },
    tokenAddress: address,
    blockNumber,
    blockHash,
    observedAt,
    raw: isB20.raw,
    decodedValue: variant,
    revertSelector: null,
  });
  evidence.push(variantEvidence);
  fields[variantIndex] = { ...fields[variantIndex]!, evidenceHash: variantEvidence.evidenceHash };

  const anyUnavailable = fields.some((field) => field.status === 'unavailable');
  return finalise({
    tenantId: input.tenantId,
    address,
    detection,
    status: anyUnavailable ? 'partial' : 'complete',
    blockNumber,
    blockHash,
    fields,
    evidence,
    observedAt,
    snapshotId: input.snapshotId,
  });
}

function finalise(input: {
  tenantId: string;
  address: string;
  detection: B20DetectionResultV1;
  status: B20ControlSnapshotV1['status'];
  blockNumber: string | null;
  blockHash: HashV1 | null;
  fields: B20ControlFieldV1[];
  evidence: B20ControlEvidenceV1[];
  observedAt: string;
  snapshotId?: string;
}): B20InspectResultV1 {
  const id =
    input.snapshotId ??
    b20SnapshotIdV1({
      tenantId: input.tenantId,
      chainId: 8453,
      tokenAddress: input.address,
      blockNumber: input.blockNumber,
    });
  const draft = {
    schemaVersion: 'b20-control-snapshot/v1' as const,
    id,
    tenantId: input.tenantId,
    chainId: 8453 as const,
    tokenAddress: input.address,
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
    status: input.status,
    snapshotHash: '0x'.padEnd(66, '0'),
    identityHash: b20TokenIdentityHashV1({ chainId: 8453, tokenAddress: input.address as `0x${string}` }),
    detection: input.detection,
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    fields: input.fields,
    evidence: input.evidence,
    observedAt: input.observedAt,
  };
  const snapshot = B20ControlSnapshotV1Schema.parse({ ...draft, snapshotHash: hashB20SnapshotV1(draft) });
  return { snapshot, card: buildB20CardV1(snapshot) };
}

export function buildB20CardV1(snapshot: B20ControlSnapshotV1): B20ControlCardV1 {
  const byKey = new Map(snapshot.fields.map((field) => [field.key, field]));
  const readable = (key: B20ControlFieldKeyV1): string | null => {
    const field = byKey.get(key);
    return field && field.status === 'exact_chain_read' ? field.value : null;
  };
  const draft = {
    schemaVersion: 'b20-control-card/v1' as const,
    cardHash: '0x'.padEnd(66, '0'),
    snapshotId: snapshot.id,
    snapshotHash: snapshot.snapshotHash,
    identityHash: snapshot.identityHash,
    chainId: snapshot.chainId,
    tokenAddress: snapshot.tokenAddress,
    displayName: readable('token_name'),
    displaySymbol: readable('token_symbol'),
    variant: snapshot.detection.variant,
    detectionOutcome: snapshot.detection.outcome,
    blockNumber: snapshot.blockNumber,
    blockHash: snapshot.blockHash,
    observedAt: snapshot.observedAt,
    fields: snapshot.fields,
    statements: snapshot.detection.outcome === 'b20' || snapshot.detection.outcome === 'b20_uninitialised'
      ? buildStatementsV1(snapshot.fields)
      : [],
    unavailable: snapshot.fields
      .filter((field) => field.status !== 'exact_chain_read')
      .map((field) => `${field.label}: ${field.reason ?? 'no value'}`)
      .slice(0, 32),
    boundaries: [...B20_CARD_BOUNDARIES_V1],
  };
  return B20ControlCardV1Schema.parse({ ...draft, cardHash: hashB20CardV1(draft) });
}
