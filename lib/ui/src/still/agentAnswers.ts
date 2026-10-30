import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';
import { formatCents } from '@mioagent/still-engine/format';

import { STILL_SHARES_V1, newYorkMomentV1, type SkyStateV1 } from './skyState';
import { dividendMoneyV1 } from './dividendMoney';

// ---------------------------------------------------------------------------
// Still Agent v2: hybrid financial analyst.
//
// Three modes of operation:
//   1. `fast`        — instant deterministic answers for direct status reads
//                      (borrowing room, current loan safety, market hours,
//                      dividends, holdings) directly from Mirror & calendars.
//   2. `analysis`    — verified Risk Engine calculations for price-shock
//                      scenarios ("What if NVDA drops 30%?"), borrowing-limit
//                      change attribution ("Why did my limit decrease?"), and
//                      safe debt-reduction options ("How to safely reduce debt
//                      by $100?"), optionally narrated by OpenRouter LLM while
//                      remaining 100% bound to deterministic figures.
//   3. `action_prep` — transaction preparation boundary ("Borrow $500 and send
//                      to a friend"): refuses autonomous signing or chained
//                      third-party transfers and prepares only verified self-
//                      custodial review links (/borrow or /repay).
//
// Fail-closed: when the financial engine lacks required onchain or oracle data,
// it refuses the calculation and names the missing evidence.
// ---------------------------------------------------------------------------

export type AgentTopicV1 =
  | 'borrow'
  | 'safety'
  | 'closed'
  | 'dividends'
  | 'holdings'
  | 'stress_test'
  | 'limit_change'
  | 'repay_options'
  | 'action_prep';
export type AgentModeV2 = 'fast' | 'analysis' | 'action_prep' | 'refused';
export type DividendReadStateV1 = 'not_loaded' | 'loading' | 'unavailable' | 'read';

export interface AgentActionLinkV2 {
  href: string;
  label: string;
  note?: string;
}

export interface AgentAnswerV1 {
  topic: AgentTopicV1 | null;
  mode?: AgentModeV2;
  text: string;
  /** What the figures stand on, printed under the answer. */
  sources: string[];
  /** Verified calculation steps from Miorail Evidence & Risk Engine. */
  steps?: string[];
  /** Explicit review preparation link (never auto-executes). */
  actionLink?: AgentActionLinkV2 | null;
  /** Structured Risk Engine output used to ground OpenRouter explanations. */
  engineFacts?: Record<string, unknown> | null;
  /** True when the hybrid backend can enrich this answer via OpenRouter. */
  needsLlm?: boolean;
}

const PATTERNS_V1: ReadonlyArray<[AgentTopicV1, RegExp]> = [
  [
    'action_prep',
    /(?:^|\s)(?:займи|возьми\s+займ|отправь|переведи|подпиши|исполни|borrow\s+\$?\d|send\s+(?:it\s+)?to|transfer\s+to)(?:\s|$)|(?:займ|borrow).*(?:отправ|перевед|друг|send|transfer|friend)/i,
  ],
  [
    'stress_test',
    /(?:если|при\s+падении|упад[её]т|падени[еи]|просадк|обвал|снизит|drop|fall|crash|down|shock|stress).*(?:\d+\s*%)|(?:\d+\s*%).*(?:упад|падени|сниз|drop|fall|crash|down)/i,
  ],
  [
    'limit_change',
    /почему.*(?:уменьш|сниз|упал|измен|меньше|сократ)|why.*(?:decreas|drop|lower|less|chang|reduc|shrank).*(?:limit|borrow|room|loan|sum|amount)|(?:уменьш|сниз).*(?:лимит|сумм.*займ)/i,
  ],
  [
    'repay_options',
    /(?:уменьш|сниз|погас|закрыт|вернут|выплат|repay|reduce|pay\s*down|pay\s*off|clear).*(?:долг|займ|кредит|debt|loan)|(?:долг|займ|debt|loan).*(?:уменьш|сниз|погас|repay|reduce)/i,
  ],
  ['dividends', /dividend|дивиденд/i],
  ['safety', /safe|liquidat|health|risk|безопас|ликвид|риск|упад/i],
  ['closed', /weekend|holiday|closed|night|выходн|праздн|закрыт|ноч/i],
  ['borrow', /borrow|lend|spend|how much|loan|cash|взять|занять|сколько|займ|кредит|деньг/i],
  ['holdings', /hold|own|assets|portfolio|что у меня|акти|держ/i],
];

export function agentTopicV1(question: string): AgentTopicV1 | null {
  for (const [topic, pattern] of PATTERNS_V1) if (pattern.test(question)) return topic;
  return null;
}

export function isRussianV1(text: string): boolean {
  return /[а-яё]/i.test(text);
}

export const AGENT_PROMPTS_V1: ReadonlyArray<{ en: string; ru: string; mode?: AgentModeV2 }> = [
  { en: 'How much can I spend without selling?', ru: 'Сколько я могу взять без продажи?', mode: 'fast' },
  { en: 'How safe is my loan?', ru: 'Насколько безопасен мой займ?', mode: 'fast' },
  { en: 'What happens if NVDA drops 30%?', ru: 'Что будет при падении NVDA на 30%?', mode: 'analysis' },
  { en: 'Why did my borrowing limit decrease?', ru: 'Почему моя сумма займа уменьшилась?', mode: 'analysis' },
  { en: 'How to safely reduce debt by $100?', ru: 'Как безопаснее уменьшить долг на $100?', mode: 'analysis' },
  { en: 'When do weekend limits start?', ru: 'Когда начинаются выходные лимиты?', mode: 'fast' },
  { en: 'When is my next dividend?', ru: 'Когда мой следующий дивиденд?', mode: 'fast' },
];

const ASSET_MATCHERS_V2: ReadonlyArray<[string, RegExp]> = [
  ['NVDAc', /nvda|nvidia|нвиди/i],
  ['AAPLc', /aapl|apple|эппл|яблок/i],
  ['TSLAc', /tsla|tesla|тесл/i],
  ['MSFTc', /msft|microsoft|майкрософт/i],
  ['AMZNc', /amzn|amazon|амазон/i],
  ['GOOGLc', /googl|google|alphabet|гугл/i],
  ['METAc', /\bmeta\b|мета/i],
  ['cbBTC', /cbbtc|btc|bitcoin|биткоин|битк/i],
  ['ETH', /\bweth\b|\beth\b|ether|эфир/i],
];

export function matchAgentAssetV2(question: string): string | null {
  for (const [assetId, regex] of ASSET_MATCHERS_V2) {
    if (regex.test(question)) return assetId;
  }
  return null;
}

