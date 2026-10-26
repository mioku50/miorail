import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Address } from 'viem';
import { displayName, parseSubject, resolveSubject, reviewedGatewaysOnly, type Names } from '../src/subject.js';
import { assertMatches } from './matches.js';

const ADDRESS = '0x7e57aB1E7E57AB1e7E57aB1E7e57Ab1e7e57aB1e' as Address;

describe('parsing what the person typed', () => {
  it('accepts an address in lowercase or with a correct checksum, and refuses a wrong checksum', () => {
    assert.deepEqual(parseSubject(` ${ADDRESS.toLowerCase()} `), { kind: 'address', input: ADDRESS.toLowerCase(), address: ADDRESS });
    assertMatches(parseSubject(ADDRESS), { kind: 'address', address: ADDRESS });
    assertMatches(parseSubject('0x7E57aB1E7E57AB1e7E57aB1E7e57Ab1e7e57aB1e'), { kind: 'invalid', reason: 'bad_checksum' });
  });

  it('turns every way of writing a Basename into the full name', () => {
    for (const input of ['alex', 'alex.base', 'alex.base.eth', '@alex', 'ALEX.base', '  Alex.Base.Eth ']) {
      assertMatches(parseSubject(input), { kind: 'name', name: 'alex.base.eth' });
    }
    assertMatches(parseSubject('vitalik.eth'), { kind: 'name', name: 'vitalik.eth' });
    assert.equal(displayName('alex.base.eth'), 'alex.base');
    assert.equal(displayName('vitalik.eth'), 'vitalik.eth');
  });

  it('refuses what is neither', () => {
    assertMatches(parseSubject(''), { kind: 'invalid', reason: 'empty' });
    assertMatches(parseSubject('hello world'), { kind: 'invalid', reason: 'not_an_address_or_name' });
    assertMatches(parseSubject('0x1234'), { kind: 'invalid', reason: 'not_an_address_or_name' });
    assertMatches(parseSubject('.base'), { kind: 'invalid' });
  });
});

describe('resolving', () => {
  const names = (overrides: Partial<Names>): Names => ({
    address: async () => null,
    name: async () => null,
    ...overrides,
  });

  it('keeps "no such name" apart from "could not ask"', async () => {
    const parsed = { kind: 'name' as const, input: 'nobody.base', name: 'nobody.base.eth' };
    assert.deepEqual(await resolveSubject(parsed, names({})), { ok: false, reason: 'unresolved' });
    assert.deepEqual(await resolveSubject(parsed, names({ address: async () => { throw new Error('timeout'); } })), { ok: false, reason: 'resolver_unavailable' });
    assert.deepEqual(await resolveSubject(parsed, null), { ok: false, reason: 'resolver_not_configured' });
  });

  it('shows a primary name only when it resolves forward to the same address', async () => {
    const parsed = { kind: 'address' as const, input: ADDRESS, address: ADDRESS };
    const honest = names({ name: async () => 'alex.base.eth', address: async () => ADDRESS });
    assert.deepEqual(await resolveSubject(parsed, honest), { ok: true, address: ADDRESS, name: 'alex.base' });
    const claimed = names({ name: async () => 'alex.base.eth', address: async () => '0x0000000000000000000000000000000000000001' as Address });
    assert.deepEqual(await resolveSubject(parsed, claimed), { ok: true, address: ADDRESS, name: null });
    const broken = names({ name: async () => { throw new Error('down'); } });
    assert.deepEqual(await resolveSubject(parsed, broken), { ok: true, address: ADDRESS, name: null });
  });
});

describe('offchain lookups', () => {
  const lookup = (urls: string[]) => reviewedGatewaysOnly({ data: '0x', sender: '0x0000000000000000000000000000000000000001', urls });

  it('never follows a resolver to a gateway we did not review', async () => {
    for (const urls of [
      ['http://169.254.169.254/latest/meta-data/{sender}'],
      ['http://localhost:8787/api/{data}'],
      ['https://evil.example/{sender}/{data}.json'],
      ['http://api.coinbase.com/{sender}'],
      ['https://api.coinbase.com/{sender}', 'https://10.0.0.1/{data}'],
      ['not a url'],
    ]) {
      await assert.rejects(lookup(urls), /offchain lookup refused/);
    }
  });
});
