import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';
import { formatCents } from '@mioagent/still-engine/format';

// The API server type-checks this file too (under node16), so relative imports
// name their `.js`; the bundlers resolve it to the `.ts` beside it.
import { STILL_SHARES_V1, newYorkMomentV1, type SkyStateV1 } from './skyState.js';
import { dividendMoneyV1 } from './dividendMoney.js';

// ---------------------------------------------------------------------------
// Still Agent: what the page answers by itself, and how a question is routed.
//
//   `fast`        — a direct read the page already holds: borrowing room, loan
//                   safety, market hours, dividends, holdings. No model.
//   `analysis`    — a calculation: a price move, a repayment, a deposit, more
//                   borrowing, interest, why the room changed. The server
//                   computes it with the Mirror engine on its own reading of
//                   the session wallet; a model may read the question and may
//                   re-say the result, and is checked both times.
//   `action_prep` — a request to act ("borrow $500 and send it to a friend"):
//                   the agent never signs or sends, and points to the screen
//                   where the person reviews and signs it themselves.
//
// A question none of these recognise goes to the server's planner when the
// person is signed in, and gets the list of what the agent answers otherwise.
// ---------------------------------------------------------------------------

export type AgentTopicV1 = 'borrow' | 'safety' | 'closed' | 'dividends' | 'holdings' | 'analysis' | 'action_prep';
export type AgentModeV2 = 'fast' | 'analysis' | 'action_prep' | 'refused';
export type AgentRouteV2 = 'fast' | 'analysis' | 'action_prep' | 'unknown';
export type DividendReadStateV1 = 'not_loaded' | 'loading' | 'unavailable' | 'read';

export interface AgentActionLinkV2 {
  href: string;
  label: string;
}

export interface AgentAnswerV1 {
  topic: AgentTopicV1 | null;
  mode?: AgentModeV2;
  text: string;
  /** What the figures stand on, printed under the answer. */
  sources: string[];
  /** The calculation, one line per figure, as the engine computed it. */
  steps?: string[];
  /** The screen where the person reviews and signs; the agent never does. */
  actionLink?: AgentActionLinkV2 | null;
  /** The figures and outcome a re-wording may not lose or contradict. */
  engineFacts?: Record<string, unknown> | null;
  /** The Base block the figures were read at, and its time. */
  calculatedAt?: { block: string; blockTime: string } | null;
  /** What the calculation holds fixed or leaves out. */
  bounds?: string[];
  /** How the question was read: by fixed rules, or by a model checked against the words. */
  understoodBy?: 'rules' | 'model' | null;
}

export function isRussianV1(text: string): boolean {
  return /[а-яё]/i.test(text);
}

// `\b` and `\w` are ASCII-only in JavaScript, so a word edge is spelled as
// "not a letter or digit" and Russian endings as a Cyrillic class.
const EDGE = '(?:^|[^\\p{L}\\p{N}])';

/** The assets Still reads, by the names people use. One table for the page and the server. */
export const AGENT_ASSET_WORDS_V2: ReadonlyArray<readonly [string, RegExp]> = [
  ['NVDAc', /nvda|nvidia|нвиди/iu],
  ['AAPLc', /aapl|apple|эппл|эпл|яблок/iu],
  ['TSLAc', /tsla|tesla|тесл/iu],
  ['MSFTc', /msft|microsoft|майкрософт/iu],
  ['AMZNc', /amzn|amazon|амазон/iu],
  ['GOOGLc', /googl|google|alphabet|гугл/iu],
  ['METAc', new RegExp(`${EDGE}(?:meta|мета)(?:$|[^\\p{L}])`, 'iu')],
  ['cbBTC', /cbbtc|btc|bitcoin|биткоин|биткойн|битк/iu],
  ['ETH', new RegExp(`${EDGE}(?:w?eth|ether|ethereum|эфир)`, 'iu')],
];

/** Every asset the question names, in the order of the table. */
export function assetsNamedInV2(question: string): string[] {
  return AGENT_ASSET_WORDS_V2.filter(([, pattern]) => pattern.test(question)).map(([asset]) => asset);
}

/** "What would happen", as opposed to "do it". */
export const WHAT_IF_V2 = /что будет|что если|а если|если\s|при\s+(?:падении|росте|цене|снижении)|what if|what happens|what would|if i\s|if my|if the|suppose|would\s|в случае/iu;

// A command to act. Asked as a what-if, the same words are a calculation.
const ACTION_V2 = new RegExp(
  [
    `${EDGE}(?:займи|одолжи|отправь|переведи|подпиши|исполни|погаси|продай|купи|внеси)`,
    `${EDGE}возьми\\s+(?:мне\\s+)?(?:займ|кредит|\\$|\\d)`,
    `^\\s*(?:please\\s+)?(?:borrow|send|transfer|sign|execute|repay|pay\\s+back|deposit|sell|buy)\\s`,
    `(?:send|transfer|отправ|перевед)\\S*\\s.*(?:friend|друг|address|адрес|0x)`,
  ].join('|'),
  'iu',
);

