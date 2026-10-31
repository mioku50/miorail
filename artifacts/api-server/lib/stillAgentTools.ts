import { assetById, type AssetId } from '@mioagent/still-engine';
import { formatCents, formatPercentBps, formatTokenAmount } from '@mioagent/still-engine/format';
import type { MirrorInput } from '@mioagent/still-engine';
import type { MirrorReport, VenueLine } from '@mioagent/still-engine/report';
import { healthFactorTextV1, scenarioV1, type ScenarioEditV1, type ScenarioRefusalV1 } from '@mioagent/still-engine/scenario';

import { agentCapabilitiesV2, type AgentAnswerV1 } from '../../../lib/ui/src/still/agentAnswers.js';
import { STILL_SHARES_V1, newYorkMomentV1 } from '../../../lib/ui/src/still/skyState.js';
import type { PlanNeedV1, PlanUnsupportedV1, StillAgentPlanV1 } from './stillAgentPlan.js';
import type { StillReadingChangeV1 } from './stillReadings.js';

// ---------------------------------------------------------------------------
// The Still Agent's calculations, as answers.
//
// Every figure here is read from a report the Mirror engine computed: the one
// the page shows, or the same reading with the question's change applied
// (lib/still-engine/src/scenario.ts). This file only chooses which figures to
// say and says them; it does no arithmetic of its own beyond a period's
// interest, which it labels an estimate.
// ---------------------------------------------------------------------------

export interface StillAgentReadingV1 {
  report: MirrorReport;
  input: MirrorInput;
}

interface Words {
  ru: boolean;
  block: string;
}

const t = (w: Words, ru: string, en: string) => (w.ru ? ru : en);

function wordsOf(report: MirrorReport, ru: boolean): Words {
  return { ru, block: Number(report.reading.block).toLocaleString('en-US') };
}

function sourcesOf(report: MirrorReport, w: Words, recomputed: boolean): string[] {
  return [
    recomputed
      ? t(w, 'РИСК-ДВИЖОК · отчёт Still пересчитан с изменением', 'RISK ENGINE · the Still report recomputed with the change')
      : t(w, 'РИСК-ДВИЖОК · отчёт Still', 'RISK ENGINE · the Still report'),
    t(w, `ЧТЕНИЕ · блок Base ${w.block}`, `READ · Base block ${w.block}`),
    t(w, `УСЛОВИЯ · Still ${report.terms.version}`, `TERMS · Still ${report.terms.version}`),
  ];
}

const calculatedAtOf = (report: MirrorReport) => ({ block: report.reading.block, blockTime: report.reading.blockTime });

function venueNameV1(line: Pick<VenueLine, 'venue' | 'label'>): string {
  if (line.venue === 'aave-v4') return 'Aave V4';
  return line.label.replace(' · ', ' ').replace('/USDC', '');
}

function assetNameV1(report: MirrorReport, asset: string): string {
  return report.assets.find((line) => line.asset === asset)?.name ?? assetById(asset as AssetId).name;
}

const sameVenue = (a: VenueLine, b: VenueLine) => a.venue === b.venue && a.market.toLowerCase() === b.market.toLowerCase();
const owes = (line: VenueLine | undefined) => line?.debtCents != null && BigInt(line.debtCents) > 0n;

function healthLineV1(w: Words, name: string, before: VenueLine | undefined, after: VenueLine): string | null {
  if (!owes(after)) {
    return owes(before) ? t(w, `${name}: долга нет, ликвидировать нечего.`, `${name}: no debt, so nothing can be liquidated.`) : null;
  }
  if (!after.safety) return t(w, `${name}: запас до ликвидации не вычислен.`, `${name}: the liquidation margin could not be computed.`);
  const from = before?.safety ? `${healthFactorTextV1(before.safety.healthFactor)} → ` : '';
  const to = healthFactorTextV1(after.safety.healthFactor);
  if (after.safety.state === 'liquidation') {
    return t(w, `Health factor ${name}: ${from}${to} — займ может быть ликвидирован.`, `Health factor on ${name}: ${from}${to}: the loan can be liquidated.`);
  }
  const margin = formatPercentBps(after.safety.marginBps);
  return t(
    w,
    `Health factor ${name}: ${from}${to}; затем цены могут вместе упасть ещё на ${margin}, прежде чем начнётся ликвидация.`,
    `Health factor on ${name}: ${from}${to}; prices could then fall ${margin} together before liquidation can start.`,
  );
}

