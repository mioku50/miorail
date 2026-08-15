import { b20QuoteAssetDisplayV1, type B20OpportunityCardV1 } from '@mioagent/opportunity-rail';
import type { B20OpportunityObservationV1 } from '@mioagent/route-storage';

export type B20CopilotQuestionKindV1 =
  | 'summary'
  | 'why_rejected'
  | 'unusual'
  | 'missing_evidence'
  | 'explain_hook'
  | 'exit_capacity'
  | 'compare_previous';

export interface B20CopilotAnswerV1 {
  schemaVersion: 'b20-copilot-answer/v1';
  answerSource: 'deterministic_evidence';
  questionKind: B20CopilotQuestionKindV1;
  subject: { tokenAddress: string; symbol: string; name: string };
  observation: {
    observationId: string;
    evidenceHash: string;
    blockNumber: string;
    measuredAt: string;
    freshness: 'fresh' | 'stale';
  } | null;
  answer: string;
  facts: Array<{ label: string; value: string; tone: 'neutral' | 'positive' | 'warning' }>;
  missingEvidence: string[];
  caveats: string[];
  routeHandoff: { label: 'Open in Routes'; goal: string } | null;
}


export function b20ObservationRefMatchesV1(
  current: Pick<B20OpportunityObservationV1, 'id' | 'evidenceHash'> | null,
  requested: { observationId: string | null; evidenceHash: string | null },
): boolean {
  return current
    ? requested.observationId === current.id && requested.evidenceHash === current.evidenceHash
    : requested.observationId === null && requested.evidenceHash === null;
}

function includesAnyV1(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

/**
 * Natural-language routing is deliberately narrow and deterministic. The
 * answer builder below owns every claim; no model is allowed to turn a card
 * into a recommendation or invent a missing measurement.
 */
export function classifyB20CopilotQuestionV1(question: string): B20CopilotQuestionKindV1 {
  const value = question.trim().toLowerCase();
  if (includesAnyV1(value, [/previous/, /changed/, /change/, /history/, /раньше/u, /измен/u, /предыдущ/u])) {
    return 'compare_previous';
  }
  if (includesAnyV1(value, [/missing/, /unknown/, /not measured/, /evidence.*need/, /не хватает/u, /неизвест/u, /не измер/u])) {
    return 'missing_evidence';
  }
  if (includesAnyV1(value, [/hook/, /permission/, /хук/u, /разрешен/u])) return 'explain_hook';
  if (includesAnyV1(value, [/why.*reject/, /rejection/, /rejected/, /почему.*отклон/u, /причин.*отклон/u])) {
    return 'why_rejected';
  }
  if (includesAnyV1(value, [/unusual/, /notable/, /strange/, /необыч/u, /подозр/u])) return 'unusual';
  if (includesAnyV1(value, [/get out/, /exit/, /sell/, /liquid/, /capacity/, /выйти/u, /продать/u, /ликвид/u])) {
    return 'exit_capacity';
  }
  return 'summary';
}

function trimDecimalV1(value: string): string {
  return value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function formatAtomicV1(atomic: string, decimals: number): string {
  const raw = BigInt(atomic);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = raw / base;
  const fraction = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '').slice(0, 6);
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** The ONE table. This file used to hold its own, defaulting an unrecognised
 * asset to eighteen decimals while the Discover card defaulted the same asset
 * to six — so a single stored observation could be quoted back to a user as
 * two numbers twelve orders of magnitude apart. */
const quoteAssetV1 = b20QuoteAssetDisplayV1;

function amountLabelV1(atomic: string, asset: { symbol: string; decimals: number | null }): string {
  // Null decimals means this build does not know the asset's scale. The atomic
  // figure is stated as atomic rather than divided by a guess.
  if (asset.decimals === null) return `${atomic} (atomic, ${asset.symbol})`;
  return `${formatAtomicV1(atomic, asset.decimals)} ${asset.symbol}`;
}

function bpsV1(value: number): string {
  return `${trimDecimalV1((value / 100).toFixed(2))}%`;
}

function requestedUsdcAtomicV1(question: string): { display: string; atomic: bigint } | null {
  const match = question.match(/(?:\$\s*([0-9]+(?:[.,][0-9]{1,6})?)|([0-9]+(?:[.,][0-9]{1,6})?)\s*(?:usdc|usd|dollars?))/iu);
  const decimal = (match?.[1] ?? match?.[2] ?? '').replace(',', '.');
  if (!decimal) return null;
  const [whole, fraction = ''] = decimal.split('.');
  const atomic = BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, '0'));
  return { display: `${trimDecimalV1(decimal)} USDC`, atomic };
}

