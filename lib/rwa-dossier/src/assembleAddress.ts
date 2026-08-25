import {
  inspectB20TokenV1,
  type B20BlockAnchorV1,
  type B20ControlSnapshotV1,
  type B20ReaderV1,
} from '@mioagent/b20-control';
import type {
  CashExitMeasurementRunV1,
  MarketTailRepositoryV1,
  OfficialAssetRepositoryV1,
  OfficialCashExitRepositoryV1,
  OfficialLookalikeRepositoryV1,
} from '@mioagent/route-storage';
import { isOfficialV1 } from '@mioagent/route-storage';

import { controlsFromSnapshotV1, marketProjectionV1 } from './assemble.js';
import {
  AddressDossierV1Schema,
  hashAddressDossierV1,
  type AddressDossierV1,
  type AddressIdentityV1,
  type AddressStandingV1,
  type CashExitChangeV1,
} from './addressDossier.js';
import type { OfficialCashExitRungPreviewV1 } from './discover.js';
import { previewLadderFromRunV1, routeStatusFromPreviewV1 } from './overview.js';
import { readTokenizedStockReferenceV1, unavailableTokenizedStockReferenceV1 } from './reference.js';

const ZERO_HASH_V1 = `0x${'0'.repeat(64)}` as const;

/**
 * The launch index, as this read needs it.
 *
 * Declared structurally rather than imported whole: the dossier wants one row
 * by address and nothing else, and depending on the feed's entire repository
 * would drag its pagination, its cursors and its projection in with it.
 */
export interface AddressLaunchSourceV1 {
  getFeedRowForToken(input: { tokenAddress: string; historyLimit: number }): Promise<{
    row: {
      launch: {
        tokenAddress: string;
        /** `${transactionHash}:${logIndex}` — how the deployer read is keyed. */
        transactionHash?: string | null;
        logIndex?: number | null;
        symbol?: string | null;
        name?: string | null;
        decimals?: number | null;
        canonical?: boolean;
        blockNumber?: string | null;
        detectedAt?: string | null;
      };
    };
  } | null>;
}

/**
 * The launch transaction's sender, as this read needs it.
 *
 * Null from `readDeployer` means nobody has read that launch's transaction —
 * which is a statement about how far our backfill has got, never about the
 * launch. A row with a null `deployerAddress` means the endpoint answered and
 * the transaction was not there. Three states, and a nullable field would
 * collapse them into one.
 */
export interface AddressDeployerSourceV1 {
  readDeployer(launchId: string): Promise<{
    deployerAddress: string | null;
    /**
     * What the sender's relation to the factory establishes, classified by the
     * caller with `b20SenderRelationV1` — the one place that rule lives.
     *
     * Classifying here would be a second copy of it, and a second copy of a
     * rule this specific drifts towards the permissive reading. What this file
     * owns instead is the REDACTION: only `direct` may travel with an address,
     * and the schema refuses the row if a caller gets that wrong.
     */
    relation: 'direct' | 'bundler' | 'intermediary' | 'contract_creation';
    readAt: string;
  } | null>;
}

/** The project claims, as this read needs them. */
export interface AddressProjectSourceV1 {
  readProject(input: { chainId: number; tokenAddress: string }): Promise<{
    claim: { claimantDomain: string; status: string; lastCheckedAt: string };
  } | null>;
}

export interface AddressDossierDepsV1 {
  official: OfficialAssetRepositoryV1;
  cashExit: OfficialCashExitRepositoryV1;
  marketTail: MarketTailRepositoryV1;
  lookalikes: OfficialLookalikeRepositoryV1;
  /** Absent on a deployment without the launch index. Its absence is reported
   * as unknown provenance, never as "not a B20". */
  launches?: AddressLaunchSourceV1 | null;
  projects?: AddressProjectSourceV1 | null;
  deployers?: AddressDeployerSourceV1 | null;
  reader: B20ReaderV1;
  now: () => Date;
}

function fieldValueV1(snapshot: B20ControlSnapshotV1 | null, key: string): string | null {
  const field = snapshot?.fields.find((row) => row.key === key);
  return field?.status === 'exact_chain_read' ? field.value : null;
}

