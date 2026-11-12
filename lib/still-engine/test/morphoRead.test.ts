import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, getAddress, type PublicClient } from 'viem';
import { morphoAbi, morphoOracleFeedAbi } from '../src/abi.js';
import { loadMorphoPriceFeeds, loadMorphoUniverse, morphoPriceUpdatedAt, type MorphoUniverse } from '../src/read.js';
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

// Audit DATA-3, 2026-11-10: gold was shown at $4,042 with no time while its feed had stood for
// three hours. Read on Base at block 56,374,564 (2026-11-12): cbBTC and WETH's oracles hold
// their feed themselves (BASE_FEED_1: BTC / USD, ETH / USD); PAXG's is a meta-oracle whose
// currentOracle() holds XAU / USD, 434 minutes old at that block, and whose backup holds PAXG / USD.
describe('the feed behind a Morpho price', () => {
  const PLAIN = '0x00000000000000000000000000000000000000b1';
  const META = '0x00000000000000000000000000000000000000b2';
  const INNER = '0x00000000000000000000000000000000000000b3';
  const BACKUP = '0x00000000000000000000000000000000000000b4';
  const BTC_FEED = '0x00000000000000000000000000000000000000c1';
  const XAU_FEED = '0x00000000000000000000000000000000000000c2';
  const ZERO = '0x0000000000000000000000000000000000000000';
  const address = (value: string) => encodeAbiParameters([{ type: 'address' }], [value as `0x${string}`]);

  /** Answers `target.function` from the table; anything not in it reverts, as on chain. */
  function chain(table: Record<string, string>, down = false): { provider: Provider; asked: string[] } {
    const asked: string[] = [];
    const provider: Provider = { label: 'fixture', client: {
      readContract: async ({ args }: { args: [any[]] }) => {
        if (down) throw new Error('provider is down');
        return args[0].map((call) => {
          const { functionName } = decodeFunctionData({ abi: morphoOracleFeedAbi, data: call.callData });
          const key = `${String(call.target).toLowerCase()}.${functionName}`;
          asked.push(key);
          return key in table ? { success: true, returnData: address(table[key]!) } : { success: false, returnData: '0x' };
        });
      },
    } as unknown as PublicClient };
    return { provider, asked };
  }
  const market = (id: 'cbBTC' | 'ETH' | 'PAXG', oracle: string): MorphoUniverse => {
    const asset = CRYPTO.find((entry) => entry.id === id)!;
    return { ok: true, market: { asset, id: asset.morphoMarket, params: { loanToken: ADDRESSES.usdc, collateralToken: asset.token, oracle: oracle as `0x${string}`, irm: ZERO, lltv: 860_000_000_000_000_000n } } };
  };

  it('an oracle that holds its feed names it, and a meta-oracle names it through the oracle it reads now', async () => {
    const f = chain({
      [`${PLAIN}.BASE_FEED_1`]: BTC_FEED,
      [`${META}.currentOracle`]: INNER,
      [`${INNER}.BASE_FEED_1`]: XAU_FEED,
    });
    const feeds = await loadMorphoPriceFeeds([f.provider], [market('cbBTC', PLAIN), market('PAXG', META)]);
    // Addresses come back as the chain's answer decodes: checksummed.
    assert.deepEqual(feeds.get('cbBTC'), { feed: getAddress(BTC_FEED), through: null });
    assert.deepEqual(feeds.get('PAXG'), { feed: getAddress(XAU_FEED), through: getAddress(INNER) });
    // The oracle behind a meta-oracle is asked once, and nothing is asked of a plain oracle twice.
    assert.deepEqual(f.asked.filter((key) => key.startsWith(INNER)), [`${INNER}.BASE_FEED_1`]);
  });

  it('a market that could not be read, an oracle that names nothing and a zero feed have no entry', async () => {
    const f = chain({ [`${PLAIN}.BASE_FEED_1`]: ZERO, [`${META}.currentOracle`]: INNER });
    const unreadable: MorphoUniverse = { ok: false, asset: CRYPTO[1]!, problem: 'unreadable' };
    const feeds = await loadMorphoPriceFeeds([f.provider], [market('cbBTC', PLAIN), unreadable, market('PAXG', META)]);
    assert.equal(feeds.size, 0);
  });

  it('a provider that fails leaves the prices without a time and fails nothing else', async () => {
    const f = chain({}, true);
    const feeds = await loadMorphoPriceFeeds([f.provider], [market('cbBTC', PLAIN)]);
    assert.equal(feeds.size, 0);
  });

  it('the feed\'s time is the price\'s only while the oracle still reads that feed', () => {
    const round = { ok: true as const, value: [1n, 398_150_000_000n, 1_794_000_000n, 1_794_000_073n, 1n] as const };
    const reverted = { ok: false as const, reason: 'reverted' as const };
    assert.deepEqual(morphoPriceUpdatedAt({ round, through: null, current: null }), { ok: true, value: 1_794_000_073n });
    assert.deepEqual(
      morphoPriceUpdatedAt({ round, through: INNER, current: { ok: true, value: INNER.toUpperCase().replace('0X', '0x') as `0x${string}` } }),
      { ok: true, value: 1_794_000_073n },
    );
    // The meta-oracle moved to its backup: the first feed's clock is no longer the price's.
    assert.equal(morphoPriceUpdatedAt({ round, through: INNER, current: { ok: true, value: BACKUP } }).ok, false);
    assert.equal(morphoPriceUpdatedAt({ round, through: INNER, current: reverted }).ok, false);
    assert.equal(morphoPriceUpdatedAt({ round, through: INNER, current: null }).ok, false);
    assert.equal(morphoPriceUpdatedAt({ round: reverted, through: null, current: null }).ok, false);
    assert.equal(morphoPriceUpdatedAt({ round: null, through: null, current: null }).ok, false);
  });
});