function missingEvidenceV1(
  card: B20OpportunityCardV1,
  history: readonly B20OpportunityObservationV1[],
): string[] {
  const observation = card.observation;
  const missing: string[] = [];
  if (!observation) {
    missing.push('An Exit-First measurement for this canonical launch.');
  } else {
    if (!observation.exitRouteFound) missing.push('A supported exit route from an allowlisted venue.');
    if (observation.routeCoverage === 'partial') missing.push('Complete responses from every configured route source.');
    if (observation.largestPassingSizeAtomic === null) missing.push('A passing exit-capacity probe.');
    if (observation.controlsComplete !== true) missing.push('A complete controls snapshot at the observation block.');
    if (observation.launchBuyerWindow?.status === 'collecting') {
      missing.push(`The completed launch-buying window, which closes at block ${observation.launchBuyerWindow.closesAtBlock}.`);
    } else if (observation.launchBuyers === null) {
      missing.push('A completed launch-buying aggregate.');
    }
    if (history.length < 2) missing.push('A second comparable observation for change analysis.');
  }
  for (const dimension of card.notMeasured) missing.push(`${dimension[0]?.toUpperCase() ?? ''}${dimension.slice(1)}.`);
  return [...new Set(missing)].slice(0, 20);
}

function factRowsV1(card: B20OpportunityCardV1): B20CopilotAnswerV1['facts'] {
  const observation = card.observation;
  if (!observation) {
    return [
      { label: 'Launch', value: `Stored at block ${card.launch.blockNumber}`, tone: 'neutral' },
      { label: 'Measurement', value: 'Not measured', tone: 'warning' },
    ];
  }
  const quote = quoteAssetV1(observation.referenceQuoteAsset);
  const rows: B20CopilotAnswerV1['facts'] = [
    { label: 'State', value: observation.state, tone: observation.state === 'rejected' ? 'warning' : 'neutral' },
    {
      label: 'Observation',
      value: `block ${observation.observationBlockNumber} · ${observation.freshness}`,
      tone: observation.freshness === 'fresh' ? 'neutral' : 'warning',
    },
    {
      label: 'Routes',
      value: `${observation.entryRouteFound ? 'entry found' : 'entry missing'} · ${observation.exitRouteFound ? 'exit found' : 'exit missing'} · ${observation.routeCoverage} coverage`,
      tone: observation.exitRouteFound && observation.routeCoverage === 'complete' ? 'positive' : 'warning',
    },
  ];
  if (observation.optimisticRoundTripBps !== null) {
    rows.push({
      label: 'Round trip',
      value: `${bpsV1(observation.optimisticRoundTripBps)} against a ${bpsV1(observation.maxRoundTripBps)} reference`,
      tone: observation.optimisticRoundTripBps <= observation.maxRoundTripBps ? 'positive' : 'warning',
    });
  }
  if (observation.largestPassingSizeAtomic !== null) {
    const failure = observation.firstFailingSizeAtomic
      ? ` · first failure by ${amountLabelV1(observation.firstFailingSizeAtomic, quote)}`
      : '';
    rows.push({
      label: 'Exit-capacity bound',
      value: `at least ${amountLabelV1(observation.largestPassingSizeAtomic, quote)}${failure}`,
      tone: observation.capacityStable === false ? 'warning' : 'neutral',
    });
  }
  if (observation.poolHook) {
    rows.push({
      label: 'Pool hook',
      value: observation.poolHook.standing.replaceAll('_', ' '),
      tone: observation.poolHook.standing === 'non_standard' || observation.poolHook.standing === 'unreadable' ? 'warning' : 'neutral',
    });
  }
  if (observation.launchBuyers) {
    const share = observation.launchBuyers.topBuyerShareBps;
    rows.push({
      label: 'Launch buying',
      value: `${observation.launchBuyers.buyerCount} wallet${observation.launchBuyers.buyerCount === 1 ? '' : 's'}${share === null ? '' : ` · largest ${bpsV1(share)}`}`,
      tone: 'neutral',
    });
  }
  return rows.slice(0, 16);
}

