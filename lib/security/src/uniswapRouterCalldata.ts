import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, type Hex } from 'viem';
import { sameCanonicalCallV1 } from './routerCalldataTail.js';

// ---------------------------------------------------------------------------
// What the bytes of a Universal Router 2.0 call do (audit SW-1, 2026-11-14).
//
// The call to the pinned router was accepted by its address alone. Nothing read
// its commands, so a route that paid the output to someone else with no
// minimum, or added a PERMIT2_TRANSFER_FROM that drew another token through a
// live Permit2 allowance, passed every check, and the review said in green that
// the recipient was the wallet: a field our own classifier had filled in.
//
// Now the call is decoded the way the router reads it (Dispatcher.sol, V4Router
// .sol and CalldataDecoder.sol of the deployment at 0x6ff5…9b43, read from its
// Sourcify-verified source on 2026-11-14) and re-encoded, so a call read one
// way here and another onchain is refused. Only exact-input swaps and the
// payments around them are allowed; every payment goes to the wallet or stays
// in the router; the wallet pays in nothing but the reviewed input, exactly;
// and what the wallet is guaranteed to receive is summed from the minimums the
// router itself enforces on what reaches the wallet.
// ---------------------------------------------------------------------------

/** The router's `map`: these two "addresses" are its own markers. */
const MSG_SENDER_V1 = '0x0000000000000000000000000000000000000001';
const ADDRESS_THIS_V1 = '0x0000000000000000000000000000000000000002';
/** Native ETH, as the router's payments and v4 currencies name it. */
export const UNISWAP_NATIVE_CURRENCY_V1 = '0x0000000000000000000000000000000000000000';
/** WETH9 on Base: what the router wraps native ETH into for v2 and v3 pools. */
export const UNISWAP_BASE_WETH_V1 = '0x4200000000000000000000000000000000000006';

const CONTRACT_BALANCE_V1 = 1n << 255n;
const UINT160_LIMIT_V1 = 1n << 160n;

/** Command types (Commands.sol). Only these may appear; each is read below. */
export const UNISWAP_COMMANDS_V1 = {
  V3_SWAP_EXACT_IN: 0x00,
  SWEEP: 0x04,
  TRANSFER: 0x05,
  PAY_PORTION: 0x06,
  V2_SWAP_EXACT_IN: 0x08,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  BALANCE_CHECK_ERC20: 0x0e,
  V4_SWAP: 0x10,
} as const;

/** v4 actions (Actions.sol) the router runs for an exact-input swap. */
export const UNISWAP_V4_ACTIONS_V1 = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_IN: 0x07,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
} as const;

/** Commands that are never part of a Still swap, by name, for the refusal. */
const REFUSED_COMMAND_NAMES_V1: Readonly<Record<number, string>> = {
  0x01: 'V3_SWAP_EXACT_OUT',
  0x02: 'PERMIT2_TRANSFER_FROM',
  0x03: 'PERMIT2_PERMIT_BATCH',
  0x09: 'V2_SWAP_EXACT_OUT',
  0x0a: 'PERMIT2_PERMIT',
  0x0d: 'PERMIT2_TRANSFER_FROM_BATCH',
  0x11: 'V3_POSITION_MANAGER_PERMIT',
  0x12: 'V3_POSITION_MANAGER_CALL',
  0x13: 'V4_INITIALIZE_POOL',
  0x14: 'V4_POSITION_MANAGER_CALL',
  0x21: 'EXECUTE_SUB_PLAN',
};

