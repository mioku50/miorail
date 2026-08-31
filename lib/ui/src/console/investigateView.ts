import {
  rwaAgeLabelV1,
  rwaBpsLabelV1,
  cashSizeLabelV1,
  moneyLabelV1,
  type FactViewV1,
  type ToneV1,
} from './rwaDiscoverView';
import { swapProviderDisplayNameV1 } from './providerDiagnostics';

// ---------------------------------------------------------------------------
// Phase 7 — one pasted address, turned into something a person reads.
//
// The rule that shapes every section: this surface says what is ESTABLISHED
// and what is NOT ESTABLISHED, and it never says "no". Almost nothing a reader
// pastes will be officially issued, indexed, claimed or measured, and printing
// those absences as findings would make the ordinary case look like an
// accusation.
//
// One vocabulary rule is absolute, and it is the user's:
//
//   The evidence layer establishes venue TRANSFERS. Until a venue-specific
//   swap event has been independently confirmed, nothing here may render a
//   movement as a trade, a buy, a sell, a buyer, a seller or a trader.
//
// The section is therefore called "Observed market activity" and carries the
// semantics in words. Measured: of 34 transactions moving a tracked asset
// through the Uniswap v4 singleton, 32 carried a Swap event and 2 did not.
// That confirmer is not built, so the caveat is not optional.
// ---------------------------------------------------------------------------

export const OBSERVED_ACTIVITY_TITLE_V1 = 'Observed market activity';
export const OBSERVED_ACTIVITY_SEMANTICS_V1 =
  'Venue transfers · not confirmed swaps. A pool receives and pays a token when somebody swaps and also when somebody adds or removes liquidity, and Miorail has not confirmed which happened here.';

export interface AddressDossierWireV1 {
  tokenAddress: string;
  assembledAt: string;
  identity: {
    standing: 'official' | 'project_verified' | 'indexed_launch' | 'unknown_to_miorail';
    official: {
      ticker: string;
      displayName: string | null;
      issuer: string;
      listedIn: readonly ('base_docs_technical' | 'base_product_list' | 'backed_assets_api')[];
      sourceDiscrepancy: boolean;
      referenceFeedAddress: string | null;
    } | null;
    project: { claimantDomain: string; status: string; verifiedAt: string | null } | null;
    launch: {
      symbol: string;
      name: string;
      decimals: number | null;
      canonical: boolean;
      blockNumber: string | null;
      detectedAt: string | null;
    } | null;
    lookalike: {
      officialAddress: string;
      officialTicker: string;
      matchKind: string;
      matchedAlias: 'published_ticker' | 'underlying' | 'display_name';
      matchedValue: string;
      firstFlaggedAt: string;
    } | null;
    origin: {
      status: 'established' | 'relayed' | 'transaction_absent' | 'not_read' | 'no_launch_row';
      deployerAddress: string | null;
      relation: 'direct' | 'bundler' | 'intermediary' | 'contract_creation' | null;
      readAt: string | null;
    };
    contract: {
      status: 'read' | 'unavailable';
      isB20: boolean | null;
      symbol: string | null;
      name: string | null;
      decimals: number | null;
    };
  };
  referenceValue: {
    status: 'fresh' | 'stale' | 'paused' | 'unavailable' | 'invalid';
    valueAtomic: string | null;
    decimals: number | null;
    ageSeconds: number | null;
    feedAddress: string | null;
  } | null;
  controls: {
    status: 'complete' | 'partial' | 'unavailable';
    blockNumber: string | null;
    observedAt: string;
    multiplier: { status: string; atomic: string | null; decimals: number };
    fields: readonly {
      key: string;
      status: 'exact_chain_read' | 'unavailable' | 'unsupported_by_variant';
      value: string | null;
      reason: string | null;
    }[];
  };
  market: {
    routeStatus:
      | 'cash_route_established'
      | 'no_route_at_measured_sizes'
      | 'no_entry_route_at_measured_sizes'
      | 'measurement_failed'
      | 'not_measured';
    measuredAt: string | null;
    approvedSources: readonly string[];
    ladder: readonly {
      requestedCashAtomic: string;
      destination: 'USDC' | 'ETH';
      status: string;
      roundTripCostBps: string | null;
      derivedFromExactRung: boolean;
      lowerBoundRequestedCashAtomic: string | null;
      entryRouteRefused: boolean;
    }[];
    change: {
      status: 'compared' | 'first_reading' | 'not_comparable';
      previousMeasuredAt: string | null;
      measuredAt: string | null;
      rungs: readonly {
        requestedCashAtomic: string;
        destination: 'USDC' | 'ETH';
        previousRoundTripCostBps: string | null;
        roundTripCostBps: string | null;
        changeBps: string | null;
        previousStatus: string;
        status: string;
      }[];
    };
    topology: {
      status: 'observed' | 'unavailable';
      checkedThroughBlock: number | null;
      venueCount: number | null;
      pairedPoolCount: number | null;
      directCashPoolCount: number | null;
    };
    activity: {
      status: 'observed' | 'no_movements_observed' | 'unavailable';
      semantics: 'venue_transfers_not_confirmed_swaps';
      movementCount: number | null;
      outOfVenueCount: number | null;
      intoVenueCount: number | null;
      confirmedSwapCount: null;
      latest: readonly {
        venueAddress: string;
        direction: 'out_of_venue' | 'into_venue';
        counterparty: string;
        counterpartyRole: 'unattributed_counterparty';
        amountAtomic: string;
        blockNumber: number;
        observedAt: string;
      }[];
    };
  };
  established: readonly { claim: string; evidence: string }[];
  unknown: readonly { claim: string; reason: string }[];
}

