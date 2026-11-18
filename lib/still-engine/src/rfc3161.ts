// ---------------------------------------------------------------------------
// RFC 3161 time-stamps, by hand: the one request Still sends, and the facts it
// reads back (audit LOOP-4, 2026-11-18).
//
// A Loop draw's list is time-stamped by public authorities the moment it is
// fixed, so anybody can see, by an authority's own signed clock, that the list
// existed before the block that picks its winners. Still sends a SHA-256 of
// the list and nothing else. The authority's signature is checked with
// openssl by whoever wants to (scripts/verify_loop_draw.ts); here are only
// the request and what a response says. Pure: the caller hashes and sends,
// and nothing here reads a clock or a network.
// ---------------------------------------------------------------------------

/** 2.16.840.1.101.3.4.2.1, SHA-256. */
const SHA256_OID_V1 = Uint8Array.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);
/** 1.2.840.113549.1.7.2, CMS SignedData. */
const SIGNED_DATA_V1 = '1.2.840.113549.1.7.2';
/** 1.2.840.113549.1.9.16.1.4, the TSTInfo a time-stamp token signs. */
const TST_INFO_V1 = '1.2.840.113549.1.9.16.1.4';
export const RFC3161_SHA256_V1 = '2.16.840.1.101.3.4.2.1';