export const UNIVERSAL_ROUTER_EXECUTE_ABI_V1 = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const SWAP_IN_V1 = [
  { name: 'recipient', type: 'address' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'amountOutMin', type: 'uint256' },
] as const;
const V3_SWAP_EXACT_IN_PARAMS_V1 = [...SWAP_IN_V1, { name: 'path', type: 'bytes' }, { name: 'payerIsUser', type: 'bool' }] as const;
const V2_SWAP_EXACT_IN_PARAMS_V1 = [...SWAP_IN_V1, { name: 'path', type: 'address[]' }, { name: 'payerIsUser', type: 'bool' }] as const;
const TOKEN_RECIPIENT_AMOUNT_PARAMS_V1 = [
  { name: 'token', type: 'address' },
  { name: 'recipient', type: 'address' },
  { name: 'amount', type: 'uint256' },
] as const;
const RECIPIENT_AMOUNT_PARAMS_V1 = [
  { name: 'recipient', type: 'address' },
  { name: 'amount', type: 'uint256' },
] as const;
const BALANCE_CHECK_PARAMS_V1 = [
  { name: 'owner', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'minBalance', type: 'uint256' },
] as const;
const V4_PLAN_PARAMS_V1 = [
  { name: 'actions', type: 'bytes' },
  { name: 'params', type: 'bytes[]' },
] as const;
const POOL_KEY_V1 = {
  name: 'poolKey',
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
} as const;
const V4_EXACT_IN_SINGLE_PARAMS_V1 = [
  {
    name: 'params',
    type: 'tuple',
    components: [
      POOL_KEY_V1,
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint128' },
      { name: 'amountOutMinimum', type: 'uint128' },
      { name: 'hookData', type: 'bytes' },
    ],
  },
] as const;
const V4_EXACT_IN_PARAMS_V1 = [
  {
    name: 'params',
    type: 'tuple',
    components: [
      { name: 'currencyIn', type: 'address' },
      {
        name: 'path',
        type: 'tuple[]',
        components: [
          { name: 'intermediateCurrency', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
      { name: 'amountIn', type: 'uint128' },
      { name: 'amountOutMinimum', type: 'uint128' },
    ],
  },
] as const;
const V4_SETTLE_PARAMS_V1 = [
  { name: 'currency', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'payerIsUser', type: 'bool' },
] as const;
const V4_CURRENCY_AMOUNT_PARAMS_V1 = [
  { name: 'currency', type: 'address' },
  { name: 'amount', type: 'uint256' },
] as const;

/** One side of the swap as the router names it: an ERC-20 address, or native ETH. */
export type UniswapRouterAssetV1 = { kind: 'erc20'; address: string } | { kind: 'native' };

export interface UniswapRouterExpectationV1 {
  /** The wallet that calls the router: the router's MSG_SENDER. */
  wallet: string;
  input: UniswapRouterAssetV1;
  output: UniswapRouterAssetV1;
  /** Exactly this much of the input is spent (base units). */
  amountInAtomic: bigint;
}

export type UniswapRouterReadingV1 =
  | {
      ok: true;
      deadline: bigint;
      commands: number[];
      /** What the router itself guarantees reaches the wallet, in the output asset. */
      guaranteedOutputAtomic: bigint;
      /** How many separate minimums make up that guarantee (one per leg, sweep or take). */
      minimumSources: number;
    }
  | { ok: false; code: string; reason: string };

function refuse(code: string, reason: string): UniswapRouterReadingV1 {
  return { ok: false, code, reason };
}

const lower = (value: string): string => value.toLowerCase();

/** Decodes `data` as `types` and requires it to be exactly their canonical encoding. */
function strictDecode<const T extends readonly { type: string }[]>(types: T, data: Hex) {
  try {
    const values = decodeAbiParameters(types as never, data) as readonly unknown[];
    const again = encodeAbiParameters(types as never, values as never);
    return again.toLowerCase() === data.toLowerCase() ? values : null;
  } catch {
    return null;
  }
}

/** The tokens of a v3 path: token (20) then fee (3) and token (20) for every pool. */
function v3PathTokensV1(path: string): string[] | null {
  const hex = path.slice(2).toLowerCase();
  if (hex.length < 86 || (hex.length - 40) % 46 !== 0) return null;
  const tokens = [`0x${hex.slice(0, 40)}`];
  for (let at = 40; at < hex.length; at += 46) tokens.push(`0x${hex.slice(at + 6, at + 46)}`);
  return tokens;
}

/**
 * Reads a Universal Router `execute(bytes,bytes[],uint256)` call against the
 * swap that was reviewed. Refuses anything it cannot read exactly.
 */
export function readUniswapExecuteV1(data: string, expected: UniswapRouterExpectationV1): UniswapRouterReadingV1 {
  const wallet = lower(expected.wallet);
  const inputToken = expected.input.kind === 'erc20' ? lower(expected.input.address) : null;
  const outputToken = expected.output.kind === 'erc20' ? lower(expected.output.address) : null;
  // How the router names the output where it pays it: an ERC-20 by address; native ETH as address(0)
  // in its sweeps, transfers and v4 takes.
  const outputCurrency = outputToken ?? UNISWAP_NATIVE_CURRENCY_V1;

  let commandsHex: Hex, inputs: readonly Hex[], deadline: bigint;
  try {
    const decoded = decodeFunctionData({ abi: UNIVERSAL_ROUTER_EXECUTE_ABI_V1, data: data as Hex });
    [commandsHex, inputs, deadline] = decoded.args as unknown as [Hex, readonly Hex[], bigint];
    const again = encodeFunctionData({ abi: UNIVERSAL_ROUTER_EXECUTE_ABI_V1, functionName: 'execute', args: [commandsHex, inputs, deadline] });
    if (!sameCanonicalCallV1(data, again)) {
      return refuse('uniswap_router_call_not_canonical', 'The router call carries bytes its own arguments do not explain');
    }
  } catch {
    return refuse('uniswap_router_call_undecodable', 'The router call is not the pinned Universal Router execute(commands, inputs, deadline)');
  }
  const commands = (commandsHex.slice(2).match(/.{2}/g) ?? []).map((byte) => parseInt(byte, 16));
  if (commands.length === 0 || commands.length > 32 || commands.length !== inputs.length) {
    return refuse('uniswap_commands_invalid', 'The router call must carry one to 32 commands, each with its input');
  }

  let pulledFromWallet = 0n;
  let nativeSpent = 0n;
  let guaranteed = 0n;
  let sources = 0;
  /** The only places a payment may go: the wallet (by address or the router's marker), or the router. */
  const destination = (recipient: string): 'wallet' | 'router' | null => {
    const value = lower(recipient);
    if (value === wallet || value === MSG_SENDER_V1) return 'wallet';
    if (value === ADDRESS_THIS_V1) return 'router';
    return null;
  };
  const paysAnother = (recipient: string) =>
    refuse('uniswap_pays_another_address', `A router command pays ${lower(recipient)}, which is not the wallet`);

  for (const [index, command] of commands.entries()) {
    const input = inputs[index]!;
    // The top bit lets a failing command be skipped (a minimum that fails would then be ignored); the
    // next is unused. Either is refused, and so is any command Still does not read below.
    if (command & 0xc0) return refuse('uniswap_command_flag_not_allowed', `Command ${index} carries a flag Still does not accept`);
    switch (command) {
      case UNISWAP_COMMANDS_V1.V3_SWAP_EXACT_IN:
      case UNISWAP_COMMANDS_V1.V2_SWAP_EXACT_IN: {
        const v3 = command === UNISWAP_COMMANDS_V1.V3_SWAP_EXACT_IN;
        const values = strictDecode(v3 ? V3_SWAP_EXACT_IN_PARAMS_V1 : V2_SWAP_EXACT_IN_PARAMS_V1, input);
        if (!values) return refuse('uniswap_command_input_invalid', `Swap command ${index} is not read exactly`);
        const [recipient, amountIn, amountOutMin, path, payerIsUser] = values as [string, bigint, bigint, string | readonly string[], boolean];
        const tokens = v3 ? v3PathTokensV1(path as string) : (path as readonly string[]).map(lower);
        if (!tokens || tokens.length < 2) return refuse('uniswap_path_invalid', `Swap command ${index} has no readable path`);
        if (payerIsUser) {
          // The wallet pays through Permit2: only the reviewed input, and an explicit amount of it.
          if (!inputToken || tokens[0] !== inputToken) {
            return refuse('uniswap_pulls_another_token', `Swap command ${index} draws ${tokens[0]} from the wallet, not the reviewed input`);
          }
          if (amountIn === 0n || amountIn === CONTRACT_BALANCE_V1) {
            return refuse('uniswap_command_input_invalid', `Swap command ${index} draws no explicit amount from the wallet`);
          }
          pulledFromWallet += amountIn;
        }
        const to = destination(recipient);
        if (to === null) return paysAnother(recipient);
        if (to === 'wallet') {
          if (tokens.at(-1) !== outputToken) {
            return refuse('uniswap_pays_another_token', `Swap command ${index} pays the wallet ${tokens.at(-1)}, not the reviewed output`);
          }
          guaranteed += amountOutMin;
          sources += 1;
        }
        break;
      }
      case UNISWAP_COMMANDS_V1.WRAP_ETH: {
        const values = strictDecode(RECIPIENT_AMOUNT_PARAMS_V1, input);
        if (!values) return refuse('uniswap_command_input_invalid', `Command ${index} is not read exactly`);
        const [recipient, amount] = values as [string, bigint];
        if (expected.input.kind !== 'native' || destination(recipient) !== 'router') {
          return refuse('uniswap_command_not_allowed', `Command ${index} wraps ETH where this swap does not`);
        }
        nativeSpent += amount === CONTRACT_BALANCE_V1 ? expected.amountInAtomic : amount;
        break;
      }
      case UNISWAP_COMMANDS_V1.UNWRAP_WETH: {
        const values = strictDecode(RECIPIENT_AMOUNT_PARAMS_V1, input);
        if (!values) return refuse('uniswap_command_input_invalid', `Command ${index} is not read exactly`);
        const [recipient, amountMin] = values as [string, bigint];
        const to = destination(recipient);
        if (to === null) return paysAnother(recipient);
        if (to === 'wallet') {
          if (expected.output.kind !== 'native') {
            return refuse('uniswap_pays_another_token', `Command ${index} pays the wallet ETH, not the reviewed output`);
          }
          guaranteed += amountMin;
          sources += 1;
        }
        break;
      }
      case UNISWAP_COMMANDS_V1.SWEEP:
      case UNISWAP_COMMANDS_V1.TRANSFER:
      case UNISWAP_COMMANDS_V1.PAY_PORTION: {
        const values = strictDecode(TOKEN_RECIPIENT_AMOUNT_PARAMS_V1, input);
        if (!values) return refuse('uniswap_command_input_invalid', `Command ${index} is not read exactly`);
        const [tokenRaw, recipient, amount] = values as [string, string, bigint];
        const token = lower(tokenRaw);
        // A payment out of what the router holds goes to the wallet, and nowhere else: a fee or a
        // second recipient is not part of a Still swap.
        if (destination(recipient) !== 'wallet') return paysAnother(recipient);
        if (command === UNISWAP_COMMANDS_V1.SWEEP && amount >= UINT160_LIMIT_V1) {
          return refuse('uniswap_command_input_invalid', `Command ${index} has a minimum the router cannot read`);
        }
        // A sweep pays the router's whole balance and refuses less than its minimum; a transfer pays its
        // exact amount. Of the output, both are what the wallet is guaranteed. A portion guarantees nothing.
        if (token === outputCurrency && command !== UNISWAP_COMMANDS_V1.PAY_PORTION && amount !== CONTRACT_BALANCE_V1) {
          guaranteed += amount;
          sources += 1;
        }
        break;
      }
      case UNISWAP_COMMANDS_V1.BALANCE_CHECK_ERC20: {
        if (!strictDecode(BALANCE_CHECK_PARAMS_V1, input)) return refuse('uniswap_command_input_invalid', `Command ${index} is not read exactly`);
        break;
      }
      case UNISWAP_COMMANDS_V1.V4_SWAP: {
        const plan = readV4PlanV1(input, index, { inputToken, outputCurrency, destination, paysAnother,
          nativeAmountIn: expected.input.kind === 'native' ? expected.amountInAtomic : null });
        if (!plan.ok) return plan.refusal;
        pulledFromWallet += plan.pulledFromWallet;
        nativeSpent += plan.nativeSpent;
        guaranteed += plan.guaranteed;
        sources += plan.sources;
        break;
      }
      default: {
        const name = REFUSED_COMMAND_NAMES_V1[command] ?? `0x${command.toString(16).padStart(2, '0')}`;
        return refuse('uniswap_command_not_allowed', `Command ${index} (${name}) is not part of a Still swap`);
      }
    }
  }

  if (inputToken) {
    if (pulledFromWallet !== expected.amountInAtomic) {
      return refuse('uniswap_input_amount_mismatch', 'The router call does not draw exactly the reviewed input from the wallet');
    }
    if (nativeSpent !== 0n) return refuse('uniswap_command_not_allowed', 'The router call spends native ETH this swap does not send');
  } else if (pulledFromWallet !== 0n || nativeSpent !== expected.amountInAtomic) {
    return refuse('uniswap_input_amount_mismatch', 'The router call does not spend exactly the reviewed ETH');
  }
  if (guaranteed <= 0n) return refuse('uniswap_minimum_missing', 'Nothing in the router call guarantees the wallet any output');
  return { ok: true, deadline, commands, guaranteedOutputAtomic: guaranteed, minimumSources: sources };
}

type V4PlanReadingV1 =
  | { ok: true; pulledFromWallet: bigint; nativeSpent: bigint; guaranteed: bigint; sources: number }
  | { ok: false; refusal: UniswapRouterReadingV1 };

/** One V4_SWAP command: its actions run inside one unlock of the pool manager. */
function readV4PlanV1(input: Hex, index: number, ctx: {
  inputToken: string | null;
  outputCurrency: string;
  /** The ETH this swap sends, when its input is native: all the router holds of it. */
  nativeAmountIn: bigint | null;
  destination: (recipient: string) => 'wallet' | 'router' | null;
  paysAnother: (recipient: string) => UniswapRouterReadingV1;
}): V4PlanReadingV1 {
  const fail = (code: string, reason: string): V4PlanReadingV1 => ({ ok: false, refusal: refuse(code, reason) });
  const plan = strictDecode(V4_PLAN_PARAMS_V1, input);
  if (!plan) return fail('uniswap_command_input_invalid', `v4 command ${index} is not read exactly`);
  const [actionsHex, params] = plan as [Hex, readonly Hex[]];
  const actions = (actionsHex.slice(2).match(/.{2}/g) ?? []).map((byte) => parseInt(byte, 16));
  if (actions.length === 0 || actions.length !== params.length || actions.length > 32) {
    return fail('uniswap_v4_plan_invalid', `v4 command ${index} must carry its actions with their inputs`);
  }
  // Per currency: what the swaps so far owe the pool manager, and the least they are sure to have left
  // to take: the sum of their own minimums.
  const debt = new Map<string, bigint>();
  const creditMin = new Map<string, bigint>();
  let pulledFromWallet = 0n, nativeSpent = 0n, guaranteed = 0n, sources = 0;
  const add = (map: Map<string, bigint>, key: string, amount: bigint) => map.set(key, (map.get(key) ?? 0n) + amount);

  for (const [at, action] of actions.entries()) {
    const param = params[at]!;
    const where = `v4 action ${at} of command ${index}`;
    switch (action) {
      case UNISWAP_V4_ACTIONS_V1.SWAP_EXACT_IN_SINGLE:
      case UNISWAP_V4_ACTIONS_V1.SWAP_EXACT_IN: {
        let currencyIn: string, currencyOut: string, amountIn: bigint, amountOutMinimum: bigint;
        if (action === UNISWAP_V4_ACTIONS_V1.SWAP_EXACT_IN_SINGLE) {
          const values = strictDecode(V4_EXACT_IN_SINGLE_PARAMS_V1, param);
          if (!values) return fail('uniswap_command_input_invalid', `${where} is not read exactly`);
          const [p] = values as [{ poolKey: { currency0: string; currency1: string }; zeroForOne: boolean; amountIn: bigint; amountOutMinimum: bigint }];
          currencyIn = lower(p.zeroForOne ? p.poolKey.currency0 : p.poolKey.currency1);
          currencyOut = lower(p.zeroForOne ? p.poolKey.currency1 : p.poolKey.currency0);
          amountIn = p.amountIn;
          amountOutMinimum = p.amountOutMinimum;
        } else {
          const values = strictDecode(V4_EXACT_IN_PARAMS_V1, param);
          if (!values) return fail('uniswap_command_input_invalid', `${where} is not read exactly`);
          const [p] = values as [{ currencyIn: string; path: readonly { intermediateCurrency: string }[]; amountIn: bigint; amountOutMinimum: bigint }];
          if (p.path.length === 0) return fail('uniswap_path_invalid', `${where} has no path`);
          currencyIn = lower(p.currencyIn);
          currencyOut = lower(p.path.at(-1)!.intermediateCurrency);
          amountIn = p.amountIn;
          amountOutMinimum = p.amountOutMinimum;
        }
        // An open amount spends what an earlier step left as credit; an explicit one is owed.
        if (amountIn !== 0n) add(debt, currencyIn, amountIn);
        add(creditMin, currencyOut, amountOutMinimum);
        break;
      }
      case UNISWAP_V4_ACTIONS_V1.SETTLE:
      case UNISWAP_V4_ACTIONS_V1.SETTLE_ALL: {
        const all = action === UNISWAP_V4_ACTIONS_V1.SETTLE_ALL;
        const values = strictDecode(all ? V4_CURRENCY_AMOUNT_PARAMS_V1 : V4_SETTLE_PARAMS_V1, param);
        if (!values) return fail('uniswap_command_input_invalid', `${where} is not read exactly`);
        const [currencyRaw, amount, payerIsUserRaw] = values as [string, bigint, boolean | undefined];
        const currency = lower(currencyRaw);
        // SETTLE_ALL always pays from the wallet; native ETH is always paid from what the router holds.
        const fromWallet = currency !== UNISWAP_NATIVE_CURRENCY_V1 && (all || payerIsUserRaw === true);
        const owed = debt.get(currency) ?? 0n;
        // Native ETH settled with the router's whole balance is the ETH this swap sent.
        const balance = currency === UNISWAP_NATIVE_CURRENCY_V1 ? ctx.nativeAmountIn : null;
        const paid = all || amount === 0n ? owed : amount === CONTRACT_BALANCE_V1 ? balance : amount;
        if (fromWallet) {
          if (!ctx.inputToken || currency !== ctx.inputToken) {
            return fail('uniswap_pulls_another_token', `${where} draws ${currency} from the wallet, not the reviewed input`);
          }
          if (paid === null || paid === 0n || (all && owed > amount)) {
            return fail('uniswap_command_input_invalid', `${where} draws no explicit amount from the wallet`);
          }
          pulledFromWallet += paid;
        } else if (currency === UNISWAP_NATIVE_CURRENCY_V1) {
          if (ctx.nativeAmountIn === null) return fail('uniswap_command_not_allowed', `${where} spends native ETH this swap does not send`);
          if (paid === null) return fail('uniswap_command_input_invalid', `${where} spends an amount Still cannot read`);
          nativeSpent += paid;
        }
        if (paid !== null) debt.set(currency, owed > paid ? owed - paid : 0n);
        break;
      }
      case UNISWAP_V4_ACTIONS_V1.TAKE: {
        const values = strictDecode(TOKEN_RECIPIENT_AMOUNT_PARAMS_V1, param);
        if (!values) return fail('uniswap_command_input_invalid', `${where} is not read exactly`);
        const [currencyRaw, recipient, amount] = values as [string, string, bigint];
        const currency = lower(currencyRaw);
        const to = ctx.destination(recipient);
        if (to === null) return { ok: false, refusal: ctx.paysAnother(recipient) };
        const least = creditMin.get(currency) ?? 0n;
        const taken = amount === 0n ? least : amount;
        if (to === 'wallet' && currency === ctx.outputCurrency && taken > 0n) {
          guaranteed += taken;
          sources += 1;
        }
        creditMin.set(currency, amount === 0n || amount >= least ? 0n : least - amount);
        break;
      }
      case UNISWAP_V4_ACTIONS_V1.TAKE_ALL: {
        const values = strictDecode(V4_CURRENCY_AMOUNT_PARAMS_V1, param);
        if (!values) return fail('uniswap_command_input_invalid', `${where} is not read exactly`);
        const [currencyRaw, minAmount] = values as [string, bigint];
        const currency = lower(currencyRaw);
        // Taken to the router's caller: the wallet.
        const least = creditMin.get(currency) ?? 0n;
        if (currency === ctx.outputCurrency) {
          guaranteed += minAmount > least ? minAmount : least;
          sources += 1;
        }
        creditMin.set(currency, 0n);
        break;
      }
      default:
        return fail('uniswap_v4_action_not_allowed', `${where} (0x${action.toString(16).padStart(2, '0')}) is not part of a Still swap`);
    }
  }
  return { ok: true, pulledFromWallet, nativeSpent, guaranteed, sources };
}

/** Every address a router call pays something to, the router's markers mapped: what the review may
 * name as the recipient. Null when the call cannot be read. */
export function uniswapExecuteRecipientsV1(data: string, wallet: string): string[] | null {
  let commandsHex: Hex, inputs: readonly Hex[];
  try {
    [commandsHex, inputs] = decodeFunctionData({ abi: UNIVERSAL_ROUTER_EXECUTE_ABI_V1, data: data as Hex }).args as unknown as [Hex, readonly Hex[]];
  } catch {
    return null;
  }
  const commands = (commandsHex.slice(2).match(/.{2}/g) ?? []).map((byte) => parseInt(byte, 16));
  if (commands.length !== inputs.length) return null;
  const recipients = new Set<string>();
  const note = (recipient: string) => {
    const value = lower(recipient);
    if (value === ADDRESS_THIS_V1) return;
    recipients.add(value === MSG_SENDER_V1 ? lower(wallet) : value);
  };
  for (const [index, command] of commands.entries()) {
    const input = inputs[index]!;
    if (command === UNISWAP_COMMANDS_V1.V3_SWAP_EXACT_IN || command === UNISWAP_COMMANDS_V1.V2_SWAP_EXACT_IN) {
      const values = strictDecode(command === UNISWAP_COMMANDS_V1.V3_SWAP_EXACT_IN ? V3_SWAP_EXACT_IN_PARAMS_V1 : V2_SWAP_EXACT_IN_PARAMS_V1, input);
      if (!values) return null;
      note(values[0] as string);
    } else if (command === UNISWAP_COMMANDS_V1.WRAP_ETH || command === UNISWAP_COMMANDS_V1.UNWRAP_WETH) {
      const values = strictDecode(RECIPIENT_AMOUNT_PARAMS_V1, input);
      if (!values) return null;
      note(values[0] as string);
    } else if (command === UNISWAP_COMMANDS_V1.SWEEP || command === UNISWAP_COMMANDS_V1.TRANSFER || command === UNISWAP_COMMANDS_V1.PAY_PORTION) {
      const values = strictDecode(TOKEN_RECIPIENT_AMOUNT_PARAMS_V1, input);
      if (!values) return null;
      note(values[1] as string);
    } else if (command === UNISWAP_COMMANDS_V1.V4_SWAP) {
      const plan = strictDecode(V4_PLAN_PARAMS_V1, input);
      if (!plan) return null;
      const [actionsHex, params] = plan as [Hex, readonly Hex[]];
      const actions = (actionsHex.slice(2).match(/.{2}/g) ?? []).map((byte) => parseInt(byte, 16));
      if (actions.length !== params.length) return null;
      for (const [at, action] of actions.entries()) {
        if (action === UNISWAP_V4_ACTIONS_V1.TAKE) {
          const values = strictDecode(TOKEN_RECIPIENT_AMOUNT_PARAMS_V1, params[at]!);
          if (!values) return null;
          note(values[1] as string);
        } else if (action === UNISWAP_V4_ACTIONS_V1.TAKE_ALL) {
          recipients.add(lower(wallet));
        } else if (!(Object.values(UNISWAP_V4_ACTIONS_V1) as number[]).includes(action)) {
          // An action Still does not read may pay anyone.
          return null;
        }
      }
    } else if (command !== UNISWAP_COMMANDS_V1.BALANCE_CHECK_ERC20) {
      // A command Still does not read may pay anyone: the review names no recipient for it.
      return null;
    }
  }
  return [...recipients];
}

// ---------------------------------------------------------------------------
// The inverse, for tests and for anyone who wants to see what an allowed call
// looks like: a plan of commands encoded exactly as the router reads them.
// ---------------------------------------------------------------------------

export type UniswapCommandV1 =
  | { command: 'V3_SWAP_EXACT_IN'; recipient: string; amountIn: bigint; amountOutMin: bigint; path: string; payerIsUser: boolean }
  | { command: 'V2_SWAP_EXACT_IN'; recipient: string; amountIn: bigint; amountOutMin: bigint; path: string[]; payerIsUser: boolean }
  | { command: 'WRAP_ETH' | 'UNWRAP_WETH'; recipient: string; amount: bigint }
  | { command: 'SWEEP' | 'TRANSFER' | 'PAY_PORTION'; token: string; recipient: string; amount: bigint }
  | { command: 'BALANCE_CHECK_ERC20'; owner: string; token: string; minBalance: bigint }
  | { command: 'V4_SWAP'; actions: UniswapV4ActionV1[] }
  | { command: 'RAW'; type: number; input: Hex };

export type UniswapV4ActionV1 =
  | { action: 'SWAP_EXACT_IN_SINGLE'; currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string; zeroForOne: boolean; amountIn: bigint; amountOutMinimum: bigint; hookData?: Hex }
  | { action: 'SWAP_EXACT_IN'; currencyIn: string; path: { intermediateCurrency: string; fee: number; tickSpacing: number; hooks: string; hookData?: Hex }[]; amountIn: bigint; amountOutMinimum: bigint }
  | { action: 'SETTLE'; currency: string; amount: bigint; payerIsUser: boolean }
  | { action: 'SETTLE_ALL' | 'TAKE_ALL'; currency: string; amount: bigint }
  | { action: 'TAKE'; currency: string; recipient: string; amount: bigint }
  | { action: 'RAW'; type: number; input: Hex };

/** A v3 path: token, then fee and token for every pool. */
export function encodeUniswapV3PathV1(tokens: readonly string[], fees: readonly number[]): Hex {
  let hex = tokens[0]!.slice(2).toLowerCase();
  for (const [i, fee] of fees.entries()) hex += fee.toString(16).padStart(6, '0') + tokens[i + 1]!.slice(2).toLowerCase();
  return `0x${hex}`;
}

function encodeV4ActionV1(action: UniswapV4ActionV1): { type: number; input: Hex } {
  switch (action.action) {
    case 'SWAP_EXACT_IN_SINGLE':
      return { type: UNISWAP_V4_ACTIONS_V1.SWAP_EXACT_IN_SINGLE, input: encodeAbiParameters(V4_EXACT_IN_SINGLE_PARAMS_V1, [{
        poolKey: { currency0: action.currency0 as Hex, currency1: action.currency1 as Hex, fee: action.fee, tickSpacing: action.tickSpacing, hooks: action.hooks as Hex },
        zeroForOne: action.zeroForOne, amountIn: action.amountIn, amountOutMinimum: action.amountOutMinimum, hookData: action.hookData ?? '0x' }]) };
    case 'SWAP_EXACT_IN':
      return { type: UNISWAP_V4_ACTIONS_V1.SWAP_EXACT_IN, input: encodeAbiParameters(V4_EXACT_IN_PARAMS_V1, [{
        currencyIn: action.currencyIn as Hex,
        path: action.path.map((key) => ({ intermediateCurrency: key.intermediateCurrency as Hex, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks as Hex, hookData: key.hookData ?? '0x' })),
        amountIn: action.amountIn, amountOutMinimum: action.amountOutMinimum }]) };
    case 'SETTLE':
      return { type: UNISWAP_V4_ACTIONS_V1.SETTLE, input: encodeAbiParameters(V4_SETTLE_PARAMS_V1, [action.currency as Hex, action.amount, action.payerIsUser]) };
    case 'SETTLE_ALL':
    case 'TAKE_ALL':
      return { type: UNISWAP_V4_ACTIONS_V1[action.action], input: encodeAbiParameters(V4_CURRENCY_AMOUNT_PARAMS_V1, [action.currency as Hex, action.amount]) };
    case 'TAKE':
      return { type: UNISWAP_V4_ACTIONS_V1.TAKE, input: encodeAbiParameters(TOKEN_RECIPIENT_AMOUNT_PARAMS_V1, [action.currency as Hex, action.recipient as Hex, action.amount]) };
    case 'RAW':
      return { type: action.type, input: action.input };
  }
}

function encodeCommandV1(command: UniswapCommandV1): { type: number; input: Hex } {
  switch (command.command) {
    case 'V3_SWAP_EXACT_IN':
      return { type: UNISWAP_COMMANDS_V1.V3_SWAP_EXACT_IN, input: encodeAbiParameters(V3_SWAP_EXACT_IN_PARAMS_V1,
        [command.recipient as Hex, command.amountIn, command.amountOutMin, command.path as Hex, command.payerIsUser]) };
    case 'V2_SWAP_EXACT_IN':
      return { type: UNISWAP_COMMANDS_V1.V2_SWAP_EXACT_IN, input: encodeAbiParameters(V2_SWAP_EXACT_IN_PARAMS_V1,
        [command.recipient as Hex, command.amountIn, command.amountOutMin, command.path as Hex[], command.payerIsUser]) };
    case 'WRAP_ETH':
    case 'UNWRAP_WETH':
      return { type: UNISWAP_COMMANDS_V1[command.command], input: encodeAbiParameters(RECIPIENT_AMOUNT_PARAMS_V1, [command.recipient as Hex, command.amount]) };
    case 'SWEEP':
    case 'TRANSFER':
    case 'PAY_PORTION':
      return { type: UNISWAP_COMMANDS_V1[command.command], input: encodeAbiParameters(TOKEN_RECIPIENT_AMOUNT_PARAMS_V1, [command.token as Hex, command.recipient as Hex, command.amount]) };
    case 'BALANCE_CHECK_ERC20':
      return { type: UNISWAP_COMMANDS_V1.BALANCE_CHECK_ERC20, input: encodeAbiParameters(BALANCE_CHECK_PARAMS_V1, [command.owner as Hex, command.token as Hex, command.minBalance]) };
    case 'V4_SWAP': {
      const actions = command.actions.map(encodeV4ActionV1);
      return { type: UNISWAP_COMMANDS_V1.V4_SWAP, input: encodeAbiParameters(V4_PLAN_PARAMS_V1, [
        `0x${actions.map((a) => a.type.toString(16).padStart(2, '0')).join('')}`, actions.map((a) => a.input)]) };
    }
    case 'RAW':
      return { type: command.type, input: command.input };
  }
}

/** `execute(commands, inputs, deadline)` for a plan of commands. */
export function encodeUniswapExecuteV1(commands: readonly UniswapCommandV1[], deadline: bigint): Hex {
  const encoded = commands.map(encodeCommandV1);
  return encodeFunctionData({ abi: UNIVERSAL_ROUTER_EXECUTE_ABI_V1, functionName: 'execute', args: [
    `0x${encoded.map((c) => c.type.toString(16).padStart(2, '0')).join('')}`, encoded.map((c) => c.input), deadline] });
}
