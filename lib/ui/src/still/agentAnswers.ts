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
//   `swap`        — a request to swap one token for another: written out as a
//                   goal for Swap AI, where routes are compared and simulated
//                   and the person signs. The agent reads an amount ("all my
//                   USDC") and never picks a route.
//
// A question none of these recognise goes to the server's planner when the
// person is signed in, and gets the list of what the agent answers otherwise.
// ---------------------------------------------------------------------------

export type AgentTopicV1 = 'borrow' | 'safety' | 'closed' | 'dividends' | 'holdings' | 'analysis' | 'action_prep';
export type AgentModeV2 = 'fast' | 'analysis' | 'action_prep' | 'refused';
export type AgentRouteV2 = 'fast' | 'analysis' | 'action_prep' | 'swap' | 'unknown';
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
  /\d+(?:[.,]\d+)?\s*(?:%|percent|per cent|процент)|вдвое|в два раза|половин|halve|by half|четверть|quarter|трет|a third|one third/iu,
  new RegExp(`(?:${AGENT_ASSET_WORDS_V2.map(([, p]) => p.source).join('|')}).*(?:\\s(?:to|до)\\s*\\$\\s?\\d)`, 'iu'),
  // Why the room changed, and what sets it.
  /почему.*(?:уменьш|сниз|упал|измен|меньше|сократ)|why.*(?:decreas|drop|lower|less|chang|reduc|shrank|smaller)|(?:уменьш|сниз)\S*\s.*(?:лимит|сумм\S*\s+займ)|what (?:sets|decides|determines) my (?:limit|room)|из чего (?:складывается|состоит)/iu,
  // Paying down a loan.
  /(?:уменьш|сниз|погас|закрыт|вернут|выплат|repay|reduce|pay\s*down|pay\s*off|clear).*(?:долг|займ|кредит|debt|loan)|(?:долг|займ|debt|loan).*(?:уменьш|сниз|погас|repay|reduce)|погас|repay|pa(?:y|ying|id)\s*(?:back|off|down)/iu,
  // What a loan costs.
  /interest|процент\S*\s+(?:по|за|на)|сколько.*(?:плач|стоит.*(?:займ|кредит|долг))|cost of (?:my |the )?loan|ставк/iu,
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
  if (!whatIf && agentSwapRequestV2(question)) return { route: 'swap', topic: 'action_prep' };
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

// ---------------------------------------------------------------------------
// A swap. Still lends; Swap AI swaps. On 2026-10-31 the operator asked for "a
// swap of all my USDC to ETH" and was told the question could not be read as
// a calculation. A swap is now written out as a goal for Swap AI: the agent
// reads the amount from the wallet, never chooses a route, and never signs.
// ---------------------------------------------------------------------------

/** USDC on Base, from the code-owned registry, never from a model. */
export const AGENT_BASE_USDC_V2 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const SWAP_WORDS_V2 = new RegExp(`${EDGE}(?:свап|своп|обмен|обменя|поменя|сконверт|конверт|swap|exchange|convert)`, 'iu');
const BUY_WORDS_V2 = new RegExp(`${EDGE}(?:купи|buy)`, 'iu');
const SELL_WORDS_V2 = new RegExp(`${EDGE}(?:продай|продать|sell)`, 'iu');
const LOAN_WORDS_V2 = /займ|кредит|долг|залог|погас|borrow|loan|debt|repay|collateral|lend/iu;
const INTO_WORDS_V2 = new RegExp(`${EDGE}(?:на|в|to|into|for)\\s`, 'giu');
const ALL_WORDS_V2 = new RegExp(`${EDGE}(?:all|everything|max|все|всё|весь|всех|вся|целиком|полностью)(?:$|[^\\p{L}])`, 'iu');
const HALF_WORDS_V2 = /half|половин/iu;

/** The tokens a swap can name: USDC and the assets Still reads. */
const SWAP_TOKEN_WORDS_V2: ReadonlyArray<readonly [string, RegExp]> = [
  ['USDC', /usdc|usd coin|юсдс|юсдц/iu],
  ...AGENT_ASSET_WORDS_V2,
];

