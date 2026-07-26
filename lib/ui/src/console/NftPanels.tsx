import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// T65.1 §6 — the NFT family's screens.
//
// Presentational only: every value is passed in, nothing is fetched, nothing
// is computed that a contract already decided. Two rules run through all of it.
//
// THE COPY NEVER OVERCLAIMS. One marketplace's listing is not a market, so the
// recommendation is `Best active OpenSea listing observed for this NFT` and
// never "best NFT price" or "safest NFT". A purchase is called completed only
// when an ownership read says so.
//
// IDENTITY IS chain + contract + tokenId. The name and the image are display,
// shown as such, and never the thing that says which NFT this is.
// ---------------------------------------------------------------------------

/** The one sentence a compared NFT card may lead with. */
export const NFT_RECOMMENDATION_COPY_V1 = 'Best active OpenSea listing observed for this NFT';

/** What a surface may say for each proof outcome. Fixed strings, so an
 * unconfirmed purchase can never be phrased as a completed one. */
export const NFT_PROOF_COPY_UI_V1 = {
  pending: 'Waiting for the transaction to be mined. Nothing is confirmed yet.',
  completed: 'Confirmed onchain: the transaction succeeded, the token transferred, and you own it.',
  reconciliation_required:
    'The transaction succeeded but ownership is not confirmed yet. Miorail keeps checking — this is not a completed purchase.',
  transaction_failed: 'The transaction reverted. The NFT was not bought and the ETH was not spent.',
  failed: 'The transaction succeeded but the token did not reach your wallet. This needs to be looked at.',
} as const;

export type NftProofFinalStatusLikeV1 = keyof typeof NFT_PROOF_COPY_UI_V1;

export interface NftAssetLikeV1 {
  chain: string;
  contractAddress: string;
  tokenId: string;
  tokenStandard: string;
  collectionSlug: string | null;
  display: {
    name: string | null;
    collectionName: string | null;
    imageUrl: string | null;
    imageBlocked: boolean;
    imageBlockedReason: string | null;
  };
}

export interface NftCandidateLikeV1 {
  listingPriceWei: string;
  estimatedGasWei: string | null;
  listingStatus: string;
  listingExpiresAt: string;
  creatorFeePolicy: string;
  order: { orderHash: string; protocolAddress: string; seller: string };
}

export interface NftScoreDimensionLikeV1 {
  dimension: string;
  score: number | null;
  notScoredReason: string | null;
}

export interface NftRouteCardLikeV1 {
  routeCardHash: string;
  status: string;
  asset: NftAssetLikeV1;
  candidate: NftCandidateLikeV1 | null;
  dimensions: readonly NftScoreDimensionLikeV1[];
  evidenceGaps: readonly string[];
  maxSpendWei: string;
  totalCostWei: string | null;
  failureReason: string | null;
  expiresAt: string;
}

export interface NftProofLikeV1 {
  proofHash: string;
  finalStatus: NftProofFinalStatusLikeV1;
  buyer: string;
  seller: string;
  listingPriceWei: string;
  receipt: {
    status: string;
    transactionHash: string | null;
    blockNumber: string | null;
    gasUsed: string | null;
    actualNativeValueWei: string | null;
  };
  transfer: { status: string; fromAddress: string | null; toAddress: string | null };
  ownership: { status: string; owner: string | null; blockNumber: string | null; unavailableReason: string | null };
}

/** ETH from wei, to at most 6 decimals, without inventing precision. Null in
 * gives an em dash out — a missing number is shown as missing. */
