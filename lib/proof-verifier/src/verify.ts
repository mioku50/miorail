import {
  PublicProofBundleV1Schema,
  PublicProofVerificationResultV1Schema,
  hashApprovedCallsV1,
  hashNftProofEventV1,
  hashNftPurchaseProofV1,
  hashPublicProofBundleV1,
  hashRouteProofEventPayloadV1,
  hashRouteProofEventV1,
  hashRouteProofV1,
  type PublicProofBundleV1,
  type PublicProofCheckV1,
  type PublicProofVerificationResultV1,
  type RouteProofEventV1,
} from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T67C.2 — the standalone canonical integrity verifier.
//
// PURE. No fetch, no RPC, no process.env, no database, no clock. It takes a
// JSON value and returns a verdict, which is what lets the same code run in a
// stranger's browser and in a CLI on their laptop and produce the same answer.
//
// It also does not trust the bundle's own claims about itself. Every hash is
// RECOMPUTED from the content and compared; a `valid: true` flag arriving in
// the payload would mean nothing and is not read.
//
// What it establishes, precisely: that this document is internally consistent
// and has not been altered since it was sealed. What it does NOT establish:
// that Miorail vouches for it (nothing here is signed by a server key), or
// that any of it is anchored onchain (no hash in a bundle was written to
// Base). The transaction hashes inside it were — a reader can check those on a
// block explorer, which is a different and stronger kind of evidence, and the
// verifier deliberately does not pretend to have done it.
// ---------------------------------------------------------------------------

type Outcome = PublicProofCheckV1['outcome'];

class Checks {
  private readonly rows: PublicProofCheckV1[] = [];

  add(key: string, label: string, outcome: Outcome, detail: string | null = null): void {
    this.rows.push({ key, label, outcome, detail });
  }

  assert(key: string, label: string, condition: boolean, failureDetail: string): void {
    this.add(key, label, condition ? 'passed' : 'failed', condition ? null : failureDetail);
  }

  get all(): PublicProofCheckV1[] {
    return this.rows;
  }
}

function result(
  checks: PublicProofCheckV1[],
  parts: { proofFamily: PublicProofVerificationResultV1['proofFamily']; bundleHash: string | null; proofHash: string | null },
): PublicProofVerificationResultV1 {
  return PublicProofVerificationResultV1Schema.parse({
    schemaVersion: 'public-proof-verification/v1',
    // A skipped check never makes a bundle invalid, and never makes one valid
    // on its own. Only a failure decides.
    valid: !checks.some((check) => check.outcome === 'failed'),
    proofFamily: parts.proofFamily,
    bundleHash: parts.bundleHash,
    proofHash: parts.proofHash,
    checks,
  });
}

/** Route proof events form a previous-hash chain. NFT proof events carry a
 * sequence and no chain, so that check is SKIPPED for them rather than
 * reported as passed — a chain nobody checked is not a chain that held. */
function verifyRouteEventChainV1(events: readonly RouteProofEventV1[], checks: Checks): void {
  if (events.length === 0) {
    checks.add('event_chain', 'Event chain', 'skipped', 'this bundle carries no events');
    return;
  }
  let indexesOk = true;
  let chainOk = true;
  let payloadsOk = true;
  let hashesOk = true;
  let previous: string | null = null;
  for (const [position, event] of events.entries()) {
    if (event.eventIndex !== position) indexesOk = false;
    if (position === 0) {
      if (event.previousEventHash !== null) chainOk = false;
    } else if (event.previousEventHash !== previous) {
      chainOk = false;
    }
    if (event.payloadHash !== hashRouteProofEventPayloadV1(event.payload)) payloadsOk = false;
    if (event.eventHash !== hashRouteProofEventV1(event)) hashesOk = false;
    previous = event.eventHash;
  }
  checks.assert('event_indexes', 'Event indexes', indexesOk, 'event indexes are not zero-based and sequential');
  checks.assert('event_chain', 'Event chain', chainOk, 'an event does not follow the one before it');
  checks.assert('event_payload_hashes', 'Event payload hashes', payloadsOk, 'an event payload hash does not match its payload');
  checks.assert('event_hashes', 'Event hashes', hashesOk, 'an event hash does not match its content');
}

