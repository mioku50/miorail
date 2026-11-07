import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { canonicalSwapExtractionV2 } from '@mioagent/intent-engine';
import { ADDRESSES, CRYPTO, STOCKS } from '@mioagent/still-engine/registry';
import { createMiorailPrivateMcpServerV1 } from './server.js';
import { StillSwapRefusalV1, stillPrepareSwapV1, stillSwapRuntimeV1 } from './stillSwapTool.js';

// miorail_prepare_swap writes the swap the Still Agent writes on the page, for
// an assistant (operator, 2026-11-07): a link to Swap AI, never a call.

const WALLET = `0x${'1'.repeat(40)}` as const;
const ME = { walletAddress: WALLET };
const PAXG = CRYPTO.find((row) => row.id === 'PAXG')!;
const NVDA = STOCKS.find((row) => row.id === 'NVDAc')!;
const goalOf = (url: string) => new URL(url).searchParams.get('goal');
const holding = (balanceAtomic: string, decimals: number) => async () => ({ ok: true as const, decimals, symbol: 'X', balanceAtomic, blockNumber: '54270000' });
const refused = (code: string) => (error: unknown) => error instanceof StillSwapRefusalV1 && error.code === code;

test('two tokens are named by their addresses, in the sentence Swap AI reads without a model', async () => {
  const out = await stillPrepareSwapV1(ME, { give: 'USDC', receive: 'PAXG', amount: '10' });
  assert.equal(out.goal, `Swap 10 ${ADDRESSES.usdc} to ${PAXG.token} on Base`);
  assert.equal(goalOf(out.reviewUrl), out.goal);
  assert.match(out.reviewUrl, /^https:\/\/miorail\.xyz\/routes\?goal=/);
  // The engine's own parser takes it as written: nothing is left for a model to copy.
  assert.deepEqual(canonicalSwapExtractionV2(out.goal), { goal: 'swap', amount: '10', fromAsset: ADDRESSES.usdc, toAsset: PAXG.token, chainId: 8453 });
  assert.deepEqual([out.give, out.receive, out.amountSource, out.balance], [
    { id: 'USDC', token: ADDRESSES.usdc, decimals: 6 }, { id: 'PAXG', token: PAXG.token, decimals: 18 }, 'stated', null,
  ]);
  // A stock is its B20 address too, twenty-one zeros and all.
  const sell = await stillPrepareSwapV1(ME, { give: 'NVDAc', receive: 'USDC', amount: '0.5' });
  assert.equal(canonicalSwapExtractionV2(sell.goal)?.fromAsset, NVDA.token);
});

test('native ETH is the symbol, and USDC beside it too, as the Still Agent writes them', async () => {
  assert.equal((await stillPrepareSwapV1(ME, { give: 'ETH', receive: 'USDC', amount: '0.01' })).goal, 'Swap 0.01 ETH to USDC on Base');
  assert.equal((await stillPrepareSwapV1(ME, { give: 'USDC', receive: 'ETH', amount: '25' })).goal, 'Swap 25 USDC to ETH on Base');
  assert.equal((await stillPrepareSwapV1(ME, { give: 'ETH', receive: 'cbBTC', amount: '0.1' })).goal, `Swap 0.1 ETH to ${ADDRESSES.cbbtc} on Base`);
});

test('the amount is kept exactly as said, within the token’s own decimals', async () => {
  assert.equal((await stillPrepareSwapV1(ME, { give: 'PAXG', receive: 'USDC', amount: '0.000000000000000001' })).amount, '0.000000000000000001');
  assert.equal((await stillPrepareSwapV1(ME, { give: 'USDC', receive: 'PAXG', amount: '10.50' })).amount, '10.5');
  await assert.rejects(stillPrepareSwapV1(ME, { give: 'USDC', receive: 'PAXG', amount: '1.0000001' }), refused('still_swap_amount_invalid'));
  await assert.rejects(stillPrepareSwapV1(ME, { give: 'cbBTC', receive: 'USDC', amount: '0.000000001' }), refused('still_swap_amount_invalid'));
  await assert.rejects(stillPrepareSwapV1(ME, { give: 'USDC', receive: 'PAXG', amount: '0' }), refused('still_swap_amount_invalid'));
});

test('an amount arrives as a string or a number, and a refused one says the form it wants', async () => {
  // 2026-11-07: Grok spent eight calls on "2 USDC" before trying "all", told only "Invalid input".
  for (const amount of [2, '2', ' 2 ', '2 USDC', '2usdc', '$2', '$ 2']) {
    const out = await stillPrepareSwapV1(ME, { give: 'USDC', receive: 'PAXG', amount });
    assert.equal(out.amount, '2', String(amount));
    assert.equal(out.goal, `Swap 2 ${ADDRESSES.usdc} to ${PAXG.token} on Base`);
  }
  assert.equal((await stillPrepareSwapV1(ME, { give: 'PAXG', receive: 'USDC', amount: 0.0005 })).amount, '0.0005');
  assert.equal((await stillPrepareSwapV1(ME, { give: 'PAXG', receive: 'USDC', amount: 'ALL' }, { readBalance: holding('7', 18) })).amountSource, 'wallet_all');
  for (const amount of [1e-7, -1, Number.NaN, '1,5', '2 PAXG', '2 dollars', 'two']) {
    await assert.rejects(stillPrepareSwapV1(ME, { give: 'USDC', receive: 'PAXG', amount }),
      (error: unknown) => refused('still_swap_amount_invalid')(error) && /a decimal such as "2" or "0\.5" \(a JSON number works too\), or "all" or "half"/.test((error as Error).message), String(amount));
  }
});

