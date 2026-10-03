import {
  reopenShareLineV1,
  type ReopenDirectionV1,
  type ReopenGameResponseV1,
} from '@mioagent/rwa-market-reality/reopen-game';

import { giftShareLinksV1 } from './giftView';
import { etLabelV1, signedPercentV1, untilV1 } from './weekendMarketView';

// ---------------------------------------------------------------------------
// Call the reopen, in words.
//
// One question per stock, said the same way in every state: will it reopen
// above or below Friday's close. Base is an opponent with a record, never an
// oracle: its call is its own price at the lock, and its record is the rounds
// actually played. Up and down carry no colour; only right and wrong do, once a
// round is settled.
// ---------------------------------------------------------------------------

export interface ReopenGameRowViewV1 {
  symbol: string;
  name: string;
  close: string;
  /** While picks are open: the price on Base now and its move from the close. */
  baseNow: string | null;
  /** Once picks closed: Base's call, at its price at the lock. */
  baseCall: string | null;
  pick: ReopenDirectionV1 | null;
  /** After the lock: how the players split. */
  crowd: string | null;
  /** Once settled: where it reopened and which way. */
  result: string | null;
  /** Once settled: the reader's square. */
  mark: '🟩' | '🟥' | '⬜' | null;
}

export interface ReopenGameViewV1 {
  state: 'upcoming' | 'open' | 'locked' | 'settled';
  roundId: string | null;
  title: string;
  badge: string;
  lede: string;
  rows: ReopenGameRowViewV1[];
  /** The reader's standing, or how to keep it. */
  standing: string | null;
  /** Shown with a sign-in button: a device keeps picks, a wallet keeps a streak. */
  keepWithWallet: boolean;
  rules: string;
  share: { x: string; farcaster: string } | null;
  error: string | null;
}

const RULES_V1 =
  "Friday's close is the Chainlink price at the 16:00 ET bell. Base's call is its own price at the lock: the median of Miorail's $100 quotes over the six hours before 17:00 ET Sunday, above or below the close. The result is the first Chainlink price Miorail records after Wall Street reopens at 20:00 ET; a stock that reopens exactly at the close, or does not print, counts for nobody. Picks close three hours early because futures open at 18:00 ET and show the way. No prizes: tokenized stocks are not offered to US persons, and this is played for the record.";

const ARROW_V1: Readonly<Record<ReopenDirectionV1, string>> = { up: '▲', down: '▼' };
const WORD_V1: Readonly<Record<ReopenDirectionV1, string>> = { up: 'above', down: 'below' };