/** Enough structure to know WHICH checks apply. Deliberately weaker than the
 * real schema: a bundle that fails validation still gets every hash checked, so
 * the report can say what was altered rather than only that something was. */
function looksLikeBundleV1(input: unknown): input is PublicProofBundleV1 {
  if (typeof input !== 'object' || input === null) return false;
  const value = input as Record<string, unknown>;
  return (
    (value.proofFamily === 'route' || value.proofFamily === 'nft') &&
    typeof value.bundleHash === 'string' &&
    typeof value.proof === 'object' &&
    value.proof !== null &&
    Array.isArray(value.events)
  );
}

/**
 * Verifies a public proof bundle.
 *
 * Accepts `unknown` because in the two places this runs — a browser that just
 * fetched a URL, a CLI that just read a file — the input is genuinely unknown.
 *
 * A schema failure does NOT stop the run. The strict schema already refuses a
 * proof whose own hash is wrong, so stopping there would report "schema" as the
 * single finding for every kind of tampering and tell the reader nothing about
 * WHAT changed. Instead the schema is one check among many and every hash is
 * recomputed regardless, so the report names the field that broke.
 */
export function verifyPublicProofBundleV1(input: unknown): PublicProofVerificationResultV1 {
  const checks = new Checks();

  if (!looksLikeBundleV1(input)) {
    checks.add('schema', 'Schema', 'failed', 'this is not a Miorail proof bundle');
    return result(checks.all, { proofFamily: null, bundleHash: null, proofHash: null });
  }
  const parsed = PublicProofBundleV1Schema.safeParse(input);
  checks.add(
    'schema',
    'Schema',
    parsed.success ? 'passed' : 'failed',
    parsed.success ? null : (parsed.error.issues[0]?.message ?? 'the bundle does not match the schema'),
  );
  // The RAW value, not the parsed one: checking the parser's output would only
  // prove the parser agrees with itself.
  const bundle: PublicProofBundleV1 = input;

  // Recomputed from the content, never read from the document.
  const bundleHash = hashPublicProofBundleV1(bundle as unknown as Record<string, unknown>);
  checks.assert('bundle_hash', 'Bundle hash', bundleHash === bundle.bundleHash, 'the bundle hash does not match its content');

  try {
    return verifyFamilyV1(bundle, bundleHash, checks);
  } catch {
    // Reached only by a bundle malformed in a way the structural guard let
    // through. It is a failure of the document, never of the reader, and it is
    // reported as such rather than crashing the page it is rendered on.
    checks.add('structure', 'Bundle structure', 'failed', 'the bundle is malformed and could not be checked');
    return result(checks.all, { proofFamily: null, bundleHash, proofHash: null });
  }
}

