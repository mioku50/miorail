import type { BaseCall } from './baseGuards.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const MARKER = '80218021802180218021802180218021';
const MAX128 = '0'.repeat(32) + 'f'.repeat(32);
/** This shape guard supplements the vertical's pinned-block factory, pool,
 * ownership and gauge reads. It does not claim to verify an address by name. */
export function validateAerodromeClaimCallsV1(wallet: string, calls: readonly BaseCall[]): void {
  if (!ADDRESS.test(wallet) || /^0x0{40}$/u.test(wallet) || !calls.length || calls.length > 20) throw new Error('aerodrome_claim_invalid');
  const walletWord = '0'.repeat(24) + wallet.slice(2).toLowerCase();
  for (const call of calls) {
    if (!ADDRESS.test(call.to) || /^0x0{40}$/u.test(call.to) || call.value !== '0'
      || !/^0x(?:[0-9a-fA-F]{2})+$/u.test(call.data ?? '')) throw new Error('aerodrome_claim_invalid');
    let data = call.data!.toLowerCase();
    if (data.endsWith(MARKER)) {
      const end = data.length - MARKER.length;
      const size = Number.parseInt(data.slice(end - 4, end - 2), 16);
      const start = end - 4 - size * 2;
      const code = data.slice(start, end - 4).match(/../gu)?.map(byte => String.fromCharCode(Number.parseInt(byte, 16))).join('');
      if (data.slice(end - 2, end) !== '00' || size < 1 || size > 32 || start < 10 || !/^[a-z0-9_]+$/u.test(code ?? '')) {
        throw new Error('aerodrome_claim_suffix_invalid');
      }
      data = data.slice(0, start);
    }
    const selector = data.slice(0, 10);
    const body = data.slice(10);
    if (selector === '0xd294f093' && body.length === 0) continue;
    if (selector === '0xc00007b0' && body === walletWord) continue;
    if (selector === '0x1c4b774b' && body.length === 64 && BigInt(`0x${body}`) > 0n) continue;
    if (selector === '0xfc6f7865' && body.length === 256 && BigInt(`0x${body.slice(0, 64)}`) > 0n
      && body.slice(64, 128) === walletWord && body.slice(128, 192) === MAX128 && body.slice(192) === MAX128) continue;
    throw new Error('aerodrome_claim_calldata_refused');
  }
}
