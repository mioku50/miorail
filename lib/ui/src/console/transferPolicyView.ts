// ---------------------------------------------------------------------------
// The token's own transfer rules, in the reader's words.
//
// The chain answer is three verdicts about two different addresses plus a pause
// flag on the contract. That is the right shape to STORE and the wrong shape to
// read: "transfer_sender = authorized, policy id 5, blocklist" is a sentence
// about our data model, and the person looking at it wants to know whether they
// can move their own money.
//
// So the split this module exists to hold:
//
//   Evidence speaks the language of the system.  UI speaks the language of the
//   question. Nothing here invents a fact — every line is one verdict, said
//   once, in words somebody who has never read a B20 spec can act on.
//
// The projection lives here rather than in `b20-control` because that package
// reads chains and this is the only place the product keeps consumer copy. It
// used to be written out twice, once in the domain and once inline in the
// review page, which is how two surfaces come to word the same verdict
// differently.
// ---------------------------------------------------------------------------

/** The wire shape the API sends. Kept structurally, not imported: the console
 * must not take a dependency on a chain-reading package to render a sentence. */
export interface TransferPolicyWireV1 {
  executor?: string | null;
  transferPause?: { state?: string | null; reason?: string | null } | null;
  scopes?: readonly {
    scope?: string;
    subject?: string;
    account?: string | null;
    verdict?: string;
    policyId?: string | null;
    reason?: string | null;
  }[];
}

export interface TransferPolicyLineV1 {
  text: string;
  tone: 'good' | 'warn' | 'off' | 'neutral';
}

export interface TransferPolicyViewV1 {
  /** The section heading. The one place the word "policy" is kept on this
   * surface: it names WHOSE rules these are, and "Onchain" says where they were
   * read. Every line beneath it is plain language. */
  title: 'Onchain transfer policy';
  lines: readonly TransferPolicyLineV1[];
  /** The strongest thing established across every scope, for a caller that
   * needs one word. Never `authorized` unless every scope answered so. */
  verdict: 'authorized' | 'denied' | 'not_established';
}

const SEND_RECEIVE_COPY_V1: Readonly<
  Record<'transfer_sender' | 'transfer_receiver', Record<'authorized' | 'denied', string>>
> = {
  transfer_sender: {
    authorized: 'Your wallet can send this token.',
    denied: 'Your wallet cannot send this token right now.',
  },
  transfer_receiver: {
    authorized: 'Your wallet can receive this token.',
    denied: 'Your wallet cannot receive this token right now.',
  },
};

const NOT_CONFIRMED_COPY_V1: Readonly<Record<string, string>> = {
  transfer_sender: 'Sending status not confirmed.',
  transfer_receiver: 'Receiving status not confirmed.',
  transfer_executor: 'Not confirmed which app would move the token, so its permission was not checked.',
};

/**
 * Three verdicts and a pause flag, as lines somebody can act on.
 *
 * Returns null when there is nothing established AND nothing to warn about —
 * a surface with no verdict must render nothing, because "no restriction
 * found" and "we did not look" are the two states this product exists to keep
 * apart, and an empty box says neither.
 */
export function transferPolicyViewV1(
  wire: TransferPolicyWireV1 | null | undefined,
): TransferPolicyViewV1 | null {
  const scopes = wire?.scopes ?? [];
  if (scopes.length === 0) return null;
  const lines: TransferPolicyLineV1[] = [];

  // A pause denies everyone at once, so it goes first and it is the only line
  // that can make the per-address verdicts beside the point.
  const pause = wire?.transferPause?.state ?? null;
  if (pause === 'paused') {
    lines.push({
      text: 'Transfers of this token are paused on the contract right now, for everyone.',
      tone: 'off',
    });
  } else if (pause === 'not_established') {
    lines.push({ text: 'Whether transfers are paused was not confirmed.', tone: 'neutral' });
  }

  for (const scope of scopes) {
    const name = scope.scope ?? '';
    const verdict = scope.verdict ?? '';
    if (name === 'transfer_sender' || name === 'transfer_receiver') {
      if (verdict === 'authorized' || verdict === 'denied') {
        lines.push({
          text: SEND_RECEIVE_COPY_V1[name][verdict],
          tone: verdict === 'authorized' ? 'good' : 'off',
        });
        continue;
      }
    } else if (name === 'transfer_executor') {
      if (verdict === 'authorized') {
        lines.push({ text: 'The app that would move the token is allowed to.', tone: 'good' });
        continue;
      }
      if (verdict === 'denied') {
        lines.push({
          // Names the party the rule is actually about. A reader told "you are
          // blocked" when the refusal belongs to a router would go looking for
          // a problem with their own account that does not exist.
          text: 'The app that would move this token is not allowed to move it. That is about that app, not about your wallet.',
          tone: 'off',
        });
        continue;
      }
    } else {
      continue;
    }
    lines.push({ text: NOT_CONFIRMED_COPY_V1[name] ?? 'Not confirmed yet.', tone: 'neutral' });
  }

  if (lines.length === 0) return null;

  const known = scopes.filter(
    (scope) => scope.scope !== undefined && scope.scope in NOT_CONFIRMED_COPY_V1,
  );
  const denied = known.some((scope) => scope.verdict === 'denied');
  const allAuthorized =
    known.length > 0 && known.every((scope) => scope.verdict === 'authorized');
  return {
    title: 'Onchain transfer policy',
    lines,
    // A pause is a denial of the same transfer, so it cannot sit under an
    // `authorized` headline.
    verdict: denied || pause === 'paused' ? 'denied' : allAuthorized ? 'authorized' : 'not_established',
  };
}

/** The one sentence that follows the lines. Fixed, because the boundary it
 * states is fixed: these are the issuer's rules for this contract, read on
 * chain, and they say nothing about the market or about any other holding. */
export const TRANSFER_POLICY_FOOTNOTE_V1 =
  "These are the issuer's rules for this exact contract, read on chain. They say nothing about the market, about what a sale would cost, or about anything else you hold.";
