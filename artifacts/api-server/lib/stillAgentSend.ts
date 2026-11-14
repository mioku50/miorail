import { STOCKS, type MirrorReport } from '@mioagent/still-engine';
import { ADDRESSES } from '@mioagent/still-engine/registry';
import {
  agentPlainAmountV2,
  agentSendRequestV2,
  atomicToDecimalV2,
  isRussianV1,
  type AgentAnswerV1,
  type AgentSendActionV1,
} from '../../../lib/ui/src/still/agentAnswers.js';
import type { BaseNameResolutionV1 } from './baseNameResolver.js';
import type { StillAgentStageV1 } from './stillAgentServer.js';
import {
  CANONICAL_BASE_USDC_V1,
  STOCK_GIFT_DAILY_LIMIT_V1,
  STOCK_GIFT_MAX_USDC_ATOMIC_V1,
  STOCK_GIFT_SEND_MIN_USDC_ATOMIC_V1,
  resolveGiftRecipientV1,
  usdcDollarsV1,
  type GiftRecipientResolutionV1,
} from './stockGift.js';

// ---------------------------------------------------------------------------
// The Agent's transfer: a stock from the session wallet to an address or a
// Basename the question wrote (operator, 2026-11-03: «хотел чтобы агент
// сделал это»). What it hands over is the stock page's own send, so the same
// review takes it: on the server the Gift Send kernel checks the stock, the
// recipient (resolved again), the balance and the value, it simulates the one
// transfer, and the person signs it in their own wallet.
//
// Here only what the answer needs is read: the wallet's own balance and what
// is pledged, from the session's report, and the recipient, from Base. A
// stock that is all pledged is said to be so, with the way to take it back.
// ---------------------------------------------------------------------------

const STOCK_IDS_V1 = new Set<string>(STOCKS.map((stock) => stock.id));
const STOCK_TICKERS_V1 = STOCKS.map((stock) => stock.ticker).join(', ');

/**
 * The coins a transfer is prepared for besides the stocks (operator, 2026-11-12: «надо бы ему агенту
 * разрешить также подготовку отправки usdc и eth и золота»): the same send from holdings takes them,
 * under the same rules. USDC is read on its own, as the report reads only what can be collateral;
 * gold is a line of the report, and may be pledged on Morpho.
 */
const COIN_SENDS_V1: Readonly<Record<string, { token: string; symbol: string }>> = {
  USDC: { token: CANONICAL_BASE_USDC_V1, symbol: 'USDC' },
  PAXG: { token: ADDRESSES.paxg.toLowerCase(), symbol: 'PAXG' },
};

/** One plain number written in the question, the recipient left out: "$5" for a send of USDC. Read by
 * the same rule that checked it, so "$.5" is half a dollar and never five (audit N13-5). */
function plainNumberV1(question: string, recipient: string | null): string | null {
  return agentPlainAmountV2(recipient ? question.replace(recipient, ' ') : question);
}

/** "0.5" in base units, exactly; null when it has more places than the token. */
function unitsToAtomicV1(value: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) return null;
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

