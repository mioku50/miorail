import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, type PublicClient } from 'viem';
import { morphoAbi } from '../src/abi.js';
import { loadMorphoUniverse } from '../src/read.js';
import { ADDRESSES, CRYPTO } from '../src/registry.js';
import type { Provider } from '../src/rpc.js';

function fixture(over: { loan?: string; collateral?: string; oracle?: string; lltv?: bigint; broken?: boolean } = {}) {
  const asked: any[] = [];
  const provider: Provider = { label: 'fixture', client: {
    readContract: async ({ args }: { args: [any[]] }) => args[0].map((call) => {
      asked.push(call);
      const decoded = decodeFunctionData({ abi: morphoAbi, data: call.callData });
      assert.equal(decoded.functionName, 'idToMarketParams');
      const asset = CRYPTO.find((entry) => entry.morphoMarket === decoded.args![0])!;
      return { success: true, returnData: over.broken ? '0x1234' : encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
        [(over.loan ?? ADDRESSES.usdc) as `0x${string}`, (over.collateral ?? asset.token) as `0x${string}`,
          (over.oracle ?? '0x0000000000000000000000000000000000000011') as `0x${string}`, '0x0000000000000000000000000000000000000012', over.lltv ?? 860_000_000_000_000_001n]) };
    }),
  } as unknown as PublicClient };
  return { asked, provider };
}
describe('bounded Morpho universe shares the Mirror decoder', () => {
  it('reads only the selected code-owned market, without Aave or a directory page', async () => {
    const f = fixture();
    const result = await loadMorphoUniverse([f.provider], ['cbBTC', 'cbBTC']);
    assert.equal(f.asked.length, 1);
    assert.equal(f.asked[0].target, ADDRESSES.morpho);
    assert.equal(result.morpho.length, 1);
    const market = result.morpho[0]!;
    assert(market.ok);
    assert.equal(market.market.params.lltv, 860_000_000_000_000_001n, 'do not round the contract LLTV through basis points');
    assert.equal(market.market.id, CRYPTO[0]!.morphoMarket);
  });
  for (const over of [
    { loan: ADDRESSES.weth }, { collateral: ADDRESSES.weth },
    { oracle: '0x0000000000000000000000000000000000000000' }, { lltv: 0n }, { lltv: 10n ** 18n + 1n },
  ]) {
    it(`refuses immutable parameters that do not match the selected market (${Object.keys(over)[0]})`, async () => {
      const f = fixture(over);
      const result = await loadMorphoUniverse([f.provider], ['cbBTC']);
      assert.equal(result.morpho[0]!.ok, false);
      assert.equal('market' in result.morpho[0]!, false);
    });
  }
  it('does not turn an undecodable answer into a zero market', async () => {
    const f = fixture({ broken: true });
    const result = await loadMorphoUniverse([f.provider], ['cbBTC']);
    assert.deepEqual(result.morpho[0], { ok: false, asset: CRYPTO[0], problem: 'unreadable' });
  });
});
