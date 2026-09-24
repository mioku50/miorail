// ---------------------------------------------------------------------------
// Growth plan step 4: a gift, read out of a public proof bundle.
//
// A gift batch is either the ordinary swap to the giver's own wallet followed
// by ONE ERC-20 `transfer(recipient, amount)` of the bought stock, or — a gift
// from what the giver already held — that one transfer alone. Either way it is
// the call a kernel checked before the wallet ever saw it. The approved calls
// are inside the canonical proof, under `approvedCallsHash`, so a reader of the
// bundle can see exactly what was sent to whom without asking Miorail.
//
// The BYTES decide. Each call also carries labels (`recipient`, `amountAtomic`,
// `asset`) for display, and a label is only a claim about the calldata; the
// calldata is what the chain executed. So the recipient and the amount are
// decoded from `data`, and a call whose labels disagree with its own bytes is
// not a gift this page will describe.
//
// Browser-safe on purpose: the public gift page runs this in the reader's
// browser, and the server runs the same function for the link preview.
// ---------------------------------------------------------------------------

const TRANSFER_SELECTOR_V1 = '0xa9059cbb';
const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;
const HASH_V1 = /^0x[0-9a-f]{64}$/;
const ATOMIC_V1 = /^(0|[1-9][0-9]*)$/;