const STANDING_COPY_V1: Readonly<
  Record<AddressDossierWireV1['identity']['standing'], { chip: string; tone: ToneV1; body: string }>
> = {
  official: {
    chip: 'OFFICIAL',
    tone: 'good',
    body: 'A reviewed source lists this exact address as officially issued.',
  },
  project_verified: {
    chip: 'PROJECT VERIFIED',
    tone: 'good',
    body: 'A domain the project controls names this exact address. That establishes who claims it, not what it is worth.',
  },
  indexed_launch: {
    chip: 'INDEXED LAUNCH',
    tone: 'neutral',
    // Provenance, not trust. Being in the index means the pinned factory
    // emitted the contract; it says nothing about who is behind the token.
    body: 'The B20 index ingested this contract from the pinned factory. That is where it came from, not who is behind it.',
  },
  unknown_to_miorail: {
    chip: 'NOT ESTABLISHED',
    tone: 'off',
    body: 'No reviewed source lists this address, no project claims it, and the B20 index has not ingested it. That is the ordinary answer for almost every contract on Base — it is not a finding against this one.',
  },
};

const SOURCE_LABEL_V1: Readonly<
  Record<'base_docs_technical' | 'base_product_list' | 'backed_assets_api', string>
> = {
  base_docs_technical: 'Base docs',
  base_product_list: 'Base product page',
  backed_assets_api: 'Backed bTokens API',
};

const ORIGIN_COPY_V1: Readonly<
  Record<AddressDossierWireV1['identity']['origin']['status'], { label: string; detail: string }>
> = {
  established: {
    label: 'Sent straight to the B20 factory',
    detail:
      'This address called the factory itself, with no contract in between — the one identity anchor on a launch that nobody can type into a log.',
  },
  relayed: {
    label: 'Relayed',
    detail:
      'The transaction reached the factory through something else, so its sender paid to include it rather than launched the token. Miorail does not show that address as a deployer and will not guess who was.',
  },
  transaction_absent: {
    label: 'Launch transaction not found',
    detail: 'The endpoint answered and the transaction was not there.',
  },
  not_read: {
    label: 'Not read yet',
    detail:
      'This launch’s transaction has not been read. That is about our backfill, not the launch.',
  },
  no_launch_row: {
    label: 'Not established',
    detail:
      'The B20 index does not hold a launch for this address, so there is no transaction to read.',
  },
};

