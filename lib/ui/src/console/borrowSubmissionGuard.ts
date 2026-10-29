// A wallet timeout is not evidence that the request was never submitted. Keep
// the attempt across reloads in this browser session; never put a signed draft,
// account address, calldata, clearance or cookie in browser storage.
export const BORROW_SUBMISSION_PREFIX_V1 = 'miorail:borrow-attempt:v1:';
export type BorrowSubmissionMarkerV1 = 'pending' | 'submitted' | 'unknown';
export interface BorrowSubmissionStorageV1 {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export async function borrowSubmissionKeyV1(draft: string, wallet: string | null | undefined): Promise<string | null> {
  if (!wallet || !/^0x[0-9a-f]{40}$/i.test(wallet)) return null;
  const bytes = new TextEncoder().encode(`borrow-attempt/v1\0${wallet.toLowerCase()}\0${draft}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return BORROW_SUBMISSION_PREFIX_V1 + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function borrowSubmissionMarkerV1(storage: BorrowSubmissionStorageV1, key: string): BorrowSubmissionMarkerV1 | null {
  const value = storage.getItem(key);
  // A damaged or unrecognised marker must not silently authorise another draw.
  return value === null ? null : value === 'submitted' || value === 'pending' ? value : 'unknown';
}

/** Wagmi/viem can wrap EIP-1193's explicit rejection in several cause objects.
 * Transport errors and disconnected-provider errors can arrive after sending;
 * unlike code 4001, they do not prove that nothing was submitted. */
export function borrowUserRejectedV1(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    const record = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (record.code === 4001 || record.name === 'UserRejectedRequestError') return true;
    current = record.cause;
  }
  return false;
}

export function borrowSubmissionLockCopyV1(marker: BorrowSubmissionMarkerV1): string {
  return marker === 'submitted'
    ? 'This review was already submitted from your wallet. Check its activity for the result. Miorail will not send it again.'
    : 'A wallet submission was attempted for this review. Its outcome is not confirmed here. Check your wallet activity; Miorail will not send it again.';
}

export class BorrowSubmissionLockedErrorV1 extends Error {
  readonly marker: BorrowSubmissionMarkerV1;
  constructor(marker: BorrowSubmissionMarkerV1) {
    super(borrowSubmissionLockCopyV1(marker));
    this.marker = marker;
  }
}
export class BorrowSubmissionStorageErrorV1 extends Error {
  constructor() { super('Miorail could not preserve this review’s submission state in this browser session. Your wallet was not asked. Restore browser storage before trying again.'); }
}

/** The marker is acquired BEFORE entering the wallet boundary. No id, no
 * response or an unknown error after SDK entry all retain it. A definitive
 * rejection or a host-proven failure before SDK entry can clear the local
 * marker; an already armed server attempt remains independently locked. */
export async function submitBorrowOnceV1(input: {
  key: string;
  storage: BorrowSubmissionStorageV1;
  send: () => Promise<string | null>;
  /** A host with a separate server-arm step can prove that SDK entry never
   * happened. A server-side attempt, if recorded, still blocks the next read. */
  enteredWallet?: () => boolean;
}): Promise<string | null> {
  try {
    const marker = borrowSubmissionMarkerV1(input.storage, input.key);
    if (marker) throw new BorrowSubmissionLockedErrorV1(marker);
    input.storage.setItem(input.key, 'pending');
    if (input.storage.getItem(input.key) !== 'pending') throw new BorrowSubmissionStorageErrorV1();
  } catch (error) {
    if (error instanceof BorrowSubmissionLockedErrorV1) throw error;
    throw new BorrowSubmissionStorageErrorV1();
  }
  try {
    const id = await input.send();
    try { input.storage.setItem(input.key, id ? 'submitted' : 'unknown'); } catch { /* pending already blocks retry */ }
    return id;
  } catch (error) {
    try {
      if (borrowUserRejectedV1(error) || input.enteredWallet?.() === false) input.storage.removeItem(input.key);
      else input.storage.setItem(input.key, 'unknown');
    } catch { /* a retained pending marker remains conservative */ }
    throw error;
  }
}
