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
test('a bound ETH send has its own tool and transport, and carries exactly the one transfer it was given', async () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  const transfer = { to: '0x2222222222222222222222222222222222222222', value: '100000000000000', data: '0x' };
  const sent: unknown[] = [];
  const provider = new PreparedBaseClaimToolProviderV1({
    sendNativeTransferCalls: async (_wallet: string, actual: unknown[]) => { sent.push(actual); return { approvalUrl: 'https://keys.coinbase.com/x', requestId: 'r' }; },
    sendAerodromeClaimCalls: async () => assert.fail('a send never rides the claim transport'),
  } as any, { actionType: 'native_send', walletAddress: wallet, calls: [transfer] });
  assert.deepEqual((await provider.listTools()).map((tool) => tool.name), ['prepared_native_send']);
  assert.equal((await provider.callTool('prepared_native_send', { to: wallet })).isError, true);
  assert.equal((await provider.callTool('prepared_native_send', {})).isError, false);
  assert.equal((await provider.callTool('prepared_native_send', {})).isError, true, 'submitted once');
  assert.deepEqual(sent, [[transfer]]);
  // Calldata, a second call or the wallet itself as recipient are refused at construction.
  assert.throws(() => new PreparedBaseClaimToolProviderV1({} as any, { actionType: 'native_send', walletAddress: wallet,
    calls: [{ ...transfer, data: '0xa9059cbb' }] }));
  assert.throws(() => new PreparedBaseClaimToolProviderV1({} as any, { actionType: 'native_send', walletAddress: wallet,
    calls: [transfer, transfer] }));
  assert.throws(() => new PreparedBaseClaimToolProviderV1({} as any, { actionType: 'native_send', walletAddress: wallet,
    calls: [{ ...transfer, to: wallet }] }));
  // A claim still never moves ETH.
  assert.throws(() => new PreparedBaseClaimToolProviderV1({} as any, { actionType: 'aerodrome_claim', walletAddress: wallet,
    calls: [{ to: transfer.to, value: '1', data: '0xd294f093' }] }));
});
