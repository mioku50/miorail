import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';
import { formatCents } from '@mioagent/still-engine/format';

import { STILL_SHARES_V1, newYorkMomentV1, type SkyStateV1 } from './skyState';
import { dividendMoneyV1 } from './dividendMoney';

// ---------------------------------------------------------------------------
// The Agent, first version: questions about your own money, answered from the
// numbers already read: the wallet's Mirror, Still's terms and Miorail's
// dividend calendar. No model writes these sentences. A machine sentence
// skips the model, so nothing here can invent a figure, and a question in
// Russian gets its answer in Russian.
//
// A question it does not recognise gets the list of what it can answer, not a
// guess.
// ---------------------------------------------------------------------------

export type AgentTopicV1 = 'borrow' | 'safety' | 'closed' | 'dividends' | 'holdings';
export type DividendReadStateV1 = 'not_loaded' | 'loading' | 'unavailable' | 'read';

export interface AgentAnswerV1 {
  topic: AgentTopicV1 | null;
  text: string;
  /** What the figures stand on, printed under the answer. */
  sources: string[];
}

const PATTERNS_V1: ReadonlyArray<[AgentTopicV1, RegExp]> = [
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

export const AGENT_PROMPTS_V1: ReadonlyArray<{ en: string; ru: string }> = [
  { en: 'How much can I spend without selling?', ru: 'Сколько я могу взять без продажи?' },
  { en: 'How safe is my loan?', ru: 'Насколько безопасен мой займ?' },
  { en: 'When do weekend limits start?', ru: 'Когда начинаются выходные лимиты?' },
  { en: 'When is my next dividend?', ru: 'Когда мой следующий дивиденд?' },
];

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

  if (topic === null) {
    return {
      topic,
      text: ru
        ? 'Пока я отвечаю о ваших деньгах: сколько можно взять без продажи, насколько безопасен займ, когда выходные лимиты и когда дивиденды.'
        : 'For now I answer about your own money: what you can spend without selling, how safe your loan is, when weekend limits start, and your dividends.',
      sources: [],
    };
  }

  if (topic === 'closed') {
    const until = newYorkMomentV1(sky.closed.endsAt);
    const from = newYorkMomentV1(sky.closed.startsAt);
    return {
      topic,
      text: sky.closed.active
        ? ru
          ? `Сейчас Уолл-стрит закрыта. До ${until} по Нью-Йорку новые займы под акции считаются по ${STILL_SHARES_V1.closed}% лимита протокола, а не по ${STILL_SHARES_V1.full}%. Уже взятые займы это не меняет.`
          : `Wall Street is closed now. Until ${until} New York time, new loans against stocks count at ${STILL_SHARES_V1.closed}% of the protocol’s limit, not ${STILL_SHARES_V1.full}%. Loans you have are not touched.`
        : ru
          ? `С ${from} до ${until} по Нью-Йорку, пока рынок закрыт, новые займы под акции считаются по ${STILL_SHARES_V1.closed}% лимита протокола. Праздники тоже. Уже взятые займы это не меняет.`
          : `From ${from} to ${until} New York time, while the market is closed, new loans against stocks count at ${STILL_SHARES_V1.closed}% of the protocol’s limit. Holidays too. Loans you have are not touched.`,
      sources: [ru ? 'КАЛЕНДАРЬ · рынок США, проверенный Miorail' : 'CALENDAR · US market, reviewed by Miorail'],
    };
  }

  if (!report) {
    return {
      topic,
      text: input.signedIn
        ? ru ? 'Данные вашего кошелька ещё не прочитаны. Пока нельзя сделать вывод о балансе или займах.' : 'Your wallet report has not been read yet. No balance or loan conclusion is available.'
        : ru ? 'Для этого нужен ваш кошелёк: войдите, и я прочитаю его на Base.' : 'That needs your wallet: sign in and I will read it on Base.',
      sources: [],
    };
  }

  if (topic === 'borrow') {
    const available = report.headline.availableCents;
    const debts = report.venues.filter((v) => v.debtCents !== null && v.debtCents !== '0');
    const owed = debts.reduce((sum, v) => sum + BigInt(v.debtCents!), BigInt(0));
    if (available === null) {
      return { topic, text: ru ? 'Сейчас не удалось прочитать расчётный запас для займа. Это наш сбой, а не факт о вашем кошельке.' : 'Your modelled borrowing room could not be read just now. That is our failure, not a fact about your wallet.', sources: read };
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
        ? 'Это расчёт, а не доступный к подписанию займ. Get money сейчас поддерживает cbBTC и WETH через Morpho: точный текущий лимит нужно проверить там. Займы под акции здесь пока не доступны.'
        : 'This is a modelled amount, not a loan ready to sign. Get money currently supports cbBTC and WETH through Morpho; check the live limit for your exact amount there. Stock-backed borrowing is not available here yet.',
    ];
    return { topic, text: parts.filter(Boolean).join(' '), sources: [...terms, ...read] };
  }

  if (topic === 'safety') {
    const loans = report.venues.filter((v) => v.debtCents !== null && v.debtCents !== '0');
    const unreadDebt = report.venues.filter((v) => v.debtCents === null);
    if (loans.length === 0 && unreadDebt.length === 0 && report.venues.length > 0) {
      return { topic, text: ru ? 'На этом блоке в проверенных рынках долг не зафиксирован.' : 'No debt was recorded in the reviewed venues at this block.', sources: read };
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
    return { topic, text: sentences.join(' '), sources: read };
  }

  if (topic === 'dividends') {
    const state = input.dividendsReadState ?? (input.dividends ? 'read' : 'not_loaded');
    if (state !== 'read' || !input.dividends) {
      return {
        topic,
        text: state === 'loading'
          ? ru ? 'Календарь дивидендов ещё загружается. Пока неизвестно, есть ли предстоящая выплата.' : 'Your dividend calendar is still loading. Whether a payment is ahead is not known yet.'
          : state === 'unavailable'
            ? ru ? 'Данные о дивидендах сейчас не удалось прочитать. Это не означает, что выплат нет.' : 'Your dividend data could not be read just now. That does not mean there are no payments.'
            : ru ? 'Данные о дивидендах ещё не загружены. Пока неизвестно, есть ли предстоящая выплата.' : 'Your dividend data has not been loaded yet. Whether a payment is ahead is not known.',
        sources: [],
      };
    }
    const next = input.dividends.holdings
      .flatMap((h) => h.upcoming.slice(0, 1).map((event) => ({ h, event })))
      .sort((a, b) => a.event.payDate.localeCompare(b.event.payDate))[0];
    if (!next) {
      return {
        topic,
        text: ru ? 'В загруженном календаре нет предстоящей выплаты по акциям, которые он охватывает в вашем кошельке.' : 'The loaded calendar lists no upcoming dividend for the stocks it covers in your wallet.',
        sources: [ru ? 'КАЛЕНДАРЬ · дивиденды Miorail' : 'CALENDAR · Miorail dividends'],
      };
    }
    const estimate = next.event.kind === 'estimate';
    const amount = dividendMoneyV1(next.event.usd);
    return {
      topic,
      text: ru
        ? `${next.h.company}: выплата ${next.event.payDateApproximate ? 'примерно ' : ''}${next.event.payDate}${amount ? `, ${estimate && !amount.startsWith('<') ? 'около ' : ''}${amount} в виде новых ${next.h.tokenSymbol}` : ', сумма не прочитана'}. Дивиденд получает тот, кто держит токен в момент конвертации${estimate ? '; сумма — оценка' : ''}.`
        : `${next.h.company}: paid ${next.event.payDateApproximate ? 'around ' : ''}${next.event.payDate}${amount ? `, ${estimate && !amount.startsWith('<') ? 'about ' : ''}${amount} as more ${next.h.tokenSymbol}` : ', amount not read'}. A dividend reaches whoever holds the token when it converts${estimate ? '; the amount is an estimate' : ''}.`,
      sources: [ru ? 'КАЛЕНДАРЬ · дивиденды Miorail, из заявлений компаний' : 'CALENDAR · Miorail dividends, from the companies’ own releases'],
    };
  }

  const held = report.assets.filter((line) => [line.wallet, line.pledged].some(amount => amount !== null && BigInt(amount.raw) > BigInt(0)));
  return {
    topic,
    text: held.length === 0
      ? ru ? 'В проверенном наборе Still не установлены активы этого кошелька: акции Coinbase, cbBTC или ETH.' : 'No holdings were established in Still’s reviewed set: Coinbase stocks, cbBTC or ETH.'
      : `${ru ? 'Прочитанные активы' : 'Reviewed holdings'}: ${held.map((l) => `${l.name} ${l.valueCents === null ? ru ? '(стоимость не прочитана)' : '(value not read)' : formatCents(l.valueCents)}`).join(', ')}.`,
    sources: read,
  };
}