test('all and half are this wallet’s own balance, read at one block, never a guess', async () => {
  const asked: string[] = [];
  const read = async (token: string, wallet: string) => { asked.push(`${token}:${wallet}`); return holding('1500000000000000001', 18)(); };
  const all = await stillPrepareSwapV1(ME, { give: 'PAXG', receive: 'USDC', amount: 'all' }, { readBalance: read });
  assert.deepEqual([all.amount, all.amountSource, all.balance], ['1.500000000000000001', 'wallet_all', { amount: '1.500000000000000001', block: '54270000' }]);
  assert.deepEqual(asked, [`${PAXG.token}:${WALLET}`]);
  const half = await stillPrepareSwapV1(ME, { give: 'PAXG', receive: 'USDC', amount: 'half' }, { readBalance: read });
  assert.deepEqual([half.amount, half.amountSource], ['0.75', 'wallet_half']);
  assert.equal(half.goal, `Swap 0.75 ${PAXG.token} to ${ADDRESSES.usdc} on Base`);
});

test('what it cannot write it refuses, and an unread balance is our failure, not an empty wallet', async () => {
  await assert.rejects(stillPrepareSwapV1(ME, { give: 'ETH', receive: 'USDC', amount: 'all' }), refused('still_swap_eth_needs_an_amount'));
  await assert.rejects(stillPrepareSwapV1(ME, { give: 'PAXG', receive: 'PAXG', amount: '1' }), refused('still_swap_same_token'));
  await assert.rejects(stillPrepareSwapV1(ME, { give: 'ETH', receive: 'WETH', amount: '1' }), refused('still_swap_is_a_wrap'));
  await assert.rejects(stillPrepareSwapV1(ME, { give: 'USDC', receive: 'PAXG', amount: 'all' }, { readBalance: async () => ({ ok: false }) }),
    (error: unknown) => refused('still_swap_balance_unread')(error) && /our failure, not an empty wallet/.test((error as Error).message));
  await assert.rejects(stillPrepareSwapV1(ME, { give: 'USDC', receive: 'PAXG', amount: 'half' }, { readBalance: holding('1', 6) }), refused('still_swap_nothing_held'));
  // A token answering with other decimals than Still's registry prepares nothing.
  await assert.rejects(stillPrepareSwapV1(ME, { give: 'USDC', receive: 'PAXG', amount: 'all' }, { readBalance: holding('5000000', 18) }), refused('still_swap_balance_unread'));
});

test('on the connected server: a read that writes a link, for this wallet, and the refusal named', async (t) => {
  const original = stillSwapRuntimeV1.readBalance;
  const asked: string[] = [];
  stillSwapRuntimeV1.readBalance = async (_token, wallet) => { asked.push(wallet); return holding('2000000', 6)(); };
  t.after(() => { stillSwapRuntimeV1.readBalance = original; });
  const client = new Client({ name: 'still-swap-test', version: '1' });
  const server = createMiorailPrivateMcpServerV1({ tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET, chainId: 8453, tokenId: 'test-grant', source: 'oauth' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  t.after(() => client.close());

  const tool = (await client.listTools()).tools.find((row) => row.name === 'miorail_prepare_swap');
  assert.ok(tool, 'listed');
  assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.match(tool.description ?? '', /no price, route, quote or calldata/);
  assert.match(tool.description ?? '', /waits for the user to press Compare/);

  const done = await client.callTool({ name: 'miorail_prepare_swap', arguments: { give: 'USDC', receive: 'PAXG', amount: 'half' } });
  const out = done.structuredContent as { goal: string; amount: string };
  assert.equal(out.amount, '1');
  assert.equal(out.goal, `Swap 1 ${ADDRESSES.usdc} to ${PAXG.token} on Base`);
  // The connected wallet's balance, never one named in the arguments.
  assert.deepEqual(asked, [WALLET]);

  // A JSON number goes through the protocol as well as a string.
  const numeric = await client.callTool({ name: 'miorail_prepare_swap', arguments: { give: 'USDC', receive: 'PAXG', amount: 2 } });
  assert.equal((numeric.structuredContent as { amount: string }).amount, '2');

  const no = await client.callTool({ name: 'miorail_prepare_swap', arguments: { give: 'ETH', receive: 'USDC', amount: 'all' } });
  assert.equal(no.isError, true);
  assert.match((no.content as Array<{ text: string }>)[0]!.text, /^still_swap_eth_needs_an_amount: /);
  // There is no argument that names another wallet: one sent anyway is dropped, and the
  // balance read is still the connected wallet's.
  const other = await client.callTool({ name: 'miorail_prepare_swap', arguments: { give: 'USDC', receive: 'PAXG', amount: 'half', wallet: `0x${'2'.repeat(40)}` } });
  assert.equal(other.isError, undefined);
  assert.deepEqual(asked, [WALLET, WALLET]);
});
