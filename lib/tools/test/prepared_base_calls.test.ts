import assert from 'node:assert/strict';
import test from 'node:test';
import { PreparedBaseClaimToolProviderV1 } from '../src/prepared_base_calls.js';

test('bound claim rejects injected calls, sends its copied calls once, never retries uncertainty', async () => {
  let submitted = 0;
  const calls = [{ to: '0x1111111111111111111111111111111111111111', value: '0', data: '0xd294f093' }];
  const provider = new PreparedBaseClaimToolProviderV1({ sendAerodromeClaimCalls: async (_wallet: string, actual: unknown) => {
    submitted++; assert.equal((actual as any)[0].data, '0xd294f093'); throw new Error('timeout after submit');
  } } as any, { actionType: 'aerodrome_claim', walletAddress: calls[0].to, calls });
  calls[0].data = '0xbad0';
  assert.equal((await provider.callTool('send_calls', {})).isError, true);
  assert.equal((await provider.callTool('prepared_aerodrome_claim', { calls })).isError, true);
  assert.equal(submitted, 0);
  assert.equal((await provider.callTool('prepared_aerodrome_claim', {})).isError, true);
  assert.equal((await provider.callTool('prepared_aerodrome_claim', {})).isError, true);
  assert.equal(submitted, 1);
});
test('bound claim refuses ETH value and unbounded batches', () => {
  const call = { to: '0x1111111111111111111111111111111111111111', value: '1', data: '0x' };
  assert.throws(() => new PreparedBaseClaimToolProviderV1({} as any, { actionType: 'aerodrome_claim', walletAddress: call.to, calls: [call] }));
  assert.throws(() => new PreparedBaseClaimToolProviderV1({} as any, { actionType: 'aerodrome_claim', walletAddress: call.to, calls: Array(21).fill({ ...call, value: '0' }) }));
});
test('a bound Uniswap collect has its own tool, its own guard and its own closed transport', async () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  const max = 'f'.repeat(32).padStart(64, '0');
  const collect = { to: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1', value: '0',
    data: `0xfc6f7865${(41).toString(16).padStart(64, '0')}${wallet.slice(2).padStart(64, '0')}${max}${max}` };
  const sent: string[] = [];
  const provider = new PreparedBaseClaimToolProviderV1({
    sendUniswapCollectCalls: async (_wallet: string, actual: { data: string }[]) => { sent.push(actual[0]!.data); return { approvalUrl: 'https://keys.coinbase.com/x', requestId: 'r' }; },
    sendAerodromeClaimCalls: async () => assert.fail('a collect never rides the Aerodrome transport'),
  } as any, { actionType: 'uniswap_collect', walletAddress: wallet, calls: [collect] });
  assert.deepEqual((await provider.listTools()).map((tool) => tool.name), ['prepared_uniswap_collect']);
  assert.equal((await provider.callTool('prepared_aerodrome_claim', {})).isError, true);
  assert.equal((await provider.callTool('prepared_uniswap_collect', {})).isError, false);
  assert.deepEqual(sent, [collect.data]);
  // An Aerodrome claim shape is refused at construction as a Uniswap collect.
  assert.throws(() => new PreparedBaseClaimToolProviderV1({} as any, { actionType: 'uniswap_collect', walletAddress: wallet,
    calls: [{ to: collect.to, value: '0', data: '0xd294f093' }] }));
  assert.throws(() => new PreparedBaseClaimToolProviderV1({} as any, { actionType: 'send' as any, walletAddress: wallet, calls: [collect] }));
});
