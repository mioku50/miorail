import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import {
  adaptersFromStatusV1,
  candidatesFromProjectionV1,
  comparisonClaimV1,
  deriveAdapterRowsV1,
  providerDiagnosticRowsV1,
  providerFailureViewV1,
  providerFailuresFromProjectionV1,
  shortfallNoticeFromProjectionV1,
  swapDiagnosticReasonV1,
  swapProviderDisplayNameV1,
  type RoutePlanProjectionV1,
} from '../src/console';

// ---------------------------------------------------------------------------
// T67E §3 / §5.
//
// The first describe block is a regression suite for a field that never
// existed. Everything below it is the behaviour the fix has to keep.
// ---------------------------------------------------------------------------

const here = path.dirname(url.fileURLToPath(import.meta.url));
const consoleDir = path.join(here, '..', 'src', 'console');

function route(provider: string, output: string, ageSeconds = 4) {
  return {
    candidateHash: `0x${provider}`,
    provider: { displayName: provider },
    expectedOutput: { amountDecimal: output, asset: { symbol: 'ETH', address: null } },
    minimumOutput: { amountDecimal: output },
    estimatedGas: { gasUnits: '150000', estimatedCostUsd: '0.01' },
    priceImpact: { percent: '0.10' },
    slippage: { percent: '0.50' },
    quoteAgeSeconds: ageSeconds,
    callCount: 1,
    approvalCount: 1,
    pathScore: { dimensions: [] },
    evidence: {},
  };
}

function projection(overrides: Partial<RoutePlanProjectionV1> = {}): RoutePlanProjectionV1 {
  return {
    outcome: 'ready',
    goalSummary: 'swap 1 ETH to USDC',
    optimizationMode: 'best_net_result',
    routeCardHash: '0xcard',
    routeRunId: 'run-1',
    recommendedRoute: null,
    availableRoutes: [],
    pathScore: null,
    evidenceSummary: {},
    providerFailures: [],
    expiresAt: null,
    ...overrides,
  } as RoutePlanProjectionV1;
}

describe('the field the console read never existed on the wire', () => {
  test('a failure is named by `provider`, which is what the schema sends', () => {
    // SwapAdapterFailureV1 is `{ outcome, provider, errorCode, retryable }` and
    // is `.strict()`. The console read `adapterId`, so every failed provider
    // rendered as the string "undefined" — in the candidate table, the evidence
    // table, the adapter rail and the shortfall notice.
    const view = providerFailureViewV1({
      provider: 'kyberswap',
      errorCode: 'provider_http_error',
      outcome: 'unavailable',
      retryable: true,
    });
    assert.equal(view.providerName, 'KyberSwap');
    assert.ok(!view.message.includes('undefined'));
  });

  test('no console source reads `.adapterId` any more', () => {
    // A source-level guard, because the defect was invisible to every unit
    // test: the code compiled, rendered, and produced "undefined" at runtime.
    const offenders: string[] = [];
    for (const name of readdirSync(consoleDir)) {
      if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
      const source = readFileSync(path.join(consoleDir, name), 'utf8');
      // Comments explaining the defect are allowed; a property read is not.
      const stripped = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/\.adapterId\b/.test(stripped)) offenders.push(name);
    }
    assert.deepEqual(offenders, []);
  });

  test('the shortfall notice names providers rather than undefined', () => {
    const notice = shortfallNoticeFromProjectionV1(
      projection({
        availableRoutes: [route('Aerodrome', '0.31')],
        providerFailures: [{ provider: 'uniswap', errorCode: 'provider_timeout', retryable: true }],
      }),
    );
    assert.ok(notice);
    assert.ok(notice.includes('Uniswap'), notice);
    assert.ok(!notice.includes('undefined'), notice);
  });
});

