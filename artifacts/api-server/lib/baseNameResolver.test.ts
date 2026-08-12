import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  baseNameResolverRuntimeV1,
  ethereumMainnetRpcUrlV1,
  resolveBaseNameV1,
} from './baseNameResolver.js';

const original = { ...baseNameResolverRuntimeV1 };
const ADDRESS = '0x2222222222222222222222222222222222222222' as const;

afterEach(() => Object.assign(baseNameResolverRuntimeV1, original));

test('the L1 resolver URL is derived only from reviewed private Base RPC hosts', () => {
  assert.equal(
    new URL(ethereumMainnetRpcUrlV1({
      BASE_MAINNET_RPC_URL: 'https://base-mainnet.infura.io/v3/project-key',
    } as NodeJS.ProcessEnv)!).hostname,
    'mainnet.infura.io',
  );
  assert.equal(
    new URL(ethereumMainnetRpcUrlV1({
      BASE_RPC_URL: 'https://base-mainnet.g.alchemy.com/v2/project-key',
    } as NodeJS.ProcessEnv)!).hostname,
    'eth-mainnet.g.alchemy.com',
  );
  assert.equal(ethereumMainnetRpcUrlV1({ BASE_MAINNET_RPC_URL: 'https://unknown.example/key' } as NodeJS.ProcessEnv), null);
});

test('Basename resolution uses the Base coin type lookup and returns a checksum address', async () => {
  let lookedUpName = '';
  baseNameResolverRuntimeV1.rpcUrl = () => 'https://eth-mainnet.example.invalid/key';
  baseNameResolverRuntimeV1.lookup = async (_rpcUrl, name) => {
    lookedUpName = name;
    return ADDRESS;
  };
  const result = await resolveBaseNameV1('Mioku.base.eth');
  assert.equal(result.outcome, 'resolved');
  assert.equal(lookedUpName, 'mioku.base.eth');
  if (result.outcome === 'resolved') assert.equal(result.address.toLowerCase(), ADDRESS);
});

test('an unresolved or unavailable Basename never falls back to a guessed address', async () => {
  baseNameResolverRuntimeV1.rpcUrl = () => 'https://eth-mainnet.example.invalid/key';
  baseNameResolverRuntimeV1.lookup = async () => null;
  assert.equal((await resolveBaseNameV1('missing.base.eth')).outcome, 'unresolved');
  baseNameResolverRuntimeV1.lookup = async () => { throw new Error('rpc down'); };
  assert.equal((await resolveBaseNameV1('mioku.base.eth')).outcome, 'unavailable');
});

test('the resolver rejects non-Basename ENS names before RPC', async () => {
  let called = false;
  baseNameResolverRuntimeV1.rpcUrl = () => 'https://eth-mainnet.example.invalid/key';
  baseNameResolverRuntimeV1.lookup = async () => { called = true; return ADDRESS; };
  assert.equal((await resolveBaseNameV1('alice.eth')).outcome, 'invalid');
  assert.equal(called, false);
});
