import { decodeFunctionData, encodeFunctionData, erc20Abi } from 'viem';
import type { AssetRefV1, ExecutionCallV1, RouteIntentV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// A gift: buy a stock and hand it to someone else, in one batch.
//
// The swap is the ordinary swap, to the person's OWN wallet — every provider
// guard requires that, and none of them is touched. The gift is one more call
// after it: an ERC-20 `transfer` of the output token to the recipient the
// person named, for exactly the swap's guaranteed minimum output. The router
// reverts below that minimum, so the transfer always has the tokens it sends,
// and anything the swap returns above it stays in the giver's wallet.
//
// Only the server builds this call, from a recipient it resolved and showed
// on the review; the Safety Kernel then checks the bytes against that
// declaration, and refuses a transfer nobody declared or a declaration with
// no transfer.
// ---------------------------------------------------------------------------

export const GIFT_TRANSFER_SELECTOR_V1 = '0xa9059cbb';

const ZERO_ADDRESS_V1 = '0x0000000000000000000000000000000000000000';
const PERMIT2_ADDRESS_V1 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;

/** What the person asked for: who receives, and how many token units. */
export interface GiftDeclarationV1 {
  recipient: `0x${string}`;
  amountAtomic: string;
}

export function encodeGiftTransferV1(recipient: `0x${string}`, amountAtomic: string): `0x${string}` {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [recipient, BigInt(amountAtomic)],
  }).toLowerCase() as `0x${string}`;
}

/** The one call that makes a swap a gift. */
export function giftTransferCallV1(input: {
  index: number;
  token: AssetRefV1;
  recipient: `0x${string}`;
  amountAtomic: string;
}): ExecutionCallV1 {
  if (input.token.kind !== 'erc20' || !input.token.address) {
    throw new Error('A gift transfer needs an ERC-20 output token');
  }
  const recipient = input.recipient.toLowerCase() as `0x${string}`;
  return {
    index: input.index,
    callType: 'transfer',
    to: input.token.address.toLowerCase() as `0x${string}`,
    valueWei: '0',
    data: encodeGiftTransferV1(recipient, input.amountAtomic),
    asset: input.token,
    amountAtomic: input.amountAtomic,
    recipient,
    spender: null,
  };
}

/** The gift a stored batch carries, read from its one transfer call. */
export function giftDeclarationFromCallsV1(calls: readonly ExecutionCallV1[]): GiftDeclarationV1 | null {
  const transfers = calls.filter((call) => call.callType === 'transfer');
  if (transfers.length !== 1) return null;
  const call = transfers[0]!;
  if (!call.recipient || !call.amountAtomic) return null;
  return { recipient: call.recipient.toLowerCase() as `0x${string}`, amountAtomic: call.amountAtomic };
}

export type GiftTransferCheckV1 = { ok: true } | { ok: false; code: string; detail: string };

/**
 * The gift call, checked against what was declared. Pure: every fact comes
 * from the arguments, so prepare, replay and approve reach the same verdict
 * over the same bytes.
 */
export function validateGiftTransferV1(input: {
  calls: readonly ExecutionCallV1[];
  intent: RouteIntentV1;
  walletAddress: string;
  routerAddress: string;
  gift: GiftDeclarationV1 | null;
  /** The swap's guaranteed minimum output — the only amount a gift may send. */
  swapMinimumOutputAtomic: string | null | undefined;
}): GiftTransferCheckV1 {
  const refuse = (code: string, detail: string): GiftTransferCheckV1 => ({ ok: false, code, detail });
  const transfers = input.calls.filter((call) => call.callType === 'transfer');
  if (!input.gift) {
    return transfers.length === 0
      ? { ok: true }
      : refuse('gift_transfer_undeclared', 'The batch transfers a token nobody declared as a gift');
  }
  if (transfers.length !== 1) {
    return refuse('gift_transfer_missing', 'A declared gift needs exactly one transfer call');
  }
  const call = transfers[0]!;
  const last = input.calls.reduce((max, entry) => Math.max(max, entry.index), -1);
  if (call.index !== last) return refuse('gift_transfer_not_last', 'The gift transfer must be the last call');

  const output = input.intent.toAsset;
  const token = output?.kind === 'erc20' ? output.address?.toLowerCase() ?? null : null;
  if (!token || !ADDRESS_V1.test(token)) {
    return refuse('gift_output_not_erc20', 'Only an ERC-20 output can be given');
  }
  if (call.to.toLowerCase() !== token || call.asset?.assetId !== output!.assetId) {
    return refuse('gift_wrong_token', 'The gift transfer must move the token the swap buys');
  }
  if (call.valueWei !== '0') return refuse('gift_carries_value', 'The gift transfer must attach no native value');

  const recipient = input.gift.recipient.toLowerCase();
  const reserved = new Set(
    [
      ZERO_ADDRESS_V1,
      PERMIT2_ADDRESS_V1,
      input.walletAddress,
      input.routerAddress,
      token,
      input.intent.fromAsset?.address ?? '',
    ].map((address) => address.toLowerCase()),
  );
  if (!ADDRESS_V1.test(recipient) || reserved.has(recipient)) {
    return refuse('gift_recipient_invalid', 'The recipient must be another person’s address, not this wallet or a contract in the route');
  }
  if (call.recipient?.toLowerCase() !== recipient || call.amountAtomic !== input.gift.amountAtomic) {
    return refuse('gift_declaration_mismatch', 'The transfer call does not name the declared recipient and amount');
  }

  const minimum = input.swapMinimumOutputAtomic;
  if (!minimum || !/^[1-9][0-9]*$/.test(minimum) || input.gift.amountAtomic !== minimum) {
    return refuse('gift_amount_not_minimum', 'A gift sends exactly the swap’s guaranteed minimum output');
  }

  // The bytes, not the labels: decode what the wallet will actually sign.
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: call.data as `0x${string}` }) as typeof decoded;
  } catch {
    return refuse('gift_calldata_invalid', 'The gift calldata is not an ERC-20 transfer');
  }
  const [to, amount] = decoded.args as [string, bigint];
  if (
    decoded.functionName !== 'transfer' ||
    call.data.toLowerCase() !== encodeGiftTransferV1(recipient as `0x${string}`, input.gift.amountAtomic) ||
    to.toLowerCase() !== recipient ||
    amount.toString() !== input.gift.amountAtomic
  ) {
    return refuse('gift_calldata_mismatch', 'The gift calldata does not transfer the declared amount to the declared recipient');
  }
  return { ok: true };
}