function liquidationLinesV1(w: Words, report: MirrorReport, before: VenueLine | undefined, after: VenueLine): string[] {
  const lines: string[] = [];
  for (const price of after.liquidationPrices) {
    const was = before?.liquidationPrices.find((p) => p.asset === price.asset);
    const name = assetNameV1(report, price.asset);
    const now = price.unreachable || price.priceCents === null ? null : price.priceCents;
    const then = !was || was.unreachable || was.priceCents === null ? null : was.priceCents;
    if (now === then) continue;
    const say = (cents: string | null) => (cents === null ? t(w, 'недостижима одной ценой', 'not reachable by this price alone') : formatCents(cents));
    lines.push(t(w, `Цена ликвидации ${name}: ${say(then)} → ${say(now)}.`, `${name} liquidation price: ${say(then)} → ${say(now)}.`));
  }
  return lines;
}

/** The move a price edit made, read back from the two reports, so a dollar target says its percentage. */
function moveBpsV1(before: MirrorReport, after: MirrorReport, edit: Extract<ScenarioEditV1, { kind: 'price' | 'price_to' }>): number {
  if (edit.kind === 'price') return edit.changeBps;
  const was = before.assets.find((line) => line.asset === edit.asset)?.priceCents;
  const now = after.assets.find((line) => line.asset === edit.asset)?.priceCents;
  if (!was || !now || BigInt(was) === 0n) return 0;
  return Number(((BigInt(now) - BigInt(was)) * 10_000n) / BigInt(was));
}

function editPhraseV1(w: Words, report: MirrorReport, after: MirrorReport, edit: ScenarioEditV1): string {
  if (edit.kind === 'price' || edit.kind === 'price_to') {
    const name = assetNameV1(report, edit.asset);
    const to = after.assets.find((line) => line.asset === edit.asset)?.priceCents;
    const changeBps = moveBpsV1(report, after, edit);
    const move = formatPercentBps(Math.abs(changeBps), Math.abs(changeBps) % 100 === 0 ? 0 : 2);
    const toText = to ? t(w, ` (до ${formatCents(to)})`, ` (to ${formatCents(to)})`) : '';
    return changeBps < 0
      ? t(w, `${name} подешевеет на ${move}${toText}`, `${name} falls ${move}${toText}`)
      : t(w, `${name} подорожает на ${move}${toText}`, `${name} rises ${move}${toText}`);
  }
  const venue = (v: string) => (v === 'aave-v4' ? 'Aave V4' : `Morpho ${v.slice('morpho:'.length)}`);
  if (edit.kind === 'borrow') return t(w, `вы займёте ещё ${formatCents(edit.usdcAtomic / 10_000n)} на ${venue(edit.venue)}`, `you borrow ${formatCents(edit.usdcAtomic / 10_000n)} more on ${venue(edit.venue)}`);
  if (edit.kind === 'repay') {
    return edit.usdcAtomic === 'all'
      ? t(w, `вы погасите весь долг на ${venue(edit.venue)}`, `you repay the whole ${venue(edit.venue)} loan`)
      : t(w, `вы погасите ${formatCents(edit.usdcAtomic / 10_000n)} на ${venue(edit.venue)}`, `you repay ${formatCents(edit.usdcAtomic / 10_000n)} on ${venue(edit.venue)}`);
  }
  const asset = assetById(edit.asset);
  const amount = `${formatTokenAmount(edit.raw, asset.decimals)} ${asset.kind === 'stock' ? asset.id : asset.symbol}`;
  return edit.source === 'wallet'
    ? t(w, `вы внесёте в залог ${amount} из кошелька`, `you pledge ${amount} from your wallet`)
    : t(w, `вы добавите в залог ${amount}, которых в кошельке нет`, `you add ${amount} as collateral that the wallet does not hold yet`);
}

const joinPhrases = (w: Words, phrases: string[]) =>
  phrases.length <= 1 ? (phrases[0] ?? '') : `${phrases.slice(0, -1).join(', ')} ${t(w, 'и', 'and')} ${phrases[phrases.length - 1]}`;

