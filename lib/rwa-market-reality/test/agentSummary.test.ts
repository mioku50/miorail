import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { marketRealityAgentSummaryV1 } from '../src/agentSummary.js';
import { MarketRealityResponseV2Schema } from '../src/contracts.js';
import type { MarketRealityResponseV2 } from '../src/contracts.js';

// ---------------------------------------------------------------------------
// The summary exists so an external model does not have to invent one.
//
// What is pinned here is the sentence it must never produce: `0 of 2` is a fact
// about Miorail's freshness at one exact size, and "NVIDIA has no liquidity" is
// what a model reaching for English turns that into.
// ---------------------------------------------------------------------------

const FORBIDDEN_V1 = [
  /\bno liquidity\b/i,
  /\billiquid\b/i,
  /\buntradeable\b|\buntradable\b/i,
  /\bcannot be (sold|traded|bought)\b/i,
  /\bbest\b/i,
  /\bcheaper\b/i,
  /\bbetter\b/i,
  /\brecommend/i,
  // The market-existence family. A count of 0 established outcomes says that
  // Miorail holds no fresh answer at ONE size in ONE direction through ITS
  // approved sources; every phrase below turns that into a claim about Base.
  // Kept separate from the words above because these are the ones a reader
  // would accept as a finding rather than as an opinion.
  /\bnobody\b/i,
  /\bno market\b/i,
  /\bno buyer/i,
  /\bno route exists\b/i,
  /\bcannot be exited\b/i,
  /\bnot traded\b/i,
];

function response(over: Record<string, unknown> = {}): MarketRealityResponseV2 {
  return MarketRealityResponseV2Schema.parse({
    schemaVersion: 'market-reality/v2',
    question: {
      chainId: 8453,
      underlyingKey: 'security:isin:US67066G1040',
      direction: 'sell',
      requestedCashAtomic: '1000000000',
      cashAsset: 'USDC',
      cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      cashDecimals: 6,
      destination: 'USDC',
      exactSizeOnly: true,
      baseOnly: true,
    },
    universe: {
      reviewedRepresentationCount: 3,
      positiveSupplyRepresentationCount: 2,
      zeroSupplyRepresentationCount: 1,
      unresolvedSupplyRepresentationCount: 0,
    },
    marketOutcomeCoverage: {
      policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
      eligibleRepresentationCount: 2,
      establishedOutcomeCount: 0,
      status: 'incomplete',
      reason: 'No positive-supply representation has a fresh exact-direction outcome.',
    },
    numericComparisonCoverage: {
      policy: 'fresh_numeric_quotes_same_exact_question_and_normalization',
      eligibleRepresentationCount: 2,
      pricedRepresentationCount: 0,
      status: 'incomplete',
      reason: 'No fresh normalized quote.',
    },
    ranking: {
      status: 'withheld',
      policy: 'withheld_phase_10b8',
      orderedTokenAddresses: [],
      reason: 'coverage_incomplete',
    },
    quoteEvidenceIsExecutionProof: false,
    representations: [],
    assembledAt: '2026-08-30T12:00:00.000Z',
    ...over,
  });
}