function usdV1(value: string): string {
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function reopenGameViewV1(
  response: ReopenGameResponseV1 | null | undefined,
  input: {
    now: Date;
    origin: string;
    /** Picks sent but not yet answered, shown as already made. */
    pending?: Readonly<Record<string, ReopenDirectionV1>> | null;
    failed?: string | null;
  },
): ReopenGameViewV1 | null {
  if (!response) return null;
  const url = `${input.origin.replace(/\/+$/, '')}/stocks/weekend`;
  const round = response.round;
  const next = response.next;
  const nextLine = next
    ? `Round #${next.number} opens ${etLabelV1(next.opensAt)}${untilV1(next.opensAt, input.now) ? ` (${untilV1(next.opensAt, input.now)})` : ''}.`
    : null;
  const error = input.failed ?? null;

  if (!round) {
    if (!next) return null;
    return {
      state: 'upcoming',
      roundId: null,
      title: 'Call the reopen',
      badge: 'Next round',
      lede: `Round #${next.number} opens ${etLabelV1(next.opensAt)}${untilV1(next.opensAt, input.now) ? ` (${untilV1(next.opensAt, input.now)})` : ''}, when Wall Street closes for the weekend: five stocks, and for each one question — will it reopen above or below Friday's close? Picks close ${etLabelV1(next.locksAt)}, and Base makes its own call at the same minute.`,
      rows: [],
      standing: null,
      keepWithWallet: false,
      rules: RULES_V1,
      share: null,
      error,
    };
  }

  const me = response.me;
  const picks: Readonly<Record<string, ReopenDirectionV1>> = input.pending ?? me?.picks ?? {};
  const picked = Object.keys(picks).length > 0;
  const state = round.state;

  const rows = round.stocks.map((stock): ReopenGameRowViewV1 => {
    const pick = picks[stock.symbol] ?? null;
    const outcome = stock.result?.outcome ?? null;
    return {
      symbol: stock.symbol,
      name: stock.name,
      close: usdV1(stock.close),
      baseNow:
        state === 'open' && stock.baseNow
          ? `${usdV1(stock.baseNow.value)} · ${signedPercentV1(stock.baseNow.moveBps)}`
          : null,
      baseCall:
        state === 'open'
          ? null
          : stock.baseCall?.call && stock.baseCall.base
            ? `${ARROW_V1[stock.baseCall.call]} at ${usdV1(stock.baseCall.base)}`
            : stock.baseCall
              ? 'no call: too few quotes'
              : null,
      pick,
      crowd: stock.crowd ? `${stock.crowd.up} ▲ · ${stock.crowd.down} ▼` : null,
      result: stock.result
        ? stock.result.reopen
          ? `${stock.result.outcome === 'void' ? 'Reopened at the close' : `Reopened ${WORD_V1[stock.result.outcome]}`} · ${usdV1(stock.result.reopen)}`
          : 'No reopen print: counts for nobody'
        : null,
      mark:
        state !== 'settled' || outcome === null
          ? null
          : outcome === 'void' || pick === null
            ? '⬜'
            : pick === outcome
              ? '🟩'
              : '🟥',
    };
  });

  const record = me?.record ?? null;
  const standing =
    me && !me.signed && (picked || (record?.played ?? 0) > 0)
      ? 'Your picks are kept on this device only. Sign in and they stay with your wallet, streak and all.'
      : me && me.signed && record && record.played > 0
        ? `Streak ${plural(record.streak, 'weekend', 'weekends')} · ${record.correct}/${record.of} right overall · beat Base ${plural(record.beatBase, 'time', 'times')}.`
        : me && me.signed && picked
          ? 'Your picks are kept with your wallet.'
          : state === 'open' && !picked
          ? 'Pick ▲ or ▼ for each stock. No wallet needed; you can change a pick until the lock.'
          : null;

  const shareCalls = rows
    .filter((row) => row.pick)
    .map((row) => `${row.symbol} ${ARROW_V1[row.pick!]}`)
    .join(' ');

  if (state === 'open') {
    const until = untilV1(round.locksAt, input.now);
    return {
      state,
      roundId: round.roundId,
      title: `Call the reopen · #${round.number}`,
      badge: 'Picks open',
      lede: `Will each stock reopen above or below Friday's close? Picks close ${etLabelV1(round.locksAt)}${until ? ` (${until})` : ''}. At that minute Base makes its own call from its price on Base, and the reopen at ${etLabelV1(round.expectedReopenAt)} settles both.`,
      rows,
      standing,
      keepWithWallet: Boolean(me && !me.signed && picked),
      rules: RULES_V1,
      share: picked
        ? giftShareLinksV1({
            url,
            text: `I'm calling the reopen against Base, #${round.number}: ${shareCalls}. Picks close ${etLabelV1(round.locksAt)}.`,
          })
        : null,
      error,
    };
  }

  if (state === 'locked') {
    const called = round.stocks.some((stock) => stock.baseCall !== null);
    return {
      state,
      roundId: round.roundId,
      title: `Call the reopen · #${round.number}`,
      badge: 'Picks closed',
      lede: `Picks closed ${etLabelV1(round.locksAt)}${round.players !== null ? `, with ${plural(round.players, 'player', 'players')}` : ''}. ${called ? "Base's calls are in." : "Base's call is being fixed from its price at the lock."} The reopen at ${etLabelV1(round.expectedReopenAt)} settles every call.`,
      rows,
      standing,
      keepWithWallet: Boolean(me && !me.signed && picked),
      rules: RULES_V1,
      share: null,
      error,
    };
  }

  // Settled.
  const base = round.score?.base ?? null;
  const crowd = round.score?.crowd ?? null;
  const mine = me?.score && picked ? me.score : null;
  const parts = [
    mine ? `You ${mine.correct}/${mine.of}` : null,
    base ? `Base ${base.correct}/${base.of}` : null,
    crowd ? `players ${crowd.correct}/${crowd.of}` : null,
  ].filter(Boolean);
  const players = round.players !== null ? ` ${plural(round.players, 'person', 'people')} played.` : '';
  return {
    state,
    roundId: round.roundId,
    title: `Call the reopen · #${round.number}`,
    badge: 'Results',
    lede: `${parts.join(' · ')}.${players}${mine ? '' : ' You did not play this round.'}${nextLine ? ` ${nextLine}` : ''}`,
    rows,
    standing,
    keepWithWallet: Boolean(me && !me.signed && (me.record.played ?? 0) > 0),
    rules: RULES_V1,
    share:
      mine && base
        ? giftShareLinksV1({ url, text: reopenShareLineV1({ number: round.number, mine, base }) })
        : null,
    error,
  };
}