function refusalV1(w: Words, report: MirrorReport, reason: ScenarioRefusalV1, edit: ScenarioEditV1): AgentAnswerV1 {
  const venue = 'venue' in edit ? (edit.venue === 'aave-v4' ? 'Aave V4' : `Morpho ${edit.venue.slice('morpho:'.length)}`) : '';
  const asset = 'asset' in edit ? assetNameV1(report, edit.asset) : '';
  const text = {
    unread: t(w, `Не посчитано: на блоке ${w.block} не прочитано значение, нужное для этого расчёта. Это наш сбой, а не факт о вашем кошельке.`, `Not computed: a value this calculation needs was not read at block ${w.block}. That is our failure, not a fact about your wallet.`),
    out_of_range: t(w, 'Падение на 100% и больше — это не цена. Назовите меньшее движение.', 'A fall of 100% or more is not a price. Name a smaller move.'),
    no_debt: t(w, `На ${venue} нет долга, гасить нечего.`, `There is no debt on ${venue} to repay.`),
    no_collateral: t(w, `На ${venue} ничего не заложено. Get money вносит залог и берёт займ одним шагом: откройте его, чтобы увидеть живой лимит.`, `Nothing is pledged on ${venue}. Get money pledges and borrows in one step: open it to see the live limit.`),
    exceeds_liquidity: t(w, `У ${venue} сейчас меньше USDC для займа, чем эта сумма.`, `${venue} has less USDC to lend than that right now.`),
    exceeds_wallet: t(w, `В кошельке меньше ${asset}, чем эта сумма.`, `Your wallet holds less ${asset} than that.`),
  }[reason];
  return {
    topic: 'analysis',
    mode: 'refused',
    text,
    sources: [t(w, `ЧТЕНИЕ · блок Base ${w.block}`, `READ · Base block ${w.block}`)],
    calculatedAt: calculatedAtOf(report),
    actionLink: reason === 'no_collateral' ? { href: '/borrow', label: t(w, 'Открыть Get money →', 'Open Get money →') } : null,
  };
}