describe('Miorail reads its own comparison', () => {
  test('an absent answer is about our freshness, never about the market', () => {
    const summary = marketRealityAgentSummaryV1(response());
    assert.equal(summary.currentComparisonAvailable, false);
    assert.match(summary.summary, /reviewed 3 representations/);
    assert.match(summary.summary, /2 have positive supply/);
    assert.match(summary.summary, /1 has zero observed supply/);
    assert.match(summary.summary, /nothing reliable to compare right now/);
    // "either" takes a singular noun. Production read "either active
    // representations" on the first deploy of this sentence.
    assert.match(summary.summary, /either active representation at/);
    assert.doesNotMatch(summary.summary, /either active representations/);
    // The size and direction travel with the claim: an answer about $1,000 SELL
    // is not an answer about $100,000.
    assert.match(summary.summary, /\$1,000 SELL → USDC/);

    const spoken = [summary.summary, summary.nextSafeStep, summary.notEstablished].join(' ');
    for (const forbidden of FORBIDDEN_V1) {
      // `notEstablished` names these words in order to forbid them, so the
      // scan runs on what Miorail ASSERTS, not on what it warns against.
      assert.doesNotMatch(`${summary.summary} ${summary.nextSafeStep}`, forbidden, String(forbidden));
    }
    assert.match(summary.notEstablished, /not about whether the security trades/);
    assert.ok(spoken.length > 0);
  });

  test('a complete comparison says so, and still chooses nothing', () => {
    const summary = marketRealityAgentSummaryV1(
      response({
        marketOutcomeCoverage: {
          policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
          eligibleRepresentationCount: 2,
          establishedOutcomeCount: 2,
          status: 'complete',
          reason: null,
        },
      }),
    );
    assert.equal(summary.currentComparisonAvailable, true);
    assert.match(summary.summary, /current market answer for all 2/);
    assert.match(summary.nextSafeStep, /does not choose a winner/);
    for (const forbidden of [/\bbest\b/i, /\bcheaper\b/i, /\brecommend/i]) {
      assert.doesNotMatch(summary.nextSafeStep, forbidden);
    }
  });

  test('the summary quotes no cash figure', () => {
    const summary = marketRealityAgentSummaryV1(response());
    // The requested size is the user's own question and may be repeated. Any
    // OTHER money figure would be a term in conversational prose, which is the
    // one place Miorail cannot keep it honest.
    const money = [...summary.summary.matchAll(/\$[\d,]+(?:\.\d+)?/g)].map((match) => match[0]);
    assert.deepEqual(money, ['$1,000']);
  });

  test('nothing outstanding is stated as membership, not as a verdict', () => {
    const summary = marketRealityAgentSummaryV1(response());
    assert.match(summary.summary, /zero observed supply/);
    assert.doesNotMatch(summary.summary, /dead|delisted|worthless/i);
  });

  test('the sentence agrees with itself at every count', () => {
    // Three eligible, none answered: "either" no longer applies.
    const many = marketRealityAgentSummaryV1(
      response({
        universe: {
          reviewedRepresentationCount: 4,
          positiveSupplyRepresentationCount: 3,
          zeroSupplyRepresentationCount: 1,
          unresolvedSupplyRepresentationCount: 0,
        },
        marketOutcomeCoverage: {
          policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
          eligibleRepresentationCount: 3,
          establishedOutcomeCount: 0,
          status: 'incomplete',
          reason: 'none',
        },
      }),
    );
    assert.match(many.summary, /any of the 3 active representations/);

    // Partially answered: the remainder is counted, and agrees in number.
    const partial = marketRealityAgentSummaryV1(
      response({
        marketOutcomeCoverage: {
          policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
          eligibleRepresentationCount: 2,
          establishedOutcomeCount: 1,
          status: 'incomplete',
          reason: 'one missing',
        },
      }),
    );
    assert.match(partial.summary, /1 of 2 active representation at/);
    assert.doesNotMatch(partial.summary, /representations at/);

    // Nothing eligible at all is its own sentence, not a count of zero.
    const none = marketRealityAgentSummaryV1(
      response({
        universe: {
          reviewedRepresentationCount: 1,
          positiveSupplyRepresentationCount: 0,
          zeroSupplyRepresentationCount: 1,
          unresolvedSupplyRepresentationCount: 0,
        },
        marketOutcomeCoverage: {
          policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
          eligibleRepresentationCount: 0,
          establishedOutcomeCount: 0,
          status: 'incomplete',
          reason: 'no eligible representation',
        },
      }),
    );
    assert.match(none.summary, /nothing to compare/);
    assert.doesNotMatch(none.summary, /either/);
  });
});


// ---------------------------------------------------------------------------
// The reading that the freshness sentence alone throws away.
//
// Taken from production on 2026-09-03. A connected Codex asked about $1,000
// SELL → USDC for NVDA and was told, correctly, that Miorail held no fresh
// answer for any of the four active representations. What the payload also
// held, and the summary did not mention: the Coinbase B20 representation had
// priced that exact question at $999.79 four minutes earlier, and two others
// could not be sized at all. "No fresh answer" is the same sentence for a
// market that just priced and one that was never reached.
// ---------------------------------------------------------------------------