function parseDollarCentsV2(question: string): bigint | null {
  const withoutPct = question.replace(/\d+(?:[.,]\d+)?\s*%/g, ' ');
  const m = /(?:\$\s*(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*(?:\$|usd|usdc|доллар|бакс))/i.exec(withoutPct)
    ?? /(?:на|by|занять|займи|borrow|repay|долг)\s+\$?(\d+(?:[.,]\d{1,2})?)/i.exec(withoutPct);
  const raw = m?.[1] ?? m?.[2];
  if (!raw) return null;
  const num = Number(raw.replace(',', '.'));
  if (!Number.isFinite(num) || num <= 0 || num > 1_000_000_000) return null;
  return BigInt(Math.round(num * 100));
}

function formatRatioHundredthsV2(hundredths: bigint): string {
  const whole = hundredths / BigInt(100);
  const frac = (hundredths % BigInt(100)).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

export function agentAnswerV1(input: {
  question: string;
  report: MirrorReport | null;
  sky: SkyStateV1;
  dividends?: DividendWalletResponseV1 | null;
  dividendsReadState?: DividendReadStateV1;
  signedIn?: boolean;
}): AgentAnswerV1 {
  const ru = isRussianV1(input.question);
  const topic = agentTopicV1(input.question);
  const { report, sky } = input;
  const read = report ? [ru ? `ЧЕЙН · блок ${Number(report.reading.block).toLocaleString('en-US')}` : `READ · Base block ${Number(report.reading.block).toLocaleString('en-US')}`] : [];
  const terms = report ? [ru ? `УСЛОВИЯ · Still ${report.terms.version}` : `TERMS · Still ${report.terms.version}`] : [];
  const riskSource = ru ? 'РИСК-ДВИЖОК · детерминированный расчёт Miorail' : 'RISK ENGINE · Miorail deterministic math';
  const boundarySource = ru ? 'БЕЗОПАСНОСТЬ · только подготовка, подпись в кошельке' : 'BOUNDARY · preparation only, wallet signs';

  if (topic === 'action_prep') {
    const thirdParty = /(?:отправ|перевед|друг|send|transfer|friend)/i.test(input.question);
    const wantsRepay = /(?:погас|вернут|закрыт|repay|pay\s*down|pay\s*off)/i.test(input.question) && !/(?:займ|возьми|borrow)/i.test(input.question);
    const requestedCents = parseDollarCentsV2(input.question);
    const availableCents = report?.headline.availableCents !== null && report?.headline.availableCents !== undefined
      ? BigInt(report.headline.availableCents)
      : null;

    const steps: string[] = [];
    if (thirdParty) {
      steps.push(
        ru
          ? 'Запрещено: автоматическая подпись и цепочка «занять и отправить третьему лицу» отклонены.'
          : 'Blocked: autonomous signing and chained third-party transfers ("borrow and send to a friend") are refused.',
      );
    } else {
      steps.push(
        ru
          ? 'Граница полномочий: агент не подписывает и не отправляет транзакции за вас.'
          : 'Execution boundary: the agent never signs or broadcasts transactions on your behalf.',
      );
    }

    let limitNote = '';
    if (requestedCents !== null && availableCents !== null && !wantsRepay) {
      const fits = requestedCents <= availableCents;
      const checkLine = fits
        ? ru
          ? `Проверка лимита: запрошенные ${formatCents(requestedCents)} укладываются в расчётный запас Still (${formatCents(availableCents)}).`
          : `Limit check: requested ${formatCents(requestedCents)} fits within Still’s modelled room (${formatCents(availableCents)}).`
        : ru
          ? `Проверка лимита: запрошенные ${formatCents(requestedCents)} превышают расчётный запас Still (${formatCents(availableCents)}).`
          : `Limit check: requested ${formatCents(requestedCents)} exceeds Still’s modelled room (${formatCents(availableCents)}).`;
      steps.push(checkLine);
      limitNote = ` ${checkLine}`;
    }

    steps.push(
      wantsRepay
        ? ru
          ? 'Доступный шаг: перейти к проверке погашения (/repay) с симуляцией на свежем блоке и личным подтверждением в кошельке.'
          : 'Available step: open repayment review (/repay) with a fresh block simulation and explicit wallet confirmation.'
        : ru
          ? 'Доступный шаг: перейти к подготовке займа (/borrow), выбрать залог, проверить симуляцию на блоке и подписать лично в кошельке.'
          : 'Available step: open borrow preparation (/borrow), choose collateral, verify the block simulation, and sign in your wallet.',
    );

    const text = thirdParty
      ? ru
        ? `Я не исполняю транзакции автоматически и не отправляю средства на сторонние адреса («отправить другу»).${limitNote} Я могу только подготовить проверенный займ на ваш собственный кошелёк через экран «Взять деньги» — с симуляцией на блоке и вашим личным подтверждением подписи.`
        : `I do not execute transactions autonomously or transfer funds to third-party wallets ("send to a friend").${limitNote} I can only prepare a verified loan to your own wallet on Get money, with a fresh block simulation and your explicit wallet signature.`
      : wantsRepay
        ? ru
          ? 'Я не подписываю погашение без вашего участия. Откройте экран погашения: мы проверим точную сумму долга на свежем блоке, а подпись вы подтвердите лично в кошельке.'
          : 'I never sign repayments without you. Open the repayment screen: we will verify the exact debt at a fresh block and you will confirm the signature in your wallet.'
        : ru
          ? `Я не подписываю займы автоматически.${limitNote} Откройте «Взять деньги», чтобы подготовить проверенную транзакцию и подтвердить её в своём кошельке.`
          : `I never sign loans automatically.${limitNote} Open Get money to prepare a verified transaction and confirm it in your wallet.`;

    return {
      topic,
      mode: 'action_prep',
      text,
      steps,
      sources: [boundarySource, ...terms, ...read],
      actionLink: wantsRepay
        ? { href: '/repay', label: ru ? 'Перейти к подготовке погашения →' : 'Open repayment preparation →' }
        : { href: '/borrow', label: ru ? 'Перейти к подготовке займа →' : 'Open borrow preparation →' },
      engineFacts: {
        mode: 'action_prep',
        thirdPartyTransferRefused: thirdParty,
        autonomousSigningRefused: true,
        requestedCents: requestedCents?.toString() ?? null,
        availableCents: availableCents?.toString() ?? null,
        targetRoute: wantsRepay ? '/repay' : '/borrow',
      },
      needsLlm: true,
    };
  }

  if (topic === null) {
    return {
      topic,
      mode: report ? 'analysis' : 'refused',
      text: ru
        ? 'Я отвечаю только по проверенным данным вашего кошелька и риск-движка: сколько можно занять без продажи, что будет при падении цены актива (например, NVDA на 30%), почему изменился лимит, как безопасно уменьшить долг, когда действуют выходные лимиты и когда дивиденды.'
        : 'I answer strictly from your verified wallet evidence and Risk Engine: how much you can borrow without selling, what happens under a price shock (e.g. NVDA down 30%), why your limit changed, how to safely reduce debt, weekend limits, and dividends.',
      sources: [...terms, ...read],
      engineFacts: report
        ? {
            mode: 'open_question',
            block: report.reading.block,
            availableCents: report.headline.availableCents,
            weekdayAvailableCents: report.headline.weekdayAvailableCents,
            assets: report.assets.map((a) => ({
              asset: a.asset,
              name: a.name,
              priceCents: a.priceCents,
              valueCents: a.valueCents,
              capacityCents: a.capacityCents,
              protocolFactorBps: a.protocolFactorBps,
              stillFactorBps: a.stillFactorBps,
            })),
            venues: report.venues.map((v) => ({
              venue: v.venue,
              debtCents: v.debtCents,
              availableCents: v.availableCents,
              healthFactor: v.safety?.healthFactor ?? null,
              marginBps: v.safety?.marginBps ?? null,
            })),
          }
        : null,
      needsLlm: Boolean(report),
    };
  }

  if (topic === 'closed') {
    const until = newYorkMomentV1(sky.closed.endsAt);
    const from = newYorkMomentV1(sky.closed.startsAt);
    return {
      topic,
      mode: 'fast',
      text: sky.closed.active
        ? ru
          ? `Сейчас Уолл-стрит закрыта. До ${until} по Нью-Йорку новые займы под акции считаются по ${STILL_SHARES_V1.closed}% лимита протокола, а не по ${STILL_SHARES_V1.full}%. Уже взятые займы это не меняет.`
          : `Wall Street is closed now. Until ${until} New York time, new loans against stocks count at ${STILL_SHARES_V1.closed}% of the protocol’s limit, not ${STILL_SHARES_V1.full}%. Loans you have are not touched.`
        : ru
          ? `С ${from} до ${until} по Нью-Йорку, пока рынок закрыт, новые займы под акции считаются по ${STILL_SHARES_V1.closed}% лимита протокола. Праздники тоже. Уже взятые займы это не меняет.`
          : `From ${from} to ${until} New York time, while the market is closed, new loans against stocks count at ${STILL_SHARES_V1.closed}% of the protocol’s limit. Holidays too. Loans you have are not touched.`,
      sources: [ru ? 'КАЛЕНДАРЬ · рынок США, проверенный Miorail' : 'CALENDAR · US market, reviewed by Miorail'],
      needsLlm: false,
    };
  }

  if (!report) {
    return {
      topic,
      mode: 'refused',
      text: input.signedIn
        ? ru ? 'Данные вашего кошелька ещё не прочитаны. Пока нельзя сделать вывод о балансе или займах.' : 'Your wallet report has not been read yet. No balance or loan conclusion is available.'
        : ru ? 'Для этого нужен ваш кошелёк: войдите, и я прочитаю его на Base.' : 'That needs your wallet: sign in and I will read it on Base.',
      sources: [],
      needsLlm: false,
    };
  }

  if (topic === 'stress_test') {
    const pctMatch = /(\d+(?:[.,]\d+)?)\s*%/.exec(input.question);
    const rawPct = pctMatch ? Number(pctMatch[1].replace(',', '.')) : 25;
    const dropPct = Math.max(1, Math.min(99, Math.round(Number.isFinite(rawPct) ? rawPct : 25)));
    const dropBps = BigInt(dropPct * 100);
    const keepBps = BigInt(10000) - dropBps;
    const requestedAssetId = matchAgentAssetV2(input.question);

    // Find target asset line or fallback to primary pledged/held asset
    const requestedLine = requestedAssetId
      ? report.assets.find((a) => a.asset.toLowerCase() === requestedAssetId.toLowerCase()) ?? null
      : null;
    const pledgedLines = report.assets.filter((a) => a.pledged !== null && BigInt(a.pledged.raw) > BigInt(0));
    const heldLines = report.assets.filter((a) =>
      [a.wallet, a.pledged].some((amt) => amt !== null && BigInt(amt.raw) > BigInt(0)),
    );
    const targetLine = requestedLine ?? pledgedLines[0] ?? heldLines[0] ?? null;

    if (!targetLine) {
      return {
        topic,
        mode: 'refused',
        text: ru
          ? `Расчёт отклонён: в кошельке на блоке ${Number(report.reading.block).toLocaleString('en-US')} не найдено залоговых активов для стресс-теста падения на ${dropPct}%.`
          : `Calculation refused: no collateral holdings were found in your wallet at block ${Number(report.reading.block).toLocaleString('en-US')} to stress-test a ${dropPct}% drop.`,
        sources: [riskSource, ...read],
        needsLlm: false,
      };
    }

    if (
      targetLine.priceCents === null ||
      targetLine.valueCents === null ||
      targetLine.protocolFactorBps === null ||
      targetLine.stillFactorBps === null
    ) {
      return {
        topic,
        mode: 'refused',
        text: ru
          ? `Расчёт отклонён: цена оракула или залоговый фактор для ${targetLine.name} (${targetLine.asset}) не прочитаны на блоке ${Number(report.reading.block).toLocaleString('en-US')}. Агент не строит догадок без полных данных.`
          : `Calculation refused: the oracle price or collateral factor for ${targetLine.name} (${targetLine.asset}) could not be read at block ${Number(report.reading.block).toLocaleString('en-US')}. The agent does not guess when evidence is incomplete.`,
        sources: [riskSource, ...read],
        needsLlm: false,
      };
    }

    const venueKey = targetLine.venue === 'aave-v4' ? 'aave-v4' : 'morpho-blue';
    const venue = report.venues.find((v) => v.venue === venueKey) ?? null;
    if (venue && venue.debtCents === null) {
      return {
        topic,
        mode: 'refused',
        text: ru
          ? `Расчёт отклонён: текущий долг на ${venue.label} не удалось прочитать на блоке ${Number(report.reading.block).toLocaleString('en-US')}.`
          : `Calculation refused: current debt on ${venue.label} could not be read at block ${Number(report.reading.block).toLocaleString('en-US')}.`,
        sources: [riskSource, ...read],
        needsLlm: false,
      };
    }

    const priceBeforeCents = BigInt(targetLine.priceCents);
    const priceAfterCents = (priceBeforeCents * keepBps) / BigInt(10000);
    const valueBeforeCents = BigInt(targetLine.valueCents);
    const valueAfterCents = (valueBeforeCents * keepBps) / BigInt(10000);
    const capBeforeCents = targetLine.capacityCents !== null ? BigInt(targetLine.capacityCents) : BigInt(0);
    const capAfterCents = (capBeforeCents * keepBps) / BigInt(10000);
    const debtCents = venue?.debtCents ? BigInt(venue.debtCents) : BigInt(0);

    const notHeldNote = requestedAssetId && !requestedLine
      ? ru
        ? `В вашем портфеле нет ${requestedAssetId} (0 токенов), поэтому падение ${requestedAssetId} само по себе не меняет ваш займ. Ниже — стресс-тест падения на ${dropPct}% для вашего фактического залога ${targetLine.name} (${targetLine.asset}): `
        : `Your wallet holds 0 ${requestedAssetId}, so a drop in ${requestedAssetId} alone does not affect your loan. Below is the ${dropPct}% stress test for your actual collateral ${targetLine.name} (${targetLine.asset}): `
      : '';

    const steps: string[] = [
      ru
        ? `Цена ${targetLine.name} (${targetLine.asset}): ${formatCents(priceBeforeCents)} → ${formatCents(priceAfterCents)} (−${dropPct}%).`
        : `${targetLine.name} (${targetLine.asset}) price: ${formatCents(priceBeforeCents)} → ${formatCents(priceAfterCents)} (−${dropPct}%).`,
      ru
        ? `Стоимость позиции ${targetLine.name}: ${formatCents(valueBeforeCents)} → ${formatCents(valueAfterCents)}.`
        : `${targetLine.name} position value: ${formatCents(valueBeforeCents)} → ${formatCents(valueAfterCents)}.`,
    ];

    if (debtCents > BigInt(0) && venue) {
      // Compute weighted collateral across all assets on this venue before & after shock
      const venueAssets = report.assets.filter((a) => a.venue === targetLine.venue);
      let weightedBeforeCents = BigInt(0);
      let weightedAfterCents = BigInt(0);
      for (const a of venueAssets) {
        if (!a.pledged || BigInt(a.pledged.raw) === BigInt(0) || a.priceCents === null || a.protocolFactorBps === null) continue;
        const aPledgedCents = a.wallet && BigInt(a.wallet.raw) === BigInt(0) && a.valueCents !== null
          ? BigInt(a.valueCents)
          : (BigInt(a.pledged.raw) * BigInt(a.priceCents)) / (BigInt(10) ** BigInt(a.pledged.decimals));
        const wBefore = (aPledgedCents * BigInt(a.protocolFactorBps)) / BigInt(10000);
        const wAfter = a.asset === targetLine.asset ? (wBefore * keepBps) / BigInt(10000) : wBefore;
        weightedBeforeCents += wBefore;
        weightedAfterCents += wAfter;
      }

      if (weightedBeforeCents === BigInt(0)) {
        weightedBeforeCents = (valueBeforeCents * BigInt(targetLine.protocolFactorBps)) / BigInt(10000);
        weightedAfterCents = (weightedBeforeCents * keepBps) / BigInt(10000);
      }

      const hfBeforeHundredths = venue.safety
        ? (BigInt(venue.safety.healthFactor) * BigInt(100)) / (BigInt(10) ** BigInt(18))
        : (weightedBeforeCents * BigInt(100)) / debtCents;
      const hfAfterHundredths = weightedBeforeCents > BigInt(0)
        ? (hfBeforeHundredths * weightedAfterCents) / weightedBeforeCents
        : BigInt(0);
      const liquidatedAfter = hfAfterHundredths < BigInt(100);
      const marginAfterPct = liquidatedAfter
        ? 0
        : Number(((hfAfterHundredths - BigInt(100)) * BigInt(100)) / hfAfterHundredths);
      const liqEntry = venue.liquidationPrices.find((p) => p.asset === targetLine.asset);
      const liqPriceCents = liqEntry && !liqEntry.unreachable && liqEntry.priceCents !== null ? BigInt(liqEntry.priceCents) : null;

      steps.push(
        ru
          ? `Порог ликвидации залога (${targetLine.protocolFactorBps / 100}%): ${formatCents(weightedBeforeCents)} → ${formatCents(weightedAfterCents)} против долга ${formatCents(debtCents)}.`
          : `Liquidation threshold (${targetLine.protocolFactorBps / 100}%): ${formatCents(weightedBeforeCents)} → ${formatCents(weightedAfterCents)} against ${formatCents(debtCents)} debt.`,
      );
      steps.push(
        ru
          ? `Health Factor: ${formatRatioHundredthsV2(hfBeforeHundredths)} → ${formatRatioHundredthsV2(hfAfterHundredths)} (${liquidatedAfter ? 'зона ликвидации < 1.00' : `запас ещё ${marginAfterPct}% падения`}).`
          : `Health Factor: ${formatRatioHundredthsV2(hfBeforeHundredths)} → ${formatRatioHundredthsV2(hfAfterHundredths)} (${liquidatedAfter ? 'liquidation zone < 1.00' : `${marginAfterPct}% further drop buffer`}).`,
      );
      if (liqPriceCents !== null) {
        steps.push(
          ru
            ? `Точка ликвидации по ${targetLine.name}: ${formatCents(liqPriceCents)} за акцию.`
            : `Liquidation trigger price for ${targetLine.name}: ${formatCents(liqPriceCents)}.`,
        );
      }

      const venueCapBefore = venue.capacityCents !== null ? BigInt(venue.capacityCents) : capBeforeCents;
      const venueCapAfter = venueCapBefore > capBeforeCents - capAfterCents
        ? venueCapBefore - (capBeforeCents - capAfterCents)
        : BigInt(0);
      const availAfterCents = venueCapAfter > debtCents ? venueCapAfter - debtCents : BigInt(0);

      const statusSentence = liquidatedAfter
        ? ru
          ? `При падении ${targetLine.name} на ${dropPct}% (с ${formatCents(priceBeforeCents)} до ${formatCents(priceAfterCents)}) Health Factor вашего займа ${formatCents(debtCents)} упадёт с ${formatRatioHundredthsV2(hfBeforeHundredths)} до ${formatRatioHundredthsV2(hfAfterHundredths)} — позиция попадёт в зону ликвидации${liqPriceCents !== null ? ` (порог ликвидации — ${formatCents(liqPriceCents)})` : ''}.`
          : `If ${targetLine.name} drops ${dropPct}% (from ${formatCents(priceBeforeCents)} to ${formatCents(priceAfterCents)}), the Health Factor on your ${formatCents(debtCents)} loan falls from ${formatRatioHundredthsV2(hfBeforeHundredths)} to ${formatRatioHundredthsV2(hfAfterHundredths)} — entering liquidation${liqPriceCents !== null ? ` (liquidation trigger is ${formatCents(liqPriceCents)})` : ''}.`
        : ru
          ? `При падении ${targetLine.name} на ${dropPct}% (с ${formatCents(priceBeforeCents)} до ${formatCents(priceAfterCents)}) ваш займ ${formatCents(debtCents)} останется безопасным: Health Factor снизится с ${formatRatioHundredthsV2(hfBeforeHundredths)} до ${formatRatioHundredthsV2(hfAfterHundredths)}, а до ликвидации${liqPriceCents !== null ? ` (ниже ${formatCents(liqPriceCents)})` : ''} останется ещё ${marginAfterPct}% запаса. Доступный лимит нового займа изменится до ${formatCents(availAfterCents)}.`
          : `If ${targetLine.name} drops ${dropPct}% (from ${formatCents(priceBeforeCents)} to ${formatCents(priceAfterCents)}), your ${formatCents(debtCents)} loan remains safe: Health Factor moves from ${formatRatioHundredthsV2(hfBeforeHundredths)} to ${formatRatioHundredthsV2(hfAfterHundredths)}, leaving a ${marginAfterPct}% buffer before liquidation${liqPriceCents !== null ? ` (below ${formatCents(liqPriceCents)})` : ''}. Available new borrowing room becomes ${formatCents(availAfterCents)}.`;

      return {
        topic,
        mode: 'analysis',
        text: `${notHeldNote}${statusSentence}`,
        steps,
        sources: [riskSource, ...terms, ...read],
        engineFacts: {
          mode: 'stress_test',
          asset: targetLine.asset,
          assetName: targetLine.name,
          dropPct,
          priceBeforeCents: priceBeforeCents.toString(),
          priceAfterCents: priceAfterCents.toString(),
          valueBeforeCents: valueBeforeCents.toString(),
          valueAfterCents: valueAfterCents.toString(),
          debtCents: debtCents.toString(),
          hfBefore: formatRatioHundredthsV2(hfBeforeHundredths),
          hfAfter: formatRatioHundredthsV2(hfAfterHundredths),
          liquidatedAfter,
          marginAfterPct,
          liquidationPriceCents: liqPriceCents?.toString() ?? null,
          availableAfterCents: availAfterCents.toString(),
        },
        needsLlm: true,
      };
    }

    steps.push(
      ru
        ? `Лимит займа Still под ${targetLine.name} (${targetLine.stillFactorBps / 100}%): ${formatCents(capBeforeCents)} → ${formatCents(capAfterCents)}.`
        : `Still borrowing capacity on ${targetLine.name} (${targetLine.stillFactorBps / 100}%): ${formatCents(capBeforeCents)} → ${formatCents(capAfterCents)}.`,
    );

    return {
      topic,
      mode: 'analysis',
      text: ru
        ? `${notHeldNote}При падении ${targetLine.name} на ${dropPct}% (с ${formatCents(priceBeforeCents)} до ${formatCents(priceAfterCents)}) стоимость позиции снизится с ${formatCents(valueBeforeCents)} до ${formatCents(valueAfterCents)}. Активного долга сейчас нет (риск ликвидации отсутствует), а доступный запас для нового займа под ${targetLine.name} уменьшится с ${formatCents(capBeforeCents)} до ${formatCents(capAfterCents)}.`
        : `${notHeldNote}If ${targetLine.name} drops ${dropPct}% (from ${formatCents(priceBeforeCents)} to ${formatCents(priceAfterCents)}), your position value moves from ${formatCents(valueBeforeCents)} to ${formatCents(valueAfterCents)}. You have no active debt (zero liquidation risk), and Still borrowing capacity on ${targetLine.name} decreases from ${formatCents(capBeforeCents)} to ${formatCents(capAfterCents)}.`,
      steps,
      sources: [riskSource, ...terms, ...read],
      engineFacts: {
        mode: 'stress_test',
        asset: targetLine.asset,
        assetName: targetLine.name,
        dropPct,
        priceBeforeCents: priceBeforeCents.toString(),
        priceAfterCents: priceAfterCents.toString(),
        valueBeforeCents: valueBeforeCents.toString(),
        valueAfterCents: valueAfterCents.toString(),
        debtCents: '0',
        capacityBeforeCents: capBeforeCents.toString(),
        capacityAfterCents: capAfterCents.toString(),
      },
      needsLlm: true,
    };
  }

  if (topic === 'limit_change') {
    if (report.headline.availableCents === null) {
      return {
        topic,
        mode: 'refused',
        text: ru
          ? `Расчёт отклонён: доступный лимит займа не удалось прочитать на блоке ${Number(report.reading.block).toLocaleString('en-US')}.`
          : `Calculation refused: available borrowing room could not be read at block ${Number(report.reading.block).toLocaleString('en-US')}.`,
        sources: [riskSource, ...read],
        needsLlm: false,
      };
    }

    const availableCents = BigInt(report.headline.availableCents);
    const weekdayCents = report.headline.weekdayAvailableCents !== null ? BigInt(report.headline.weekdayAvailableCents) : null;
    const totalDebtCents = report.venues
      .filter((v) => v.debtCents !== null)
      .reduce((sum, v) => sum + BigInt(v.debtCents!), BigInt(0));
    const totalCapacityCents = report.venues
      .filter((v) => v.capacityCents !== null)
      .reduce((sum, v) => sum + BigInt(v.capacityCents!), BigInt(0));
    const loweredEarningsAssets = report.assets.filter((a) => a.earnings?.lowered);
    const gasReserveAssets = report.assets.filter((a) => a.limits.includes('gas_reserve'));

    const steps: string[] = [
      ru
        ? `Текущий расчётный запас Still: ${formatCents(availableCents)} (общая ёмкость залога ${formatCents(totalCapacityCents)}).`
        : `Current Still borrowing room: ${formatCents(availableCents)} (total collateral capacity ${formatCents(totalCapacityCents)}).`,
    ];

    const reasons: string[] = [];
    if (sky.closed.active && weekdayCents !== null && weekdayCents > availableCents) {
      const diff = weekdayCents - availableCents;
      steps.push(
        ru
          ? `Закрытый рынок США (−${formatCents(diff)}): до ${newYorkMomentV1(sky.closed.endsAt)} акции считаются по ${STILL_SHARES_V1.closed}% порога протокола вместо ${STILL_SHARES_V1.full}% (на открытом рынке было бы ${formatCents(weekdayCents)}).`
          : `Closed US market (−${formatCents(diff)}): until ${newYorkMomentV1(sky.closed.endsAt)} stocks count at ${STILL_SHARES_V1.closed}% of protocol threshold instead of ${STILL_SHARES_V1.full}% (open market room: ${formatCents(weekdayCents)}).`,
      );
      reasons.push(
        ru
          ? `рынок США закрыт, поэтому залог по акциям временно считается по ${STILL_SHARES_V1.closed}% вместо ${STILL_SHARES_V1.full}% (−${formatCents(diff)} до ${newYorkMomentV1(sky.closed.endsAt)})`
          : `the US market is closed, so stock collateral counts at ${STILL_SHARES_V1.closed}% instead of ${STILL_SHARES_V1.full}% (−${formatCents(diff)} until ${newYorkMomentV1(sky.closed.endsAt)})`,
      );
    }

    if (loweredEarningsAssets.length > 0) {
      const names = loweredEarningsAssets.map((a) => a.name).join(', ');
      steps.push(
        ru
          ? `Окно отчётности (${names}): буфер снижен до ${STILL_SHARES_V1.earnings}% из-за близкого отчёта или непрочитанного календаря.`
          : `Earnings window (${names}): buffer lowered to ${STILL_SHARES_V1.earnings}% due to an upcoming earnings report or unread calendar.`,
      );
      reasons.push(
        ru
          ? `для ${names} действует консервативный коэффициент ${STILL_SHARES_V1.earnings}% на период отчётности`
          : `${names} is under the ${STILL_SHARES_V1.earnings}% earnings-window buffer`,
      );
    }

    if (totalDebtCents > BigInt(0)) {
      steps.push(
        ru
          ? `Вычет текущего долга: −${formatCents(totalDebtCents)} уже занято в проверенных протоколах.`
          : `Existing debt deduction: −${formatCents(totalDebtCents)} is already borrowed across reviewed venues.`,
      );
      reasons.push(
        ru
          ? `из лимита вычтен текущий долг ${formatCents(totalDebtCents)} (с учётом начисленных процентов)`
          : `existing debt of ${formatCents(totalDebtCents)} (including accrued interest) is deducted`,
      );
    }

    if (gasReserveAssets.length > 0) {
      steps.push(
        ru
          ? 'Резерв газа Base: 0.002 ETH оставлены в кошельке на комиссии сети и не включаются в залог.'
          : 'Base gas reserve: 0.002 ETH is kept unpledged for network fees.',
      );
    }

    for (const a of report.assets) {
      if (a.priceCents !== null && a.valueCents !== null && a.stillFactorBps !== null) {
        steps.push(
          ru
            ? `${a.name}: цена оракула ${formatCents(a.priceCents)}, оценка ${formatCents(a.valueCents)}, зачёт Still ${a.stillFactorBps / 100}% (протокол ${a.protocolFactorBps !== null ? `${a.protocolFactorBps / 100}%` : '—'}).`
            : `${a.name}: oracle price ${formatCents(a.priceCents)}, value ${formatCents(a.valueCents)}, Still factor ${a.stillFactorBps / 100}% (protocol ${a.protocolFactorBps !== null ? `${a.protocolFactorBps / 100}%` : '—'}).`,
        );
      }
    }

    const summary = reasons.length > 0
      ? ru
        ? `Сейчас вам доступно ${formatCents(availableCents)} из ${formatCents(totalCapacityCents)} расчётной ёмкости, потому что ${reasons.join('; ')}. Кроме того, лимит пересчитывается на каждом блоке вслед за ценой оракула активов.`
        : `Your current borrowing room is ${formatCents(availableCents)} out of ${formatCents(totalCapacityCents)} modelled capacity because ${reasons.join('; ')}. In addition, the limit updates at every block with oracle asset prices.`
      : ru
        ? `Сейчас вам доступно ${formatCents(availableCents)} (полная расчётная ёмкость по текущим ценам оракула и коэффициенту Still ${STILL_SHARES_V1.full}% от порога протокола). Сумма займа меняется вслед за ценой залога на блоке, при переходе к выходным/ночным лимитам (${STILL_SHARES_V1.closed}%) или в окно квартальной отчётности.`
        : `Your current borrowing room is ${formatCents(availableCents)} (full modelled capacity at current oracle prices and Still’s ${STILL_SHARES_V1.full}% share of protocol threshold). Borrowing room changes with block oracle prices, overnight/weekend buffers (${STILL_SHARES_V1.closed}%), or earnings windows.`;

    return {
      topic,
      mode: 'analysis',
      text: summary,
      steps,
      sources: [riskSource, ...terms, ...read],
      engineFacts: {
        mode: 'limit_change',
        availableCents: availableCents.toString(),
        weekdayAvailableCents: weekdayCents?.toString() ?? null,
        totalCapacityCents: totalCapacityCents.toString(),
        totalDebtCents: totalDebtCents.toString(),
        marketClosedActive: sky.closed.active,
        loweredEarningsAssets: loweredEarningsAssets.map((a) => a.asset),
      },
      needsLlm: true,
    };
  }

  if (topic === 'repay_options') {
    const unreadVenue = report.venues.find((v) => v.debtCents === null);
    const activeLoans = report.venues.filter((v) => v.debtCents !== null && BigInt(v.debtCents) > BigInt(0));
    if (activeLoans.length === 0 && unreadVenue) {
      return {
        topic,
        mode: 'refused',
        text: ru
          ? `Расчёт отклонён: долг на ${unreadVenue.label} не удалось прочитать на блоке ${Number(report.reading.block).toLocaleString('en-US')}.`
          : `Calculation refused: debt on ${unreadVenue.label} could not be read at block ${Number(report.reading.block).toLocaleString('en-US')}.`,
        sources: [riskSource, ...read],
        needsLlm: false,
      };
    }

    if (activeLoans.length === 0) {
      return {
        topic,
        mode: 'analysis',
        text: ru
          ? `На блоке ${Number(report.reading.block).toLocaleString('en-US')} за вашим кошельком не числится активного долга (0 USDC), поэтому погашение не требуется.`
          : `At block ${Number(report.reading.block).toLocaleString('en-US')} your wallet has no active debt (0 USDC), so no repayment is needed.`,
        steps: [
          ru ? 'Активный долг на Aave V4 и Morpho: $0.00.' : 'Active debt across Aave V4 and Morpho: $0.00.',
        ],
        sources: [riskSource, ...read],
        needsLlm: false,
      };
    }

    const loan = activeLoans[0]!;
    const venueLabel = loan.venue === 'aave-v4' ? 'Aave V4' : 'Morpho';
    const debtCents = BigInt(loan.debtCents!);
    const requestedReduceCents = parseDollarCentsV2(input.question) ?? BigInt(10000);
    const actualReduceCents = requestedReduceCents < debtCents ? requestedReduceCents : debtCents;
    const remainingDebtCents = debtCents - actualReduceCents;

    const steps: string[] = [
      ru
        ? `Текущий долг на ${venueLabel}: ${formatCents(debtCents)}${loan.borrowRateBps !== null ? ` (ставка ${(loan.borrowRateBps / 100).toFixed(2)}% годовых)` : ''}.`
        : `Current debt on ${venueLabel}: ${formatCents(debtCents)}${loan.borrowRateBps !== null ? ` (rate ${(loan.borrowRateBps / 100).toFixed(2)}% APR)` : ''}.`,
    ];

    if (remainingDebtCents === BigInt(0)) {
      steps.push(
        ru
          ? `Вариант 1 — Полное погашение (${formatCents(debtCents)}) через «Repay all debt»: закрывает долг до 0 USDC с небольшим запасом USDC на набежавшие доли и микродолг, сохраняя 100% залога без продажи акций.`
          : `Option 1 — Full payoff (${formatCents(debtCents)}) via "Repay all debt": clears debt to 0 USDC using a small USDC buffer for accrued shares and micro-debt, keeping 100% of collateral without selling stocks.`,
      );
      steps.push(
        ru
          ? 'Результат: Health Factor переходит в состояние No debt / N/A (риск ликвидации полностью снят).'
          : 'Result: Health Factor becomes No debt / N/A (liquidation risk completely eliminated).',
      );
      return {
        topic,
        mode: 'analysis',
        text: ru
          ? `Ваш текущий долг на ${venueLabel} составляет ${formatCents(debtCents)} (меньше или равен ${formatCents(requestedReduceCents)}). Самый безопасный способ — выбрать «Repay all debt» на экране погашения: это полностью закроет долг до 0 USDC без продажи залога и снимет риск ликвидации.`
          : `Your current debt on ${venueLabel} is ${formatCents(debtCents)} (at or below ${formatCents(requestedReduceCents)}). The safest path is selecting "Repay all debt" on the repayment screen: this clears the entire balance to 0 USDC without selling collateral and removes liquidation risk.`,
        steps,
        sources: [riskSource, ...terms, ...read],
        actionLink: { href: '/repay', label: ru ? 'Перейти к погашению →' : 'Open repayment screen →' },
        engineFacts: {
          mode: 'repay_options',
          venue: venueLabel,
          debtBeforeCents: debtCents.toString(),
          repayCents: actualReduceCents.toString(),
          debtAfterCents: '0',
          fullPayoff: true,
        },
        needsLlm: true,
      };
    }

    const hfBeforeHundredths = loan.safety
      ? (BigInt(loan.safety.healthFactor) * BigInt(100)) / (BigInt(10) ** BigInt(18))
      : null;
    const hfAfterHundredths = hfBeforeHundredths !== null
      ? (hfBeforeHundredths * debtCents) / remainingDebtCents
      : null;
    const marginBeforePct = loan.safety ? Math.floor(loan.safety.marginBps / 100) : null;
    const marginAfterPct = hfAfterHundredths !== null && hfAfterHundredths > BigInt(100)
      ? Number(((hfAfterHundredths - BigInt(100)) * BigInt(100)) / hfAfterHundredths)
      : null;
    const firstLiq = loan.liquidationPrices.find((p) => !p.unreachable && p.priceCents !== null);
    const liqBeforeCents = firstLiq?.priceCents ? BigInt(firstLiq.priceCents) : null;
    const liqAfterCents = liqBeforeCents !== null ? (liqBeforeCents * remainingDebtCents) / debtCents : null;

    steps.push(
      ru
        ? `Вариант 1 (Рекомендуемый) — Частичное погашение Exact USDC на ${formatCents(actualReduceCents)}: долг снижается с ${formatCents(debtCents)} до ${formatCents(remainingDebtCents)}, 100% залога остаётся в позиции (дивиденды и акции сохраняются).`
        : `Option 1 (Recommended) — Exact USDC partial repayment of ${formatCents(actualReduceCents)}: debt drops from ${formatCents(debtCents)} to ${formatCents(remainingDebtCents)} while 100% of collateral stays deposited (preserving stocks and dividends).`,
    );
    if (hfBeforeHundredths !== null && hfAfterHundredths !== null) {
      steps.push(
        ru
          ? `Улучшение безопасности: Health Factor вырастет с ${formatRatioHundredthsV2(hfBeforeHundredths)} до ${formatRatioHundredthsV2(hfAfterHundredths)}${marginBeforePct !== null && marginAfterPct !== null ? `, запас падения цен увеличится с ${marginBeforePct}% до ${marginAfterPct}%` : ''}.`
          : `Safety improvement: Health Factor rises from ${formatRatioHundredthsV2(hfBeforeHundredths)} to ${formatRatioHundredthsV2(hfAfterHundredths)}${marginBeforePct !== null && marginAfterPct !== null ? `, price-drop buffer widens from ${marginBeforePct}% to ${marginAfterPct}%` : ''}.`,
      );
    }
    if (firstLiq && liqBeforeCents !== null && liqAfterCents !== null) {
      steps.push(
        ru
          ? `Порог ликвидации ${firstLiq.asset}: отодвинется вниз с ${formatCents(liqBeforeCents)} до ${formatCents(liqAfterCents)}.`
          : `${firstLiq.asset} liquidation price: moves down from ${formatCents(liqBeforeCents)} to ${formatCents(liqAfterCents)}.`,
      );
    }
    steps.push(
      ru
        ? `Вариант 2 — Полное закрытие через «Repay all debt» (${formatCents(debtCents)}): полностью убирает долг и остаточные микродоли в одной транзакции.`
        : `Option 2 — Full payoff via "Repay all debt" (${formatCents(debtCents)}): eliminates all debt and residual shares in a single transaction.`,
    );

    return {
      topic,
      mode: 'analysis',
      text: ru
        ? `Самый безопасный способ уменьшить долг на ${formatCents(actualReduceCents)} — внести частичное погашение в USDC через экран «Погасить» без вывода залога. Ваш долг на ${venueLabel} снизится с ${formatCents(debtCents)} до ${formatCents(remainingDebtCents)}${hfBeforeHundredths !== null && hfAfterHundredths !== null ? `, Health Factor вырастет с ${formatRatioHundredthsV2(hfBeforeHundredths)} до ${formatRatioHundredthsV2(hfAfterHundredths)}` : ''}${marginBeforePct !== null && marginAfterPct !== null ? `, а запас до ликвидации увеличится с ${marginBeforePct}% до ${marginAfterPct}%` : ''}. Вы не продаёте акции и сохраняете право на дивиденды.`
        : `The safest way to reduce debt by ${formatCents(actualReduceCents)} is an Exact USDC partial repayment on the Repay screen while keeping all collateral deposited. Your ${venueLabel} debt drops from ${formatCents(debtCents)} to ${formatCents(remainingDebtCents)}${hfBeforeHundredths !== null && hfAfterHundredths !== null ? `, raising Health Factor from ${formatRatioHundredthsV2(hfBeforeHundredths)} to ${formatRatioHundredthsV2(hfAfterHundredths)}` : ''}${marginBeforePct !== null && marginAfterPct !== null ? ` and widening your liquidation buffer from ${marginBeforePct}% to ${marginAfterPct}%` : ''}. You avoid selling shares and keep full dividend entitlement.`,
      steps,
      sources: [riskSource, ...terms, ...read],
      actionLink: { href: '/repay', label: ru ? 'Подготовить погашение →' : 'Prepare repayment →' },
      engineFacts: {
        mode: 'repay_options',
        venue: venueLabel,
        debtBeforeCents: debtCents.toString(),
        repayCents: actualReduceCents.toString(),
        debtAfterCents: remainingDebtCents.toString(),
        hfBefore: hfBeforeHundredths !== null ? formatRatioHundredthsV2(hfBeforeHundredths) : null,
        hfAfter: hfAfterHundredths !== null ? formatRatioHundredthsV2(hfAfterHundredths) : null,
        marginBeforePct,
        marginAfterPct,
        liqBeforeCents: liqBeforeCents?.toString() ?? null,
        liqAfterCents: liqAfterCents?.toString() ?? null,
      },
      needsLlm: true,
    };
  }

  if (topic === 'borrow') {
    const available = report.headline.availableCents;
    const debts = report.venues.filter((v) => v.debtCents !== null && v.debtCents !== '0');
    const owed = debts.reduce((sum, v) => sum + BigInt(v.debtCents!), BigInt(0));
    if (available === null) {
      return { topic, mode: 'refused', text: ru ? 'Сейчас не удалось прочитать расчётный запас для займа. Это наш сбой, а не факт о вашем кошельке.' : 'Your modelled borrowing room could not be read just now. That is our failure, not a fact about your wallet.', sources: read, needsLlm: false };
    }
    const floor = report.headline.complete ? '' : ru ? 'не меньше ' : 'at least ';
    const weekday = report.headline.weekdayAvailableCents;
    const parts = [
      ru ? `Расчётный запас для займа — ${floor}${formatCents(available)}.` : `Modelled borrowing room: ${floor}${formatCents(available)}.`,
      sky.closed.active && weekday !== null
        ? ru ? `На открытом рынке было бы ${formatCents(weekday)}: до ${newYorkMomentV1(sky.closed.endsAt)} акции считаются по ${STILL_SHARES_V1.closed}%.` : `On an open market it would be ${formatCents(weekday)}: until ${newYorkMomentV1(sky.closed.endsAt)} stocks count at ${STILL_SHARES_V1.closed}%.`
        : '',
      owed > BigInt(0) ? (ru ? `Ваш долг ${formatCents(owed)} уже учтён.` : `Your ${formatCents(owed)} owed is already counted.`) : '',
      ru
        ? 'Это расчёт, а не доступный к подписанию займ. Get money поддерживает проверенные акции через Aave V4 и cbBTC и WETH через Morpho: точный текущий лимит нужно проверить для выбранного залога.'
        : 'This is a modelled amount, not a loan ready to sign. Get money supports reviewed stocks through Aave V4 and cbBTC and WETH through Morpho; check the live limit for your exact collateral choice there.',
    ];
    return { topic, mode: 'fast', text: parts.filter(Boolean).join(' '), sources: [...terms, ...read], needsLlm: false };
  }

  if (topic === 'safety') {
    const loans = report.venues.filter((v) => v.debtCents !== null && v.debtCents !== '0');
    const unreadDebt = report.venues.filter((v) => v.debtCents === null);
    if (loans.length === 0 && unreadDebt.length === 0 && report.venues.length > 0) {
      return { topic, mode: 'fast', text: ru ? 'На этом блоке в проверенных рынках долг не зафиксирован.' : 'No debt was recorded in the reviewed venues at this block.', sources: read, needsLlm: false };
    }
    const sentences = loans.map((v) => {
      const venue = v.venue === 'aave-v4' ? 'Aave' : 'Morpho';
      if (!v.safety) return ru
        ? `Займ ${formatCents(v.debtCents!)} на ${venue} зафиксирован, но его запас до ликвидации прочитать не удалось. Вывода о безопасности пока нет.`
        : `Your ${formatCents(v.debtCents!)} loan on ${venue} is recorded, but its liquidation safety could not be read. No safety conclusion is available.`;
      const margin = Math.floor(v.safety!.marginBps / 100);
      const prices = v.liquidationPrices
        .filter((p) => !p.unreachable && p.priceCents !== null)
        .map((p) => `${report.assets.find((l) => l.asset === p.asset)?.name ?? p.asset} ${ru ? 'ниже' : 'below'} ${formatCents(p.priceCents!)}`);
      if (v.safety.state === 'liquidation') return ru
        ? `Протокол показывает, что займ ${formatCents(v.debtCents!)} на ${venue} уже может быть ликвидирован.`
        : `The protocol reading marks your ${formatCents(v.debtCents!)} loan on ${venue} as liquidatable now.`;
      return ru
        ? `Займ ${formatCents(v.debtCents!)} на ${venue}: цены могут вместе упасть на ${margin}%, прежде чем начнётся ликвидация${prices.length ? `. Отдельно: ${prices.join(', ')}` : ''}.`
        : `Your ${formatCents(v.debtCents!)} loan on ${venue}: prices can fall ${margin}% together before liquidation can start${prices.length ? `. On its own: ${prices.join(', ')}` : ''}.`;
    });
    if (unreadDebt.length > 0 || report.venues.length === 0) sentences.push(ru
      ? `Долг ${unreadDebt.length ? `на ${unreadDebt.map(v => v.label).join(', ')}` : 'на проверяемых рынках'} прочитать не удалось. Это не означает, что займов нет.`
      : `Debt ${unreadDebt.length ? `at ${unreadDebt.map(v => v.label).join(', ')}` : 'in the reviewed venues'} could not be read. This does not establish that no loan exists.`);
    const mode: AgentModeV2 = loans.length === 0 && unreadDebt.length > 0 ? 'refused' : 'fast';
    return { topic, mode, text: sentences.join(' '), sources: read, needsLlm: false };
  }

  if (topic === 'dividends') {
    const state = input.dividendsReadState ?? (input.dividends ? 'read' : 'not_loaded');
    if (state !== 'read' || !input.dividends) {
      return {
        topic,
        mode: 'refused',
        text: state === 'loading'
          ? ru ? 'Календарь дивидендов ещё загружается. Пока неизвестно, есть ли предстоящая выплата.' : 'Your dividend calendar is still loading. Whether a payment is ahead is not known yet.'
          : state === 'unavailable'
            ? ru ? 'Данные о дивидендах сейчас не удалось прочитать. Это не означает, что выплат нет.' : 'Your dividend data could not be read just now. That does not mean there are no payments.'
            : ru ? 'Данные о дивидендах ещё не загружены. Пока неизвестно, есть ли предстоящая выплата.' : 'Your dividend data has not been loaded yet. Whether a payment is ahead is not known.',
        sources: [],
        needsLlm: false,
      };
    }
    const next = input.dividends.holdings
      .flatMap((h) => h.upcoming.slice(0, 1).map((event) => ({ h, event })))
      .sort((a, b) => a.event.payDate.localeCompare(b.event.payDate))[0];
    if (!next) {
      return {
        topic,
        mode: 'fast',
        text: ru ? 'В загруженном календаре нет предстоящей выплаты по акциям, которые он охватывает в вашем кошельке.' : 'The loaded calendar lists no upcoming dividend for the stocks it covers in your wallet.',
        sources: [ru ? 'КАЛЕНДАРЬ · дивиденды Miorail' : 'CALENDAR · Miorail dividends'],
        needsLlm: false,
      };
    }
    const estimate = next.event.kind === 'estimate';
    const amount = dividendMoneyV1(next.event.usd);
    return {
      topic,
      mode: 'fast',
      text: ru
        ? `${next.h.company}: выплата ${next.event.payDateApproximate ? 'примерно ' : ''}${next.event.payDate}${amount ? `, ${estimate && !amount.startsWith('<') ? 'около ' : ''}${amount} в виде новых ${next.h.tokenSymbol}` : ', сумма не прочитана'}. Дивиденд получает тот, кто держит токен в момент конвертации${estimate ? '; сумма — оценка' : ''}.`
        : `${next.h.company}: paid ${next.event.payDateApproximate ? 'around ' : ''}${next.event.payDate}${amount ? `, ${estimate && !amount.startsWith('<') ? 'about ' : ''}${amount} as more ${next.h.tokenSymbol}` : ', amount not read'}. A dividend reaches whoever holds the token when it converts${estimate ? '; the amount is an estimate' : ''}.`,
      sources: [ru ? 'КАЛЕНДАРЬ · дивиденды Miorail, из заявлений компаний' : 'CALENDAR · Miorail dividends, from the companies’ own releases'],
      needsLlm: false,
    };
  }

  const held = report.assets.filter((line) => [line.wallet, line.pledged].some(amount => amount !== null && BigInt(amount.raw) > BigInt(0)));
  return {
    topic,
    mode: 'fast',
    text: held.length === 0
      ? ru ? 'В проверенном наборе Still не установлены активы этого кошелька: акции Coinbase, cbBTC или ETH.' : 'No holdings were established in Still’s reviewed set: Coinbase stocks, cbBTC or ETH.'
      : `${ru ? 'Прочитанные активы' : 'Reviewed holdings'}: ${held.map((l) => `${l.name} ${l.valueCents === null ? ru ? '(стоимость не прочитана)' : '(value not read)' : formatCents(l.valueCents)}`).join(', ')}.`,
    sources: read,
    needsLlm: false,
  };
}