describe('the reason taxonomy', () => {
  test('every adapter error code maps to a safe reason', () => {
    // The full set `lib/swap-adapters` can emit. A code that falls through to
    // `unknown` reaches a user as "reported no reason", which is only honest
    // when it is true.
    const emitted = [
      'provider_asset_mismatch', 'provider_chain_mismatch', 'provider_expired_quote',
      'provider_http_error', 'provider_invalid_schema', 'provider_no_route',
      'provider_not_configured', 'provider_rate_limited', 'provider_router_mismatch',
      'provider_timeout', 'provider_unreachable', 'provider_unsupported_intent',
    ];
    for (const code of emitted) {
      assert.notEqual(swapDiagnosticReasonV1(code), 'unknown', `${code} must map to a safe reason`);
    }
  });

  test('engine validation refusals map without an entry each', () => {
    assert.equal(swapDiagnosticReasonV1('engine_future_quote_observation'), 'provider_invalid_schema');
    assert.equal(swapDiagnosticReasonV1('engine_a_check_added_next_year'), 'provider_invalid_schema');
  });

  test('an unrecognised code does not invent a cause', () => {
    const view = providerFailureViewV1({ provider: 'uniswap', errorCode: 'something_new' });
    assert.equal(view.reason, 'unknown');
    assert.match(view.message, /reported no reason/);
  });

  test('a router mismatch is a preflight failure, not a bad schema', () => {
    // It is the one refusal that is about the CONTRACT the calls would target,
    // which is a safety property rather than a data-quality one.
    const view = providerFailureViewV1({ provider: 'aerodrome', errorCode: 'provider_router_mismatch' });
    assert.equal(view.reason, 'provider_preflight_failed');
    assert.match(view.message, /could not verify the router on Base/);
  });

  test('an unknown provider id is shown, not hidden', () => {
    assert.equal(swapProviderDisplayNameV1('newdex'), 'newdex');
  });
});

describe('a failure message says what still works', () => {
  test('one survivor is named', () => {
    const view = providerFailureViewV1(
      { provider: 'kyberswap', errorCode: 'provider_timeout' },
      ['Aerodrome'],
    );
    assert.equal(view.message, 'KyberSwap did not answer before the timeout. Aerodrome comparison still completed.');
  });

  test('with nothing left, no survival is claimed', () => {
    const view = providerFailureViewV1({ provider: 'kyberswap', errorCode: 'provider_timeout' }, []);
    // The clause is absent rather than false. This is the whole reason the
    // survivor list is threaded through instead of assumed.
    assert.equal(view.message, 'KyberSwap did not answer before the timeout.');
  });

  test('the server’s own retryable flag wins over the default', () => {
    // The adapter knows more about its provider than this table does.
    const view = providerFailureViewV1({
      provider: 'uniswap',
      errorCode: 'provider_timeout',
      retryable: false,
    });
    assert.equal(view.retryable, false);
  });

  test('a not-configured provider is not offered a retry', () => {
    const view = providerFailureViewV1({ provider: 'uniswap', errorCode: 'provider_not_configured' });
    assert.equal(view.retryable, false);
    assert.match(view.message, /not configured on this server/);
  });
});

describe('§3.4 — what a comparison may claim', () => {
  test('one quotable candidate is not a comparison', () => {
    const claim = comparisonClaimV1(1);
    assert.equal(claim.claim, 'single_route');
    assert.equal(claim.headline, 'Single route available · no comparative recommendation');
  });

  test('two or more earns a comparative recommendation', () => {
    assert.equal(comparisonClaimV1(2).claim, 'comparative');
    assert.equal(comparisonClaimV1(2).headline, null);
  });

  test('none says so plainly', () => {
    assert.equal(comparisonClaimV1(0).claim, 'none');
  });

  test('a lone route is never called the best one', () => {
    const rows = candidatesFromProjectionV1(
      projection({
        availableRoutes: [route('Aerodrome', '0.31')],
        recommendedRoute: route('Aerodrome', '0.31'),
      }) as RoutePlanProjectionV1,
    );
    const chosen = rows.find((row) => row.state === 'chosen');
    assert.ok(chosen);
    assert.ok(!/best/i.test(chosen.why), chosen.why);
    assert.match(chosen.why, /Only route that produced a quote/);
  });

  test('with two routes the superlative returns', () => {
    const rows = candidatesFromProjectionV1(
      projection({
        availableRoutes: [route('Aerodrome', '0.31'), route('Uniswap', '0.30')],
        recommendedRoute: route('Aerodrome', '0.31'),
      }) as RoutePlanProjectionV1,
    );
    assert.match(rows.find((row) => row.state === 'chosen')!.why, /Best net result/);
  });
});

describe('§3.4 — every registered adapter keeps a row', () => {
  const registered = ['uniswap', 'kyberswap', 'aerodrome'];

  test('an adapter that was never asked says so, and borrows no error', () => {
    const rows = providerDiagnosticRowsV1(
      projection({
        availableRoutes: [route('Aerodrome', '0.31')],
        providerFailures: [{ provider: 'uniswap', errorCode: 'provider_timeout', retryable: true }],
      }),
      registered,
    );
    assert.equal(rows.length, 3);
    const kyber = rows.find((row) => row.provider === 'KyberSwap');
    assert.ok(kyber);
    assert.equal(kyber.result, 'not asked');
    assert.equal(kyber.reason, 'not part of this run');
  });

  test('a failed row carries no fabricated age', () => {
    const rows = providerDiagnosticRowsV1(
      projection({ providerFailures: [{ provider: 'uniswap', errorCode: 'provider_timeout' }] }),
      [],
    );
    // "0s" would read as an instant answer. Nothing was measured.
    assert.equal(rows[0]!.age, '—');
  });

  test('a quoted row reports the measured quote age', () => {
    const rows = providerDiagnosticRowsV1(
      projection({ availableRoutes: [route('Aerodrome', '0.31', 7)] }),
      [],
    );
    assert.equal(rows[0]!.age, '7s');
    assert.equal(rows[0]!.result, 'quoted');
  });

  test('a provider that both quoted and failed is not double-counted', () => {
    const rows = providerDiagnosticRowsV1(
      projection({ availableRoutes: [route('Uniswap', '0.30')] }),
      registered,
    );
    assert.equal(rows.filter((row) => row.provider === 'Uniswap').length, 1);
  });
});