export interface PublicGiftAssetV1 {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

export interface PublicGiftV1 {
  /** The wallet that approved the batch — the proof's own wallet. */
  giver: `0x${string}`;
  recipient: `0x${string}`;
  /** Exactly what the transfer sends, decoded from its calldata. */
  amountAtomic: string;
  token: PublicGiftAssetV1;
  /** The proof's final status. Only `completed` means the receipt showed the
   * transfer: the reconciler refuses to complete a gift proof otherwise. */
  finalStatus: string;
  delivered: boolean;
  transactionHash: `0x${string}` | null;
  /** `bought`: a swap, then the transfer. `held`: the transfer alone, from
   * what the giver's wallet already held — nothing was bought or paid. */
  source: 'bought' | 'held';
  /** What the whole purchase spent, from the proof's actual debit (falling back
   * to the expected one). The gift is the swap's guaranteed minimum, so this is
   * what the giver paid — not a price for the amount given. Null for a gift
   * from holdings: its one debit is the gift itself. */
  paid: { amountAtomic: string; symbol: string; decimals: number } | null;
  /** When the link was created. */
  issuedAt: string;
}

type LooseCallV1 = {
  callType?: unknown;
  to?: unknown;
  valueWei?: unknown;
  data?: unknown;
  asset?: unknown;
  amountAtomic?: unknown;
  recipient?: unknown;
};

type LooseAssetV1 = { kind?: unknown; address?: unknown; symbol?: unknown; decimals?: unknown };
type LooseChangeV1 = { direction?: unknown; amountAtomic?: unknown; asset?: unknown };

function lower(value: unknown): string | null {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

/** `transfer(address,uint256)` calldata, decoded — or null for anything else,
 * including a dirty address word or trailing bytes. */
export function decodeTransferCalldataV1(data: unknown): { recipient: `0x${string}`; amountAtomic: string } | null {
  const hex = lower(data);
  if (!hex || !hex.startsWith(TRANSFER_SELECTOR_V1) || hex.length !== 10 + 64 + 64) return null;
  const addressWord = hex.slice(10, 74);
  const amountWord = hex.slice(74, 138);
  if (!/^[0-9a-f]{64}$/.test(addressWord) || !/^[0-9a-f]{64}$/.test(amountWord)) return null;
  // An address is 20 bytes; the 12 above it must be zero, or a different
  // decoder could read a different recipient out of the same word.
  if (!/^0{24}$/.test(addressWord.slice(0, 24))) return null;
  const recipient = `0x${addressWord.slice(24)}` as `0x${string}`;
  return { recipient, amountAtomic: BigInt(`0x${amountWord}`).toString() };
}

function assetOf(value: unknown): PublicGiftAssetV1 | null {
  const asset = value as LooseAssetV1 | null | undefined;
  if (!asset || asset.kind !== 'erc20') return null;
  const address = lower(asset.address);
  if (!address || !ADDRESS_V1.test(address)) return null;
  if (typeof asset.symbol !== 'string' || !asset.symbol.trim() || asset.symbol.length > 40) return null;
  if (typeof asset.decimals !== 'number' || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) {
    return null;
  }
  return { address: address as `0x${string}`, symbol: asset.symbol, decimals: asset.decimals };
}

function debitOf(result: unknown): PublicGiftV1['paid'] {
  const changes = (result as { assetChanges?: unknown } | null | undefined)?.assetChanges;
  if (!Array.isArray(changes)) return null;
  const debits = (changes as LooseChangeV1[]).filter((change) => change?.direction === 'debit');
  if (debits.length !== 1) return null;
  const debit = debits[0]!;
  const asset = debit.asset as LooseAssetV1 | null | undefined;
  if (typeof debit.amountAtomic !== 'string' || !ATOMIC_V1.test(debit.amountAtomic)) return null;
  if (!asset || typeof asset.symbol !== 'string' || typeof asset.decimals !== 'number') return null;
  return { amountAtomic: debit.amountAtomic, symbol: asset.symbol, decimals: asset.decimals };
}

/**
 * The gift a public bundle records, or null when it records none — or when
 * what it records is not unambiguously one.
 *
 * Reads `unknown` for the same reason the verifier does: in the browser this
 * is a body that just arrived. Whether the bundle's hashes hold is the
 * verifier's question, answered beside this, never assumed by it.
 */
export function giftOfPublicBundleV1(input: unknown): PublicGiftV1 | null {
  const bundle = input as { proofFamily?: unknown; proof?: unknown; issuedAt?: unknown } | null | undefined;
  if (!bundle || bundle.proofFamily !== 'route' || typeof bundle.proof !== 'object' || bundle.proof === null) return null;
  const proof = bundle.proof as {
    walletAddress?: unknown;
    approvedCalls?: unknown;
    finalStatus?: unknown;
    transactionHashes?: unknown;
    actualResult?: unknown;
    expectedResult?: unknown;
  };
  if (!Array.isArray(proof.approvedCalls) || proof.approvedCalls.length < 1) return null;
  const calls = proof.approvedCalls as LooseCallV1[];
  const transfers = calls.filter((call) => call?.callType === 'transfer');
  // One transfer, and it is the last call: the order the kernel enforces. On
  // its own it is a gift from holdings; after a swap, a gift that was bought.
  if (transfers.length !== 1 || calls.at(-1) !== transfers[0]) return null;
  const call = transfers[0]!;
  const source = calls.length === 1 ? 'held' : 'bought';

  const token = assetOf(call.asset);
  const decoded = decodeTransferCalldataV1(call.data);
  if (!token || !decoded) return null;
  if (lower(call.to) !== token.address) return null;
  if (call.valueWei !== '0') return null;
  // Labels must say what the bytes say.
  if (lower(call.recipient) !== decoded.recipient || call.amountAtomic !== decoded.amountAtomic) return null;

  const giver = lower(proof.walletAddress);
  if (!giver || !ADDRESS_V1.test(giver) || giver === decoded.recipient) return null;
  if (decoded.amountAtomic === '0') return null;

  const finalStatus = typeof proof.finalStatus === 'string' ? proof.finalStatus : 'unknown';
  const hashes = Array.isArray(proof.transactionHashes) ? proof.transactionHashes : [];
  const firstHash = lower(hashes[0]);
  return {
    giver: giver as `0x${string}`,
    recipient: decoded.recipient,
    amountAtomic: decoded.amountAtomic,
    token,
    finalStatus,
    delivered: finalStatus === 'completed',
    transactionHash: firstHash && HASH_V1.test(firstHash) ? (firstHash as `0x${string}`) : null,
    source,
    paid: source === 'held' ? null : (debitOf(proof.actualResult) ?? debitOf(proof.expectedResult)),
    issuedAt: typeof bundle.issuedAt === 'string' ? bundle.issuedAt : '',
  };
}

/** Atomic units as a decimal string, trailing zeros trimmed. */
export function formatAtomicV1(atomic: string, decimals: number): string {
  if (!ATOMIC_V1.test(atomic) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return atomic;
  if (decimals === 0) return atomic;
  const padded = atomic.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