/**
 * Which rungs can be compared, and what moved.
 *
 * Comparable is deliberately narrow: the same size to the same destination in
 * two runs. A rung present in one reading and absent from the other is not a
 * change, it is a different question, and reporting it as one would put a
 * movement on screen that nothing measured.
 */
export function cashExitChangeV1(input: {
  previous: CashExitMeasurementRunV1 | null;
  next: CashExitMeasurementRunV1 | null;
}): CashExitChangeV1 {
  if (input.next === null) {
    return { status: 'first_reading', previousMeasuredAt: null, measuredAt: null, rungs: [] };
  }
  if (input.previous === null) {
    return {
      status: 'first_reading',
      previousMeasuredAt: null,
      measuredAt: input.next.completedAt,
      rungs: [],
    };
  }
  const before = new Map(
    previewLadderFromRunV1(input.previous).map((rung) => [
      `${rung.destination}:${rung.requestedCashAtomic}`,
      rung,
    ]),
  );
  const rungs = previewLadderFromRunV1(input.next).flatMap((rung) => {
    const prior = before.get(`${rung.destination}:${rung.requestedCashAtomic}`);
    if (!prior) return [];
    const bothCosted = prior.roundTripCostBps !== null && rung.roundTripCostBps !== null;
    return [
      {
        requestedCashAtomic: rung.requestedCashAtomic,
        destination: rung.destination,
        previousRoundTripCostBps: prior.roundTripCostBps,
        roundTripCostBps: rung.roundTripCostBps,
        // Null when either side has no cost. Subtracting a number from an
        // absence is how a first measurement becomes a dramatic move.
        changeBps: bothCosted
          ? (BigInt(rung.roundTripCostBps!) - BigInt(prior.roundTripCostBps!)).toString()
          : null,
        previousStatus: prior.status,
        status: rung.status,
      },
    ];
  });
  return {
    status: rungs.length > 0 ? 'compared' : 'not_comparable',
    previousMeasuredAt: input.previous.completedAt,
    measuredAt: input.next.completedAt,
    rungs,
  };
}

/**
 * What this read settled, and what it did not.
 *
 * Computed from the bundle and nothing else, which is the whole point: the
 * roadmap asks for a "structured Miorail summary derived only from the
 * evidence bundle", and a deterministic partition cannot say a thing the
 * bundle does not contain. Every unknown is phrased as *not established* --
 * never as a negative finding, because almost none of them are one.
 */