export interface AgentSwapRequestV2 {
  from: string | null;
  to: string | null;
  /** An exact amount of `from` as typed, or a share of the wallet's `from`. */
  amount: { kind: 'exact'; value: string } | { kind: 'share'; share: 'all' | 'half' } | null;
}

/** A request to swap, read by fixed rules; null when the question is not one. */
export function agentSwapRequestV2(question: string): AgentSwapRequestV2 | null {
  if (LOAN_WORDS_V2.test(question)) return null;
  const named = SWAP_TOKEN_WORDS_V2.flatMap(([asset, pattern]) => {
    const match = pattern.exec(question);
    return match ? [{ asset, at: match.index }] : [];
  }).sort((a, b) => a.at - b.at);
  const buy = BUY_WORDS_V2.test(question);
  const sell = SELL_WORDS_V2.test(question);
  if (!SWAP_WORDS_V2.test(question) && !((buy || sell) && named.length > 0)) return null;

  const dollars = /\$|доллар|\busd\b/iu.test(question);
  let from: string | null = null;
  let to: string | null = null;
  if (buy && !sell) {
    to = named.find((n) => n.asset !== 'USDC')?.asset ?? null;
    from = named.find((n) => n.asset !== to)?.asset ?? 'USDC';
  } else if (sell && !buy) {
    from = named.find((n) => n.asset !== 'USDC')?.asset ?? named[0]?.asset ?? null;
    to = named.find((n) => n.asset !== from)?.asset ?? 'USDC';
  } else {
    // "...на ETH", "...to ETH": the token after the word is the one received.
    const into = [...question.matchAll(INTO_WORDS_V2)].map((m) => m.index ?? 0);
    const received = named.find((n) => into.some((at) => at < n.at && n.at - at <= 6));
    to = received?.asset ?? named[1]?.asset ?? null;
    from = named.find((n) => n.asset !== to)?.asset ?? (dollars ? 'USDC' : null);
  }
  if (from !== null && from === to) to = null;

  let amount: AgentSwapRequestV2['amount'] = null;
  if (ALL_WORDS_V2.test(question)) amount = { kind: 'share', share: 'all' };
  else if (HALF_WORDS_V2.test(question)) amount = { kind: 'share', share: 'half' };
  else {
    // To buy, the amount is what is spent: "for 10 USDC", "$10". A number of
    // the token bought is an output, which Swap AI does not take.
    const spent = buy && !sell
      ? /(?:\$\s*(\d+(?:[.,]\d+)?))|(?:(\d+(?:[.,]\d+)?)\s*(?:usdc|\$|доллар|usd))/iu.exec(question)
      : /(\d+(?:[.,]\d+)?)/.exec(question);
    const raw = spent?.[1] ?? spent?.[2] ?? null;
    if (raw && Number(raw.replace(',', '.')) > 0) amount = { kind: 'exact', value: raw.replace(',', '.') };
  }
  return { from, to, amount };
}

