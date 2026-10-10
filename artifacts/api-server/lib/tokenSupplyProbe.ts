import { BaseError, ExecutionRevertedError, RawContractError, createPublicClient, http, type Hex } from 'viem';
import { base } from 'viem/chains';

import { baseRpcUrlV1 } from './earnPreflight.js';

// ---------------------------------------------------------------------------
// Is this address a token at all? Asked before anything is charged.
//
// The paid identity check answers from stored evidence, and that corpus can
// only ever say `unknown_to_miorail` about a wallet. On 2026-10-10 an
// assistant paid 0.002 USDC to learn exactly that about its own wallet.
//
// The question is ERC-20's own `totalSupply()`, never whether the address
// holds code: a Coinbase B20 stock holds ONE byte of code (NVDAc, read
// 2026-10-10) and answers the call with a full word, while a wallet answers
// with nothing at all and a contract without the function reverts.
// ---------------------------------------------------------------------------

export type TokenSupplyAnswerV1 = 'token' | 'not_token' | 'unreadable';

const TOTAL_SUPPLY_SELECTOR_V1 = '0x18160ddd';

/** One 32-byte word is a supply; an empty or short answer is not. */
export function tokenSupplyAnswerFromCallV1(data: Hex | undefined): 'token' | 'not_token' {
  return typeof data === 'string' && /^0x[0-9a-fA-F]{64}$/.test(data) ? 'token' : 'not_token';
}

/** A revert is the address answering "no"; anything else is the read failing. */
export function tokenSupplyCallRevertedV1(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk((cause) => cause instanceof ExecutionRevertedError || cause instanceof RawContractError) !== null
  );
}

export async function readTokenSupplyAnswerV1(
  tokenAddress: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TokenSupplyAnswerV1> {
  const client = createPublicClient({
    chain: base,
    transport: http(baseRpcUrlV1(env), { retryCount: 1, timeout: 6_000 }),
  });
  try {
    const { data } = await client.call({ to: tokenAddress as Hex, data: TOTAL_SUPPLY_SELECTOR_V1 });
    return tokenSupplyAnswerFromCallV1(data);
  } catch (error) {
    return tokenSupplyCallRevertedV1(error) ? 'not_token' : 'unreadable';
  }
}
