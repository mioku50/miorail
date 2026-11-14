import dns from 'node:dns';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { pipeline, Readable } from 'node:stream';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// Only a public address is ever connected to (audit AUTH-5, 2026-11-14).
//
// The guard on URLs a claim file names read the host as text. IPv4 literals
// were caught, but IPv6 ones were not: [::ffff:127.0.0.1], [::ffff:169.254.
// 169.254], [::], [fe80::1] and [::127.0.0.1] all passed. And a name passed by
// definition: the fetch then connected to whatever DNS answered at that
// moment, so a public name pointed at 127.0.0.1, or flipped to it between a
// check and the connection, reached this machine's own network. HTTPS and the
// certificate check were all that stood in the way.
//
// Now an address is public only when it is in the global unicast space and in
// none of the ranges kept for other uses; a name is resolved here, refused if
// any of its addresses is not public, and the connection is made to exactly
// the addresses that were checked, on every hop.
// ---------------------------------------------------------------------------

function ipv4OctetsV1(text: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  const octets = match.slice(1).map(Number) as [number, number, number, number];
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function ipv4PublicV1([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this network, private, loopback, multicast and reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, the cloud metadata address among them
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, documentation
  if (a === 192 && b === 88 && c === 99) return false; // the retired 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** The eight groups of an IPv6 address, or null when the text is not one. */
function ipv6GroupsV1(text: string): number[] | null {
  let head = text;
  const tail: number[] = [];
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (v4) {
    const octets = ipv4OctetsV1(v4[1]!);
    if (!octets) return null;
    tail.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    head = text.slice(0, v4.index);
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string) => (part === '' ? [] : part.split(':'));
  const left = groupsOf(halves[0]!), right = halves.length === 2 ? groupsOf(halves[1]!) : [];
  if ([...left, ...right].some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const written = left.length + right.length + tail.length;
  if (halves.length === 1 ? written !== 8 : written > 7) return null;
  const zeros = Array.from({ length: 8 - written }, () => 0);
  return [...left.map((group) => parseInt(group, 16)), ...zeros, ...right.map((group) => parseInt(group, 16)), ...tail];
}

function ipv6PublicV1(groups: number[]): boolean {
  const [first, second] = groups as [number, number];
  // Global unicast is 2000::/3. Everything outside it is loopback, unspecified, IPv4-mapped or
  // -compatible, NAT64, unique local, link-local, site-local, multicast or unassigned.
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && second < 0x0200) return false; // protocol assignments, Teredo among them
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x2002) return false; // 6to4, which carries an IPv4 address inside
  if (first === 0x3fff && second < 0x1000) return false; // documentation (3fff::/20)
  return true;
}

/** Whether an IP address literal is somewhere other than the public internet. Text that is not an address is not public either. */
export function nonPublicAddressV1(address: string): boolean {
  let text = address.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone >= 0) return true; // an address scoped to an interface is on this machine's own link
  const v4 = ipv4OctetsV1(text);
  if (v4) return !ipv4PublicV1(v4);
  const v6 = text.includes(':') ? ipv6GroupsV1(text) : null;
  return v6 ? !ipv6PublicV1(v6) : true;
}

/** Whether text written as a host is an IP literal (in brackets or not), rather than a name. */
export function isAddressLiteralV1(host: string): boolean {
  const text = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return ipv4OctetsV1(text) !== null || (text.includes(':') && (ipv6GroupsV1(text.split('%')[0]!) !== null || text.includes('%')));
}

export class B20NonPublicAddressError extends Error {
  readonly code = 'ENONPUBLIC';
  constructor() {
    super('the name resolves to an address that is not public');
    this.name = 'B20NonPublicAddressError';
  }
}

type ResolveAllV1 = (hostname: string, callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;
const systemResolveV1: ResolveAllV1 = (hostname, callback) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => callback(error, addresses ?? []));
};

/** A lookup for the connection itself: the name's addresses, every one public, or no connection at all. */
export function createPublicOnlyLookupV1(resolve: ResolveAllV1 = systemResolveV1): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, (error, addresses) => {
      if (error) { callback(error, '', undefined); return; }
      // One private answer among public ones is how a rebinding name is built: any one refuses the name.
      if (addresses.length === 0 || addresses.some((entry) => nonPublicAddressV1(entry.address))) {
        callback(new B20NonPublicAddressError(), '', undefined);
        return;
      }
      const family = options.family === 4 || options.family === 6 ? options.family : null;
      const usable = family === null ? addresses : addresses.filter((entry) => entry.family === family);
      if (usable.length === 0) {
        callback(Object.assign(new Error(`no IPv${family} address`), { code: 'ENOTFOUND' }), '', undefined);
        return;
      }
      if (options.all) callback(null, usable);
      else callback(null, usable[0]!.address, usable[0]!.family);
    });
  };
}

/**
 * The fetch the B20 public context reads with: HTTPS through Node's own client, connected only to
 * addresses the lookup above checked, redirects never followed (the caller re-checks every hop), and a
 * body a server compressed anyway decoded on the way. Nothing is asked to be compressed.
 */
export function createPublicOnlyFetchV1(options: { lookup?: LookupFunction } = {}): typeof fetch {
  const lookup = options.lookup ?? createPublicOnlyLookupV1();
  return (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.protocol !== 'https:') throw new TypeError('only https is fetched');
    if (isAddressLiteralV1(url.hostname) && nonPublicAddressV1(url.hostname)) throw new B20NonPublicAddressError();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    const body = typeof init.body === 'string' ? init.body : undefined;
    if (init.body != null && body === undefined) throw new TypeError('only a text body is sent');
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    return await new Promise<Response>((resolve, reject) => {
      const request = https.request(url, { method: init.method ?? 'GET', headers, lookup, ...(init.signal ? { signal: init.signal } : {}) }, (incoming) => {
        const status = incoming.statusCode ?? 0;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const one of value) responseHeaders.append(name, one);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        if ([204, 205, 304].includes(status) || status < 200 || status > 599) {
          incoming.resume();
          if (status < 200 || status > 599) { reject(new TypeError(`unexpected status ${status}`)); return; }
          resolve(new Response(null, { status, headers: responseHeaders }));
          return;
        }
        const encoding = (incoming.headers['content-encoding'] ?? '').toString().trim().toLowerCase();
        const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip()
          : encoding === 'deflate' ? zlib.createInflate() : encoding === 'br' ? zlib.createBrotliDecompress() : null;
        // A reader that stops early closes the connection: pipeline destroys every stream with the last one.
        const stream: Readable = decoder ? pipeline(incoming, decoder, () => undefined) : incoming;
        if (decoder) { responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length'); }
        resolve(new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, statusText: incoming.statusMessage, headers: responseHeaders }));
      });
      request.on('error', reject);
      if (body !== undefined) request.write(body);
      request.end();
    });
  }) as typeof fetch;
}
