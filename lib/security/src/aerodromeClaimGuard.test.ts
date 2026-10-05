import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, parseAbi } from 'viem';
import { validateAerodromeClaimCallsV1 } from './aerodromeClaimGuard.js';
import { validateBaseCalls } from './baseGuards.js';
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
function calls() {
  const max = (1n << 128n) - 1n;
  const build = (sig: string, name: string, args: any[] = []) => ({ to: OTHER, value: '0',
    data: encodeFunctionData({ abi: parseAbi([sig]) as any, functionName: name, args }) });
  return [build('function claimFees()', 'claimFees'), build('function getReward(address)', 'getReward', [WALLET]),
    build('function getReward(uint256)', 'getReward', [42n]),
    build('function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max))', 'collect', [
      { tokenId: 41n, recipient: WALLET, amount0Max: max, amount1Max: max },
    ])];
}
test('closed shape guard accepts only the four claims; generic transport remains USDC/native only', () => {
  assert.doesNotThrow(() => validateAerodromeClaimCallsV1(WALLET, calls()));
  assert.throws(() => validateBaseCalls('8453', calls()));
  assert.throws(() => validateAerodromeClaimCallsV1(OTHER, calls()));
  assert.throws(() => validateAerodromeClaimCallsV1(WALLET, [{ ...calls()[0], data: '0x095ea7b3' }]));
  assert.throws(() => validateAerodromeClaimCallsV1(WALLET, [{ ...calls()[0], value: '1' }]));
  assert.throws(() => validateAerodromeClaimCallsV1(WALLET, [{ ...calls()[0], data: `${calls()[0].data}00` }]));
});
test('ERC-8021 is trailing attribution; malformed suffix and altered collect recipient are refused', () => {
  const suffix = '62635f74657374070080218021802180218021802180218021';
  assert.doesNotThrow(() => validateAerodromeClaimCallsV1(WALLET, calls().map(call => ({ ...call, data: call.data + suffix }))));
  assert.throws(() => validateAerodromeClaimCallsV1(WALLET, [{ ...calls()[0], data: calls()[0].data + suffix.replace('0700', 'ff00') }]));
  const collect = calls()[3];
  assert.throws(() => validateAerodromeClaimCallsV1(WALLET, [{ ...collect, data: collect.data.replace(WALLET.slice(2), OTHER.slice(2)) }]));
});