const RELATION_DETAIL_V1: Readonly<Record<string, string>> = {
  bundler:
    'Submitted through the ERC-4337 EntryPoint by a bundler acting for somebody else. Across the stored corpus 458 launches arrived this way from eight senders.',
  intermediary: 'A contract stood between the sender and the factory.',
  contract_creation: 'The transaction created a contract directly, with no recipient.',
  direct: '',
};

const CONTROL_LABEL_V1: Readonly<Record<string, string>> = {
  token_name: 'Name',
  token_symbol: 'Symbol',
  token_decimals: 'Decimals',
  supply_cap: 'Supply cap',
  paused_features: 'Paused features',
  transfer_sender_policy: 'Who may send',
  transfer_receiver_policy: 'Who may receive',
  transfer_executor_policy: 'Who may move on your behalf',
  rebase_multiplier: 'Rebase multiplier',
};

export interface InvestigateViewV1 {
  tokenAddress: string;
  /** Symbol and name are DISPLAY. They travel with the address, never alone. */
  displaySymbol: string | null;
  displayName: string | null;
  standing: { chip: string; tone: ToneV1; body: string };
  readAt: string;
  established: readonly { claim: string; evidence: string }[];
  unknown: readonly { claim: string; reason: string }[];
  identityFacts: FactViewV1[];
  origin: { label: string; detail: string; address: string | null };
  reference: FactViewV1[];
  controls: { status: string; note: string; rows: FactViewV1[] };
  ladder: FactViewV1[];
  ladderNote: string | null;
  change: { headline: string; rows: FactViewV1[] };
  topology: FactViewV1[];
  activity: {
    title: string;
    semantics: string;
    headline: string;
    facts: FactViewV1[];
    movements: {
      direction: string;
      amount: string;
      venue: string;
      counterparty: string;
      when: string;
    }[];
  };
}

