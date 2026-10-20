import { z } from 'zod';

export const EVIDENCE_TOOLS_V1 = [
  'miorail_discover_status', 'list_reviewed_stocks', 'get_representations', 'compare_market_reality',
  'get_market_changes', 'get_use_access', 'check_address_identity', 'get_dividend_calendar',
  'get_recorded_changes', 'get_reopen_round',
] as const;
export type EvidenceToolV1 = typeof EVIDENCE_TOOLS_V1[number];

const Pointer = z.string().regex(/^(\/[^\s]*)?$/).max(600);
const Scope = z.object({
  tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/).optional(),
  underlyingKey: z.string().max(200).optional(),
  requestedCashAtomic: z.string().regex(/^[0-9]+$/).optional(),
  tokenAmountAtomic: z.string().regex(/^[0-9]+$/).optional(),
  direction: z.enum(['buy', 'sell']).optional(),
  destination: z.enum(['USDC', 'ETH']).optional(),
  routePolicyKey: z.string().regex(/^0x[0-9a-f]{64}$/).optional(),
  from: z.string().datetime().optional(), until: z.string().datetime().optional(),
  effectiveAt: z.string().max(80).optional(), roundId: z.string().max(40).optional(),
  phase: z.enum(['close', 'lock', 'reopen', 'base_now']).optional(),
}).strict();
const Claim = z.object({
  paths: z.array(Pointer).min(1).max(20),
  kind: z.enum(['corpus', 'issuer_mapping', 'supply', 'quote', 'reference', 'normalization',
    'history', 'recorded_change', 'controls', 'pools', 'venue', 'announcement', 'declaration',
    'token_effect', 'estimate', 'game', 'derived']),
  block: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  observedAt: z.string().datetime().nullable(),
  source: z.object({
    kind: z.enum(['rpc', 'issuer_api', 'router_measurement', 'venue_catalogue', 'public_source',
      'miorail_store', 'miorail_derived']),
    id: z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/),
  }).strict(),
  hash: z.string().regex(/^(0x)?[0-9a-f]{64}$/).nullable(),
  hashKind: z.enum(['source_content', 'measurement_evidence', 'snapshot']).nullable(),
  scope: Scope,
  basisPaths: z.array(Pointer).max(20),
  missing: z.array(z.enum(['block', 'observedAt', 'hash'])).max(3),
}).strict();
export const EvidencePackageV1Schema = z.object({
  schemaVersion: z.literal('miorail-evidence-package/v1'),
  chainId: z.literal(8453),
  generatedAt: z.string().datetime(),
  claims: z.array(Claim).max(8192),
  availability: z.object({ claims: z.number().int(), withBlock: z.number().int(),
    withObservedAt: z.number().int(), withHash: z.number().int() }).strict(),
  interpretation: z.array(z.string()).length(4),
}).strict();
export const EvidenceOutputExtensionV1 = { evidencePackage: EvidencePackageV1Schema };

type Row = Record<string, unknown>;
type ClaimV1 = z.infer<typeof Claim>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const iso = (value: unknown): string | null => typeof value === 'string'
  && z.string().datetime().safeParse(value).success ? value : null;
const hash = (value: unknown): string | null => typeof value === 'string'
  && /^(0x)?[0-9a-f]{64}$/.test(value) ? value : null;
const id = (value: unknown, fallback: string): string => typeof value === 'string'
  && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value) ? value : fallback;
function block(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string' || !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) return null;
  return BigInt(value).toString();
}
function subject(value: Row): z.infer<typeof Scope> {
  return {
    ...(typeof value.tokenAddress === 'string' && /^0x[0-9a-f]{40}$/.test(value.tokenAddress)
      ? { tokenAddress: value.tokenAddress } : {}),
    ...(typeof value.underlyingKey === 'string' ? { underlyingKey: value.underlyingKey } : {}),
  };
}
function question(value: Row): z.infer<typeof Scope> {
  return {
    ...subject(value),
    ...(typeof value.requestedCashAtomic === 'string' ? { requestedCashAtomic: value.requestedCashAtomic } : {}),
    ...(value.direction === 'buy' || value.direction === 'sell' ? { direction: value.direction } : {}),
    ...(value.destination === 'USDC' || value.destination === 'ETH' ? { destination: value.destination } : {}),
    ...(hash(value.routePolicyKey) ? { routePolicyKey: String(value.routePolicyKey) } : {}),
  };
}