function summaryAnswerV1(card: B20OpportunityCardV1): string {
  const observation = card.observation;
  if (!observation) {
    return `${card.launch.symbol || card.launch.tokenAddress} is a canonical B20 launch in Miorail, but no Exit-First observation exists yet. No route, cost, controls, capacity or launch-buying conclusion can be made from this card.`;
  }
  return `${card.launch.symbol || card.launch.tokenAddress} was measured at Base block ${observation.observationBlockNumber}. The stored state is ${observation.state}: ${observation.detail} This describes the named observation only; it is not a recommendation or an executable quote.`;
}

function whyRejectedAnswerV1(card: B20OpportunityCardV1): string {
  const observation = card.observation;
  if (!observation) return 'This card is not rejected; it has not been measured yet.';
  if (observation.state !== 'rejected') {
    return `This card is not rejected. Its stored state at block ${observation.observationBlockNumber} is ${observation.state}.`;
  }
  return `Miorail rejected this observation with reason ${observation.reasonCode ?? 'not recorded'}: ${observation.detail} Rejected describes the fixed measurement profile at block ${observation.observationBlockNumber}; it is not a scam label or a claim that every venue will always give the same result.`;
}

function unusualAnswerV1(card: B20OpportunityCardV1): string {
  const observation = card.observation;
  if (!observation) return 'Nothing unusual can be established because no B20 observation exists yet.';
  const findings: string[] = [];
  if (observation.poolHook?.standing === 'non_standard') findings.push('the pool does not use Miorail’s usual sampled launch hook');
  if (observation.poolHook?.standing === 'unreadable') findings.push('the pool hook permissions could not be decoded');
  if (observation.routeCoverage === 'partial') findings.push('route-source coverage is partial');
  if (!observation.exitRouteFound) findings.push('no supported exit route was found');
  if (observation.capacityStable === false) findings.push('the measured capacity ladder was not monotonic');
  if (observation.transferPolicyState === 'restricted') findings.push('a transfer policy is active');
  if (findings.length === 0) {
    return 'The stored fields contain no server-classified deviation to call out. That is not a safety verdict: unmeasured behaviour, future liquidity and wallet-specific transfer outcomes remain unknown.';
  }
  return `Notable stored conditions: ${findings.join('; ')}. These are measured or decoded facts, not a combined risk score.`;
}

function hookAnswerV1(card: B20OpportunityCardV1): string {
  const hook = card.observation?.poolHook;
  if (!card.observation) return 'No pool-hook evidence exists because this launch has not been measured.';
  if (!hook) return 'This observation carries no pool-hook record. Miorail does not substitute “no hook” for missing evidence.';
  if (hook.standing === 'no_hook') return 'The measured venue has no hook. Nothing at that hook boundary can intercept swaps or gate liquidity.';
  if (!hook.permissions) return `The hook is ${hook.standing.replaceAll('_', ' ')}, but its permissions were not readable.`;
  const allowed = [
    hook.permissions.mayInterceptSwaps ? 'intercept swaps' : null,
    hook.permissions.mayChangeSwapAmounts ? 'change swap amounts' : null,
    hook.permissions.mayGateLiquidity ? 'gate liquidity changes' : null,
  ].filter((value): value is string => value !== null);
  return `This is a ${hook.standing.replaceAll('_', ' ')} hook at ${hook.permissions.hook}. Its address permits it to ${allowed.length ? allowed.join(', ') : 'use none of the decoded swap or liquidity permissions'}. Permissions do not prove behaviour; the measured round trip is the evidence of observed cost.`;
}