const shortV1 = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export async function stillAgentSendAnswerV1(input: {
  question: string;
  /** The session's wallet, lower case. */
  wallet: string;
  report: MirrorReport;
  resolveName: (name: string) => Promise<BaseNameResolutionV1>;
  /** The wallet's USDC, read on its own: the report reads only what can be collateral. */
  readUsdc?: () => Promise<{ raw: string; decimals: number; block: string } | null>;
  stage: (stage: StillAgentStageV1) => void;
}): Promise<AgentAnswerV1> {
  const { question, report } = input;
  const ru = isRussianV1(question);
  const t = (russian: string, english: string) => (ru ? russian : english);
  const block = Number(report.reading.block).toLocaleString('en-US');
  const say = (text: string, extra: Partial<AgentAnswerV1> = {}): AgentAnswerV1 => ({
    topic: 'action_prep',
    mode: 'action_prep',
    text,
    sources: [t('БЕЗОПАСНОСТЬ · только подготовка, подпись в кошельке', 'BOUNDARY · preparation only, wallet signs'), t(`ЧТЕНИЕ · блок Base ${block}`, `READ · Base block ${block}`)],
    engineFacts: { mode: 'action_prep', send: null, autonomousSigningRefused: true },
    ...extra,
  });

  const request = agentSendRequestV2(question);
  if (!request?.asset) {
    return say(
      (request?.named ?? 0) > 1
        ? t('Назовите одну акцию: перевод готовится по одной, например «переведи все NVDAc на имя.base.eth».', 'Name one stock: a transfer is prepared one at a time, e.g. “send all my NVDAc to name.base.eth”.')
        : t('Назовите, какую акцию перевести, например «переведи все NVDAc на имя.base.eth».', 'Name the stock to send, e.g. “send all my NVDAc to name.base.eth”.'),
    );
  }
  const coin = COIN_SENDS_V1[request.asset] ?? null;
  const line = report.assets.find((entry) => entry.asset === request.asset) ?? null;
  const symbol = coin?.symbol ?? line?.symbol ?? request.asset;
  if (!STOCK_IDS_V1.has(request.asset) && !coin) {
    return say(
      t(
        `Перевод я готовлю для акций Coinbase (${STOCK_TICKERS_V1}), USDC и золота (PAXG): для них в Miorail есть проверенная передача. ${symbol} отправьте кнопкой Send в своём кошельке.`,
        `I prepare transfers of Coinbase stocks (${STOCK_TICKERS_V1}), USDC and gold (PAXG): Miorail has a checked transfer for them. Send ${symbol} with your own wallet’s Send button.`,
      ),
    );
  }
  const recipient = request.recipient;
  // The first one written is not necessarily the one meant, so nothing is prepared from it.
  if (request.unclear === 'several') {
    return say(t(
      'В вопросе больше одного получателя или сказано, кому не отправлять. Спросите ещё раз и напишите только того, кому перевести: адрес 0x… или имя .base.eth. Сам я получателя не выбираю.',
      'Your question names more than one recipient, or says who not to send to. Ask again with only the one who should receive it: a 0x address or a .base.eth name. I never pick one for you.',
    ));
  }
  // "Do not send", "cancel the transfer" (audit SS-3): nothing is prepared, and nothing was ever going out
  // by itself, since a transfer leaves only when the person signs it in their own wallet.
  if (request.unclear === 'negated') {
    return say(t(
      'В вопросе сказано не переводить, отменить перевод или кому не отправлять, поэтому я ничего не подготовил. Сам Still ничего не отправляет: перевод уходит, только когда вы подписываете его в своём кошельке. Если перевести всё же нужно, спросите ещё раз: сумма и один получатель, адрес 0x… или имя .base.eth.',
      'Your question says not to send, to cancel a transfer, or who not to send to, so I prepared nothing. Still never sends anything by itself: a transfer leaves only when you sign it in your own wallet. If you do want to send, ask again with the amount and the one recipient, a 0x address or a .base.eth name.',
    ));
  }
  if (!recipient) {
    return say(t('Кому перевести? Напишите в вопросе адрес 0x… или имя .base.eth: получателя я беру только из ваших слов.', 'Who should receive it? Write a 0x address or a .base.eth name in the question: I take the recipient only from your own words.'));
  }
  if (recipient.kind === 'other_name') {
    return say(t(`Я читаю имена .base.eth и адреса 0x…, а имя ${recipient.value} проверить не могу. Напишите адрес 0x….`, `I read .base.eth names and 0x addresses, and cannot check ${recipient.value}. Write the 0x address instead.`));
  }
  // An amount that is not one plain number is never worked out (audit MCP-1): a percentage, "all but",
  // a date beside the amount, "1,000". The answer says so, and prepares nothing.
  if (request.amountUnclear) {
    return say(t(
      `Сумму я читаю только как одно простое число, поэтому угадывать не стал. Напишите одно количество ${symbol}, например 0.5, или «все».`,
      `I take an amount only as one plain number, so I did not guess. Write one amount of ${symbol}, such as 0.5, or “all”.`,
    ));
  }
  if (!request.amount) return say(t(`Сколько перевести? Напишите количество ${symbol} или «все».`, `How much? Write an amount of ${symbol}, or “all”.`));
  // Dollars are USDC's own unit; for anything else they would have to be turned into it at a price.
  const dollars = request.amount.kind === 'dollars' && request.asset === 'USDC' ? plainNumberV1(question, recipient.value) : null;
  const amount = dollars !== null ? { kind: 'exact' as const, value: dollars } : request.amount;
  if (amount.kind === 'dollars') {
    return say(
      request.asset === 'USDC'
        ? t('Напишите, сколько USDC перевести, одним числом, например 5, или «все».', 'Write how much USDC to send as one number, such as 5, or “all”.')
        : t(`Назовите количество в ${symbol} или «все»: сумму в долларах я в ${coin ? symbol : 'акции'} не пересчитываю.`, `Name an amount in ${symbol}, or “all”: I do not turn dollars into ${coin ? symbol : 'shares'}.`),
    );
  }
  const unread = () =>
    say(t(`Баланс ${symbol} сейчас не удалось прочитать: это наш сбой, а не факт о кошельке. Спросите ещё раз через минуту.`, `Your ${symbol} balance could not be read just now: that is our failure, not a fact about your wallet. Ask again in a minute.`));
  // USDC is read on its own, at its own block; a stock and gold are lines of the report.
  let decimals: number;
  let held: bigint;
  let pledged = 0n;
  let tokenAddress: string;
  let heldAt = block;
  if (request.asset === 'USDC') {
    const usdc = await (input.readUsdc?.() ?? Promise.resolve(null)).catch(() => null);
    if (!usdc || !/^[0-9]+$/.test(usdc.raw)) return unread();
    decimals = usdc.decimals;
    held = BigInt(usdc.raw);
    tokenAddress = CANONICAL_BASE_USDC_V1;
    if (/^\d+$/.test(usdc.block)) heldAt = Number(usdc.block).toLocaleString('en-US');
  } else {
    if (!line?.wallet) return unread();
    decimals = line.wallet.decimals;
    held = BigInt(line.wallet.raw);
    pledged = line.pledged ? BigInt(line.pledged.raw) : 0n;
    tokenAddress = (coin?.token ?? line.token).toLowerCase();
  }
  const units = (raw: bigint) => atomicToDecimalV2(raw, decimals);
  // Where what is pledged lies: a stock on the Aave V4 Spoke, gold in its Morpho market.
  const venueName = line?.venue === 'morpho' ? 'Morpho' : 'Aave V4';
  let atomic: bigint;
  if (amount.kind === 'share') {
    atomic = amount.share === 'all' ? held : held / 2n;
  } else {
    const exact = unitsToAtomicV1(amount.value, decimals);
    if (exact === null) return say(t(`У ${symbol} не больше ${decimals} знаков после запятой.`, `${symbol} has at most ${decimals} decimal places.`));
    if (exact > held && held > 0n) {
      return say(t(`В кошельке ${units(held)} ${symbol} (блок Base ${heldAt}), меньше чем ${amount.value}. Назовите количество поменьше или «все».`, `The wallet holds ${units(held)} ${symbol} (Base block ${heldAt}), less than ${amount.value}. Name a smaller amount, or “all”.`));
    }
    atomic = exact;
  }

  if (held === 0n || atomic === 0n) {
    if (pledged === 0n) {
      return say(t(`В вашем кошельке нет ${symbol} (блок Base ${heldAt}): переводить нечего.`, `Your wallet holds no ${symbol} (Base block ${heldAt}), so there is nothing to send.`));
    }
    // A stock is pledged on the Aave V4 Spoke, gold in its own Morpho market; Repay takes either back.
    const venue = line?.venue === 'morpho'
      ? report.venues.find((entry) => entry.venue === 'morpho' && entry.label.includes(symbol)) ?? null
      : report.venues.find((entry) => entry.venue === line?.venue) ?? null;
    const debt = venue?.debtAtomic ? BigInt(venue.debtAtomic) : null;
    const lead = t(
      `Ваши ${units(pledged)} ${symbol} лежат залогом в ${venueName}, а в кошельке их 0 (блок Base ${block}).`,
      `Your ${units(pledged)} ${symbol} are pledged as collateral on ${venueName}, and the wallet holds none (Base block ${block}).`,
    );
    const next =
      debt === 0n
        ? t(` Долга нет, поэтому забрать их можно без USDC: Repay → «Take back ${symbol}». Когда акции вернутся в кошелёк, попросите перевод снова.`, ` Nothing is owed, so you can take them back without USDC: Repay → “Take back ${symbol}”. Once they are back in the wallet, ask for the transfer again.`)
        : debt === null
          ? t(` Сначала верните их: Repay → «Take back ${symbol}» или «Repay all, take back ${symbol}», если есть долг. Потом попросите перевод снова.`, ` Take them back first: Repay → “Take back ${symbol}”, or “Repay all, take back ${symbol}” if anything is owed. Then ask for the transfer again.`)
          : t(` Сначала верните их: Repay → «Repay all, take back ${symbol}». Для этого в кошельке нужно не меньше ${atomicToDecimalV2(debt, 6)} USDC и немного сверху на проценты. Потом попросите перевод снова.`, ` Take them back first: Repay → “Repay all, take back ${symbol}”, which needs at least ${atomicToDecimalV2(debt, 6)} USDC in the wallet and a little more for interest. Then ask for the transfer again.`);
    return say(lead + next, { actionLink: { href: line?.venue === 'morpho' ? `/repay?asset=${encodeURIComponent(symbol)}` : '/repay', label: t('Открыть Repay →', 'Open Repay →') } });
  }

  const name = recipient.kind === 'basename' ? recipient.value.toLowerCase() : null;
  input.stage({ stage: 'understood', by: 'rules', summary: t(`перевод ${units(atomic)} ${symbol} → ${name ?? shortV1(recipient.value)}`, `send ${units(atomic)} ${symbol} → ${name ?? shortV1(recipient.value)}`) });
  if (name) input.stage({ stage: 'resolving', summary: name });
  const resolution: GiftRecipientResolutionV1 = await resolveGiftRecipientV1({
    value: recipient.value,
    walletAddress: input.wallet,
    resolveName: input.resolveName,
  }).catch((): GiftRecipientResolutionV1 => ({ outcome: 'refused', code: 'resolver_unavailable', message: '' }));
  if (resolution.outcome !== 'resolved') {
    const label = name ?? recipient.value;
    const text = {
      recipient_is_you: t(`${label} — это ваш же кошелёк, с которым вы вошли: перевод самому себе ничего не меняет.`, `${label} is the wallet you signed in with: a transfer to yourself changes nothing.`),
      recipient_invalid: t('Это нулевой адрес: отправленное туда никто не сможет потратить.', 'That is the zero address: nothing sent there can be spent.'),
      name_unresolved: t(`${label} не указывает ни на какой адрес в Base. Проверьте имя или напишите адрес 0x….`, `${label} does not point to any address on Base. Check the name, or write the 0x address.`),
      resolver_unavailable: t('Имена .base.eth сейчас не читаются: это наш сбой. Напишите адрес 0x… или спросите ещё раз через минуту.', 'Basenames cannot be read right now: that is our failure. Write the 0x address, or ask again in a minute.'),
    }[resolution.code];
    return say(text);
  }
  const address = resolution.address;
  if (name) input.stage({ stage: 'resolved', summary: `${name} → ${shortV1(address)}` });

  const share =
    amount.kind === 'share'
      ? amount.share === 'all'
        ? t('всё, что в кошельке', 'all of it in the wallet')
        : t('половина того, что в кошельке', 'half of what the wallet holds')
      : null;
  const who = name ? `${name} (${address})` : address;
  const pledgedNote =
    pledged > 0n
      ? t(` Ещё ${units(pledged)} ${symbol} в залоге ${venueName}: этот перевод их не трогает.`, ` Another ${units(pledged)} ${symbol} is pledged on ${venueName}: this transfer does not touch it.`)
      : '';
  const sendAction: AgentSendActionV1 = {
    tokenAddress,
    amountAtomic: atomic.toString(),
    symbol,
    decimals,
    recipient: address,
    recipientName: name,
  };
  return say(
    t(
      `Подготовил перевод: ${units(atomic)} ${symbol}${share ? ` (${share})` : ''} на ${who}. Я ничего не подписываю: на следующем экране Miorail соберёт одну передачу и проверит её симуляцией на свежем блоке, а подпишете её вы, в своём кошельке.${pledgedNote}`,
      `Prepared a transfer: ${units(atomic)} ${symbol}${share ? ` (${share})` : ''} to ${who}. I sign nothing: on the next screen Miorail builds the one transfer and checks it in a simulation at a fresh block, and you sign it in your own wallet.${pledgedNote}`,
    ),
    {
      steps: [
        name ? t(`Получатель: ${name} → ${address}, прочитано на Base`, `Recipient: ${name} → ${address}, read on Base`) : t(`Получатель: ${address}`, `Recipient: ${address}`),
        t(`Сумма: ${units(atomic)} ${symbol} из кошелька, блок Base ${heldAt}`, `Amount: ${units(atomic)} ${symbol} from the wallet, Base block ${heldAt}`),
        t('Одна передача токена: без обмена и без разрешения на списание', 'One token transfer: no swap and no spending approval'),
        sendRangeLineV1({ ru, symbol, coin: coin !== null }),
      ],
      sendAction,
      calculatedAt: { block: report.reading.block, blockTime: report.reading.blockTime },
      engineFacts: { mode: 'action_prep', send: { asset: request.asset, amountAtomic: sendAction.amountAtomic, recipient: address }, autonomousSigningRefused: true },
    },
  );
}

