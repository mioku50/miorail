import { z } from 'zod';
import { ADDRESSES, CRYPTO, STOCKS } from '@mioagent/still-engine/registry';

import { atomicToDecimalV2 } from '../../../../lib/ui/src/still/agentAnswers.js';
import { readStockHoldingV1, type StockHoldingV1 } from '../../lib/stockTokenRead.js';
import { STILL_PUBLIC_ORIGIN_V1 } from '../../lib/stillOrigin.js';

// ---------------------------------------------------------------------------
// A swap written out for Swap AI, for the owner to compare and sign: what the
// Still Agent does on the page since 2026-11-01, offered to an assistant
// (operator, 2026-11-07).
//
// The assistant gets a link and never a call. The link puts one sentence in
// Swap AI's box and nothing runs from it: a goal that arrives in a URL waits
// for the person to press Compare (goalHandoff.ts), because a link is text
// anyone can write. Swap AI then compares routes, simulates the swap on a
// fresh block, and the person's own wallet signs. So this reply carries no
// price, route or calldata: a route quote lives for about twenty seconds, and
// the page is where terms are established.
//
// The sentence names tokens by their exact addresses, in the one form Swap AI
// reads without a model ("Swap <amount> <address> to <address> on Base",
// canonicalSwapExtractionV2): a model asked to copy a B20 address, with its
// twenty-one zeros, can miscount one. Native ETH has no address, so it is the
// symbol, as the Still Agent writes it, and with USDC on the other side USDC
// is too: Swap AI resolves both from its own registry.
// ---------------------------------------------------------------------------

export const STILL_SWAP_TOKENS_V1 = ['USDC', 'ETH', 'WETH', 'cbBTC', 'PAXG', ...STOCKS.map((stock) => stock.id)] as [string, ...string[]];

const DECIMAL_V1 = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/;

export const StillPrepareSwapInputV1Schema = z.object({
  give: z.enum(STILL_SWAP_TOKENS_V1)
    .describe('The token the user gives: USDC, native ETH, WETH, cbBTC, PAXG (Paxos gold) or a Coinbase stock token (AAPLc, AMZNc, GOOGLc, METAc, MSFTc, NVDAc, SPCXc, TSLAc).'),
  receive: z.enum(STILL_SWAP_TOKENS_V1).describe('The token the user receives, from the same list. Not the one given.'),
  // A string or a number: on 2026-11-07 an assistant spent eight calls finding the one form a
  // stricter schema took, because a refused union says only "Invalid input". The handler reads
  // either and says exactly what it wants when it cannot.
  amount: z.union([z.string().max(80), z.number()])
    .describe('How much of `give` to swap, in whole-token units such as "10" or "0.005" (a JSON number such as 10 works too), exactly as the user said it; or "all" or "half" of what this wallet holds, which the server reads at one Base block. Native ETH takes an exact amount only: some has to stay for network fees. Never an amount of `receive`: Swap AI takes what is spent, not what is received.'),
}).strict();

export const StillPrepareSwapOutputV1Schema = z.object({
  reviewUrl: z.string(),
  goal: z.string(),
  give: z.object({ id: z.string(), token: z.string().nullable(), decimals: z.number().int() }).strict(),
  receive: z.object({ id: z.string(), token: z.string().nullable(), decimals: z.number().int() }).strict(),
  amount: z.string(),
  amountSource: z.enum(['stated', 'wallet_all', 'wallet_half']),
  /** For "all" and "half": the balance it was taken from, and the block it was read at. */
  balance: z.object({ amount: z.string(), block: z.string() }).strict().nullable(),
  next: z.string(),
}).strict();

export type StillPrepareSwapInputV1 = z.infer<typeof StillPrepareSwapInputV1Schema>;
export type StillPrepareSwapOutputV1 = z.infer<typeof StillPrepareSwapOutputV1Schema>;

/** The chain read behind "all" and "half": one token's balance, decimals and block, together. */
export const stillSwapRuntimeV1 = {
  readBalance: (token: string, wallet: string): Promise<StockHoldingV1> => readStockHoldingV1(token, wallet),
};

export class StillSwapRefusalV1 extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

interface SwapTokenV1 { id: string; token: `0x${string}` | null; decimals: number }

/** From the registry: Still's own addresses and decimals, never a symbol looked up elsewhere. */
export function stillSwapTokenV1(id: string): SwapTokenV1 {
  if (id === 'USDC') return { id, token: ADDRESSES.usdc, decimals: 6 };
  if (id === 'ETH') return { id, token: null, decimals: 18 };
  if (id === 'WETH') return { id, token: ADDRESSES.weth, decimals: 18 };
  const coin = CRYPTO.find((row) => row.id === id && row.id !== 'ETH');
  if (coin) return { id, token: coin.token, decimals: coin.decimals };
  const stock = STOCKS.find((row) => row.id === id);
  if (stock) return { id, token: stock.token, decimals: stock.decimals };
  throw new StillSwapRefusalV1('still_swap_token_unknown', `${id} is not a token Still names.`);
}