export function addressAssertionsV1(input: {
  identity: AddressIdentityV1;
  referenceValue: AddressDossierV1['referenceValue'];
  controls: AddressDossierV1['controls'];
  market: AddressDossierV1['market'];
}): { established: AddressDossierV1['established']; unknown: AddressDossierV1['unknown'] } {
  const established: AddressDossierV1['established'] = [];
  const unknown: AddressDossierV1['unknown'] = [];
  const { identity, market } = input;

  if (identity.official) {
    established.push({
      claim: `Officially issued as ${identity.official.ticker} by ${identity.official.issuer}.`,
      evidence: `Listed at this exact address by ${identity.official.listedIn.length} reviewed source(s).`,
    });
    if (identity.official.sourceDiscrepancy) {
      unknown.push({
        claim: 'Whether the reviewed sources agree about this asset.',
        reason: 'They do not. Both readings are shown rather than reconciled.',
      });
    }
  } else {
    unknown.push({
      claim: 'Whether an issuer publishes this exact address.',
      reason: 'No reviewed source lists it. That is the ordinary answer for almost every token.',
    });
  }

  if (identity.project) {
    established.push({
      claim: `A claim by ${identity.project.claimantDomain} is ${identity.project.status}.`,
      evidence: 'A domain the project controls names this exact address.',
    });
  }

  if (identity.launch) {
    established.push({
      claim: 'The B20 index ingested this contract from the pinned factory.',
      evidence: identity.launch.detectedAt
        ? `First seen by the index at ${identity.launch.detectedAt}.`
        : 'Stored by the index without a detection time.',
    });
  } else {
    unknown.push({
      claim: 'When this contract was launched.',
      reason: 'The B20 launch index does not hold it. That is about our index, not the contract.',
    });
  }

  switch (identity.origin.status) {
    case 'established':
      established.push({
        claim: 'The launch transaction was sent straight to the B20 factory.',
        evidence:
          'The sender called the factory itself, with no contract in between — the one identity anchor on a launch that nobody can type into a log.',
      });
      break;
    case 'relayed':
      unknown.push({
        claim: 'Who launched this contract.',
        reason:
          identity.origin.relation === 'bundler'
            ? 'The transaction was relayed through the ERC-4337 EntryPoint, so its sender is a bundler acting for somebody else. Miorail cannot see who, and will not guess.'
            : 'A contract stood between the sender and the factory, so whether that sender launched the token or relayed for whoever did is not established.',
      });
      break;
    case 'transaction_absent':
      unknown.push({
        claim: 'Who launched this contract.',
        reason: 'The endpoint answered and the launch transaction was not there.',
      });
      break;
    case 'not_read':
      unknown.push({
        claim: 'Who launched this contract.',
        reason: 'Its transaction has not been read yet. That is about our backfill, not the launch.',
      });
      break;
    case 'no_launch_row':
      break;
  }

  if (identity.lookalike) {
    established.push({
      claim: `It declares a name ${identity.lookalike.officialTicker} also answers to.`,
      // The sentence that keeps a resemblance a resemblance.
      evidence: `Matched on "${identity.lookalike.matchedValue}". The addresses differ, which is what makes this a resemblance and not the asset.`,
    });
  }

  if (identity.contract.status === 'unavailable') {
    unknown.push({
      claim: 'What the contract itself answers.',
      reason: 'The chain read did not complete. Nothing here is a statement about the contract.',
    });
  } else if (identity.contract.isB20 === false) {
    established.push({
      claim: 'The pinned B20 factory does not recognise this address.',
      evidence: 'isB20 returned false at the observed block.',
    });
  }

  if (input.referenceValue === null) {
    unknown.push({
      claim: 'A reference price.',
      reason: 'No reviewed source binds a price feed to this address.',
    });
  } else if (input.referenceValue.status === 'fresh') {
    established.push({
      claim: 'A reference price was read inside its freshness window.',
      evidence: 'Chainlink total-return feed, read at the anchored block.',
    });
  } else {
    unknown.push({
      claim: 'A usable reference price.',
      reason: `The feed read as ${input.referenceValue.status}.`,
    });
  }

  switch (market.routeStatus) {
    case 'cash_route_established':
      established.push({
        claim: 'A round trip to cash completed at a measured size.',
        evidence: `Quoted through ${market.approvedSources.join(', ') || 'the approved router set'}.`,
      });
      break;
    case 'no_route_at_measured_sizes':
      established.push({
        claim: 'No approved router would sell it back to cash at any measured size.',
        evidence: 'Every measured rung returned no exit route.',
      });
      break;
    case 'no_entry_route_at_measured_sizes':
      established.push({
        claim: 'No approved router would sell it to you for cash at any measured size.',
        evidence: 'Every measured rung was refused on the buy leg.',
      });
      unknown.push({
        claim: 'Whether a position already held could be sold.',
        reason: 'The ladder is sized in cash, so with no buy route the sell was never attempted.',
      });
      break;
    case 'measurement_failed':
      unknown.push({
        claim: 'What it costs to get out.',
        reason: 'Our own router call did not complete. This says nothing about the market.',
      });
      break;
    case 'not_measured':
      unknown.push({
        claim: 'What it costs to get out.',
        reason: 'Nothing has measured a cash route for this address yet.',
      });
      break;
  }

  if (market.change.status === 'first_reading') {
    unknown.push({
      claim: 'What has changed since the last reading.',
      reason: 'There is only one reading, so there is nothing to compare it with.',
    });
  }

  if (market.activity.status === 'unavailable') {
    unknown.push({
      claim: 'Whether this token has moved through a venue.',
      reason: 'The ledger tail has not read it.',
    });
  }

  if (input.controls.status !== 'complete') {
    unknown.push({
      claim: 'The full set of on-chain controls.',
      reason:
        input.controls.status === 'unavailable'
          ? 'No control field could be read at the anchored block.'
          : 'Some control fields could not be read at the anchored block.',
    });
  }
  // True of every B20 and worth saying once: a card that listed controls
  // without it reads as if the holders were checked and found empty.
  unknown.push({
    claim: 'Who holds these controls.',
    reason: 'B20 exposes hasRole(role, account) and no enumeration, so no holder is readable.',
  });

  return { established: established.slice(0, 24), unknown: unknown.slice(0, 24) };
}

