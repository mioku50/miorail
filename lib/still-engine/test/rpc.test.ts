import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeAbiParameters, getAddress, type PublicClient } from 'viem';
import { erc20Abi } from '../src/abi.js';
import { ADDRESSES, ASSETS } from '../src/registry.js';
import { Batch, ChainUnavailable, classifyFailure, providerLabel, type Provider } from '../src/rpc.js';
import { assertMatches } from './matches.js';

type Result = { success: boolean; returnData: `0x${string}` };

function provider(label: string, answer: (calls: unknown[]) => Result[] | Error): Provider & { asked: number } {
  const p = {
    label,
    asked: 0,
    client: {
      readContract: async ({ args }: { args: [unknown[]] }) => {
        p.asked += 1;
        const result = answer(args[0]);
        if (result instanceof Error) throw result;
        return result;
      },
    } as unknown as PublicClient,
  };
  return p;
}

const uint = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n]);
const throttled = Object.assign(new Error('HTTP request failed'), { status: 429 });

describe('one-block batches', () => {
  it('maps each call to its own outcome: value, revert or a shape we could not decode', async () => {
    const batch = new Batch();
    const a = batch.add(ADDRESSES.usdc, erc20Abi, 'balanceOf', [ADDRESSES.usdc]);
    const b = batch.add(ADDRESSES.usdc, erc20Abi, 'balanceOf', [ADDRESSES.usdc]);
    const c = batch.add(ADDRESSES.usdc, erc20Abi, 'balanceOf', [ADDRESSES.usdc]);
    const p = provider('alchemy', () => [
      { success: true, returnData: uint(42n) },
      { success: false, returnData: '0x' },
      { success: true, returnData: '0x1234' },
    ]);
    assert.deepEqual(await batch.run([p]), { provider: 'alchemy' });
    assert.deepEqual(a.outcome, { ok: true, value: 42n });
    assert.deepEqual(b.outcome, { ok: false, reason: 'reverted' });
    assert.deepEqual(c.outcome, { ok: false, reason: 'undecodable' });
  });

  it('asks the fallback once when the primary throttles', async () => {
    const batch = new Batch();
    const a = batch.add(ADDRESSES.usdc, erc20Abi, 'balanceOf', [ADDRESSES.usdc]);
    const primary = provider('alchemy', () => throttled);
    const fallback = provider('infura', () => [{ success: true, returnData: uint(7n) }]);
    assert.deepEqual(await batch.run([primary, fallback]), { provider: 'infura' });
    assert.deepEqual(a.outcome, { ok: true, value: 7n });
    assert.deepEqual([primary.asked, fallback.asked], [1, 1]);
  });

  it('throws ChainUnavailable naming every attempt when nobody answers, and leaves outcomes failed', async () => {
    const batch = new Batch();
    const a = batch.add(ADDRESSES.usdc, erc20Abi, 'balanceOf', [ADDRESSES.usdc]);
    const run = batch.run([provider('alchemy', () => throttled), provider('infura', () => new Error('fetch failed'))]);
    await assert.rejects(run, ChainUnavailable);
    await assert.rejects(run, (error) => {
      assertMatches(error, { attempts: [{ provider: 'alchemy', kind: 'throttled' }, { provider: 'infura', kind: 'unavailable' }] });
      return true;
    });
    assert.equal(a.outcome.ok, false);
  });
});

describe('failure taxonomy', () => {
  it('reads status and JSON-RPC codes before wording', () => {
    assert.equal(classifyFailure(throttled), 'throttled');
    assert.equal(classifyFailure({ cause: { code: -32005, message: 'project ID request rate exceeded' } }), 'throttled');
    assert.equal(classifyFailure({ cause: { code: 429, message: 'Request failed' } }), 'throttled');
    assert.equal(classifyFailure({ code: -32007, message: '25/second request limit reached' }), 'throttled');
    assert.equal(classifyFailure({ status: 402, message: 'daily credit cap' }), 'rejected');
    assert.equal(classifyFailure({ status: 403, message: 'forbidden' }), 'rejected');
    assert.equal(classifyFailure(new Error('The request took too long to respond.')), 'unavailable');
  });

  it('labels a provider by its host and never repeats the URL', () => {
    assert.equal(providerLabel('https://base-mainnet.g.alchemy.com/v2/SECRET'), 'alchemy');
    assert.equal(providerLabel('https://base-mainnet.infura.io/v3/SECRET'), 'infura');
    assert.equal(providerLabel('https://mainnet.base.org'), 'base-public');
    assert.equal(providerLabel('not a url'), 'invalid-url');
    assert.doesNotMatch(new ChainUnavailable([{ provider: 'alchemy', kind: 'throttled' }]).message, /SECRET|https?:/);
  });
});

describe('registry', () => {
  it('writes every address with its checksum, so a typo cannot pass as a case difference', () => {
    for (const address of [...Object.values(ADDRESSES), ...ASSETS.map((a) => a.token)]) {
      assert.equal(getAddress(address), address);
    }
  });

  it('keys stocks by ISIN-shaped identifiers and unique tokens', () => {
    const stocks = ASSETS.filter((a) => a.kind === 'stock');
    assert.equal(new Set(stocks.map((s) => s.token.toLowerCase())).size, stocks.length);
    for (const s of stocks) assert.match(s.isin, /^US[0-9A-Z]{9}[0-9]$/);
  });
});