/** The amount as said, in one form: a decimal, "all" or "half"; null for anything else. */
export function stillSwapAmountTextV1(raw: string | number, give: string): string | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const text = String(raw);
    return DECIMAL_V1.test(text) ? text : null;
  }
  let text = raw.trim();
  const word = text.toLowerCase();
  if (word === 'all' || word === 'half') return word;
  // "2 USDC" and "$2" name the same two dollars: the token said again is not a second amount.
  // A comma is never read: "1,000" and "1,5" mean different things in different places.
  text = text.replace(new RegExp(`\\s*${give}$`, 'i'), '');
  if (give === 'USDC') text = text.replace(/^\$\s*/, '');
  return DECIMAL_V1.test(text) ? text : null;
}

function unitsV1(text: string, decimals: number): bigint | null {
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > decimals) return null;
  return BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
}

/** The sentence Swap AI's box receives. */
export function stillSwapGoalV1(from: SwapTokenV1, to: SwapTokenV1, amount: string): string {
  if (from.token && to.token) return `Swap ${amount} ${from.token} to ${to.token} on Base`;
  const name = (side: SwapTokenV1) => (side.token === null ? 'ETH' : side.token === ADDRESSES.usdc ? 'USDC' : side.token);
  return `Swap ${amount} ${name(from)} to ${name(to)} on Base`;
}

export async function stillPrepareSwapV1(
  identity: { walletAddress: string },
  args: StillPrepareSwapInputV1,
  deps: { readBalance?: (token: string, wallet: string) => Promise<StockHoldingV1> } = {},
): Promise<StillPrepareSwapOutputV1> {
  const from = stillSwapTokenV1(args.give);
  const to = stillSwapTokenV1(args.receive);
  if (from.id === to.id) throw new StillSwapRefusalV1('still_swap_same_token', 'A swap needs two different tokens.');
  if ((from.id === 'ETH' && to.id === 'WETH') || (from.id === 'WETH' && to.id === 'ETH')) {
    throw new StillSwapRefusalV1('still_swap_is_a_wrap', 'ETH and WETH are the same asset: that is wrapping or unwrapping in the wallet, not a swap between routes.');
  }

  const said = stillSwapAmountTextV1(args.amount, from.id);
  if (said === null) {
    throw new StillSwapRefusalV1('still_swap_amount_invalid', `amount is how much ${from.id} to swap: a decimal such as "2" or "0.5" (a JSON number works too), or "all" or "half" of this wallet's ${from.id}. Nothing was prepared.`);
  }
  let amount: string;
  let balance: StillPrepareSwapOutputV1['balance'] = null;
  if (said === 'all' || said === 'half') {
    if (from.token === null) {
      throw new StillSwapRefusalV1('still_swap_eth_needs_an_amount', 'Name an amount of ETH: some ETH has to stay in the wallet for network fees, so "all" or "half" of it is not worked out here.');
    }
    const held = await (deps.readBalance ?? stillSwapRuntimeV1.readBalance)(from.token, identity.walletAddress);
    if (!held.ok) throw new StillSwapRefusalV1('still_swap_balance_unread', `This wallet's ${from.id} could not be read just now. That is our failure, not an empty wallet. Ask for an exact amount, or try again.`);
    if (held.decimals !== from.decimals) throw new StillSwapRefusalV1('still_swap_balance_unread', `${from.id} answered with ${held.decimals} decimals where Still has ${from.decimals}; nothing was prepared.`);
    const raw = BigInt(held.balanceAtomic);
    const spent = said === 'all' ? raw : raw / 2n;
    if (spent === 0n) throw new StillSwapRefusalV1('still_swap_nothing_held', `This wallet holds no ${from.id} to swap at block ${held.blockNumber}.`);
    amount = atomicToDecimalV2(spent, from.decimals);
    balance = { amount: atomicToDecimalV2(raw, from.decimals), block: held.blockNumber };
  } else {
    const units = unitsV1(said, from.decimals);
    if (units === null) throw new StillSwapRefusalV1('still_swap_amount_invalid', `${from.id} has ${from.decimals} decimals; the amount has more.`);
    if (units === 0n) throw new StillSwapRefusalV1('still_swap_amount_invalid', 'A swap of zero is not a swap.');
    amount = atomicToDecimalV2(units, from.decimals);
  }

  const goal = stillSwapGoalV1(from, to, amount);
  return {
    reviewUrl: `${STILL_PUBLIC_ORIGIN_V1}/routes?goal=${encodeURIComponent(goal)}`,
    goal,
    give: { id: from.id, token: from.token, decimals: from.decimals },
    receive: { id: to.id, token: to.token, decimals: to.decimals },
    amount,
    amountSource: said === 'all' ? 'wallet_all' : said === 'half' ? 'wallet_half' : 'stated',
    balance,
    next: 'Give the user this link, to open signed in with this same wallet. It opens Swap AI with this exact swap written in its box, and nothing runs until the user presses Compare: Swap AI then compares the routes, simulates the swap on a fresh block, and the user signs in their own wallet. This reply is not a quote. It holds no price, route or calldata, so never state what the user would receive, and do not prepare it again to learn one.',
  };
}
