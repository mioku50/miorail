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
