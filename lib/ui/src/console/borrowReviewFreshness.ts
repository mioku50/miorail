export interface FreshBorrowReviewV1 {
  state?: 'ready' | 'refused';
  refusal?: string | null;
  detail?: string | null;
  calls?: { to: string; value: string; data: string }[];
  callsHash?: string;
  signingTermsHash?: string;
  expiresAt?: string;
}

const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
type SignableBorrowReviewV1 = FreshBorrowReviewV1 & {
  state: 'ready'; callsHash: string; signingTermsHash: string; expiresAt: string;
  calls: NonNullable<FreshBorrowReviewV1['calls']>;
};
export function hasBorrowSigningTermsV1(body: FreshBorrowReviewV1 | null, maxCalls = 4): body is SignableBorrowReviewV1 {
  return body?.state === 'ready' && hash(body.callsHash) && hash(body.signingTermsHash) &&
    typeof body.expiresAt === 'string' && Number.isFinite(Date.parse(body.expiresAt)) &&
    Number.isSafeInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 8 &&
    Array.isArray(body.calls) && body.calls.length > 0 && body.calls.length <= maxCalls && body.calls.every((call) =>
      call !== null && typeof call === 'object' && typeof call.to === 'string' && typeof call.data === 'string' && typeof call.value === 'string' &&
      /^0x[0-9a-f]{40}$/i.test(call.to) && /^0x(?:[0-9a-f]{2}){4,}$/i.test(call.data) && /^(0|[1-9][0-9]*)$/.test(call.value));
}

export type BorrowHandoffV1 =
  | { state: 'submitted'; batchId: string | null }
  | { state: 'review_changed'; termsHash: string; message: string }
  | { state: 'refused'; message: string };

/** First click re-measures. If anything changed, the next explicit click may
 * accept THAT exact fresh review inside its server-owned expiry. Re-preparing
 * on that second click would create an endless loop as interest/deadlines age. */
export async function handOffFreshBorrowV1(input: {
  seen: FreshBorrowReviewV1 | null;
  confirmedTermsHash: string | null;
  refresh: () => Promise<FreshBorrowReviewV1>;
  send: (calls: NonNullable<FreshBorrowReviewV1['calls']>) => Promise<string | null>;
  current: () => boolean;
  now?: () => number;
  maxCalls?: number;
}): Promise<BorrowHandoffV1> {
  const now = input.now ?? Date.now;
  let fresh = input.seen;
  const armed = hasBorrowSigningTermsV1(fresh, input.maxCalls) && input.confirmedTermsHash === fresh.signingTermsHash && Date.parse(fresh.expiresAt) > now();
  if (!armed) fresh = await input.refresh();
  if (!input.current()) return { state: 'refused', message: 'The wallet or review changed. Open the review again.' };
  if (fresh?.state === 'refused') return { state: 'refused', message: fresh.detail || 'The server refused this fresh review. Nothing was sent.' };
  if (!hasBorrowSigningTermsV1(fresh, input.maxCalls)) return { state: 'refused', message: 'This response did not establish fresh signing terms. Nothing was sent.' };
  if (Date.parse(fresh.expiresAt) <= now()) return { state: 'refused', message: 'This preparation expired. Measure again before opening your wallet.' };
  if (!armed && (input.seen?.signingTermsHash !== fresh.signingTermsHash || input.seen?.callsHash !== fresh.callsHash)) {
    return { state: 'review_changed', termsHash: fresh.signingTermsHash, message: 'The terms changed. Read the updated review, then open your wallet again to accept these exact terms.' };
  }
  // No cached calls cross this boundary: it is either the fresh server result
  // or the fresh changed review the person explicitly accepted next.
  return { state: 'submitted', batchId: await input.send(fresh.calls) };
}