const OBSERVED_AT_V1 = '2026-09-03T18:51:03.000Z';

function representation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tokenAddress: '0xb20000000000000000000078ee7ce2fe4908108c',
    issuerId: 'coinbase',
    issuerInstrumentKey: 'coinbase:b20_address:0xb20000000000000000000078ee7ce2fe4908108c',
    representationKind: 'b20_asset',
    supply: {
      state: 'positive_supply',
      totalSupplyAtomic: '1289408020000',
      decimals: 8,
      normalization: 'raw_erc20_total_supply',
      blockNumber: '50829695',
      blockHash: '0x53deb892b799db0310012c90e6dc20db8700d18cba93191c37f926118ec2b223',
      observedAt: '2026-09-03T15:18:58.350Z',
      evidenceHash: '0x3c3fc05180baf048e579d8db1e346845ade7ac005d2a393ec76e5d5177183c3c',
      source: 'erc20_total_supply',
      readOutcome: 'success',
      fresh: true,
      reason: null,
    },
    status: 'not_measured',
    routePolicyKey: '0x43e565deb2d53a6bf74b607d9ce08bd77da251cc873dd1cd362ab2dc76b0c017',
    exactTestedTokenAtomic: null,
    normalizedExposureAtomic: null,
    normalizedExposureDecimals: null,
    normalization: 'not_established',
    returnedCashAtomic: null,
    effectivePriceAtomic: null,
    effectivePriceDecimals: null,
    premiumDiscountBps: null,
    reference: {
        "status": "fresh",
        "session": "regular_hours",
        "marketSession": "regular_hours",
        "publicationMode": "live_reference",
        "valueAtomic": "23016000000",
        "decimals": 8,
        "observedAt": "2026-09-03T18:55:38.619Z",
        "referenceUpdatedAt": "2026-09-03T17:52:55.000Z",
        "freshness": "fresh",
        "referenceSource": "https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base.md",
        "referenceAddress": "0x04689a41629776563e6822f76f2e57d148d28513",
        "calendar": {
              "key": "us_equities_core_2026_v1",
              "sourceUrls": [
                    "https://www.nyse.com/trade/hours-calendars",
                    "https://www.nasdaq.com/market-activity/stock-market-holiday-schedule"
              ],
              "timeZone": "America/New_York",
              "localDate": "2026-09-03",
              "regularOpenMinute": 570,
              "regularCloseMinute": 960,
              "publicationSessionLocalDate": "2026-09-03",
              "publicationSessionOpenMinute": 570,
              "publicationSessionCloseMinute": 960
        },
        "evidence": {
              "kind": "chainlink_feed",
              "source": "chainlink_v3_proxy_total_return",
              "blockNumber": "50836195",
              "blockHash": "0x430f3d050b91d136c321d0cde757c38c96eb69a5c7756b3264fb6a42c77469c3",
              "targetAddress": "0x04689a41629776563e6822f76f2e57d148d28513",
              "evidenceHash": "0x78fc0eaa65afecdc84dbb5ef063fd0ba8df37aa25b5bd9ee5a24adeb32e5b7c3"
        },
        "comparable": false,
        "reasonCode": "reviewed_calendar_regular_hours",
        "reason": "The explicit observation time falls inside the reviewed core trading session."
  },
    basis: {
      policy: 'exact_normalized_price_same_quote_window_reviewed_publication_v1',
      status: 'withheld',
      kind: 'withheld',
      premiumDiscountBps: null,
      reasonCode: 'expired_quote',
      reason: 'The exact executable quote is no longer open.',
    },
    sources: [],
    observedAt: null,
    expiresAt: null,
    liveness: 'history_only',
    lastObservation: {
      source: 'kyberswap',
      status: 'quoted',
      errorCode: null,
      observedAt: OBSERVED_AT_V1,
      expiresAt: '2026-09-03T18:51:23.000Z',
      returnedCashAtomic: '999788541',
      open: false,
    },
    ...over,
  };
}