/** What the review screen is called, and the range a send from holdings keeps to. */
function sendRangeLineV1(input: { ru: boolean; symbol: string; coin: boolean }): string {
  const min = usdcDollarsV1(STOCK_GIFT_SEND_MIN_USDC_ATOMIC_V1.toString());
  const max = usdcDollarsV1(STOCK_GIFT_MAX_USDC_ATOMIC_V1.toString());
  // USDC is its own dollar figure; gold and a stock are worth what a router would pay for them.
  const measure = input.symbol === 'USDC' ? '' : input.ru ? ' по цене продажи' : ' at the sell price';
  if (!input.coin) {
    return input.ru
      ? `Экран проверки называется Gift: так Miorail называет отправку акции из кошелька. Она бывает от ${min} до ${max}${measure} и до ${STOCK_GIFT_DAILY_LIMIT_V1} в день`
      : `The review screen is titled Gift, Miorail’s name for sending a stock from the wallet. It is worth ${min} to ${max}${measure}, up to ${STOCK_GIFT_DAILY_LIMIT_V1} a day`;
  }
  return input.ru
    ? `Экран проверки называется Gift: так Miorail называет любую отправку из кошелька. Она бывает от ${min} до ${max}${measure} и до ${STOCK_GIFT_DAILY_LIMIT_V1} в день`
    : `The review screen is titled Gift, Miorail’s name for any send from the wallet. It is worth ${min} to ${max}${measure}, up to ${STOCK_GIFT_DAILY_LIMIT_V1} a day`;
}
