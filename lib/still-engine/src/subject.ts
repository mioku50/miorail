// Whose wallet: an address, a Basename or an ENS name, exactly as the person typed it.
//
// Names resolve through ENS on Ethereum with the Base coin type (ENSIP-19, the universal
// resolver follows Basenames' offchain lookup). A primary name is read on Base, from ENS's
// L2 reverse registrar and then Basenames' own resolver, and is shown only when it resolves
// forward to the same address.

import { ccipRequest, createPublicClient, getAddress, http, isAddress, namehash, parseAbi, type Address, type CcipRequestParameters, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize, toCoinType } from 'viem/ens';
import { ADDRESSES, BASE_CHAIN_ID } from './registry.js';
import { Batch, type Provider } from './rpc.js';

export type ParsedSubject =
  | { kind: 'address'; input: string; address: Address }
  | { kind: 'name'; input: string; name: string }
  | { kind: 'invalid'; input: string; reason: 'empty' | 'bad_checksum' | 'not_an_address_or_name' };

const LABEL = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

export function parseSubject(raw: string): ParsedSubject {
  const input = raw.trim();
  if (!input) return { kind: 'invalid', input, reason: 'empty' };
  if (/^0x[0-9a-fA-F]{40}$/.test(input)) {
    // Mixed case is a checksum claim; a wrong one is a typo, never silently fixed.
    if (!isAddress(input, { strict: true })) return { kind: 'invalid', input, reason: 'bad_checksum' };
    return { kind: 'address', input, address: getAddress(input) };
  }
  // Hex after 0x was meant as an address, never as a name.
  if (/^0x[0-9a-fA-F]*$/i.test(input)) return { kind: 'invalid', input, reason: 'not_an_address_or_name' };
  let name = input.toLowerCase();
  if (name.startsWith('@')) name = name.slice(1);
  if (!name.includes('.') && LABEL.test(name)) name = `${name}.base.eth`;
  else if (name.endsWith('.base')) name = `${name}.eth`;
  try {
    name = normalize(name);
  } catch {
    return { kind: 'invalid', input, reason: 'not_an_address_or_name' };
  }
  if (!/^[^.]+(\.[^.]+)+$/.test(name) || name.length > 255) return { kind: 'invalid', input, reason: 'not_an_address_or_name' };
  return { kind: 'name', input, name };
}

/** How a name is shown: Basenames without the ".eth" people do not type. */
export function displayName(name: string): string {
  return name.endsWith('.base.eth') ? name.slice(0, -'.eth'.length) : name;
}

export type Resolution =
  | { ok: true; address: Address; name: string | null }
  | { ok: false; reason: 'unresolved' | 'resolver_unavailable' | 'resolver_not_configured' };

export interface Names {
  address(name: string): Promise<Address | null>;
  name(address: Address): Promise<string | null>;
}

/**
 * Offchain lookups (CCIP-read) are followed only to gateways we reviewed. A resolver can name any
 * URL, so following every one would let anyone who registers a name make this server fetch
 * internal addresses. Basenames answer from api.coinbase.com (seen on 2026-10-25).
 */
export const CCIP_GATEWAYS = new Set(['api.coinbase.com']);

export async function reviewedGatewaysOnly(params: CcipRequestParameters) {
  for (const template of params.urls) {
    let url: URL;
    try {
      url = new URL(template.replace('{sender}', 'sender').replace('{data}', 'data'));
    } catch {
      throw new Error('offchain lookup refused: not a URL');
    }
    if (url.protocol !== 'https:' || !CCIP_GATEWAYS.has(url.hostname)) throw new Error('offchain lookup refused: gateway not reviewed');
  }
  return ccipRequest(params);
}

const reverseAbi = parseAbi([
  'function nameForAddr(address addr) view returns (string)',
  'function name(bytes32 node) view returns (string)',
]);

export function createNames(ethereumRpcUrl: string | undefined, baseProviders: readonly Provider[], userAgent = 'still/0.1'): Names | null {
  if (!ethereumRpcUrl) return null;
  const client = createPublicClient({
    chain: mainnet,
    transport: http(ethereumRpcUrl, { retryCount: 1, timeout: 8_000, fetchOptions: { headers: { 'user-agent': userAgent } } }),
    ccipRead: { request: reviewedGatewaysOnly },
  }) as PublicClient;
  const coinType = toCoinType(BASE_CHAIN_ID);
  // Not strict: a name with no resolver or no Base address answers null, while a transport
  // failure still throws, so "no such name" and "we could not ask" stay apart.
  return {
    address: async (name) => {
      const address = await client.getEnsAddress({ name, coinType });
      return address ? getAddress(address) : null;
    },
    name: async (address) => {
      const batch = new Batch();
      const ens = batch.add(ADDRESSES.ensL2ReverseRegistrar, reverseAbi, 'nameForAddr', [address]);
      const node = namehash(`${address.slice(2).toLowerCase()}.${(0x80000000 | BASE_CHAIN_ID).toString(16)}.reverse`);
      const basenames = batch.add(ADDRESSES.basenamesL2Resolver, reverseAbi, 'name', [node]);
      await batch.run(baseProviders);
      for (const slot of [ens, basenames]) {
        if (slot.outcome.ok && slot.outcome.value) return slot.outcome.value;
      }
      return null;
    },
  };
}

export async function resolveSubject(subject: Exclude<ParsedSubject, { kind: 'invalid' }>, names: Names | null): Promise<Resolution> {
  if (subject.kind === 'address') {
    // The display name is a nicety: if the lookup fails, the address alone is still the answer.
    if (!names) return { ok: true, address: subject.address, name: null };
    try {
      const primary = await names.name(subject.address);
      if (!primary) return { ok: true, address: subject.address, name: null };
      const forward = await names.address(primary);
      const verified = forward !== null && forward === subject.address;
      return { ok: true, address: subject.address, name: verified ? displayName(primary) : null };
    } catch {
      return { ok: true, address: subject.address, name: null };
    }
  }
  if (!names) return { ok: false, reason: 'resolver_not_configured' };
  try {
    const address = await names.address(subject.name);
    if (!address) return { ok: false, reason: 'unresolved' };
    return { ok: true, address, name: displayName(subject.name) };
  } catch {
    return { ok: false, reason: 'resolver_unavailable' };
  }
}
