// ---------------------------------------------------------------------------
// What was checked, and what was not.
//
// Opening the pair rule means a user can now put a token nobody has heard of
// on either side of a swap. Everything Miorail can say about such a token is
// narrow and specific — an address answered `symbol()`, a provider reported
// the contract's powers, a kernel read the calldata — and none of it is the
// question a holder actually has, which is "is this a scam".
//
// A screen that shows only the checks that PASSED implies the rest were
// considered. This panel exists to say the opposite out loud. The absence list
// is fixed and unconditional: it is not derived from data, because the whole
// point is that there IS no data behind it.
// ---------------------------------------------------------------------------

export interface VerifiedFactV1 {
  label: string;
  /** What was actually read, in the terms it was read in. */
  detail: string;
  tone: 'good' | 'warn' | 'none';
}

export interface VerificationHonestyViewV1 {
  verified: VerifiedFactV1[];
  /** Plain statements of what nobody checked. Never empty. */
  notVerified: string[];
  /** One sentence framing the whole panel. */
  note: string;
}

interface AssetLikeV1 {
  kind: 'native' | 'erc20';
  address: string | null;
  symbol: string;
  decimals: number;
}

interface ContractVerdictLikeV1 {
  address: string;
  provider: string;
  status: 'ok' | 'warning' | 'high-risk' | 'unknown' | 'failed';
  summary: string | null;
}

interface ContractSecurityLikeV1 {
  provider: string;
  required: boolean;
  status: 'passed' | 'warning' | 'blocked' | 'skipped';
  verdicts: readonly ContractVerdictLikeV1[];
}

interface SafetyCheckLikeV1 {
  id: string;
  description: string;
  status: 'passed' | 'failed' | 'skipped';
  detail: string | null;
}

export interface VerificationHonestyInputV1 {
  inputAsset: AssetLikeV1 | null;
  outputAsset: AssetLikeV1 | null;
  contractSecurity: ContractSecurityLikeV1 | null;
  safetyChecks: readonly SafetyCheckLikeV1[];
  simulation: { state: string; detail?: string | null } | null;
}

/** The three assets this repo pins. An identified token is described by what
 * was READ; a canonical one by the fact that it is pinned, which is a stronger
 * statement and a different one. */
const CANONICAL_ADDRESSES_V1 = new Set([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  '0x4200000000000000000000000000000000000006',
]);

/**
 * What Miorail never looked at.
 *
 * Deliberately hard-coded and unconditional. Every line here is a question a
 * user will assume was answered because the screen looks thorough, and each
 * one names the specific thing rather than hedging.
 */
export const NOT_VERIFIED_V1: readonly string[] = [
  'How deep the pool is beyond this one quote — the size you could exit at was not measured here.',
  'Whether the liquidity is locked, or can be withdrawn by whoever provided it.',
  'How concentrated the holders are, or whether one wallet can move the price.',
  'Any price history: nothing here says the quoted price is a fair one.',
  'Who the owner is. Only what the contract PERMITS was read, not what anyone intends to do with it.',
  'Anything the project says about itself — a name, a site, a social account, a promise.',
];

function assetFact(asset: AssetLikeV1 | null, side: 'You pay' | 'You receive'): VerifiedFactV1 | null {
  if (!asset) return null;
  if (asset.kind === 'native') {
    return { label: side, detail: 'Native ETH on Base — no contract to read.', tone: 'good' };
  }
  const address = asset.address?.toLowerCase() ?? null;
  if (!address) return { label: side, detail: 'This token has no address to read.', tone: 'warn' };
  if (CANONICAL_ADDRESSES_V1.has(address)) {
    return {
      label: side,
      detail: `${address} — pinned in this build as ${asset.symbol}, not taken from the request.`,
      tone: 'good',
    };
  }
  // The address FIRST, because that is the identity. The symbol is what the
  // contract calls itself and is shown as such — two contracts can answer the
  // same name, and one of them can answer it in a different alphabet.
  return {
    label: side,
    detail: `${address} — the contract answers "${asset.symbol}" and ${asset.decimals} decimals. The address is the identity; the name is only what it says.`,
    tone: 'none',
  };
}

function securityFact(security: ContractSecurityLikeV1 | null): VerifiedFactV1[] {
  if (!security || !security.required) {
    return [
      {
        label: 'Token security',
        detail: 'Not requested for this route, so no provider was asked about these contracts.',
        tone: 'warn',
      },
    ];
  }
  if (security.verdicts.length === 0) {
    return [
      {
        label: 'Token security',
        detail: `${security.provider} returned no verdict for either side.`,
        tone: 'warn',
      },
    ];
  }
  return security.verdicts.map((verdict) => ({
    label: 'Token security',
    detail:
      verdict.summary && verdict.summary.trim().length > 0
        ? `${verdict.address} — ${verdict.provider}: ${verdict.status}. ${verdict.summary}`
        : `${verdict.address} — ${verdict.provider}: ${verdict.status}.`,
    tone: verdict.status === 'ok' ? 'good' : verdict.status === 'warning' ? 'warn' : 'warn',
  }));
}

/** The kernel checks worth naming here. The full list is its own panel; this
 * one carries the three that answer "can these bytes take something I did not
 * agree to". */
const HEADLINE_CHECK_IDS_V1 = [
  'provider_guard_uniswap',
  'provider_guard_kyberswap',
  'provider_guard_aerodrome',
  'input_amount_matches_intent',
  'recipient_is_wallet',
];

export function verificationHonestyViewV1(
  input: VerificationHonestyInputV1,
): VerificationHonestyViewV1 {
  const verified: VerifiedFactV1[] = [];
  const payFact = assetFact(input.inputAsset, 'You pay');
  const receiveFact = assetFact(input.outputAsset, 'You receive');
  if (payFact) verified.push(payFact);
  if (receiveFact) verified.push(receiveFact);
  verified.push(...securityFact(input.contractSecurity));

  const headline = input.safetyChecks.filter((check) => HEADLINE_CHECK_IDS_V1.includes(check.id));
  for (const check of headline) {
    verified.push({
      label: 'Calldata',
      detail:
        check.status === 'passed'
          ? check.description
          : `${check.description} — ${check.detail ?? check.status}`,
      tone: check.status === 'passed' ? 'good' : 'warn',
    });
  }

  if (input.simulation) {
    const passed = input.simulation.state === 'passed';
    verified.push({
      label: 'Simulation',
      detail: passed
        ? 'The batch was executed against a fork of Base and did not revert.'
        : `Not simulated (${input.simulation.state}). Nothing here proves the batch would succeed.`,
      tone: passed ? 'good' : 'warn',
    });
  }

  return {
    verified,
    notVerified: [...NOT_VERIFIED_V1],
    note: 'Each line above is something that was read. Everything below it is something nobody looked at — a passing check is not a safe token.',
  };
}
