import { z } from 'zod';

import {
  DividendCalendarResponseV1Schema,
  dividendReleasesReadV1,
  type DividendCalendarResponseV1,
  type DividendEventV1,
  type DividendStockV1,
} from './dividends.js';

// ---------------------------------------------------------------------------
// The dividend calendar, for an assistant.
//
// One read for "when does my stock pay next, about how much, and how much has
// already been reinvested". An assistant quotes what it is handed, so the
// sentences are written here, from the same calendar the board renders, and
// each keeps the two parties apart: what the COMPANY declared in its own
// release, and what reached the TOKEN, read from the token. An estimate is
// called one in the sentence itself, because a paraphrase drops a flag and
// keeps a number.
// ---------------------------------------------------------------------------

export const DividendCalendarAgentInputV1Schema = z
  .object({
    /** A ticker or its Coinbase token: "META" or "METAc". Omitted: every stock. */
    symbol: z
      .string()
      .regex(/^[A-Za-z]{1,6}c?$/, 'a ticker such as META, or its token such as METAc')
      .optional(),
  })
  .strict();
export type DividendCalendarAgentInputV1 = z.infer<typeof DividendCalendarAgentInputV1Schema>;

export const DividendCalendarAgentOutputV1Schema = DividendCalendarResponseV1Schema.extend({
  /** Read first, and prefer its wording: every number in it is on a row below. */
  miorailSummary: z.string(),
});
export type DividendCalendarAgentOutputV1 = z.infer<typeof DividendCalendarAgentOutputV1Schema>;

/** The mechanism, once, in words that survive being quoted alone. */
export const DIVIDEND_MECHANISM_SENTENCE_V1 =
  "A Coinbase token takes a dividend as more shares per token, after withholding tax and Coinbase's fee, never as cash. It reaches whoever holds the token when the multiplier moves, not whoever held it on the record date.";

const STATE_WORDS_V1: Readonly<Record<DividendEventV1['state'], string>> = {
  estimated: 'not declared yet; the last dividend again, a quarter later, is an estimate',
  announced: 'declared',
  scheduled: 'declared, and the conversion is scheduled on Base',
  effective: 'reinvested into the token',
  awaiting_confirmation: 'paid by the company; Miorail has not confirmed the conversion yet',
  not_entitled: 'paid, and not owed to the token: it had no supply on the record date',
  not_reflected: 'paid; the token has not converted it',
};

/** One dividend, one sentence: the company's side, then the token's. */
export function dividendEventSentenceV1(event: DividendEventV1, stock: DividendStockV1): string {
  const when = event.payDateApproximate ? `around ${event.payDate}` : event.payDate;
  const company = `${stock.company} $${event.amountPerShare} a share, payable ${when} (${STATE_WORDS_V1[event.state]})`;
  const token = event.token;
  if (token.kind === 'measured' && token.increasePercent !== null) {
    const share = token.passThroughPercent ? `, ${token.passThroughPercent}% of the declared amount` : '';
    const worth = token.perTokenUsd && token.priceUsd ? `, worth $${token.perTokenUsd} a token at $${token.priceUsd}` : '';
    return `${company}: ${stock.tokenSymbol} tracked ${token.increasePercent}% more ${stock.symbol} shares per token from ${token.at}${worth}${share}.`;
  }
  if (token.kind === 'scheduled' && token.increasePercent !== null) {
    return `${company}: the issuer scheduled ${stock.tokenSymbol} to track ${token.increasePercent}% more ${stock.symbol} shares per token from ${token.at}.`;
  }
  if (token.kind === 'estimate' && token.increasePercent !== null) {
    return `${company}: Miorail estimates about ${token.increasePercent}% more ${stock.symbol} shares per ${stock.tokenSymbol}, about $${token.perTokenUsd} a token, at the ${token.passThroughPercent}% of a dividend that has reached a token so far. An estimate, not the company's figure.`;
  }
  return `${company}.`;
}

/** The whole calendar, or one stock of it, as sentences an assistant can repeat. */
export function dividendCalendarSummaryV1(calendar: DividendCalendarResponseV1): string {
  const sentences: string[] = [];
  for (const stock of calendar.stocks) {
    if (stock.next) sentences.push(`Next for ${stock.symbol}: ${dividendEventSentenceV1(stock.next, stock)}`);
    const last = stock.history[0];
    if (last) sentences.push(`Last for ${stock.symbol}: ${dividendEventSentenceV1(last, stock)}`);
  }
  const silent = calendar.stocks.filter((stock) => stock.next === null && stock.history.length === 0);
  const quiet = silent.filter((stock) => dividendReleasesReadV1(stock.underlyingKey)).map((stock) => stock.symbol);
  const unread = silent.filter((stock) => !dividendReleasesReadV1(stock.underlyingKey)).map((stock) => stock.symbol);
  if (quiet.length > 0) sentences.push(`No dividend on record: ${quiet.join(', ')}.`);
  // Miorail's gap, said as one. "No dividend on record" here once told an
  // assistant that Pfizer and Philip Morris pay nothing.
  if (unread.length > 0) {
    sentences.push(
      `Not read: Miorail does not read the dividend releases of ${unread.join(', ')}, so nothing is established about whether they pay one.`,
    );
  }
  if (sentences.length === 0) sentences.push('No dividend is on record for any of these stocks.');
  return [...sentences, DIVIDEND_MECHANISM_SENTENCE_V1].join(' ');
}

/** The calendar narrowed to one ticker or token, and its sentences. */
export function dividendCalendarForAgentV1(
  calendar: DividendCalendarResponseV1,
  input: DividendCalendarAgentInputV1,
): DividendCalendarAgentOutputV1 {
  const wanted = input.symbol?.toUpperCase();
  const stocks = wanted
    ? calendar.stocks.filter((stock) => stock.symbol.toUpperCase() === wanted || stock.tokenSymbol.toUpperCase() === wanted)
    : calendar.stocks;
  const narrowed = { ...calendar, stocks };
  return {
    ...narrowed,
    miorailSummary:
      wanted && stocks.length === 0
        ? `${input.symbol} is not one of the Coinbase tokenized stocks on Base that Miorail reads. ${DIVIDEND_MECHANISM_SENTENCE_V1}`
        : dividendCalendarSummaryV1(narrowed),
  };
}