function scenarioAnswerV1(plan: Extract<StillAgentPlanV1, { task: 'scenario' }>, reading: StillAgentReadingV1, w: Words): AgentAnswerV1 {
  const outcome = scenarioV1(reading.input, plan.edits);
  if (!outcome.ok) return refusalV1(w, reading.report, outcome.reason, outcome.edit);
  const { before, after } = outcome;
  const steps: string[] = [];
  const notHeld: string[] = [];
  for (const edit of plan.edits) {
    if (edit.kind !== 'price' && edit.kind !== 'price_to') continue;
    const was = before.assets.find((line) => line.asset === edit.asset);
    const now = after.assets.find((line) => line.asset === edit.asset);
    const name = assetNameV1(before, edit.asset);
    if (!was || !now?.priceCents || !was.priceCents) {
      notHeld.push(name);
      continue;
    }
    const changeBps = moveBpsV1(before, after, edit);
    const move = `${changeBps < 0 ? '−' : '+'}${formatPercentBps(Math.abs(changeBps), Math.abs(changeBps) % 100 === 0 ? 0 : 2)}`;
    steps.push(t(w, `Цена ${name}: ${formatCents(was.priceCents)} → ${formatCents(now.priceCents)} (${move}).`, `${name} price: ${formatCents(was.priceCents)} → ${formatCents(now.priceCents)} (${move}).`));
  }
  const loans: Array<{ name: string; before: VenueLine | undefined; after: VenueLine }> = [];
  for (const line of after.venues) {
    const was = before.venues.find((v) => sameVenue(v, line));
    const name = venueNameV1(line);
    if (was?.debtCents !== line.debtCents && line.debtCents !== null) {
      steps.push(t(w, `Долг ${name}: ${was?.debtCents != null ? formatCents(was.debtCents) : '—'} → ${formatCents(line.debtCents)}.`, `Debt on ${name}: ${was?.debtCents != null ? formatCents(was.debtCents) : '—'} → ${formatCents(line.debtCents)}.`));
    }
    // Only a loan the change moves is described: an untouched loan is not news.
    const moved = was?.debtCents !== line.debtCents || was?.safety?.healthFactor !== line.safety?.healthFactor;
    const health = moved ? healthLineV1(w, name, was, line) : null;
    if (health && (owes(line) || owes(was))) {
      steps.push(health);
      loans.push({ name, before: was, after: line });
    }
    steps.push(...liquidationLinesV1(w, after, was, line));
  }
  const roomBefore = before.headline.availableCents;
  const roomAfter = after.headline.availableCents;
  if (roomBefore !== null && roomAfter !== null) {
    steps.push(t(w, `Запас Still для нового займа: ${formatCents(roomBefore)} → ${formatCents(roomAfter)}.`, `Still’s room for a new loan: ${formatCents(roomBefore)} → ${formatCents(roomAfter)}.`));
  }

  const phrases = plan.edits.filter((e) => (e.kind !== 'price' && e.kind !== 'price_to') || !notHeld.includes(assetNameV1(before, e.asset))).map((e) => editPhraseV1(w, before, after, e));
  const lead = phrases.length ? t(w, `Если ${joinPhrases(w, phrases)}`, `If ${joinPhrases(w, phrases)}`) : '';
  const sentences: string[] = [];
  if (notHeld.length) {
    sentences.push(t(w, `В проверенном наборе вашего кошелька нет ${notHeld.join(', ')}, поэтому эта цена не меняет ни займ, ни запас.`, `Your wallet holds no ${notHeld.join(', ')} in the reviewed set, so that price changes neither a loan nor the room.`));
  }
  const primary = loans.find((loan) => loan.after.safety?.state === 'liquidation') ?? loans[0];
  if (lead && primary && owes(primary.after) && primary.after.safety) {
    const debt = formatCents(primary.after.debtCents!);
    const from = primary.before?.safety ? `${healthFactorTextV1(primary.before.safety.healthFactor)} → ` : '';
    const to = healthFactorTextV1(primary.after.safety.healthFactor);
    sentences.push(
      primary.after.safety.state === 'liquidation'
        ? t(w, `${lead}, займ ${debt} на ${primary.name} может быть ликвидирован: health factor ${from}${to}.`, `${lead}, the ${debt} loan on ${primary.name} can be liquidated: health factor ${from}${to}.`)
        : t(w, `${lead}, займ ${debt} на ${primary.name} не доходит до ликвидации: health factor ${from}${to}, и затем цены могут вместе упасть ещё на ${formatPercentBps(primary.after.safety.marginBps)}.`, `${lead}, the ${debt} loan on ${primary.name} stays out of liquidation: health factor ${from}${to}, and prices could then fall ${formatPercentBps(primary.after.safety.marginBps)} together before liquidation can start.`),
    );
  } else if (lead && primary && !owes(primary.after)) {
    sentences.push(t(w, `${lead}, долга на ${primary.name} не остаётся, ликвидировать нечего.`, `${lead}, no debt is left on ${primary.name}, so nothing can be liquidated.`));
  } else if (lead && before.venues.some((v) => owes(v))) {
    sentences.push(t(w, `${lead}, ни один займ не меняется.`, `${lead}, none of your loans changes.`));
  } else if (lead) {
    sentences.push(t(w, `${lead}: долга нет, поэтому ликвидировать нечего.`, `${lead}: there is no loan, so nothing can be liquidated.`));
  }
  if (lead && roomBefore !== null && roomAfter !== null && roomBefore !== roomAfter) {
    sentences.push(t(w, `Запас Still для нового займа: ${formatCents(roomBefore)} → ${formatCents(roomAfter)}.`, `Still’s room for a new loan goes from ${formatCents(roomBefore)} to ${formatCents(roomAfter)}.`));
  } else if (lead && roomAfter !== null && plan.edits.some((e) => e.kind === 'deposit' && e.source === 'wallet')) {
    sentences.push(t(w, `Запас Still остаётся ${formatCents(roomAfter)}: токены в кошельке он уже учитывает.`, `Still’s room stays ${formatCents(roomAfter)}: it already counts the tokens in your wallet.`));
  }

  const bounds: string[] = [];
  if (plan.edits.some((e) => e.kind === 'price' || e.kind === 'price_to')) {
    bounds.push(t(w, `Остальные цены — как на блоке ${w.block}.`, `Every other price is as read at block ${w.block}.`));
    bounds.push(t(w, 'Цены — оракулы Base, по которым протоколы ликвидируют; цена на бирже может отличаться.', 'Prices are the Base oracles the protocols liquidate by; an exchange price can differ.'));
  }
  if (before.venues.some((v) => v.venue === 'aave-v4' && v.safety?.source === 'protocol') && loans.some((l) => l.after.venue === 'aave-v4')) {
    bounds.push(t(w, 'Health factor Aave сдвинут от значения самого протокола на изменение, которое считает движок.', 'The Aave health factor is the protocol’s own figure moved by the change the engine computes.'));
  }
  if (loans.length) bounds.push(t(w, `Проценты после блока ${w.block} не учтены.`, `Interest after block ${w.block} is not included.`));
  if (before.terms.weekend.active) {
    bounds.push(t(w, `Рынок США закрыт: до ${newYorkMomentV1(before.terms.weekend.endsAt)} по Нью-Йорку новые займы под акции считаются по ${STILL_SHARES_V1.closed}%.`, `The US market is closed: until ${newYorkMomentV1(before.terms.weekend.endsAt)} New York time, new loans against stocks count at ${STILL_SHARES_V1.closed}%.`));
  }

  const decisive = primary?.after.safety && owes(primary.after) ? healthFactorTextV1(primary.after.safety.healthFactor) : null;
  return {
    topic: 'analysis',
    mode: 'analysis',
    text: sentences.join(' ') || t(w, 'Это изменение не меняет ни займ, ни запас.', 'That change moves neither a loan nor the room.'),
    steps,
    sources: sourcesOf(before, w, true),
    calculatedAt: calculatedAtOf(before),
    bounds,
    actionLink: plan.edits.some((e) => e.kind === 'repay') ? { href: '/repay', label: t(w, 'Открыть погашение →', 'Open repayment →') } : null,
    engineFacts: {
      mode: 'scenario',
      hfAfter: decisive,
      liquidatedAfter: primary?.after.safety ? primary.after.safety.state === 'liquidation' : null,
      roomAfterCents: roomAfter,
    },
  };
}

