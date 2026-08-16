import {
  b20ClaimStandingV1,
  b20FundamentalProfileV1,
  type B20ClaimLinkV1,
  type B20FundamentalEvidenceV1,
  type B20FundamentalProfileV1,
  type B20TokenClaimV1,
} from '@mioagent/opportunity-rail';

import { claimUrlAllowedV1 } from './claimFile.js';
import {
  probeProductV1,
  probeUrlV1,
  readBasePresenceV1,
  readClaimFileV1,
  readRepositoryV1,
  verifyClaimLinksV1,
  type B20CollectDepsV1,
} from './collect.js';

// ---------------------------------------------------------------------------
// One verification pass for one token.
//
// The order is the whole design: read the claim file, decide whether the
// identity holds, and only then probe anything. A pass that failed at the gate
// makes NO further requests — not because they would be wasteful, but because
// the results could not be attached to the token and a collector that gathers
// unattachable evidence is one refactor away from attaching it.
// ---------------------------------------------------------------------------

export interface B20VerifyInputV1 {
  chainId: number;
  tokenAddress: string;
  /** The domain making the claim. An operator supplies it — Miorail does not
   * discover domains, and a project that has not told anyone is unclaimed. */
  domain: string;
  /** The launch transaction sender, from the chain. Null when unread. */
  launchSender: string | null;
  /** `direct`, `bundler`, `intermediary`, `contract_creation`, or null. */
  senderRelation: string | null;
  /** The token's launch time, from the block. Null when unknown. */
  launchedAt: string | null;
}

export interface B20VerifyResultV1 {
  claim: B20TokenClaimV1 | null;
  /** Why no claim was recorded. Null when one was. */
  refusal: string | null;
  evidence: B20FundamentalEvidenceV1;
  profile: B20FundamentalProfileV1;
  /** Declared URLs the safety rules refused, with the reason. Reported so an
   * operator sees a rejected declaration rather than a silent absence. */
  refusedUrls: readonly { url: string; refusal: string }[];
}

export async function verifyB20ProjectV1(
  deps: B20CollectDepsV1,
  input: B20VerifyInputV1,
): Promise<B20VerifyResultV1> {
  const now = deps.now();
  const read = await readClaimFileV1(deps, {
    domain: input.domain,
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
  });

  const unverified = (refusal: string): B20VerifyResultV1 => {
    const evidence: B20FundamentalEvidenceV1 = {
      claim: b20ClaimStandingV1(null),
      claimantDomain: null,
      website: null,
      product: null,
      docs: null,
      repository: null,
      basePresence: null,
      launchedAt: input.launchedAt,
      now,
    };
    return {
      claim: null,
      refusal,
      evidence,
      profile: b20FundamentalProfileV1(evidence),
      refusedUrls: [],
    };
  };

  if (read.file === null) return unverified(read.refusal ?? 'unreachable');

  const file = read.file;
  const links = await verifyClaimLinksV1(deps, {
    file,
    domain: input.domain,
    tokenAddress: input.tokenAddress,
    launchSender: input.launchSender,
    senderRelation: input.senderRelation,
  });

  // A refuted link decides the claim on its own. A project that told Miorail a
  // sender the chain contradicts has said something untrue about the one field
  // it could not choose, and nothing after that is attached.
  const status: B20TokenClaimV1['status'] = links.refuted.length > 0 ? 'refuted' : 'verified';
  const claim: B20TokenClaimV1 = {
    claimantDomain: input.domain,
    status,
    verifiedLinks: links.verified as readonly B20ClaimLinkV1[],
    refutedLinks: links.refuted as readonly B20ClaimLinkV1[],
    lastCheckedAt: read.readAt,
  };

  if (status === 'refuted') {
    const evidence: B20FundamentalEvidenceV1 = {
      claim: b20ClaimStandingV1(claim),
      claimantDomain: input.domain,
      website: null,
      product: null,
      docs: null,
      repository: null,
      basePresence: null,
      launchedAt: input.launchedAt,
      now,
    };
    return {
      claim,
      refusal: 'claim_refuted',
      evidence,
      profile: b20FundamentalProfileV1(evidence),
      refusedUrls: [],
    };
  }

  const refusedUrls: { url: string; refusal: string }[] = [];
  const note = (url: string | null, kind: 'same_domain' | 'repository') => {
    if (!url) return;
    const allowed = claimUrlAllowedV1({ url, domain: input.domain, kind });
    if (!allowed.allowed) refusedUrls.push({ url, refusal: allowed.refusal });
  };
  note(file.project.website, 'same_domain');
  note(file.project.product, 'same_domain');
  note(file.project.docs, 'same_domain');
  note(file.project.repository, 'repository');

  const repositoryAllowed =
    file.project.repository !== null &&
    claimUrlAllowedV1({ url: file.project.repository, domain: input.domain, kind: 'repository' }).allowed;

  const [website, product, docs, repository] = await Promise.all([
    file.project.website ? probeUrlV1(deps, { url: file.project.website, domain: input.domain }) : null,
    file.project.product ? probeProductV1(deps, { url: file.project.product, domain: input.domain }) : null,
    file.project.docs ? probeUrlV1(deps, { url: file.project.docs, domain: input.domain }) : null,
    repositoryAllowed ? readRepositoryV1(deps, { url: file.project.repository! }) : null,
  ]);

  const basePresence = await readBasePresenceV1(deps, {
    contract: file.project.baseContract,
    productFunctional: product?.functional === true,
    productUrl: product?.url ?? null,
  });

  const evidence: B20FundamentalEvidenceV1 = {
    claim: b20ClaimStandingV1(claim),
    claimantDomain: input.domain,
    website,
    product,
    docs,
    repository,
    basePresence,
    launchedAt: input.launchedAt,
    now,
  };

  return {
    claim,
    refusal: null,
    evidence,
    profile: b20FundamentalProfileV1(evidence),
    refusedUrls,
  };
}