describe('§5 — the adapter rail is a source of truth', () => {
  const status = {
    productMigration: {
      routeIntelligenceV1: true, paidIntelligence: true, earnRouteV1: true,
      commerceRouteV1: true, nftRouteV1: true, privateAiRouteV1: false,
    },
  };

  test('a run refines the rail instead of replacing it', () => {
    // This used to return only the run's own adapters, so during a swap
    // comparison Moonwell, Bitrefill, OpenSea and o1 vanished from a panel
    // called "Route adapters" — exactly when a user would consult it.
    const rows = adaptersFromStatusV1(status, [{ name: 'Aerodrome' }], [{ name: 'Uniswap' }]);
    const names = rows.map((row) => row.name);
    for (const expected of ['Uniswap', 'KyberSwap', 'Aerodrome', 'Moonwell', 'Bitrefill', 'OpenSea', 'o1.exchange']) {
      assert.ok(names.includes(expected), `${expected} disappeared from the rail`);
    }
  });

  test('an adapter that failed this run is degraded, not disabled', () => {
    const rows = adaptersFromStatusV1(status, [{ name: 'Aerodrome' }], [
      { name: 'Uniswap', reason: 'invalid schema' },
    ]);
    const uniswap = rows.find((row) => row.name === 'Uniswap');
    assert.equal(uniswap?.state, 'degraded');
    assert.equal(uniswap?.detail, 'invalid schema');
    assert.equal(rows.find((row) => row.name === 'Aerodrome')?.state, 'live');
  });

  test('a degraded row states what failed on the same line', () => {
    const { rows } = deriveAdapterRowsV1([
      { name: 'KyberSwap', state: 'degraded', detail: 'last request failed' },
    ]);
    assert.equal(rows[0]!.label, 'degraded · last request failed');
  });

  test('a switched-off family stays disabled during a swap run', () => {
    const rows = adaptersFromStatusV1(status, [{ name: 'Aerodrome' }], []);
    assert.equal(rows.find((row) => row.name === 'Venice')?.state, 'disabled');
  });

  test('blocked is out of the ready NUMERATOR, and stays in the rail', () => {
    // o1.exchange is not an integration waiting for a switch — its protocol
    // cannot be reached from Miorail's execution path at all. It must never be
    // counted as usable. It does stay in the denominator: it is listed on the
    // rail, and a count that disagreed with the rows below it would be worse
    // than one that simply says 2 of 3 are usable.
    const { rows, summary } = deriveAdapterRowsV1([
      { name: 'Uniswap', state: 'live' },
      { name: 'Aerodrome', state: 'live' },
      { name: 'o1.exchange', state: 'blocked' },
    ]);
    assert.equal(summary, '2 / 3');
    assert.equal(rows.find((row) => row.name === 'o1.exchange')?.usable, false);
  });

  test('an adapter that answered but is not in the gate table still gets a row', () => {
    const rows = adaptersFromStatusV1(status, [{ name: 'SomeNewDex' }], []);
    assert.ok(rows.some((row) => row.name === 'SomeNewDex' && row.state === 'live'));
  });
});

describe('the two surfaces cannot disagree', () => {
  test('failures come from one helper, so both consoles read one answer', () => {
    const model = projection({
      availableRoutes: [route('Aerodrome', '0.31')],
      providerFailures: [
        { provider: 'uniswap', errorCode: 'provider_invalid_schema', retryable: false },
        { provider: 'kyberswap', errorCode: 'provider_http_error', retryable: true },
      ],
    });
    const views = providerFailuresFromProjectionV1(model);
    assert.deepEqual(views.map((view) => view.providerName), ['Uniswap', 'KyberSwap']);
    assert.match(views[0]!.message, /could not verify/);
    assert.match(views[0]!.message, /Aerodrome comparison still completed/);
  });
});