export function ethFromWeiV1(wei: string | null): string {
  if (wei === null) return '—';
  let value: bigint;
  try {
    value = BigInt(wei);
  } catch {
    return '—';
  }
  // Not a BigInt literal: the miniapp compiles below ES2020.
  const unit = BigInt(10) ** BigInt(18);
  const whole = value / unit;
  const fraction = (value % unit).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction} ETH` : `${whole} ETH`;
}

export function shortHashV1(value: string | null): string {
  if (!value) return '—';
  return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

/** Seaport 1.6 and 1.5 are the only pinned protocol addresses. A third one
 * would be a version nobody here reviewed, and it is labelled as such. */
export function seaportVersionLabelV1(protocolAddress: string): string {
  const address = protocolAddress.toLowerCase();
  if (address === '0x0000000000000068f116a894984e2db1123eb395') return 'Seaport 1.6';
  if (address === '0x00000000000000adc04c56bf30ac9d3c0aaf14dc') return 'Seaport 1.5';
  return 'Unrecognised protocol';
}

/** Zone-restricted orders take the advanced fulfilment path. Stated, because
 * it changes which calldata the wallet is asked to sign. */
export function nftOrderFormLabelV1(restrictedByZone: boolean): string {
  return restrictedByZone ? 'Zone-restricted order (advanced fulfilment)' : 'Open order (basic fulfilment)';
}

/** The chain, in words. The contract carries a CAIP-2 id, which is the right
 * thing to store and the wrong thing to put in front of a person. An
 * unrecognised id is shown verbatim rather than guessed at. */
export function nftChainLabelV1(chain: string): string {
  if (chain === 'eip155:8453' || chain === 'base') return 'Base mainnet · 8453';
  if (chain === 'eip155:84532') return 'Base Sepolia · 84532';
  return chain;
}

/**
 * One labelled fact.
 *
 * `qrow` is the console's own key/value row — the same one the right rail and
 * the spend panel use. These panels deliberately own NO layout vocabulary of
 * their own: an NFT screen that invents its own classes is an NFT screen that
 * silently renders as unstyled text the first time it ships.
 */
function Row({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="qrow" title={title}>
      <span>{label}</span>
      <span className="v mono">{value}</span>
    </div>
  );
}

/**
 * The NFT media slot.
 *
 * A blocked image renders a PLACEHOLDER and the reason. The URL is not carried
 * into this component at all when the policy blocked it, so there is no path
 * where a marketplace URL is loaded because a prop was passed by accident.
 */
export function NftMedia({ asset }: { asset: NftAssetLikeV1 }) {
  if (asset.display.imageBlocked || asset.display.imageUrl === null) {
    return (
      <div className="nftmedia na" role="img" aria-label="No image shown">
        <span className="nftmedia-ph">No image</span>
        <span className="lnote">{asset.display.imageBlockedReason ?? 'This item has no image.'}</span>
      </div>
    );
  }
  return (
    <img
      className="nftmedia"
      src={asset.display.imageUrl}
      alt={asset.display.name ?? `Token ${asset.tokenId}`}
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}

/** Identity, always as chain + contract + tokenId. The name sits beside it as
 * display, never instead of it. */
export function NftIdentity({ asset }: { asset: NftAssetLikeV1 }) {
  return (
    <div className="cardrow">
      <div className="cr-top">
        <span className="cr-name">{asset.display.name ?? 'Unnamed token'}</span>
        <span className="pill n">{asset.tokenStandard.toUpperCase()}</span>
      </div>
      <div className="cr-nums">
        <div>
          <span className="cr-k">Chain</span>
          <span className="cr-v mono">{nftChainLabelV1(asset.chain)}</span>
        </div>
        <div>
          <span className="cr-k">Token ID</span>
          <span className="cr-v mono">{asset.tokenId}</span>
        </div>
      </div>
      {/* The contract gets its own line: it is the identity, not a detail. */}
      <p className="cr-why mono">{asset.contractAddress}</p>
    </div>
  );
}

export interface NftRouteCardPanelProps {
  card: NftRouteCardLikeV1;
  restrictedByZone?: boolean;
  onReview?: () => void;
  reviewDisabledReason?: string | null;
}

export function NftRouteCardPanel({ card, restrictedByZone = false, onReview, reviewDisabledReason }: NftRouteCardPanelProps) {
  const { asset, candidate } = card;

  if (candidate === null) {
    // A listing that vanished still gets a card naming the token. Removing it
    // from the screen would leave the user guessing what happened.
    return (
      <div className="panel" aria-label="NFT route card">
        <div className="ph">
          <h3>NFT route</h3>
          <span className="rt">
            <span className="pill a">nothing to buy</span>
          </span>
        </div>
        <div className="pb">
          <div className="nftrow">
            <NftMedia asset={asset} />
            <NftIdentity asset={asset} />
          </div>
          <p className="why warn">{card.failureReason ?? 'There is nothing to buy for this NFT right now.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel" aria-label="NFT route card">
      <div className="ph">
        <h3>NFT route</h3>
        <span className="rt">
          <span className="pill n">{seaportVersionLabelV1(candidate.order.protocolAddress)}</span>
          <span className="pill br">{candidate.listingStatus}</span>
        </span>
      </div>
      <div className="pb">
        <div className="nftrow">
          <NftMedia asset={asset} />
          <NftIdentity asset={asset} />
        </div>

        {/* One marketplace's listing is not a market, and the sentence says so. */}
        <p className="why">{NFT_RECOMMENDATION_COPY_V1}</p>

        <div className="cr-nums" style={{ marginTop: 12 }}>
          <div>
            <span className="cr-k">Price</span>
            <span className="cr-v mono">{ethFromWeiV1(candidate.listingPriceWei)}</span>
          </div>
          <div>
            <span className="cr-k">Your limit</span>
            <span className="cr-v mono">{ethFromWeiV1(card.maxSpendWei)}</span>
          </div>
        </div>

        <Row
          label="Estimated gas"
          value={candidate.estimatedGasWei === null ? 'Not estimated' : ethFromWeiV1(candidate.estimatedGasWei)}
        />
        <Row
          label="Total"
          // A gap is SHOWN, not filled. Without a gas estimate there is no total
          // — the price wearing the word "total" would be a different claim.
          value={card.totalCostWei === null ? 'Not available without a gas estimate' : ethFromWeiV1(card.totalCostWei)}
        />
        <Row label="Seller" value={shortHashV1(candidate.order.seller)} title={candidate.order.seller} />
        <Row label="Listing expires" value={candidate.listingExpiresAt} />
        <Row label="Order" value={shortHashV1(candidate.order.orderHash)} title={candidate.order.orderHash} />
        <Row label="Order type" value={nftOrderFormLabelV1(restrictedByZone)} />
        <Row label="Creator fees" value={candidate.creatorFeePolicy.replace(/_/g, ' ')} />

        <div className="sechead">
          <span>Scoring</span>
          <span>no combined number</span>
        </div>
        {card.dimensions.map((dimension) => {
          const scored = dimension.score !== null;
          return (
            <div key={dimension.dimension} className={`scorerow${scored ? '' : ' na'}`}>
              <span className="nm">{dimension.dimension.replace(/_/g, ' ')}</span>
              {/* An unscored dimension keeps its hatched track and says why —
                  it never renders as a zero. */}
              <span className={`track${scored ? '' : ' na'}`}>
                {scored && <span style={{ width: `${Math.max(0, Math.min(100, dimension.score as number))}%` }} />}
              </span>
              <span className="nu">{scored ? dimension.score : '—'}</span>
              <span className="cf">
                {scored ? '' : `not scored · ${dimension.notScoredReason?.replace(/_/g, ' ') ?? 'no source'}`}
              </span>
            </div>
          );
        })}
        {/* No combined number. Averaging four dimensions would read as a market
            verdict, and one marketplace's listing is not a market. */}

        {card.evidenceGaps.length > 0 && (
          <p className="lnote">Not established: {card.evidenceGaps.join(', ').replace(/_/g, ' ')}</p>
        )}

        {onReview && (
          <button type="button" className="btn sec" onClick={onReview} disabled={Boolean(reviewDisabledReason)}>
            Review purchase
          </button>
        )}
        {reviewDisabledReason && <p className="lnote">{reviewDisabledReason}</p>}
      </div>
    </div>
  );
}

export interface NftReviewPanelProps {
  card: NftRouteCardLikeV1;
  blueprintHash: string;
  callsHash: string;
  valueWei: string;
  /** Zone-restricted orders take the advanced fulfilment path; it decides which
   * calldata the wallet is asked to sign, so it is on the screen. */
  restrictedByZone?: boolean;
  simulation: { status: string; blockNumber: string | null; gasUsed?: string | null; errorCode: string | null } | null;
  safety: { ok: boolean; violations: readonly string[] };
  signable: boolean;
  blockedReason: string | null;
  /** The shared "Confirm in Base Account" control. Passed in rather than built
   * here: there is exactly ONE wallet submission implementation, and this
   * package is presentational. */
  submitSlot?: ReactNode;
}

export function NftReviewPanel({
  card,
  blueprintHash,
  callsHash,
  valueWei,
  restrictedByZone = false,
  simulation,
  safety,
  signable,
  blockedReason,
  submitSlot,
}: NftReviewPanelProps) {
  const { asset, candidate } = card;
  return (
    <div className="panel" aria-label="NFT purchase review">
      <div className="ph">
        <h3>Review this purchase</h3>
        <span className="rt">
          <span className={`pill ${safety.ok ? 'g' : 'a'}`}>{safety.ok ? 'safety checks passed' : 'blocked'}</span>
        </span>
      </div>
      <div className="pb">
        <div className="nftrow">
          <NftMedia asset={asset} />
          <NftIdentity asset={asset} />
        </div>

        <div className="cr-nums" style={{ marginTop: 12 }}>
          <div>
            <span className="cr-k">You send</span>
            <span className="cr-v mono">{ethFromWeiV1(valueWei)}</span>
          </div>
          <div>
            {/* What arrives, named the only way identity is ever named here. */}
            <span className="cr-k">You receive</span>
            <span className="cr-v mono">{`1 × ${asset.tokenStandard.toUpperCase()} #${asset.tokenId}`}</span>
          </div>
        </div>

        <Row label="Order type" value={nftOrderFormLabelV1(restrictedByZone)} />
        <Row
          label="Fulfilled through"
          value={candidate ? seaportVersionLabelV1(candidate.order.protocolAddress) : '—'}
          title={candidate?.order.protocolAddress}
        />
        <Row label="Listing expires" value={candidate?.listingExpiresAt ?? '—'} />
        <Row
          label="Simulation"
          value={
            simulation === null || simulation.status === 'unavailable'
              ? `Unavailable${simulation?.errorCode ? ` · ${simulation.errorCode}` : ''}`
              : simulation.status === 'passed'
                ? `Passed at block ${simulation.blockNumber ?? '—'}${simulation.gasUsed ? ` · gas ${simulation.gasUsed}` : ''}`
                : `Reverted at block ${simulation.blockNumber ?? '—'}`
          }
        />
        <Row
          label="Safety checks"
          value={safety.ok ? 'Passed' : `Blocked: ${safety.violations.join(', ').replace(/_/g, ' ')}`}
        />
        <Row label="Blueprint hash" value={shortHashV1(blueprintHash)} title={blueprintHash} />
        <Row label="Calls hash" value={shortHashV1(callsHash)} title={callsHash} />

        {/* Signing is offered only when every gate passed. A disabled button with
            a stated reason beats a button that fails after the click. */}
        <div className="ctarow" style={{ marginTop: 12 }}>
          {signable ? submitSlot : <span className="nt">{blockedReason ?? 'This purchase cannot be signed yet.'}</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * The headline for each outcome — the short sentence, kept separate from the
 * explanation below it.
 *
 * `completed` is the ONLY one that uses the word. Everything else says what is
 * and is not known, because a receipt is not a purchase.
 */
export const NFT_PROOF_HEADLINE_V1: Record<NftProofFinalStatusLikeV1, string> = {
  pending: 'Submitted — waiting for the transaction',
  completed: 'Purchase completed and ownership verified',
  reconciliation_required: 'Receipt confirmed, ownership still being verified',
  transaction_failed: 'The transaction reverted — nothing was bought',
  failed: 'Ownership could not be independently proven',
};

export function NftProofPanel({ proof, asset }: { proof: NftProofLikeV1; asset?: NftAssetLikeV1 }) {
  const owned = proof.ownership.status === 'verified';
  // Only a verified ownership read earns the green pill. Everything else is
  // amber or neutral, including a receipt that succeeded.
  const tone = proof.finalStatus === 'completed' ? 'g' : proof.finalStatus === 'pending' ? 'n' : 'a';
  return (
    <div className="panel" aria-label="NFT ownership proof">
      <div className="ph">
        <h3>NFT proof</h3>
        <span className="rt">
          <span className={`pill ${tone}`}>{proof.finalStatus.replace(/_/g, ' ')}</span>
        </span>
      </div>
      <div className="pb">
        <p className="why">
          <b>{NFT_PROOF_HEADLINE_V1[proof.finalStatus]}</b>
        </p>
        <p className="lnote">{NFT_PROOF_COPY_UI_V1[proof.finalStatus]}</p>

        {asset && (
          <div className="nftrow" style={{ marginTop: 12 }}>
            <NftMedia asset={asset} />
            <NftIdentity asset={asset} />
          </div>
        )}

        <Row
          label="Transaction"
          value={shortHashV1(proof.receipt.transactionHash)}
          title={proof.receipt.transactionHash ?? undefined}
        />
        <Row label="Receipt" value={proof.receipt.status} />
        <Row label="Block" value={proof.receipt.blockNumber ?? '—'} />
        <Row label="Gas used" value={proof.receipt.gasUsed ?? '—'} />
        <Row
          label="Actually spent"
          // Read from the transaction, not copied from the card.
          value={ethFromWeiV1(proof.receipt.actualNativeValueWei)}
        />

        {/* Who held it before, and who holds it now — the two ends of the only
            question this screen exists to answer. */}
        <Row
          label="Previous owner"
          value={shortHashV1(proof.transfer.fromAddress ?? proof.seller)}
          title={proof.transfer.fromAddress ?? proof.seller}
        />
        <Row
          label="New owner"
          value={owned ? shortHashV1(proof.ownership.owner) : 'Not independently confirmed'}
          title={owned ? (proof.ownership.owner ?? undefined) : undefined}
        />

        <Row
          label="Transfer"
          value={
            proof.transfer.status === 'observed'
              ? `ERC-721 Transfer → ${shortHashV1(proof.transfer.toAddress)}`
              : proof.transfer.status === 'wrong_recipient'
                ? `Transferred to someone else: ${shortHashV1(proof.transfer.toAddress)}`
                : 'No Transfer of this token observed'
          }
        />

        <Row
          label="ownerOf"
          value={
            owned
              ? `${shortHashV1(proof.ownership.owner)} at block ${proof.ownership.blockNumber ?? '—'}`
              : proof.ownership.status === 'mismatch'
                ? `Owned by ${shortHashV1(proof.ownership.owner)} — not you`
                : (proof.ownership.unavailableReason ?? 'Not read yet')
          }
        />

        <Row label="Proof hash" value={shortHashV1(proof.proofHash)} title={proof.proofHash} />
      </div>
    </div>
  );
}