describe('a lapsed quote is not an unreached market', () => {
  const nvda = () =>
    response({
      assembledAt: '2026-09-03T18:55:00.000Z',
      universe: {
        reviewedRepresentationCount: 5,
        positiveSupplyRepresentationCount: 4,
        zeroSupplyRepresentationCount: 1,
        unresolvedSupplyRepresentationCount: 0,
      },
      marketOutcomeCoverage: {
        policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
        eligibleRepresentationCount: 4,
        establishedOutcomeCount: 0,
        status: 'incomplete',
        reason: 'No positive-supply representation has a fresh exact-direction outcome.',
      },
      representations: [
        representation(),
        representation({
          tokenAddress: '0x7e8101a1c322d394b3961498c7d40d2dfa94c392',
          issuerId: 'backed',
          issuerInstrumentKey: 'backed:base_address:0x7e8101a1c322d394b3961498c7d40d2dfa94c392',
          representationKind: 'non_rebasing_erc4626_wrapper',
          lastObservation: {
            source: 'kyberswap',
            status: 'measurement_failed',
            errorCode: 'provider_unavailable',
            observedAt: OBSERVED_AT_V1,
            expiresAt: '2026-09-03T18:51:23.000Z',
            returnedCashAtomic: null,
            open: false,
          },
        }),
        representation({
          tokenAddress: '0x92ecf64fdb76e60b76d78a29ad4bf9d38b7b1b97',
          issuerId: 'dinari',
          issuerInstrumentKey: 'dinari:base_address:0x92ecf64fdb76e60b76d78a29ad4bf9d38b7b1b97',
          representationKind: 'dinari_dshare',
          lastObservation: {
            source: 'kyberswap',
            status: 'unsized',
            errorCode: null,
            observedAt: OBSERVED_AT_V1,
            expiresAt: '2026-09-03T18:51:23.000Z',
            returnedCashAtomic: null,
            open: false,
          },
        }),
        representation({
          tokenAddress: '0xa34c5e0abe843e10461e2c9586ea03e55dbcc495',
          issuerId: 'backed',
          issuerInstrumentKey: 'backed:base_address:0xa34c5e0abe843e10461e2c9586ea03e55dbcc495',
          representationKind: 'rebasing_erc20',
          lastObservation: {
            source: 'kyberswap',
            status: 'unsized',
            errorCode: null,
            observedAt: OBSERVED_AT_V1,
            expiresAt: '2026-09-03T18:51:23.000Z',
            returnedCashAtomic: null,
            open: false,
          },
        }),
        representation({
          tokenAddress: '0xf37e92704df29338dd09759f322fd09868dd25cc',
          issuerId: 'dinari',
          issuerInstrumentKey: 'dinari:base_address:0xf37e92704df29338dd09759f322fd09868dd25cc',
          representationKind: 'dinari_dshare',
          supply: {
            state: 'zero_supply',
            totalSupplyAtomic: '0',
            decimals: 18,
            normalization: 'raw_erc20_total_supply',
            blockNumber: '50829695',
            blockHash: '0x53deb892b799db0310012c90e6dc20db8700d18cba93191c37f926118ec2b223',
            observedAt: '2026-09-03T15:18:58.350Z',
            evidenceHash:
              '0x3c3fc05180baf048e579d8db1e346845ade7ac005d2a393ec76e5d5177183c3c',
            source: 'erc20_total_supply',
            readOutcome: 'success',
            fresh: true,
            reason: null,
          },
          liveness: 'never_measured',
          lastObservation: null,
        }),
      ],
    });

  test('the freshness sentence is followed by what the last look found', () => {
    const summary = marketRealityAgentSummaryV1(nvda());
    assert.equal(summary.currentComparisonAvailable, false);
    // Still says the true thing about freshness first.
    assert.match(summary.summary, /does not currently hold a fresh established market answer/);
    // And then the thing it used to leave out.
    assert.match(summary.summary, /The last completed look at these 4, 4 minutes ago/);
    assert.match(summary.summary, /1 priced/);
    assert.match(summary.summary, /2 could not be sized/);
    assert.match(summary.summary, /1 measurement failed/);
    assert.match(summary.summary, /history, not a current answer/);
  });

  test('the zero-supply row is not counted among the four', () => {
    // It is outside the comparison by supply, not by freshness, and folding it
    // into "never measured" would put a contract with nothing outstanding into
    // a sentence about market coverage.
    const summary = marketRealityAgentSummaryV1(nvda());
    // The closing clause names the phrase in order to draw the distinction, so
    // what is forbidden is a COUNT of never-measured rows, not the words.
    assert.doesNotMatch(summary.summary, /\d+ never measured/);
    assert.match(summary.summary, /look at these 4/);
  });

  test('the issuer is named once per row', () => {
    // Production read "Dinari Dinari dShare": the issuer label and the
    // representation kind both carried the issuer's name.
    const summary = marketRealityAgentSummaryV1(nvda());
    for (const row of summary.representations) {
      assert.doesNotMatch(row.line, /\b(Dinari|Backed|Coinbase)\b.*\b\1\b/);
    }
  });

  test('each row carries its own last look, with its age', () => {
    const summary = marketRealityAgentSummaryV1(nvda());
    const priced = summary.representations.find(
      (row) => row.tokenAddress === '0xb20000000000000000000078ee7ce2fe4908108c',
    );
    assert.match(priced!.line, /last look priced, 4 minutes ago/);
    const zero = summary.representations.find(
      (row) => row.tokenAddress === '0xf37e92704df29338dd09759f322fd09868dd25cc',
    );
    // Zero supply, never measured: the row says the supply state and claims no
    // measurement history it does not have.
    assert.match(zero!.line, /zero observed supply/);
    assert.doesNotMatch(zero!.line, /last look/);
  });

  test('no cash figure reaches the summary, however recent the look was', () => {
    // The last observation carries $999.79. It stays out of the prose: a
    // number in a sentence is a number nobody can expire.
    const summary = marketRealityAgentSummaryV1(nvda());
    const spoken = [summary.summary, summary.nextSafeStep, ...summary.representations.map((row) => row.line)].join(' ');
    assert.doesNotMatch(spoken, /999/);
    assert.doesNotMatch(spoken, /\$9/);
  });

  test('a corpus nobody has reached yet says that instead', () => {
    const never = marketRealityAgentSummaryV1(
      response({
        assembledAt: '2026-09-03T18:55:00.000Z',
        universe: {
          reviewedRepresentationCount: 1,
          positiveSupplyRepresentationCount: 1,
          zeroSupplyRepresentationCount: 0,
          unresolvedSupplyRepresentationCount: 0,
        },
        marketOutcomeCoverage: {
          policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
          eligibleRepresentationCount: 1,
          establishedOutcomeCount: 0,
          status: 'incomplete',
          reason: 'never measured',
        },
        representations: [representation({ liveness: 'never_measured', lastObservation: null })],
      }),
    );
    assert.match(never.summary, /never completed a look at this representation/);
    assert.doesNotMatch(never.summary, /The last completed look/);
  });
});