/** An additive index over the returned facts, never another read or another
 * hash. Paths are JSON Pointers into the ORIGINAL answer. Missing provenance
 * stays null, including when a deeper store may retain it. Source hashes,
 * measurement hashes and snapshot hashes retain their different meanings. */
export function evidencePackageV1(tool: EvidenceToolV1, payload: Row, now = new Date()) {
  const claims: ClaimV1[] = [];
  const add = (paths: string[], kind: ClaimV1['kind'], sourceKind: ClaimV1['source']['kind'], sourceId: unknown,
    evidence: Row = {}, scope: z.infer<typeof Scope> = {}, basisPaths: string[] = [],
    hashKind: ClaimV1['hashKind'] = 'measurement_evidence') => {
    const value = hash(evidence.evidenceHash ?? evidence.sourceHash ?? evidence.snapshotHash);
    const b = block(evidence.blockNumber ?? evidence.observedBlockNumber);
    const at = iso(evidence.observedAt);
    claims.push({ paths, kind, block: b, observedAt: at,
      source: { kind: sourceKind, id: id(sourceId, 'not_exposed') }, hash: value,
      hashKind: value ? hashKind : null, scope, basisPaths,
      missing: [...(b === null ? ['block' as const] : []), ...(at === null ? ['observedAt' as const] : []),
        ...(value === null ? ['hash' as const] : [])] });
  };
  const corpus = (paths: string[], scope = subject(payload)) => add(paths, 'corpus', 'miorail_store', tool, {}, scope);
  const identity = (paths: string[], evidence: Row, scope: z.infer<typeof Scope>) =>
    add(paths, 'issuer_mapping', evidence.sourceKind === 'coinbase_b20_metadata' ? 'miorail_store' : 'issuer_api',
      evidence.sourceKind, evidence, scope, [], 'source_content');

  switch (tool) {
    case 'miorail_discover_status':
      corpus(['/state', '/summary', '/blocksBehind', '/counts', '/lastIngestionRunAt', '/lastMeasurementRunAt']);
      break;
    case 'list_reviewed_stocks':
      corpus(['/stocks', '/reviewedTotal', '/reviewedByAssetClass', '/returned', '/truncated']);
      rows(payload.stocks).forEach((stock, i) => {
        if (stock.sourceEvidence) identity(['underlyingKey', 'canonicalName', 'displaySymbol', 'sourceEvidence']
          .map(field => `/stocks/${i}/${field}`), row(stock.sourceEvidence), subject(stock));
      });
      break;
    case 'get_representations': {
      corpus(['/representationCount', '/selection']);
      if (payload.underlying) identity(['/underlying'], row(payload.underlying), subject(row(payload.underlying)));
      rows(payload.representations).forEach((rep, i) => {
        const scope = { ...subject(row(payload.underlying)), ...subject(rep) };
        identity(['tokenAddress', 'caip10', 'issuerId', 'representationKind', 'identityEvidence']
          .map(field => `/representations/${i}/${field}`), row(rep.identityEvidence), scope);
        add([`/representations/${i}/supply`], 'supply', 'rpc', 'erc20_total_supply', row(rep.supply), scope);
      });
      break;
    }
    case 'compare_market_reality': {
      const comparison = row(payload.comparison), q = question(row(comparison.question));
      corpus(['/comparison/universe', '/comparison/marketOutcomeCoverage', '/comparison/numericComparisonCoverage'], q);
      rows(comparison.representations).forEach((rep, i) => {
        const p = `/comparison/representations/${i}`, scope = { ...q, ...subject(rep),
          ...(hash(rep.routePolicyKey) ? { routePolicyKey: String(rep.routePolicyKey) } : {}),
          ...(typeof rep.exactTestedTokenAtomic === 'string' ? { tokenAmountAtomic: rep.exactTestedTokenAtomic } : {}) };
        add([`${p}/supply`], 'supply', 'rpc', 'erc20_total_supply', row(rep.supply), subject(rep));
        rows(rep.sources).forEach((source, j) => add([`${p}/sources/${j}`], 'quote', 'router_measurement',
          source.source, row(source.quoteEvidence), scope));
        const reference = row(rep.reference);
        add([`${p}/reference`], 'reference', 'rpc', row(reference.evidence).source ?? reference.referenceSource,
          { ...row(reference.evidence), observedAt: reference.observedAt }, subject(rep));
        add([`${p}/normalization`], 'normalization', 'miorail_derived', 'representation_ratio',
          { observedAt: rep.normalizationCheckedAt }, scope);
        if (rep.lastObservation) add([`${p}/lastObservation`], 'history', 'router_measurement',
          row(rep.lastObservation).source, row(rep.lastObservation), { ...q, ...subject(rep) });
        add([p], 'derived', 'miorail_derived', 'market_reality', {}, scope,
          [`${p}/sources`, `${p}/supply`, `${p}/reference`, `${p}/normalization`]);
      });
      break;
    }
    case 'get_market_changes': {
      const scope = { ...subject(payload), ...question(row(payload.question)),
        ...(iso(payload.since) ? { from: String(payload.since) } : {}),
        ...(iso(payload.assembledAt) ? { until: String(payload.assembledAt) } : {}),
        ...question(row(payload.routePolicy)) };
      corpus(['/windowObservationCount', '/windowChangeCount', '/changeCountsByKind', '/nextCursor'], scope);
      rows(payload.observations).forEach((observation, i) => {
        const point = row(observation.point);
        add([`/observations/${i}`], 'history', 'router_measurement', point.source ?? 'public_market_history',
          point, scope, [], 'snapshot');
      });
      rows(payload.changes).forEach((change, i) => add([`/changes/${i}`], 'recorded_change',
        'miorail_derived', 'public_market_history', { snapshotHash: change.snapshotHash }, scope,
        [`/changes/${i}/previousSnapshotHash`, `/changes/${i}/snapshotHash`], 'snapshot'));
      break;
    }
    case 'get_use_access': {
      const scope = subject(payload);
      for (const field of ['transfers', 'transferPolicies', 'seizure', 'bridge']) {
        if (Array.isArray(payload.blockTagCovers) && payload.blockTagCovers.includes(field)) {
          add([`/${field}`], 'controls', 'rpc', 'base_token_controls',
            { blockNumber: payload.blockTag, observedAt: payload.observedAt }, scope);
        }
      }
      const pools = row(payload.pools);
      add(['/pools'], 'pools', 'miorail_store', 'pool_balances', { ...pools, observedAt: pools.readAt }, scope);
      rows(row(payload.defi).venues).forEach((venue, i) => {
        const observed = row(venue.observed);
        add([`/defi/venues/${i}`], 'venue', observed.source === 'chain_head' ? 'rpc'
          : observed.source === 'venue_catalogue' ? 'venue_catalogue' : 'miorail_store', venue.venueId,
          { observedAt: observed.at }, scope);
      });
      rows(payload.announcements).forEach((announcement, i) => add([`/announcements/${i}`], 'announcement',
        'public_source', 'venue_announcement', {}, { ...scope,
          ...(typeof announcement.announcedAt === 'string' ? { effectiveAt: announcement.announcedAt } : {}) }));
      if (payload.ecosystem) add(['/ecosystem'], 'derived', 'miorail_derived', 'ecosystem_ledger', {}, scope, ['/defi']);
      if (payload.poolYield) add(['/poolYield'], 'estimate', 'miorail_derived', 'pool_yield',
        { observedAt: row(payload.poolYield).readAt }, scope, ['/pools']);
      break;
    }
    case 'check_address_identity': {
      const scope = subject(payload);
      corpus(['/standing', '/answer', '/corpus'], scope);
      rows(row(payload.official).listedIn).forEach((listing, i) => add([`/official/listedIn/${i}`],
        'issuer_mapping', 'public_source', listing.sourceKind, { observedAt: listing.lastSeenAt }, scope));
      if (payload.issuerRepresentation) add(['/issuerRepresentation'], 'issuer_mapping', 'miorail_store',
        'issuer_registry', row(payload.issuerRepresentation), scope);
      if (payload.lookalike) add(['/lookalike'], 'recorded_change', 'miorail_store', 'lookalike_corpus', {}, scope);
      break;
    }
    case 'get_dividend_calendar':
      add(['/passThrough'], 'estimate', 'miorail_derived', 'dividend_arithmetic');
      rows(payload.stocks).forEach((stock, i) => {
        const scope = subject(stock), p = `/stocks/${i}`;
        const events: [Row, string][] = rows(stock.history).map((event, j) => [event, `${p}/history/${j}`]);
        if (stock.next) events.unshift([row(stock.next), `${p}/next`]);
        events.forEach(([event, path]) => {
          add([path], event.state === 'estimated' ? 'estimate' : 'declaration',
            event.source ? 'public_source' : 'miorail_derived', event.source ? 'company_release' : 'dividend_arithmetic',
            {}, scope, event.source ? [`${path}/source`] : []);
          const effect = row(event.token), kind = effect.kind;
          add([`${path}/token`], kind === 'estimate' ? 'estimate' : 'token_effect',
            kind === 'measured' || kind === 'scheduled' ? 'rpc' : 'miorail_derived',
            kind === 'scheduled' ? 'issuer_multiplier_schedule' : kind === 'measured' ? 'issuer_multiplier' : 'dividend_arithmetic',
            {}, { ...scope, ...(typeof effect.at === 'string' ? { effectiveAt: effect.at } : {}) });
        });
        if (stock.lastReadAt) add([`${p}/lastReadAt`], 'token_effect', 'rpc', 'issuer_multiplier',
          { observedAt: stock.lastReadAt }, scope);
        if (stock.notice) add([`${p}/notice`], 'announcement', 'rpc', 'issuer_announcement', {},
          { ...scope, effectiveAt: String(row(stock.notice).at) }, [`${p}/notice/transactionHash`]);
      });
      break;
    case 'get_recorded_changes': {
      const scope = { ...(iso(payload.since) ? { from: String(payload.since) } : {}),
        ...(iso(payload.observedAt) ? { until: String(payload.observedAt) } : {}) };
      corpus(['/changeCount', '/changeCountsByKind', '/subjectCount', '/watching', '/notWatched', '/truncated'], scope);
      if (payload.corporateActionRecord) corpus(['/corporateActionRecord'], scope);
      rows(payload.changes).forEach((change, i) => {
        const facts = row(change.facts);
        add([`/changes/${i}`], 'recorded_change', 'miorail_store', change.kind,
          { blockNumber: facts.blockNumber, evidenceHash: facts.evidenceHash },
          { ...scope, ...subject({ tokenAddress: change.subjectAddress }), ...question(facts) });
      });
      break;
    }
    case 'get_reopen_round': {
      corpus(['/round', '/next', '/closeDay']);
      const round = row(payload.round);
      rows(round.stocks).forEach((stock, i) => {
        const p = `/round/stocks/${i}`, scope = { ...subject(stock), roundId: String(round.roundId) };
        add([`${p}/close`], 'game', 'miorail_store', 'reopen_frozen_close', {}, { ...scope, phase: 'close' });
        if (stock.baseCall) add([`${p}/baseCall`], 'game', 'miorail_store', 'reopen_frozen_call', {}, { ...scope, phase: 'lock' });
        if (stock.result) add([`${p}/result`], 'game', 'miorail_store', 'reopen_frozen_result', {}, { ...scope, phase: 'reopen' });
        if (stock.baseNow) add([`${p}/baseNow`], 'game', 'miorail_derived', 'reopen_quote_median', {}, { ...scope, phase: 'base_now' });
      });
      break;
    }
  }
  return EvidencePackageV1Schema.parse({ schemaVersion: 'miorail-evidence-package/v1', chainId: 8453,
    generatedAt: now.toISOString(), claims,
    availability: { claims: claims.length, withBlock: claims.filter(c => c.block !== null).length,
      withObservedAt: claims.filter(c => c.observedAt !== null).length, withHash: claims.filter(c => c.hash !== null).length },
    interpretation: [
      'Paths are JSON Pointers into this answer. Scope and provenance apply only to the named claim, not its siblings.',
      'Null means not available in this returned evidence; it never means zero, safe, absent or freshly checked.',
      'generatedAt is packaging time, not measurement time. Effective dates, publication dates and coverage ranges are separate clocks.',
      'Hashes are existing source-content, measurement or snapshot hashes, not a new answer hash or a signature. A transaction hash is a lookup reference, not an evidence hash.',
    ] });
}