export async function assembleAddressDossierV1(
  deps: AddressDossierDepsV1,
  input: { chainId: 8453; tokenAddress: string },
): Promise<AddressDossierV1> {
  const now = deps.now();
  const tokenAddress = input.tokenAddress.toLowerCase();

  const [identityRow, lookalikeRow, launchRow, projectRow, discrepancies, universe] =
    await Promise.all([
      deps.official.officialIdentity({ chainId: 8453, tokenAddress }),
      deps.lookalikes.lookalikeFor({ chainId: 8453, tokenAddress }),
      deps.launches?.getFeedRowForToken({ tokenAddress, historyLimit: 1 }) ?? Promise.resolve(null),
      deps.projects?.readProject({ chainId: 8453, tokenAddress }) ?? Promise.resolve(null),
      deps.official.sourceDiscrepancies({ chainId: 8453 }),
      deps.official.officialAssets({ chainId: 8453, limit: 64 }),
    ]);
  const official = isOfficialV1(identityRow) ? identityRow : null;

  // The launch id is `${transactionHash}:${logIndex}`, and the deployer read is
  // keyed by it. No launch row means no transaction to have read — which is
  // about our index, not about who deployed the contract.
  const launchId =
    launchRow?.row.launch.transactionHash && launchRow.row.launch.logIndex !== undefined
      ? `${launchRow.row.launch.transactionHash}:${launchRow.row.launch.logIndex}`
      : null;
  const deployerRow =
    launchId === null || !deps.deployers ? null : await deps.deployers.readDeployer(launchId);
  const origin: AddressIdentityV1['origin'] =
    launchId === null
      ? { status: 'no_launch_row', deployerAddress: null, relation: null, readAt: null }
      : deployerRow === null
        ? // Nobody has read this launch's transaction yet. A statement about
          // how far the backfill has got, never about the launch.
          { status: 'not_read', deployerAddress: null, relation: null, readAt: null }
        : deployerRow.deployerAddress === null
          ? { status: 'transaction_absent', deployerAddress: null, relation: null, readAt: deployerRow.readAt }
          : deployerRow.relation === 'direct'
            ? {
                status: 'established',
                deployerAddress: deployerRow.deployerAddress,
                relation: 'direct',
                readAt: deployerRow.readAt,
              }
            : // A bundler, a relayer or an intermediary contract. The sender
              // paid to include the transaction and is not the launcher, so the
              // relation travels and the address does not.
              {
                status: 'relayed',
                deployerAddress: null,
                relation: deployerRow.relation,
                readAt: deployerRow.readAt,
              };

  const anchorRead = await deps.reader.readBlockAnchor();
  const anchor: B20BlockAnchorV1 | null = anchorRead.ok ? anchorRead.value : null;
  let snapshot: B20ControlSnapshotV1 | null = null;
  if (anchor !== null) {
    const inspected = await inspectB20TokenV1(
      { reader: deps.reader },
      { tenantId: 'address-dossier', chainId: 8453, tokenAddress, now, anchor },
    );
    snapshot = inspected.snapshot;
  }
  const controls = controlsFromSnapshotV1(snapshot, now);

  const listed = official?.listings.filter((row) => row.currentlyListed) ?? [];
  const feedAddress = listed.find((row) => row.referenceFeedAddress !== null)?.referenceFeedAddress ?? null;
  const referenceValue =
    official === null || feedAddress === null
      ? null
      : anchor === null
        ? unavailableTokenizedStockReferenceV1({ feedAddress, reason: 'reference_unavailable' })
        : await readTokenizedStockReferenceV1(deps.reader, {
            feedAddress,
            anchor,
            now,
            // Base Docs names the registry pause but publishes no callable
            // ABI. Unknown, never inferred from a fresh answer.
            registryPause: null,
          });

  const [latestRun, previousRun] = await Promise.all([
    deps.cashExit.latestCompletedRun({ chainId: 8453, tokenAddress, scope: 'public_ladder' }),
    deps.cashExit.previousCompletedRun({ chainId: 8453, tokenAddress, scope: 'public_ladder' }),
  ]);
  const ladder: OfficialCashExitRungPreviewV1[] = previewLadderFromRunV1(latestRun);
  const market = await marketProjectionV1(
    { marketTail: deps.marketTail, now: deps.now },
    tokenAddress,
    new Set(universe.map((asset) => asset.tokenAddress)),
  );

  const standing: AddressStandingV1 =
    official !== null
      ? 'official'
      : projectRow?.claim.status === 'verified'
        ? 'project_verified'
        : launchRow !== null
          ? 'indexed_launch'
          : 'unknown_to_miorail';

  const identity: AddressIdentityV1 = {
    standing,
    official:
      official === null
        ? null
        : {
            ticker: (listed[0] ?? official.listings[0]!).ticker,
            displayName: listed.map((row) => row.displayName).find((name) => name) ?? null,
            issuer: official.issuer,
            listedIn: [...new Set(listed.map((row) => row.sourceKind))].sort(),
            sourceDiscrepancy: discrepancies.some(
              (item) => 'tokenAddress' in item && item.tokenAddress === tokenAddress,
            ),
            referenceFeedAddress: feedAddress,
          },
    project:
      projectRow === null
        ? null
        : {
            claimantDomain: projectRow.claim.claimantDomain,
            status: projectRow.claim.status,
            verifiedAt: projectRow.claim.lastCheckedAt,
          },
    launch:
      launchRow === null
        ? null
        : {
            symbol: (launchRow.row.launch.symbol ?? '').slice(0, 120),
            name: (launchRow.row.launch.name ?? '').slice(0, 200),
            decimals: launchRow.row.launch.decimals ?? null,
            canonical: launchRow.row.launch.canonical ?? true,
            blockNumber: launchRow.row.launch.blockNumber ?? null,
            detectedAt: launchRow.row.launch.detectedAt ?? null,
          },
    origin,
    // An official contract can never be a lookalike, so the row is dropped
    // rather than rendered alongside the listing that disproves it.
    lookalike:
      lookalikeRow === null || official !== null
        ? null
        : {
            officialAddress: lookalikeRow.officialAddress,
            officialTicker:
              universe
                .find((asset) => asset.tokenAddress === lookalikeRow.officialAddress)
                ?.listings[0]?.ticker ?? 'the official asset',
            matchKind: lookalikeRow.matchKind,
            matchedAlias: lookalikeRow.matchedAlias,
            matchedValue: lookalikeRow.matchedValue,
            firstFlaggedAt: lookalikeRow.firstFlaggedAt,
          },
    contract:
      snapshot === null
        ? { status: 'unavailable', isB20: null, symbol: null, name: null, decimals: null }
        : {
            status: 'read',
            isB20:
              snapshot.detection.outcome === 'b20' || snapshot.detection.outcome === 'b20_uninitialised'
                ? true
                : snapshot.detection.outcome === 'not_b20'
                  ? false
                  : // Our read failing is not a negative answer.
                    null,
            symbol: fieldValueV1(snapshot, 'token_symbol'),
            name: fieldValueV1(snapshot, 'token_name'),
            decimals: (() => {
              const raw = fieldValueV1(snapshot, 'token_decimals');
              const value = raw === null ? Number.NaN : Number(raw);
              return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
            })(),
          },
  };

  const marketBlock: AddressDossierV1['market'] = {
    routeStatus: routeStatusFromPreviewV1(ladder),
    measuredAt: latestRun?.completedAt ?? null,
    approvedSources: latestRun?.approvedSources ?? [],
    ladder,
    change: cashExitChangeV1({ previous: previousRun, next: latestRun }),
    topology: market.topology,
    activity: market.activity,
  };

  const { established, unknown } = addressAssertionsV1({
    identity,
    referenceValue,
    controls,
    market: marketBlock,
  });

  const draft = {
    schemaVersion: 'address-dossier/v1' as const,
    dossierHash: ZERO_HASH_V1,
    assembly: 'deterministic_no_llm_facts' as const,
    chainId: 8453 as const,
    tokenAddress,
    assembledAt: now.toISOString(),
    identity,
    referenceValue,
    controls,
    market: marketBlock,
    established,
    unknown,
  };
  return AddressDossierV1Schema.parse({ ...draft, dossierHash: hashAddressDossierV1(draft) });
}