function atomicToDecimalV2(raw: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const fraction = (raw % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function agentSwapAnswerV2(input: {
  question: string;
  report: MirrorReport | null;
  /** The wallet's USDC, read by the server when a share of it is asked for. */
  usdcBalance?: { raw: string; decimals: number; block: string } | 'unread' | null;
}): AgentAnswerV1 {
  const ru = isRussianV1(input.question);
  const request = agentSwapRequestV2(input.question);
  const boundary = ru ? 'БЕЗОПАСНОСТЬ · только подготовка, подпись в кошельке' : 'BOUNDARY · preparation only, wallet signs';
  const say = (text: string, goal: string | null): AgentAnswerV1 => ({
    topic: 'action_prep',
    mode: 'action_prep',
    text,
    sources: [boundary],
    actionLink: {
      href: goal ? `/routes?goal=${encodeURIComponent(goal)}` : '/routes',
      label: ru ? 'Открыть в Swap AI →' : 'Open in Swap AI →',
    },
    engineFacts: { mode: 'action_prep', swapGoal: goal, autonomousSigningRefused: true },
  });
  if (!request?.from || !request.to) {
    return say(
      ru
        ? 'Назовите, что на что обменять и сколько, например «обменяй 10 USDC на ETH». Обмены делает Swap AI: он сравнивает маршруты и проверяет обмен симуляцией, а подписываете вы в своём кошельке.'
        : 'Name what to swap for what, and how much, for example “swap 10 USDC to ETH”. Swaps are made in Swap AI: it compares routes and simulates the swap, and you sign in your own wallet.',
      null,
    );
  }
  const { from, to } = request;
  // A stock or cbBTC is named by its address, read from the chain; USDC and
  // ETH by the symbols Swap AI resolves from its own registry.
  const line = input.report?.assets.find((asset) => asset.symbol === from) ?? null;
  const refOf = (symbol: string) =>
    symbol === 'USDC' || symbol === 'ETH'
      ? symbol
      : input.report?.assets.find((asset) => asset.symbol === symbol)?.token ?? symbol;
  const goalFor = (amount: string | null) => `Swap ${amount ? `${amount} ` : ''}${refOf(from)} to ${refOf(to)}`;
  const signs = ru
    ? 'Swap AI сравнит маршруты и проверит обмен симуляцией; подписываете вы, в своём кошельке.'
    : 'Swap AI compares routes and simulates the swap; you sign it in your own wallet.';

  if (request.amount?.kind === 'exact') {
    return say(
      ru
        ? `Подготовил обмен: ${request.amount.value} ${from} на ${to}. ${signs}`
        : `Prepared: swap ${request.amount.value} ${from} to ${to}. ${signs}`,
      goalFor(request.amount.value),
    );
  }
  if (request.amount === null) {
    return say(
      ru
        ? `Подготовил обмен ${from} на ${to}: укажите сумму в Swap AI. ${signs}`
        : `Prepared a swap of ${from} to ${to}: name the amount in Swap AI. ${signs}`,
      goalFor(null),
    );
  }
  if (from === 'ETH') {
    return say(
      ru
        ? `Назовите сумму ETH: часть ETH должна остаться на комиссии сети, поэтому «весь ETH» я не считаю. ${signs}`
        : `Name an amount of ETH: some ETH has to stay for network fees, so I do not work out “all of it”. ${signs}`,
      goalFor(null),
    );
  }
  // Null: nobody is signed in to read. 'unread': a read that did not answer.
  const held =
    from === 'USDC'
      ? (input.usdcBalance ?? null)
      : !input.report
        ? null
        : line?.wallet
          ? { raw: line.wallet.raw, decimals: line.wallet.decimals, block: input.report.reading.block }
          : 'unread';
  if (held === null || held === 'unread') {
    return say(
      held === null
        ? ru
          ? `Войдите, и я прочитаю ваш ${from}, или укажите сумму в Swap AI. ${signs}`
          : `Sign in and I will read your ${from}, or name the amount in Swap AI. ${signs}`
        : ru
          ? `Баланс ${from} сейчас не удалось прочитать: это наш сбой, а не факт о кошельке. Укажите сумму в Swap AI. ${signs}`
          : `Your ${from} balance could not be read just now: that is our failure, not a fact about your wallet. Name the amount in Swap AI. ${signs}`,
      goalFor(null),
    );
  }
  const whole = BigInt(held.raw);
  const share = request.amount.share === 'all' ? whole : whole / 2n;
  const block = Number(held.block).toLocaleString('en-US');
  if (share === 0n) {
    return say(
      ru
        ? `В вашем кошельке сейчас 0 ${from} (блок Base ${block}), обменивать нечего.`
        : `Your wallet holds 0 ${from} right now (Base block ${block}), so there is nothing to swap.`,
      null,
    );
  }
  const amount = atomicToDecimalV2(share, held.decimals);
  const which = request.amount.share === 'all'
    ? ru ? `весь ваш ${from} на блоке Base ${block}` : `all your ${from} at Base block ${block}`
    : ru ? `половина вашего ${from} на блоке Base ${block}` : `half your ${from} at Base block ${block}`;
  return say(
    ru
      ? `Подготовил обмен: ${amount} ${from} (${which}) на ${to}. ${signs}`
      : `Prepared: swap ${amount} ${from} (${which}) to ${to}. ${signs}`,
    goalFor(amount),
  );
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
  const { route, topic } = agentRouteV2(input.question);
  if (route === 'swap') return agentSwapAnswerV2({ question: input.question, report: input.report, usdcBalance: null });
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