function verifyFamilyV1(
  bundle: PublicProofBundleV1,
  bundleHash: string,
  checks: Checks,
): PublicProofVerificationResultV1 {
  if (bundle.proofFamily === 'route') {
    const proof = bundle.proof;
    checks.assert('proof_hash', 'Proof hash', hashRouteProofV1(proof) === proof.proofHash, 'the proof hash does not match the proof');
    checks.assert(
      'approved_calls_hash',
      'Approved calls hash',
      hashApprovedCallsV1(proof.approvedCalls) === proof.approvedCallsHash,
      'the approved calls hash does not match the approved calls',
    );

    const hashes = proof.transactionHashes;
    checks.assert(
      'transaction_uniqueness',
      'Transaction hashes are unique',
      new Set(hashes).size === hashes.length,
      'a transaction hash appears more than once',
    );
    const receiptHashes = new Set(proof.receipts.map((receipt) => receipt.transactionHash));
    checks.assert(
      'receipt_coverage',
      'Receipt coverage',
      hashes.every((hash) => receiptHashes.has(hash)),
      'a transaction hash has no receipt',
    );

    // Terminal-status invariants. These are what stop a proof from claiming an
    // outcome its receipts do not support.
    const successes = proof.receipts.filter((receipt) => receipt.status === 'success');
    const failures = proof.receipts.filter((receipt) => receipt.status !== 'success');
    if (proof.finalStatus === 'completed') {
      checks.assert(
        'final_status',
        'Final-status invariants',
        proof.receipts.length > 0 && failures.length === 0,
        'a completed proof carries a receipt that did not succeed',
      );
    } else if (proof.finalStatus === 'partial_failure') {
      checks.assert(
        'final_status',
        'Final-status invariants',
        successes.length > 0 && failures.length > 0,
        'a partial failure must carry both successful and unsuccessful receipts',
      );
    } else if (proof.finalStatus === 'cancelled') {
      // A cancelled record describes a route that was never executed, so a
      // transaction hash on one is a contradiction rather than extra detail.
      checks.assert(
        'final_status',
        'Final-status invariants',
        hashes.length === 0,
        'a cancelled proof carries transaction hashes',
      );
    } else {
      checks.add('final_status', 'Final-status invariants', 'passed', `no additional invariant for ${proof.finalStatus}`);
    }

    verifyRouteEventChainV1(bundle.events, checks);
    // Every event must be about THIS proof. Without this an event chain from
    // another proof could be pasted in and still verify on its own terms.
    checks.assert(
      'event_binding',
      'Events belong to this proof',
      bundle.events.every(
        (event) =>
          event.routeProofId === proof.id &&
          event.approvedCallsHash === proof.approvedCallsHash &&
          event.blueprintHash === proof.blueprintHash &&
          event.intentHash === proof.intentHash,
      ),
      'an event does not belong to this proof',
    );

    return result(checks.all, { proofFamily: 'route', bundleHash, proofHash: proof.proofHash });
  }

  const proof = bundle.proof;
  checks.assert('proof_hash', 'Proof hash', hashNftPurchaseProofV1(proof) === proof.proofHash, 'the proof hash does not match the proof');
  // An NFT proof carries the calls hash but not the calls themselves, so there
  // is nothing to recompute it from. Saying so is the honest answer.
  checks.add(
    'approved_calls_hash',
    'Approved calls hash',
    'skipped',
    'an NFT proof does not carry the approved calls, so this hash cannot be recomputed',
  );

  const receipt = proof.receipt;
  checks.assert(
    'receipt_coverage',
    'Receipt coverage',
    receipt.transactionHash === null || receipt.status !== 'unknown',
    'a transaction hash carries no receipt status',
  );
  // The rule of this family, checked independently rather than taken on trust:
  // a completed NFT proof needs a successful receipt AND the chain reporting
  // the buyer as the owner. A successful receipt alone is not a purchase.
  checks.assert(
    'final_status',
    'Final-status invariants',
    proof.finalStatus !== 'completed' ||
      (receipt.status === 'success' &&
        proof.ownership.status === 'verified' &&
        proof.ownership.owner?.toLowerCase() === proof.buyer.toLowerCase()),
    'a completed NFT proof needs a successful receipt and the buyer as the verified onchain owner',
  );

  let sequencesOk = true;
  let hashesOk = true;
  for (const [position, event] of bundle.events.entries()) {
    if (event.sequence !== position) sequencesOk = false;
    if (event.eventHash !== hashNftProofEventV1(event)) hashesOk = false;
  }
  checks.assert('event_indexes', 'Event sequence', sequencesOk, 'event sequences are not zero-based and sequential');
  checks.assert('event_hashes', 'Event hashes', hashesOk, 'an event hash does not match its content');
  checks.add(
    'event_chain',
    'Event chain',
    'skipped',
    'NFT proof events carry a sequence rather than a previous-hash chain',
  );
  checks.assert(
    'event_binding',
    'Events belong to this proof',
    bundle.events.every((event) => event.proofHash === proof.proofHash),
    'an event does not belong to this proof',
  );

  return result(checks.all, { proofFamily: 'nft', bundleHash, proofHash: proof.proofHash });
}