// ---------------------------------------------------------------------------
// The size in the summary is the size that was asked about.
//
// `moneyV1` kept only whole-dollar digits, so every sub-dollar question read as
// `$0` and every question with cents lost them. This is the one string in the
// summary that goes into an assistant's prose — the module already forbids
// quoting a cash FIGURE for that reason, and quoting the user's own SIZE wrongly
// is the same failure pointed at the question instead of the answer.
//
// Caught on production while preparing a $0.10 run: the tool answered
// "no answer at $0 BUY → USDC" for a question about ten cents.
// ---------------------------------------------------------------------------
describe('the question names the size the caller actually asked about', () => {
  const at = (requestedCashAtomic: string) => {
    const base = response();
    return marketRealityAgentSummaryV1({
      ...base,
      question: { ...base.question, requestedCashAtomic },
    }).summary;
  };

  test('a sub-dollar size is never rendered as zero', () => {
    const summary = at('100000');
    assert.match(summary, /\$0\.1\b/);
    assert.doesNotMatch(summary, /\$0 /);
  });

  test('cents survive', () => {
    assert.match(at('1234560000'), /\$1,234\.56\b/);
  });

  test('a whole-dollar size keeps reading as a whole dollar', () => {
    // Trailing zeros would be a precision this question never had.
    assert.match(at('100000000'), /\$100 /);
    assert.match(at('1000000000'), /\$1,000 /);
    assert.doesNotMatch(at('100000000'), /\$100\.0/);
  });
});