function repayOptionsAnswerV1(plan: Extract<StillAgentPlanV1, { task: 'repay_options' }>, reading: StillAgentReadingV1, w: Words): AgentAnswerV1 {
  const { report } = reading;
  const unread = report.venues.filter((line) => line.debtCents === null);
  const loans = report.venues.filter((line) => owes(line) && (plan.venue === null || venueKeyV1(line) === plan.venue));
  if (loans.length === 0) {
    return {
      topic: 'analysis',
      mode: unread.length ? 'refused' : 'analysis',
      text: unread.length
        ? t(w, `Долг на ${unread.map(venueNameV1).join(', ')} не прочитан на блоке ${w.block}. Это не значит, что долга нет.`, `The debt on ${unread.map(venueNameV1).join(', ')} was not read at block ${w.block}. That does not mean there is none.`)
        : t(w, `На блоке ${w.block} у вашего кошелька нет долга в проверенных рынках, гасить нечего.`, `At block ${w.block} your wallet owes nothing in the reviewed markets, so there is nothing to repay.`),
      sources: [t(w, `ЧТЕНИЕ · блок Base ${w.block}`, `READ · Base block ${w.block}`)],
      calculatedAt: calculatedAtOf(report),
    };
  }
  const steps: string[] = [];
  let decisive: string | null = null;
  let option = 0;
  for (const loan of loans) {
    const venue = venueKeyV1(loan)!;
    const name = venueNameV1(loan);
    const amounts: Array<bigint | 'all'> = plan.usdcAtomic === null ? ['all'] : plan.usdcAtomic === 'all' ? ['all'] : [plan.usdcAtomic, 'all'];
    for (const amount of amounts) {
      const outcome = scenarioV1(reading.input, [{ kind: 'repay', venue, usdcAtomic: amount }]);
      if (!outcome.ok) continue;
      const after = outcome.after.venues.find((v) => sameVenue(v, loan))!;
      option += 1;
      const paid = amount === 'all' || BigInt(loan.debtCents!) * 10_000n <= amount ? formatCents(loan.debtCents!) : formatCents(amount / 10_000n);
      const parts = [t(w, `долг ${formatCents(loan.debtCents!)} → ${formatCents(after.debtCents ?? '0')}`, `debt ${formatCents(loan.debtCents!)} → ${formatCents(after.debtCents ?? '0')}`)];
      if (owes(after) && after.safety && loan.safety) {
        parts.push(`health factor ${healthFactorTextV1(loan.safety.healthFactor)} → ${healthFactorTextV1(after.safety.healthFactor)}`);
        // "Цена ликвидации" joins the sentence in lower case; "NVIDIA liquidation price" keeps its name.
        for (const line of liquidationLinesV1(w, outcome.after, loan, after)) parts.push(line.replace(/\.$/, '').replace(/^(\p{Lu})(?=\p{Ll})/u, (c) => c.toLowerCase()));
      } else {
        parts.push(t(w, 'ликвидировать нечего', 'nothing left to liquidate'));
      }
      const label = amount === 'all' ? t(w, `весь долг (${paid})`, `all of it (${paid})`) : paid;
      steps.push(t(w, `Вариант ${option} · Погасить ${label} на ${name}: ${parts.join(', ')}.`, `Option ${option} · Repay ${label} on ${name}: ${parts.join(', ')}.`));
      decisive ??= after.debtCents;
    }
  }
  const text =
    plan.usdcAtomic === null
      ? t(w, 'Без суммы показано полное погашение каждого займа. Назовите сумму, чтобы увидеть частичное. Залог остаётся внесённым, ничего не продаётся.', 'With no amount named, each loan is shown repaid in full. Name an amount to see a partial repayment. The collateral stays pledged and nothing is sold.')
      : t(w, 'Вот что меняет каждое погашение. Залог остаётся внесённым, ничего не продаётся.', 'Here is what each repayment changes. The collateral stays pledged and nothing is sold.');
  return {
    topic: 'analysis',
    mode: 'analysis',
    text,
    steps,
    sources: sourcesOf(report, w, true),
    calculatedAt: calculatedAtOf(report),
    bounds: [
      t(w, 'Баланс USDC здесь не читается: экран погашения читает его и симулирует платёж до вашей подписи.', 'Your USDC balance is not read here: the repayment screen reads it and simulates the payment before you sign.'),
      t(w, `Цены — как на блоке ${w.block}.`, `Prices as read at block ${w.block}.`),
    ],
    actionLink: { href: '/repay', label: t(w, 'Открыть погашение →', 'Open repayment →') },
    engineFacts: { mode: 'repay_options', debtAfterCents: decisive },
  };
}