function exitAnswerV1(card: B20OpportunityCardV1, question: string): string {
  const observation = card.observation;
  if (!observation) return 'Miorail cannot assess an exit from this card because no Exit-First measurement exists.';
  if (!observation.exitRouteFound) {
    return `Miorail cannot support an exit-capacity claim: no allowlisted exit route was found at block ${observation.observationBlockNumber}. This does not prove that no route exists elsewhere.`;
  }
  if (observation.largestPassingSizeAtomic === null) {
    return 'An exit route was seen, but no passing capacity probe was stored, so Miorail will not invent a size.';
  }
  const quote = quoteAssetV1(observation.referenceQuoteAsset);
  const passing = BigInt(observation.largestPassingSizeAtomic);
  const failing = observation.firstFailingSizeAtomic === null ? null : BigInt(observation.firstFailingSizeAtomic);
  const requested = requestedUsdcAtomicV1(question);
  let comparison = '';
  if (requested && quote.symbol === 'USDC') {
    if (requested.atomic <= passing) {
      comparison = ` ${requested.display} is not greater than the largest passing probe.`;
    } else if (failing !== null && requested.atomic >= failing) {
      comparison = ` ${requested.display} is at or above the first failing probe.`;
    } else if (failing !== null) {
      comparison = ` ${requested.display} falls between the passing and failing probes, so that interval was not measured.`;
    } else {
      comparison = ` ${requested.display} is larger than the largest passing probe and was not assessed.`;
    }
  } else if (requested) {
    comparison = ` The stored ladder is denominated in ${quote.symbol}, so a dollar amount cannot be compared without fresh price evidence.`;
  }
  const freshness = observation.freshness === 'fresh'
    ? 'The observation is inside its freshness window, but it is still not an executable quote.'
    : 'The observation is stale and is historical evidence only.';
  return `At block ${observation.observationBlockNumber}, at least ${amountLabelV1(observation.largestPassingSizeAtomic, quote)} passed the ${bpsV1(observation.capacityToleranceBps)} exit reference${observation.firstFailingSizeAtomic ? `, and the ladder failed by ${amountLabelV1(observation.firstFailingSizeAtomic, quote)}` : ''}.${comparison} ${freshness} Routes must obtain fresh quotes before any approval.`;
}

