import type { BaseCall } from './baseGuards.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

/**
 * The closed shape of a person's ETH send: exactly one call, a positive
 * amount of wei as a decimal string, to one other non-zero address, with no
 * calldata. A call that carries data is a contract interaction, not a send,
 * and is refused here whatever it encodes. The amount and the recipient are
 * the vertical's typed intent; this checks only that nothing else rides along.
 */
export function validateNativeSendCallsV1(wallet: string, calls: readonly BaseCall[]): void {
  if (!ADDRESS.test(wallet) || /^0x0{40}$/u.test(wallet) || calls.length !== 1) throw new Error('native_send_invalid');
  const [call] = calls;
  if (!ADDRESS.test(call!.to) || /^0x0{40}$/u.test(call!.to) || call!.to.toLowerCase() === wallet.toLowerCase()) {
    throw new Error('native_send_recipient_invalid');
  }
  if (!/^[1-9][0-9]*$/u.test(call!.value ?? '')) throw new Error('native_send_value_invalid');
  if ((call!.data ?? '0x') !== '0x') throw new Error('native_send_calldata_refused');
}