function venueKeyV1(line: VenueLine) {
  if (line.venue === 'aave-v4') return 'aave-v4' as const;
  if (/cbBTC/i.test(line.label)) return 'morpho:cbBTC' as const;
  if (/WETH|ETH/i.test(line.label)) return 'morpho:ETH' as const;
  return null;
}

function interestAnswerV1(plan: Extract<StillAgentPlanV1, { task: 'interest' }>, reading: StillAgentReadingV1, w: Words, periodNamed: boolean): AgentAnswerV1 {
  const { report } = reading;
  const loans = report.venues.filter((line) => owes(line));
  if (loans.length === 0) {
    return {
      topic: 'analysis',
      mode: 'analysis',
      text: t(w, `На блоке ${w.block} займа нет, проценты не начисляются.`, `At block ${w.block} there is no loan, so no interest accrues.`),
      sources: [t(w, `ЧТЕНИЕ · блок Base ${w.block}`, `READ · Base block ${w.block}`)],
      calculatedAt: calculatedAtOf(report),
    };
  }
  const steps: string[] = [];
  let total = 0n;
  for (const loan of loans) {
    const name = venueNameV1(loan);
    if (loan.borrowRateBps === null) {
      steps.push(t(w, `${name}: ставка не прочитана, проценты не посчитаны.`, `${name}: the rate was not read, so its interest is not computed.`));
      continue;
    }
    // Simple interest at today's variable rate, rounded up against the borrower.
    const numerator = BigInt(loan.debtCents!) * BigInt(loan.borrowRateBps) * BigInt(plan.days);
    const cost = (numerator + 3_650_000n - 1n) / 3_650_000n;
    total += cost;
    steps.push(t(w, `${name}: ${formatCents(loan.debtCents!)} × ${formatPercentBps(loan.borrowRateBps, 2)} годовых × ${plan.days} дн. ≈ ${formatCents(cost)}.`, `${name}: ${formatCents(loan.debtCents!)} × ${formatPercentBps(loan.borrowRateBps, 2)} a year × ${plan.days} days ≈ ${formatCents(cost)}.`));
  }
  const bounds = [
    t(w, `Ставки переменные, как на блоке ${w.block}: они меняются с загрузкой рынка. Это оценка.`, `Variable rates as read at block ${w.block}: they move with how much of each market is borrowed. This is an estimate.`),
    t(w, 'Простые проценты по сегодняшней ставке; протоколы начисляют сложные, это немного больше на долгих сроках.', 'Simple interest at today’s rate; the protocols compound, which adds a little over long periods.'),
  ];
  if (!periodNamed) bounds.unshift(t(w, 'Срок не назван: показан месяц (30 дней).', 'No period was named: a month (30 days) is shown.'));
  return {
    topic: 'analysis',
    mode: 'analysis',
    text: t(w, `По ставкам на блоке ${w.block} ваш долг начислит около ${formatCents(total)} процентов за ${plan.days} дн. Это оценка: ставки переменные.`, `At the rates read at block ${w.block}, your debt accrues about ${formatCents(total)} in interest over ${plan.days} days. This is an estimate: the rates are variable.`),
    steps,
    sources: sourcesOf(report, w, false),
    calculatedAt: calculatedAtOf(report),
    bounds,
    engineFacts: { mode: 'interest', totalCents: total.toString() },
  };
}