export function investigateViewV1(wire: AddressDossierWireV1, now: Date): InvestigateViewV1 {
  const { identity, market } = wire;
  const standing = STANDING_COPY_V1[identity.standing];

  const identityFacts: FactViewV1[] = [];
  if (identity.official) {
    identityFacts.push({
      label: 'Listed by',
      value:
        identity.official.listedIn.map((kind) => SOURCE_LABEL_V1[kind]).join(' + ') || 'no source',
      note: identity.official.sourceDiscrepancy
        ? 'The reviewed sources do not agree; both readings are kept'
        : null,
      tone: identity.official.sourceDiscrepancy ? 'warn' : 'good',
    });
    identityFacts.push({
      label: 'Issuer',
      value: identity.official.issuer,
      note: 'As the reviewed source states it',
      tone: 'neutral',
    });
  }
  if (identity.project) {
    identityFacts.push({
      label: 'Claimed by',
      value: identity.project.claimantDomain,
      note: `Claim is ${identity.project.status}`,
      tone: identity.project.status === 'verified' ? 'good' : 'off',
    });
  }
  if (identity.launch) {
    identityFacts.push({
      label: 'Indexed',
      value: rwaAgeLabelV1(identity.launch.detectedAt, now) ?? 'at an unknown time',
      note: identity.launch.canonical ? 'Canonical launch row' : 'Non-canonical launch row',
      tone: 'neutral',
    });
  }
  identityFacts.push({
    label: 'Recognised by the B20 factory',
    value:
      identity.contract.status === 'unavailable'
        ? 'not read'
        : identity.contract.isB20 === null
          ? 'not read'
          : identity.contract.isB20
            ? 'yes'
            : 'no',
    note:
      identity.contract.status === 'unavailable' || identity.contract.isB20 === null
        ? 'The chain read did not complete, so this says nothing about the contract'
        : 'isB20, read at the anchored block',
    tone: identity.contract.isB20 === null ? 'off' : 'neutral',
  });
  if (identity.lookalike) {
    identityFacts.push({
      label: 'Resembles',
      value: identity.lookalike.officialTicker,
      // The sentence that keeps a resemblance a resemblance.
      note: `Matched on "${identity.lookalike.matchedValue}" — the addresses differ, and a resemblance establishes no relationship between the contracts`,
      tone: 'warn',
    });
  }

  const reference: FactViewV1[] =
    wire.referenceValue === null
      ? [
          {
            label: 'Reference value',
            value: 'not established',
            note: 'No reviewed source binds a price feed to this address',
            tone: 'off',
          },
        ]
      : [
          {
            label: 'Reference value',
            value:
              moneyLabelV1(wire.referenceValue.valueAtomic, wire.referenceValue.decimals) ??
              'not available',
            note:
              wire.referenceValue.status === 'fresh'
                ? `Chainlink total-return feed${
                    wire.referenceValue.ageSeconds === null
                      ? ''
                      : ` · updated ${
                          rwaAgeLabelV1(
                            new Date(
                              now.getTime() - wire.referenceValue.ageSeconds * 1000,
                            ).toISOString(),
                            now,
                          ) ?? 'recently'
                        }`
                  }`
                : `The feed read as ${wire.referenceValue.status}`,
            tone: wire.referenceValue.status === 'fresh' ? 'good' : 'warn',
          },
        ];

  const controlRows: FactViewV1[] = wire.controls.fields.map((field) => ({
    label: CONTROL_LABEL_V1[field.key] ?? field.key,
    // Null renders the reason, never a blank and never a guess.
    value: field.status === 'exact_chain_read' ? (field.value ?? 'not read') : 'not read',
    note:
      field.status === 'exact_chain_read' ? null : (field.reason ?? 'This field could not be read'),
    tone: field.status === 'exact_chain_read' ? 'neutral' : 'off',
  }));

  const ladder: FactViewV1[] = market.ladder
    .filter((rung) => rung.destination === 'USDC' && rung.status !== 'not_measured')
    .map((rung) => ({
      label: cashSizeLabelV1(rung.requestedCashAtomic),
      value:
        rwaBpsLabelV1(rung.roundTripCostBps) ??
        (rung.entryRouteRefused
          // The SAME words Discover and Stocks use. This was a second,
          // independent copy of the label, so fixing one screen would have
          // left the product naming one state two ways.
          ? 'no buy route'
          : rung.status === 'full'
            ? 'round trip'
            : 'no exit route'),
      note: rung.derivedFromExactRung
        ? `carried from ${cashSizeLabelV1(rung.lowerBoundRequestedCashAtomic ?? '0')}`
        : null,
      tone: rung.status === 'full' ? 'good' : 'warn',
    }));

  const changeRows: FactViewV1[] = market.change.rungs.map((rung) => {
    const move = rwaBpsLabelV1(rung.changeBps);
    return {
      label: cashSizeLabelV1(rung.requestedCashAtomic),
      value:
        move === null
          ? `${rung.previousStatus} → ${rung.status}`
          : `${move.startsWith('-') ? '' : '+'}${move}`,
      note:
        move === null
          ? 'One of the two readings carried no cost, so there is nothing to subtract'
          : `${rwaBpsLabelV1(rung.previousRoundTripCostBps) ?? '—'} → ${rwaBpsLabelV1(rung.roundTripCostBps) ?? '—'}`,
      tone:
        move === null
          ? 'off'
          : move === '0.00%'
            ? 'neutral'
            : move.startsWith('-')
              ? 'good'
              : 'warn',
    };
  });

  const changeHeadline =
    market.change.status === 'first_reading'
      ? 'One reading on file, so there is nothing to compare it with. This is not a market that has not moved.'
      : market.change.status === 'not_comparable'
        ? 'The two readings measured different sizes, so nothing here is comparable. A different question is not a change.'
        : `Against the reading from ${rwaAgeLabelV1(market.change.previousMeasuredAt, now) ?? 'an unknown time'}.`;

  const activity = market.activity;
  return {
    tokenAddress: wire.tokenAddress,
    displaySymbol:
      identity.contract.symbol ?? identity.official?.ticker ?? identity.launch?.symbol ?? null,
    displayName:
      identity.contract.name ?? identity.official?.displayName ?? identity.launch?.name ?? null,
    standing,
    readAt: rwaAgeLabelV1(wire.assembledAt, now) ?? 'just now',
    established: wire.established,
    unknown: wire.unknown,
    identityFacts,
    origin: {
      ...ORIGIN_COPY_V1[identity.origin.status],
      detail:
        identity.origin.status === 'relayed' && identity.origin.relation
          ? `${ORIGIN_COPY_V1.relayed.detail} ${RELATION_DETAIL_V1[identity.origin.relation] ?? ''}`.trim()
          : ORIGIN_COPY_V1[identity.origin.status].detail,
      // Present only for a direct-to-factory launch. The schema refuses the
      // row otherwise, so this can never render a bundler as a deployer.
      address: identity.origin.deployerAddress,
    },
    reference,
    controls: {
      status: wire.controls.status,
      note:
        wire.controls.status === 'complete'
          ? `Read at Base block ${wire.controls.blockNumber ?? '—'}. Who holds these controls is not readable: B20 exposes hasRole(role, account) and no enumeration.`
          : wire.controls.status === 'partial'
            ? 'Some fields could not be read at the anchored block. Who holds these controls is not readable either way.'
            : 'No control field could be read at the anchored block. Nothing here is a statement about the contract.',
      rows: controlRows,
    },
    ladder,
    ladderNote:
      ladder.length === 0
        ? null
        : `Exact sizes only, quoted through ${market.approvedSources.map((source) => swapProviderDisplayNameV1(source)).join(', ') || 'no approved router'} · measured ${
            rwaAgeLabelV1(market.measuredAt, now) ?? 'at an unknown time'
          }. Nothing here was executed.`,
    change: { headline: changeHeadline, rows: changeRows },
    topology: [
      {
        label: 'Identified pools',
        value:
          market.topology.status === 'unavailable'
            ? 'not observed'
            : String(market.topology.pairedPoolCount ?? 0),
        note:
          market.topology.status === 'unavailable'
            ? 'The ledger tail has not read this token'
            : 'Pools holding this exact token as one side of the pair',
        tone: market.topology.status === 'unavailable' ? 'off' : 'neutral',
      },
      {
        label: 'Reachable in one hop to cash',
        value:
          market.topology.status === 'unavailable'
            ? 'not observed'
            : String(market.topology.directCashPoolCount ?? 0),
        note: 'Pools pairing it directly with USDC or WETH',
        tone: market.topology.status === 'unavailable' ? 'off' : 'neutral',
      },
    ],
    activity: {
      title: OBSERVED_ACTIVITY_TITLE_V1,
      semantics: OBSERVED_ACTIVITY_SEMANTICS_V1,
      headline:
        activity.status === 'unavailable'
          ? 'The ledger tail has not read this token, so nothing has been observed. That is not a quiet market.'
          : activity.status === 'no_movements_observed'
            ? 'The ledger tail read this token and saw it move through no identified venue in the stored window.'
            : `${(activity.movementCount ?? 0).toLocaleString('en-US')} movement${
                activity.movementCount === 1 ? '' : 's'
              } through an identified venue in the stored window.`,
      facts:
        activity.status === 'unavailable'
          ? []
          : [
              {
                label: 'Left a venue',
                value: String(activity.outOfVenueCount ?? 0),
                note: 'The token moved out of a pool',
                tone: 'neutral',
              },
              {
                label: 'Entered a venue',
                value: String(activity.intoVenueCount ?? 0),
                note: 'The token moved into a pool',
                tone: 'neutral',
              },
              {
                label: 'Confirmed swaps',
                // Always null and always shown. An absent row would let a
                // reader assume the movements above are swaps.
                value: 'not established',
                note: 'Confirming a movement as a swap is a separate read against the venue’s own event, and it is not built',
                tone: 'off',
              },
            ],
      movements: activity.latest.map((row) => ({
        direction: row.direction === 'out_of_venue' ? 'Left a venue' : 'Entered a venue',
        amount: row.amountAtomic,
        venue: row.venueAddress,
        // Never "trader" and never "buyer". Measured over 2,170 observations,
        // the busiest single counterparty accounted for 12.3% of them — a
        // router's share, not a person's.
        counterparty: row.counterparty,
        when: rwaAgeLabelV1(row.observedAt, now) ?? 'unknown',
      })),
    },
  };
}