function concatV1(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function tlvV1(tag: number, body: Uint8Array): Uint8Array {
  const n = body.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return concatV1(Uint8Array.from([tag, ...length]), body);
}

/** A positive DER INTEGER of these bytes. */
function integerV1(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = bytes.slice(start);
  return tlvV1(0x02, trimmed[0]! & 0x80 ? concatV1(Uint8Array.of(0), trimmed) : trimmed);
}

/**
 * A TimeStampReq (RFC 3161 §2.4.1) for a SHA-256 digest: version 1, the message imprint, a nonce, and the
 * authority's certificate asked for, so the token carries what checks its signature.
 */
export function rfc3161RequestV1(digest: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new RangeError('rfc3161: a SHA-256 digest is 32 bytes');
  if (nonce.length < 1 || nonce.length > 16) throw new RangeError('rfc3161: a nonce of 1 to 16 bytes');
  const algorithm = tlvV1(0x30, concatV1(SHA256_OID_V1, Uint8Array.of(0x05, 0x00)));
  const imprint = tlvV1(0x30, concatV1(algorithm, tlvV1(0x04, digest)));
  return tlvV1(0x30, concatV1(Uint8Array.of(0x02, 0x01, 0x01), imprint, integerV1(nonce), Uint8Array.of(0x01, 0x01, 0xff)));
}

interface NodeV1 {
  tag: number;
  /** The contents, without the tag and length. */
  body: Uint8Array;
}

/** The DER values one after another in `bytes`; null when they are not exactly that. */
function childrenV1(bytes: Uint8Array): NodeV1[] | null {
  const out: NodeV1[] = [];
  let at = 0;
  while (at < bytes.length) {
    const tag = bytes[at]!;
    if ((tag & 0x1f) === 0x1f) return null;
    let length = bytes[at + 1];
    if (length === undefined) return null;
    let head = 2;
    if (length & 0x80) {
      const count = length & 0x7f;
      if (count < 1 || count > 3 || at + 2 + count > bytes.length) return null;
      length = 0;
      for (let i = 0; i < count; i += 1) length = length * 256 + bytes[at + 2 + i]!;
      head = 2 + count;
    }
    if (at + head + length > bytes.length) return null;
    out.push({ tag, body: bytes.subarray(at + head, at + head + length) });
    at += head + length;
  }
  return out;
}

function oneV1(bytes: Uint8Array, tag: number): NodeV1 | null {
  const nodes = childrenV1(bytes);
  return nodes && nodes.length === 1 && nodes[0]!.tag === tag ? nodes[0]! : null;
}

function oidV1(body: Uint8Array): string {
  const parts = [Math.floor(body[0]! / 40), body[0]! % 40];
  let value = 0;
  for (const byte of body.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

const hexV1 = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** "20261128180031.25Z" as an instant; null for anything else. */
function generalizedTimeV1(body: Uint8Array): string | null {
  const text = String.fromCharCode(...body);
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,6}))?Z$/.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, fraction = ''] = match;
  const at = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}.${(fraction + '000').slice(0, 3)}Z`);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

export interface Rfc3161ReadingV1 {
  /** PKIStatus: 0 granted, 1 granted with modifications; anything else is a refusal. */
  status: number;
  /** From the signed TSTInfo, or null when the response carries no token. */
  hashOid: string | null;
  imprint: string | null;
  genTime: string | null;
  /** Hex, without leading zeros' padding; null when the token carries none. */
  nonce: string | null;
}

/** What a TimeStampResp (RFC 3161 §2.4.2) says, read from its signed TSTInfo. Null for anything that is not one. */
export function rfc3161ResponseV1(der: Uint8Array): Rfc3161ReadingV1 | null {
  const response = oneV1(der, 0x30);
  const parts = response && childrenV1(response.body);
  if (!parts || parts.length < 1 || parts[0]!.tag !== 0x30) return null;
  const status = childrenV1(parts[0]!.body)?.[0];
  if (!status || status.tag !== 0x02 || status.body.length !== 1) return null;
  const empty = { status: status.body[0]!, hashOid: null, imprint: null, genTime: null, nonce: null };
  if (parts.length < 2) return empty;
  const content = childrenV1(parts[1]!.tag === 0x30 ? parts[1]!.body : new Uint8Array());
  if (!content || content.length !== 2 || content[0]!.tag !== 0x06 || oidV1(content[0]!.body) !== SIGNED_DATA_V1 || content[1]!.tag !== 0xa0) return null;
  const signed = oneV1(content[1]!.body, 0x30);
  const fields = signed && childrenV1(signed.body);
  const encapsulated = fields?.[2];
  if (!encapsulated || encapsulated.tag !== 0x30) return null;
  const inner = childrenV1(encapsulated.body);
  if (!inner || inner.length !== 2 || inner[0]!.tag !== 0x06 || oidV1(inner[0]!.body) !== TST_INFO_V1 || inner[1]!.tag !== 0xa0) return null;
  const octets = oneV1(inner[1]!.body, 0x04);
  const info = octets && oneV1(octets.body, 0x30);
  const tst = info && childrenV1(info.body);
  // version, policy, messageImprint, serialNumber, genTime, then accuracy, ordering and nonce, each optional.
  if (!tst || tst.length < 5 || tst[2]!.tag !== 0x30 || tst[4]!.tag !== 0x18) return null;
  const imprint = childrenV1(tst[2]!.body);
  const algorithm = imprint?.[0] && imprint[0].tag === 0x30 ? childrenV1(imprint[0].body)?.[0] : undefined;
  if (!imprint || imprint.length !== 2 || imprint[1]!.tag !== 0x04 || !algorithm || algorithm.tag !== 0x06) return null;
  const nonce = tst.slice(5).find((node) => node.tag === 0x02);
  return {
    status: empty.status,
    hashOid: oidV1(algorithm.body),
    imprint: hexV1(imprint[1]!.body),
    genTime: generalizedTimeV1(tst[4]!.body),
    nonce: nonce ? hexV1(nonce.body).replace(/^(00)+(?=.)/, '') : null,
  };
}

/** Whether a response is the stamp asked for: granted, of this SHA-256 digest, with this nonce, at a readable time. */
export function rfc3161StampsV1(reading: Rfc3161ReadingV1 | null, digest: Uint8Array, nonce: Uint8Array | null = null): reading is Rfc3161ReadingV1 & { genTime: string } {
  return reading !== null && (reading.status === 0 || reading.status === 1) && reading.hashOid === RFC3161_SHA256_V1
    && reading.imprint === hexV1(digest) && reading.genTime !== null
    && (nonce === null || reading.nonce === hexV1(nonce).replace(/^(00)+(?=.)/, ''));
}