function limitAnswerV1(reading: StillAgentReadingV1, w: Words, change: StillReadingChangeV1 | null): AgentAnswerV1 {
  const { report } = reading;
  const available = report.headline.availableCents;
  if (available === null) {
    return {
      topic: 'analysis',
      mode: 'refused',
      text: t(w, `Запас для займа не прочитан на блоке ${w.block}. Это наш сбой, а не факт о вашем кошельке.`, `The borrowing room was not read at block ${w.block}. That is our failure, not a fact about your wallet.`),
      sources: [t(w, `ЧТЕНИЕ · блок Base ${w.block}`, `READ · Base block ${w.block}`)],
      calculatedAt: calculatedAtOf(report),
    };
  }
  const steps: string[] = [];
  for (const line of report.assets) {
    if (line.capacityCents === null || line.stillFactorBps === null || line.priceCents === null) continue;
    const reasons: string[] = [];
    if (line.earnings?.lowered) reasons.push(t(w, `окно отчётности: ${STILL_SHARES_V1.earnings}%`, `earnings window: ${STILL_SHARES_V1.earnings}%`));
    if (line.limits.includes('supply_cap')) reasons.push(t(w, 'упёрлось в лимит Aave', 'held back by Aave’s cap'));
    if (line.limits.some((l) => ['reserve_paused', 'reserve_frozen', 'spoke_halted', 'issuer_paused', 'not_listed'].includes(l))) reasons.push(t(w, 'рынок закрыт для займов', 'the market is closed to loans'));
    steps.push(t(w, `${line.name}: цена ${formatCents(line.priceCents)}, зачёт Still ${formatPercentBps(line.stillFactorBps, 2)} → ${formatCents(line.capacityCents)}${reasons.length ? ` (${reasons.join('; ')})` : ''}.`, `${line.name}: price ${formatCents(line.priceCents)}, Still counts ${formatPercentBps(line.stillFactorBps, 2)} → ${formatCents(line.capacityCents)}${reasons.length ? ` (${reasons.join('; ')})` : ''}.`));
  }
  for (const venue of report.venues) {
    if (venue.deductions.loansCents && venue.deductions.loansCents !== '0') steps.push(t(w, `Долг на ${venueNameV1(venue)} вычтен: −${formatCents(venue.deductions.loansCents)}.`, `Debt on ${venueNameV1(venue)} is subtracted: −${formatCents(venue.deductions.loansCents)}.`));
    if (venue.deductions.venueLimitCents && venue.deductions.venueLimitCents !== '0') steps.push(t(w, `${venueNameV1(venue)} сейчас может дать меньше: −${formatCents(venue.deductions.venueLimitCents)}.`, `${venueNameV1(venue)} can lend less right now: −${formatCents(venue.deductions.venueLimitCents)}.`));
  }
  const weekday = report.headline.weekdayAvailableCents;
  if (report.terms.weekend.active && weekday !== null) {
    steps.push(t(w, `Рынок США закрыт: акции считаются по ${STILL_SHARES_V1.closed}% вместо ${STILL_SHARES_V1.full}% до ${newYorkMomentV1(report.terms.weekend.endsAt)} по Нью-Йорку; на открытом рынке было бы ${formatCents(weekday)}.`, `The US market is closed: stocks count at ${STILL_SHARES_V1.closed}% instead of ${STILL_SHARES_V1.full}% until ${newYorkMomentV1(report.terms.weekend.endsAt)} New York time; an open market would give ${formatCents(weekday)}.`));
  }
  const sentences = [t(w, `Сейчас запас для займа — ${formatCents(available)}.`, `Your borrowing room is ${formatCents(available)} now.`)];
  if (change) {
    sentences.push(
      t(w, `${change.sinceText.ru}: было ${formatCents(change.before)}, стало ${formatCents(available)}.`, `${change.sinceText.en} it was ${formatCents(change.before)}; it is ${formatCents(available)} now.`),
    );
    for (const cause of change.causes) steps.unshift(w.ru ? cause.ru : cause.en);
    if (change.causes.length) sentences.push(t(w, 'Причины — по шагам ниже.', 'The causes are in the steps below.'));
  } else {
    sentences.push(t(w, 'Более раннего чтения вашего кошелька сохранено не было, поэтому сравнить не с чем; ниже — из чего складывается запас сейчас.', 'No earlier reading of your wallet is stored, so there is nothing to compare with; below is what makes up the room now.'));
  }
  if (report.terms.weekend.active && weekday !== null && BigInt(weekday) > BigInt(available)) {
    sentences.push(t(w, `Пока рынок закрыт, акции считаются по ${STILL_SHARES_V1.closed}%: на открытом рынке было бы ${formatCents(weekday)}.`, `While the market is closed, stocks count at ${STILL_SHARES_V1.closed}%: an open market would give ${formatCents(weekday)}.`));
  }
  return {
    topic: 'analysis',
    mode: 'analysis',
    text: sentences.join(' '),
    steps,
    sources: sourcesOf(report, w, false),
    calculatedAt: calculatedAtOf(report),
    bounds: [t(w, 'Запас пересчитывается на каждом блоке вслед за ценами оракулов.', 'The room is recomputed at every block, with the oracle prices.')],
    engineFacts: { mode: 'limit', availableCents: available },
  };
}