const ANALYSIS_V2: readonly RegExp[] = [
  // A price move by a share or to a price.
  /\d+(?:[.,]\d+)?\s*(?:%|percent|per cent|процент)|вдвое|в два раза|половин|halve|by half/iu,
  new RegExp(`(?:${AGENT_ASSET_WORDS_V2.map(([, p]) => p.source).join('|')}).*(?:\\s(?:to|до)\\s*\\$\\s?\\d)`, 'iu'),
  // Why the room changed, and what sets it.
  /почему.*(?:уменьш|сниз|упал|измен|меньше|сократ)|why.*(?:decreas|drop|lower|less|chang|reduc|shrank|smaller)|(?:уменьш|сниз)\S*\s.*(?:лимит|сумм\S*\s+займ)|what (?:sets|decides|determines) my (?:limit|room)|из чего (?:складывается|состоит)/iu,
  // Paying down a loan.
  /(?:уменьш|сниз|погас|закрыт|вернут|выплат|repay|reduce|pay\s*down|pay\s*off|clear).*(?:долг|займ|кредит|debt|loan)|(?:долг|займ|debt|loan).*(?:уменьш|сниз|погас|repay|reduce)|погас|repay|pay\s*(?:back|off|down)/iu,
  // What a loan costs.
  /interest|процент\S*\s+(?:по|за|на)|сколько.*(?:плач|стоит\s+займ)|cost of (?:my |the )?loan|ставк/iu,
  // Pledging more.
  /(?:добав|внес|довнес|залож|deposit|pledge|add)\S*\s.*\d/iu,
];

const FAST_V2: ReadonlyArray<[AgentTopicV1, RegExp]> = [
  ['dividends', /dividend|дивиденд/iu],
  ['safety', /safe|liquidat|health|risk|безопас|ликвид|риск/iu],
  ['closed', /weekend|holiday|closed|night|выходн|праздн|закрыт|ноч/iu],
  ['borrow', /borrow|lend|spend|how much|loan|cash|взять|занять|сколько|займ|кредит|деньг/iu],
  ['holdings', /hold|own|assets|portfolio|что у меня|акти|держ/iu],
];

/** Where a question goes. One rule for the page and the server, so they cannot disagree. */
export function agentRouteV2(question: string): { route: AgentRouteV2; topic: AgentTopicV1 | null } {
  const whatIf = WHAT_IF_V2.test(question);
  if (!whatIf && ACTION_V2.test(question)) return { route: 'action_prep', topic: 'action_prep' };
  if (ANALYSIS_V2.some((pattern) => pattern.test(question))) return { route: 'analysis', topic: 'analysis' };
  if (whatIf && /(?:займу|возьму|borrow|take)\S*\s.*\d/iu.test(question)) return { route: 'analysis', topic: 'analysis' };
  // A number in a question asks for more than a direct read: the server's planner reads it.
  if (/\d/.test(question)) return { route: 'unknown', topic: null };
  for (const [topic, pattern] of FAST_V2) if (pattern.test(question)) return { route: 'fast', topic };
  return { route: 'unknown', topic: null };
}

/** Suggested questions are fixed in source: a model does not decide what a reader should wonder. */
export const AGENT_PROMPTS_V1: ReadonlyArray<{ en: string; ru: string }> = [
  { en: 'How much can I spend without selling?', ru: 'Сколько я могу взять без продажи?' },
  { en: 'How safe is my loan?', ru: 'Насколько безопасен мой займ?' },
  { en: 'What happens if NVDA drops 30%?', ru: 'Что будет при падении NVDA на 30%?' },
  { en: 'Why did my borrowing limit decrease?', ru: 'Почему моя сумма займа уменьшилась?' },
  { en: 'What if I repay $100 of my loan?', ru: 'Что будет, если погасить $100 долга?' },
  { en: 'When do weekend limits start?', ru: 'Когда начинаются выходные лимиты?' },
  { en: 'When is my next dividend?', ru: 'Когда мой следующий дивиденд?' },
];

