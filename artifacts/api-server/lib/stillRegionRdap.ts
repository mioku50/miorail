import { isIPv4 } from 'node:net';
import { ipv6NumberV1 } from './stillRegionTable.js';
import type { StillRegistryV1 } from './stillRegistryTable.js';

// ---------------------------------------------------------------------------
// The country a registry records for a network, asked of that registry's RDAP
// service (RFC 9083: an "ip network" carries the `country` of its record).
//
// Asked only when DB-IP places an address in the United States and a registry
// other than ARIN holds its block (stillRegion.ts): the RIPE database recorded
// the operator's Frankfurt VPN exit as in Germany (DE), where DB-IP had the
// United States. What is sent is the network, a /24 or a /48, never the
// address; the answer is kept for a day, a failure for a quarter of an hour.
// Any doubt is no answer: a timeout, a redirect away from the registries, a
// body that is not an ip network with a two-letter country.
// ---------------------------------------------------------------------------

export type StillAskedRegistryV1 = Exclude<StillRegistryV1, 'arin'>;

const RDAP_BASE_V1: Record<StillAskedRegistryV1, string> = {
  ripencc: 'https://rdap.db.ripe.net/ip/',
  apnic: 'https://rdap.apnic.net/ip/',
  lacnic: 'https://rdap.lacnic.net/rdap/ip/',
  afrinic: 'https://rdap.afrinic.net/rdap/ip/',
};
/** Where a registry may send the question on: the registries themselves, and Brazil's, to which LACNIC hands its own. */
const RDAP_HOSTS_V1 = new Set(['rdap.db.ripe.net', 'rdap.apnic.net', 'rdap.lacnic.net', 'rdap.afrinic.net', 'rdap.registro.br']);
const TIMEOUT_MS_V1 = 4_000;
const MAX_HOPS_V1 = 3;
const ANSWER_MS_V1 = 24 * 60 * 60 * 1000;
const FAILURE_MS_V1 = 15 * 60 * 1000;
const MAX_ENTRIES_V1 = 5_000;

/** The network an address is asked about by: its /24, or its /48. Null for anything else. */
export function stillRegistryNetworkOfV1(address: string): string | null {
  const bare = address.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (isIPv4(bare)) return bare.replace(/\.\d+$/, '.0');
  const value = ipv6NumberV1(bare);
  if (value === null) return null;
  const top = value >> BigInt(80);
  return `${[32, 16, 0].map((shift) => ((top >> BigInt(shift)) & BigInt(0xffff)).toString(16)).join(':')}::`;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One RDAP question about a network: the country its record names, or null. */
export async function rdapNetworkCountryV1(registry: StillAskedRegistryV1, network: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const signal = AbortSignal.timeout(TIMEOUT_MS_V1);
  let url = `${RDAP_BASE_V1[registry]}${network}`;
  for (let hop = 0; hop < MAX_HOPS_V1; hop++) {
    const response = await fetchImpl(url, { redirect: 'manual', signal,
      headers: { accept: 'application/rdap+json, application/json;q=0.9', 'user-agent': 'miorail-region/1' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return null;
      const next = new URL(location, url);
      if (next.protocol !== 'https:' || !RDAP_HOSTS_V1.has(next.hostname)) return null;
      url = next.toString();
      continue;
    }
    if (response.status !== 200) return null;
    const body: unknown = await response.json().catch(() => null);
    if (!object(body) || body.objectClassName !== 'ip network' || typeof body.country !== 'string') return null;
    const country = body.country.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(country) ? country : null;
  }
  return null;
}

interface KeptV1 { country: string | null; until: number }
const keptV1 = new Map<string, KeptV1>();
const askingV1 = new Map<string, Promise<string | null>>();

export const stillRegionRdapRuntimeV1 = {
  ask: (registry: StillAskedRegistryV1, network: string): Promise<string | null> => rdapNetworkCountryV1(registry, network),
  now: (): number => Date.now(),
};

/** The country the registry records for the network of `address`, kept a day; one question at a time per network. */
export async function stillRegistryNetworkCountryV1(registry: StillAskedRegistryV1, address: string): Promise<string | null> {
  const network = stillRegistryNetworkOfV1(address);
  if (!network) return null;
  const key = `${registry}|${network}`, now = stillRegionRdapRuntimeV1.now();
  const kept = keptV1.get(key);
  if (kept && kept.until > now) return kept.country;
  const asking = askingV1.get(key);
  if (asking) return asking;
  const question = stillRegionRdapRuntimeV1.ask(registry, network).catch(() => null).then((country) => {
    keptV1.delete(key);
    keptV1.set(key, { country, until: stillRegionRdapRuntimeV1.now() + (country ? ANSWER_MS_V1 : FAILURE_MS_V1) });
    while (keptV1.size > MAX_ENTRIES_V1) keptV1.delete(keptV1.keys().next().value!);
    askingV1.delete(key);
    return country;
  });
  askingV1.set(key, question);
  return question;
}

/** Tests only: forget every answer. */
export function resetStillRegionRdapV1(): void {
  keptV1.clear();
  askingV1.clear();
}