function needsAnswerV1(what: PlanNeedV1, report: MirrorReport, w: Words): AgentAnswerV1 {
  const loans = report.venues.filter((line) => owes(line)).map(venueNameV1);
  const text = {
    percent: t(w, 'Назовите движение в процентах, например «NVDA −20%», или цену, например «BTC до $60,000».', 'Name the move as a percentage, e.g. “NVDA −20%”, or a price, e.g. “BTC to $60,000”.'),
    amount: t(w, 'Назовите сумму в долларах, например «погасить $100».', 'Name the amount in dollars, e.g. “repay $100”.'),
    asset: t(w, 'Назовите актив: NVDA, AAPL, TSLA, MSFT, AMZN, GOOGL, META, BTC или ETH, или «мои акции».', 'Name the asset: NVDA, AAPL, TSLA, MSFT, AMZN, GOOGL, META, BTC or ETH, or “my stocks”.'),
    venue: t(w, `Назовите займ${loans.length ? `: ${loans.join(' или ')}` : ''}.`, `Name the loan${loans.length ? `: ${loans.join(' or ')}` : ''}.`),
    direction: t(w, 'Скажите, падает цена или растёт, например «NVDA упадёт на 20%».', 'Say whether the price falls or rises, e.g. “NVDA falls 20%”.'),
  }[what];
  return { topic: 'analysis', mode: 'refused', text, sources: [] };
}

function unsupportedAnswerV1(reason: PlanUnsupportedV1, w: Words): AgentAnswerV1 {
  const text = {
    not_reviewed_asset: t(w, 'Still считает только акции Coinbase (AAPL, AMZN, GOOGL, META, MSFT, NVDA, TSLA), cbBTC и ETH. Других активов в расчёте нет.', 'Still computes only Coinbase stocks (AAPL, AMZN, GOOGL, META, MSFT, NVDA, TSLA), cbBTC and ETH. Nothing else is in the calculation.'),
    other_wallet: t(w, 'Я читаю только ваш кошелёк, с которым вы вошли. Любой адрес можно проверить на Home.', 'I read only the wallet you signed in with. Any address can be checked on Home.'),
    forecast: t(w, 'Я не предсказываю цены. Назовите движение, например «NVDA −20%», и я посчитаю, что оно сделает с займом.', 'I do not predict prices. Name a move, e.g. “NVDA −20%”, and I will compute what it does to your loan.'),
    tax: t(w, 'Налоги Still не считает.', 'Still does not compute taxes.'),
    trade: t(w, 'Сделки и обмены — в Swap AI. Здесь — займы без продажи.', 'Trades and swaps are on Swap AI. This is about borrowing without selling.'),
    other: null,
  }[reason];
  return { topic: null, mode: text ? 'refused' : undefined, text: text ?? agentCapabilitiesV2(w.ru), sources: [] };
}

export interface StillAgentToolInputV1 {
  plan: StillAgentPlanV1;
  reading: StillAgentReadingV1;
  ru: boolean;
  question: string;
  /** The room at an earlier stored reading, for "why did it change". */
  change?: StillReadingChangeV1 | null;
}

/** A plan's answer, from the engine's reports. `status` and `chat` are answered by the page's own rules upstream. */
export function stillAgentToolAnswerV1(input: StillAgentToolInputV1): AgentAnswerV1 {
  const w = wordsOf(input.reading.report, input.ru);
  switch (input.plan.task) {
    case 'scenario':
      return scenarioAnswerV1(input.plan, input.reading, w);
    case 'repay_options':
      return repayOptionsAnswerV1(input.plan, input.reading, w);
    case 'interest':
      return interestAnswerV1(input.plan, input.reading, w, /\d|year|month|week|day|год|месяц|недел|день|сутк/iu.test(input.question));
    case 'limit':
      return limitAnswerV1(input.reading, w, input.change ?? null);
    case 'needs':
      return needsAnswerV1(input.plan.what, input.reading.report, w);
    case 'unsupported':
      return unsupportedAnswerV1(input.plan.reason, w);
    case 'status':
    case 'chat':
      return { topic: null, text: agentCapabilitiesV2(input.ru), sources: [] };
  }
}