/** What the agent answers, said when a question is not one of them. */
export function agentCapabilitiesV2(ru: boolean): string {
  return ru
    ? 'Я отвечаю о ваших деньгах: сколько можно занять без продажи, что будет при движении цены (например, NVDA −30% или BTC до названной вами цены), что изменит погашение, новый займ или залог, сколько стоят проценты, почему изменился лимит, когда действуют выходные лимиты и когда дивиденды.'
    : 'I answer about your own money: how much you can borrow without selling, what a price move would do (e.g. NVDA down 30%, or BTC to a price you name), what a repayment, more borrowing or more collateral would change, what the interest costs, why your limit changed, when weekend limits start, and your dividends.';
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

export function agentAnswerV1(input: {
  question: string;
  report: MirrorReport | null;
  sky: SkyStateV1;
  dividends?: DividendWalletResponseV1 | null;
  dividendsReadState?: DividendReadStateV1;
  signedIn?: boolean;
}): AgentAnswerV1 {
  const ru = isRussianV1(input.question);
  const { topic } = agentRouteV2(input.question);
  const { report, sky } = input;
  const read = report ? [ru ? `ЧТЕНИЕ · блок Base ${Number(report.reading.block).toLocaleString('en-US')}` : `READ · Base block ${Number(report.reading.block).toLocaleString('en-US')}`] : [];
  const terms = report ? [ru ? `УСЛОВИЯ · Still ${report.terms.version}` : `TERMS · Still ${report.terms.version}`] : [];
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
      }
    };
  }

  if (topic === null) {
    return { topic, text: agentCapabilitiesV2(ru), sources: [] };
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
      sources: [ru ? 'КАЛЕНДАРЬ · рынок США, проверенный Miorail' : 'CALENDAR · US market, reviewed by Miorail']
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
    };
  }

  if (topic === 'analysis') {
    // A calculation is the server's: it recomputes the Mirror on its own reading.
    return {
      topic,
      mode: 'refused',
      text: ru ? 'Этот расчёт делает сервер, а он сейчас не ответил. Это наш сбой, а не факт о вашем кошельке.' : 'This calculation runs on the server, which did not answer just now. That is our failure, not a fact about your wallet.',
      sources: [],
    };
  }

  if (topic === 'borrow') {
    const available = report.headline.availableCents;
    const debts = report.venues.filter((v) => v.debtCents !== null && v.debtCents !== '0');
    const owed = debts.reduce((sum, v) => sum + BigInt(v.debtCents!), BigInt(0));
    if (available === null) {
      return { topic, mode: 'refused', text: ru ? 'Сейчас не удалось прочитать расчётный запас для займа. Это наш сбой, а не факт о вашем кошельке.' : 'Your modelled borrowing room could not be read just now. That is our failure, not a fact about your wallet.', sources: read };
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
    return { topic, mode: 'fast', text: parts.filter(Boolean).join(' '), sources: [...terms, ...read] };
  }

  if (topic === 'safety') {
    const loans = report.venues.filter((v) => v.debtCents !== null && v.debtCents !== '0');
    const unreadDebt = report.venues.filter((v) => v.debtCents === null);
    if (loans.length === 0 && unreadDebt.length === 0 && report.venues.length > 0) {
      return { topic, mode: 'fast', text: ru ? 'На этом блоке в проверенных рынках долг не зафиксирован.' : 'No debt was recorded in the reviewed venues at this block.', sources: read };
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
    return { topic, mode, text: sentences.join(' '), sources: read };
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
        sources: []
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
        sources: [ru ? 'КАЛЕНДАРЬ · дивиденды Miorail' : 'CALENDAR · Miorail dividends']
      };
    }
    const estimate = next.event.kind === 'estimate';
    const amount = dividendMoneyV1(next.event.usd);
    return {
      topic,
      mode: 'fast',
      text: ru
        ? `${next.h.company}: выплата ${next.event.payDateApproximate ? 'примерно ' : ''}${next.event.payDate}${amount ? `, ${estimate && !amount.startsWith('<') ? 'около ' : ''}${amount} в виде новых ${next.h.tokenSymbol}` : ', сумма не прочитана'}. Дивиденд получает тот, кто держит токен в момент конвертации${estimate ? '; сумма — оценка' : ''}.`
        : `${next.h.company}: pays ${next.event.payDateApproximate ? 'around' : 'on'} ${next.event.payDate}${amount ? `, ${estimate && !amount.startsWith('<') ? 'about ' : ''}${amount} as more ${next.h.tokenSymbol}` : ', amount not read'}. A dividend reaches whoever holds the token when it converts${estimate ? '; the amount is an estimate' : ''}.`,
      sources: [ru ? 'КАЛЕНДАРЬ · дивиденды Miorail, из заявлений компаний' : 'CALENDAR · Miorail dividends, from the companies’ own releases']
    };
  }

  const held = report.assets.filter((line) => [line.wallet, line.pledged].some(amount => amount !== null && BigInt(amount.raw) > BigInt(0)));
  return {
    topic,
    mode: 'fast',
    text: held.length === 0
      ? ru ? 'В проверенном наборе Still не установлены активы этого кошелька: акции Coinbase, cbBTC или ETH.' : 'No holdings were established in Still’s reviewed set: Coinbase stocks, cbBTC or ETH.'
      : `${ru ? 'Прочитанные активы' : 'Reviewed holdings'}: ${held.map((l) => `${l.name} ${l.valueCents === null ? ru ? '(стоимость не прочитана)' : '(value not read)' : formatCents(l.valueCents)}`).join(', ')}.`,
    sources: read
  };
}
