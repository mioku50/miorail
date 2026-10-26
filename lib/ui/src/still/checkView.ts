import type { MirrorReport } from '@mioagent/still-engine/report';

// ---------------------------------------------------------------------------
// The public check's answers, in words. Every outcome the server gives has a
// sentence: a refusal says what to change, and our own failure says it is
// ours, never a fact about the wallet or the name.
// ---------------------------------------------------------------------------

export type StillCheckOutcomeV1 =
  | { outcome: 'report'; report: MirrorReport }
  | { outcome: 'invalid_subject'; reason: 'empty' | 'bad_checksum' | 'not_an_address_or_name' }
  | { outcome: 'name_not_found'; name: string }
  | { outcome: 'names_unavailable'; name: string }
  | { outcome: 'chain_unavailable' }
  | { outcome: 'rate_limited' }
  | { outcome: 'internal_error' };

/** Null for a report: the numbers speak. */
export function stillCheckMessageV1(answer: StillCheckOutcomeV1): string | null {
  switch (answer.outcome) {
    case 'report':
      return null;
    case 'invalid_subject':
      if (answer.reason === 'bad_checksum') return 'That address has a typo: its capital letters do not check out. Paste it again.';
      if (answer.reason === 'empty') return 'Type a Base address or a name.';
      return 'That is not a Base address (0x…) or a name like name.base.eth.';
    case 'name_not_found':
      return `${answer.name} does not point to a wallet.`;
    case 'names_unavailable':
      return 'Names could not be looked up just now. This is our failure; the wallet’s 0x address works.';
    case 'chain_unavailable':
      return 'Base could not be read just now. This is our failure, not a fact about the wallet. Try again in a minute.';
    case 'rate_limited':
      return 'Too many checks from this connection in a minute. Try again shortly.';
    case 'internal_error':
      return 'The check failed on our side. Try again in a minute.';
  }
}