function comparePreviousAnswerV1(
  card: B20OpportunityCardV1,
  history: readonly B20OpportunityObservationV1[],
): string {
  const current = card.observation;
  if (!current) return 'There is no current observation to compare.';
  const storedCurrent = history.find((entry) => entry.id === current.observationId);
  const previous = storedCurrent
    ? history.find(
        (entry) =>
          entry.id !== current.observationId &&
          entry.measurementVersion === storedCurrent.measurementVersion &&
          entry.profileIdentity === storedCurrent.profileIdentity,
      )
    : undefined;
  if (!previous) return 'Miorail has no earlier comparable observation for this launch yet.';
  const changes: string[] = [];
  if (previous.state !== current.state) changes.push(`state ${previous.state} → ${current.state}`);
  if (previous.exitRouteFound !== current.exitRouteFound) {
    changes.push(`exit route ${previous.exitRouteFound ? 'found' : 'missing'} → ${current.exitRouteFound ? 'found' : 'missing'}`);
  }
  if (previous.routeCoverage !== current.routeCoverage) changes.push(`coverage ${previous.routeCoverage} → ${current.routeCoverage}`);
  if (previous.optimisticRoundTripBps !== current.optimisticRoundTripBps) {
    changes.push(`round trip ${previous.optimisticRoundTripBps === null ? 'not measured' : bpsV1(previous.optimisticRoundTripBps)} → ${current.optimisticRoundTripBps === null ? 'not measured' : bpsV1(current.optimisticRoundTripBps)}`);
  }
  if (previous.largestPassingSizeAtomic !== current.largestPassingSizeAtomic) {
    const quote = quoteAssetV1(current.referenceQuoteAsset);
    changes.push(`largest passing probe ${previous.largestPassingSizeAtomic === null ? 'not measured' : amountLabelV1(previous.largestPassingSizeAtomic, quote)} → ${current.largestPassingSizeAtomic === null ? 'not measured' : amountLabelV1(current.largestPassingSizeAtomic, quote)}`);
  }
  if (changes.length === 0) {
    return `No displayed measurement changed between blocks ${previous.observationBlockNumber} and ${current.observationBlockNumber}. This does not mean every pool or token property was unchanged.`;
  }
  return `From block ${previous.observationBlockNumber} to ${current.observationBlockNumber}: ${changes.join('; ')}.`;
}

export function answerB20CopilotV1(input: {
  card: B20OpportunityCardV1;
  history: readonly B20OpportunityObservationV1[];
  question: string;
}): B20CopilotAnswerV1 {
  const { card, history, question } = input;
  const kind = classifyB20CopilotQuestionV1(question);
  const observation = card.observation;
  const answer = kind === 'why_rejected'
    ? whyRejectedAnswerV1(card)
    : kind === 'unusual'
      ? unusualAnswerV1(card)
      : kind === 'missing_evidence'
        ? `To make a stronger evidence-backed statement, Miorail is missing: ${missingEvidenceV1(card, history).join(' ')}`
        : kind === 'explain_hook'
          ? hookAnswerV1(card)
          : kind === 'exit_capacity'
            ? exitAnswerV1(card, question)
            : kind === 'compare_previous'
              ? comparePreviousAnswerV1(card, history)
              : summaryAnswerV1(card);
  const exitQuestion = kind === 'exit_capacity';
  return {
    schemaVersion: 'b20-copilot-answer/v1',
    answerSource: 'deterministic_evidence',
    questionKind: kind,
    subject: {
      tokenAddress: card.launch.tokenAddress,
      symbol: card.launch.symbol,
      name: card.launch.name,
    },
    observation: observation
      ? {
          observationId: observation.observationId,
          evidenceHash: observation.evidenceHash,
          blockNumber: observation.observationBlockNumber,
          measuredAt: observation.measuredAt,
          freshness: observation.freshness,
        }
      : null,
    answer,
    facts: factRowsV1(card),
    missingEvidence: missingEvidenceV1(card, history),
    caveats: [
      'B20 measurements describe one stored observation and are not financial recommendations.',
      observation?.freshness === 'stale'
        ? 'This observation is past its freshness window and cannot support a current route.'
        : 'A fresh observation is still not an executable quote; Routes must quote again.',
      'Provisional means the fixed reference profile passed before entry moved the pool; it does not mean qualified.',
      ...(observation?.poolHook
        ? ['Hook permissions describe what the address may do, not what the hook actually did.']
        : []),
      ...(observation?.launchBuyers
        ? ['Launch buying is a gross onchain window aggregate; it does not prove intent, related wallets or current holdings.']
        : []),
    ],
    routeHandoff: {
      label: 'Open in Routes',
      goal: exitQuestion
        ? `Swap B20 token ${card.launch.tokenAddress} to USDC. Ask me for the amount.`
        : `Buy B20 token ${card.launch.tokenAddress} with USDC. Ask me for the amount.`,
    },
  };
}
