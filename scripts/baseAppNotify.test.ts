import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

import {
  InMemoryBaseAppNotificationRepositoryV1,
  type RadarEventNoticeRowV1,
  type RwaSignalRowV1,
} from '@mioagent/route-storage';

import {
  BASE_APP_MESSAGE_MAX_V1,
  BASE_APP_NOTIFY_ENDPOINT_V1,
  BASE_APP_TITLE_MAX_V1,
  BaseAppNotifyErrorV1,
  baseAppNotifyConfigV1,
  clipV1,
  createBaseAppNotifyClientV1,
  multiplierV1,
  noticeForRadarEventV1,
  noticeForSignalV1,
  percentFromBpsV1,
  planBaseAppNotificationsV1,
  planWeeklySummaryV1,
  ppmPercentV1,
  holderMultiplierNoticeV1,
  multiplierChangePpmV1,
  runBaseAppNotifyV1,
  weeklyNoticeV1,
  weeklySummaryDueV1,
  type WeeklySummaryV1,
  stockPathV1,
  summaryNoticeV1,
  usdV1,
  walletOfUserIdV1,
  type BaseAppNotifyClientV1,
  type NamesOfV1,
} from './baseAppNotify.js';

// ---------------------------------------------------------------------------
// Base App notifications: what is said, to whom, how often — and that the key
// never leaves the one header it belongs in.
// ---------------------------------------------------------------------------

const KEY = 'test-key-0123456789abcdef';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const MSTR = '0xb200000000000000000000d8d64a0cbc00b3cc31';
const LOOKALIKE = '0x1234567890123456789012345678901234567890';
const ME = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
const YOU = '0x1111111111111111111111111111111111111111';
const THEM = '0x2222222222222222222222222222222222222222';
const NOW = new Date('2026-09-23T18:30:00.000Z');
/** When the notifier first ran: before every row the tests write. */
const OPENED = new Date('2026-09-23T18:00:00.000Z');

const names: NamesOfV1 = (address) =>
  address === NVDA
    ? { symbol: 'NVDA', representation: 'NVDAc' }
    : address === MSTR
      ? { symbol: 'MSTR', representation: 'MSTRc' }
      : null;

let nextSignalId = 100;
function signal(kind: string, facts: Record<string, unknown>, over: Partial<RwaSignalRowV1> = {}): RwaSignalRowV1 {
  nextSignalId += 1;
  return {
    signalId: String(nextSignalId),
    kind: kind as RwaSignalRowV1['kind'],
    chainId: 8453,
    subjectAddress: NVDA,
    officialAddress: null,
    occurredAt: '2026-09-23T18:20:00.000Z',
    recordedAt: '2026-09-23T18:21:00.000Z',
    facts,
    ...over,
  };
}

const corporateAction = (over: Partial<RwaSignalRowV1> = {}) =>
  signal(
    'official_asset_corporate_action_announced',
    {
      event: 'announcement',
      announcementId: null,
      description: null,
      uri: null,
      payloadState: 'topic_only',
      transactionHash: `0x${'cd'.repeat(32)}`,
      blockNumber: '51310619',
    },
    over,
  );

const exitCostChanged = (over: Partial<RwaSignalRowV1> = {}) =>
  signal(
    'official_asset_cash_exit_changed',
    {
      ticker: 'MSTRc',
      changeBps: '68',
      destination: 'USDC',
      thresholdBps: 50,
      approvedSources: ['kyberswap'],
      roundTripCostBps: '218',
      requestedCashAtomic: '100000000000',
      previousRoundTripCostBps: '150',
    },
    { subjectAddress: MSTR, ...over },
  );

function radarEvent(over: Partial<RadarEventNoticeRowV1> = {}): RadarEventNoticeRowV1 {
  return {
    eventId: `0x${'e1'.repeat(32)}`,
    recordedAt: '2026-09-23T18:22:00.000Z',
    occurredAt: '2026-09-23T18:22:00.000Z',
    kind: 'sell_exit_cost_changed',
    tokenAddress: NVDA,
    facts: {
      changeBps: '40',
      previousExitCostBps: '31',
      exitCostBps: '71',
      previousCashBackAtomic: '996900000',
      cashBackAtomic: '992900000',
    },
    userId: `eip155:8453:${ME}`,
    direction: 'sell',
    requestedCashAtomic: '1000000000',
    destination: 'USDC',
    ...over,
  };
}

describe('configuration', () => {
  test('reads the key under the name the operator gave it, and nothing is on without it', () => {
    assert.deepEqual(baseAppNotifyConfigV1({ BASE_DEV_API: KEY } as NodeJS.ProcessEnv), {
      apiKey: KEY,
      appUrl: 'https://miorail.xyz',
    });
    assert.equal(baseAppNotifyConfigV1({ BASE_DEV_API: `"${KEY}"` } as NodeJS.ProcessEnv)?.apiKey, KEY);
    assert.equal(baseAppNotifyConfigV1({ BASE_DASHBOARD_API_KEY: KEY } as NodeJS.ProcessEnv)?.apiKey, KEY);
    assert.equal(baseAppNotifyConfigV1({} as NodeJS.ProcessEnv), null);
    assert.equal(baseAppNotifyConfigV1({ BASE_DEV_API: 'has spaces in it' } as NodeJS.ProcessEnv), null);
  });

  test('a switch turns it off with the key in place, and the app URL must be ours to name', () => {
    assert.equal(
      baseAppNotifyConfigV1({ BASE_DEV_API: KEY, MIORAIL_BASE_APP_NOTIFICATIONS_V1: 'off' } as NodeJS.ProcessEnv),
      null,
    );
    assert.equal(
      baseAppNotifyConfigV1({ BASE_DEV_API: KEY, MIORAIL_BASE_APP_URL: 'http://miorail.xyz' } as NodeJS.ProcessEnv),
      null,
    );
    assert.equal(
      baseAppNotifyConfigV1({ BASE_DEV_API: KEY, MIORAIL_BASE_APP_URL: 'https://miorail.xyz/' } as NodeJS.ProcessEnv)?.appUrl,
      'https://miorail.xyz',
    );
  });
});

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(answers: ((call: Call) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const answer = answers.shift();
    if (!answer) throw new Error('unexpected request');
    return answer(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the Base Dashboard client', () => {
  test('lists opted-in wallets page by page, lowercased, with the key in its header only', async () => {
    const { fetchImpl, calls } = fakeFetch([
      () =>
        json(200, {
          success: true,
          users: [
            { address: '0x4DE27EAD5A3C9AEB58C7F812178DDDE282670D70', notificationsEnabled: true },
            { address: YOU, notificationsEnabled: false },
          ],
          nextCursor: 'page-2',
        }),
      () => json(200, { success: true, users: [{ address: THEM, notificationsEnabled: true }] }),
    ]);
    const client = createBaseAppNotifyClientV1({
      config: { apiKey: KEY, appUrl: 'https://miorail.xyz' },
      fetch: fetchImpl,
      sleep: async () => {},
    });
    assert.deepEqual([...(await client.enabledWallets())].sort(), [ME, THEM].sort());
    assert.equal(calls.length, 2);
    const first = new URL(calls[0]!.url);
    assert.equal(`${first.origin}${first.pathname}`, `${BASE_APP_NOTIFY_ENDPOINT_V1}/app/users`);
    assert.equal(first.searchParams.get('app_url'), 'https://miorail.xyz');
    assert.equal(first.searchParams.get('notification_enabled'), 'true');
    assert.equal(new URL(calls[1]!.url).searchParams.get('cursor'), 'page-2');
    assert.equal(calls[0]!.headers['x-api-key'], KEY);
    assert.doesNotMatch(calls[0]!.url, new RegExp(KEY));
  });

  test('sends one push to many wallets and counts, without naming, who did not get it', async () => {
    const { fetchImpl, calls } = fakeFetch([
      () =>
        json(200, {
          success: false,
          results: [
            { walletAddress: ME, sent: true },
            { walletAddress: YOU, sent: false, failureReason: 'user has not saved this app' },
            { walletAddress: THEM, sent: false, failureReason: 'user has notifications disabled' },
          ],
          sentCount: 1,
          failedCount: 2,
        }),
    ]);
    const client = createBaseAppNotifyClientV1({
      config: { apiKey: KEY, appUrl: 'https://miorail.xyz' },
      fetch: fetchImpl,
      sleep: async () => {},
    });
    const result = await client.send({ wallets: [ME, YOU, THEM], title: 'NVDA: corporate action', message: 'm', targetPath: '/stocks/nvda' });
    assert.deepEqual(result, { sent: [ME], failed: { notSaved: 1, disabled: 1, other: 0 } });
    assert.equal(calls[0]!.url, `${BASE_APP_NOTIFY_ENDPOINT_V1}/send`);
    assert.deepEqual(calls[0]!.body, {
      app_url: 'https://miorail.xyz',
      wallet_addresses: [ME, YOU, THEM],
      title: 'NVDA: corporate action',
      message: 'm',
      target_path: '/stocks/nvda',
    });
  });

  test('a refusal is a status code, marked worth retrying or not, and never carries the key', async () => {
    const statuses = [401, 403, 400, 429, 503];
    const { fetchImpl } = fakeFetch(statuses.map((status) => () => json(status, { message: `invalid API key ${KEY}` })));
    const client = createBaseAppNotifyClientV1({
      config: { apiKey: KEY, appUrl: 'https://miorail.xyz' },
      fetch: fetchImpl,
      sleep: async () => {},
    });
    for (const status of statuses) {
      const error = await client.enabledWallets().then(
        () => null,
        (cause: unknown) => cause as BaseAppNotifyErrorV1,
      );
      assert.ok(error instanceof BaseAppNotifyErrorV1);
      assert.equal(error.status, status);
      assert.equal(error.transient, status === 429 || status >= 500, String(status));
      assert.doesNotMatch(`${error.message} ${error.stack}`, new RegExp(KEY));
    }
    const unreachable = createBaseAppNotifyClientV1({
      config: { apiKey: KEY, appUrl: 'https://miorail.xyz' },
      fetch: (async () => {
        throw Object.assign(new Error(`connect ECONNREFUSED ${KEY}`), { name: 'TypeError' });
      }) as unknown as typeof fetch,
      sleep: async () => {},
    });
    const error = await unreachable.enabledWallets().then(
      () => null,
      (cause: unknown) => cause as BaseAppNotifyErrorV1,
    );
    assert.ok(error instanceof BaseAppNotifyErrorV1);
    assert.equal(error.transient, true);
    assert.doesNotMatch(error.message, new RegExp(KEY));
  });

  test('keeps its requests apart, because Base counts twenty a minute', async () => {
    let clock = 1_000;
    const waits: number[] = [];
    const { fetchImpl } = fakeFetch([() => json(200, { users: [] }), () => json(200, { users: [] })]);
    const client = createBaseAppNotifyClientV1({
      config: { apiKey: KEY, appUrl: 'https://miorail.xyz' },
      fetch: fetchImpl,
      clock: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      gapMs: 3_500,
    });
    await client.enabledWallets();
    clock += 500;
    await client.enabledWallets();
    assert.deepEqual(waits, [3_000]);
  });
});

describe('what a push says', () => {
  test('numbers are written for a phone', () => {
    assert.equal(usdV1('100000000000'), '$100,000');
    assert.equal(usdV1('12500000'), '$12.50');
    assert.equal(percentFromBpsV1('218'), '2.18%');
    assert.equal(percentFromBpsV1('-5'), '−0.05%');
    assert.equal(multiplierV1('1000377118676784179'), '1.000377');
    assert.equal(multiplierV1('1000000000000000000'), '1');
    assert.equal(stockPathV1('NVDA'), '/stocks/nvda');
    assert.equal(stockPathV1('BRK.B'), '/stocks/brk.b');
    assert.equal(stockPathV1(null), '/stocks');
    assert.equal(stockPathV1('../etc'), '/stocks');
    assert.equal(clipV1('x'.repeat(40), 30).length, 30);
    assert.ok(clipV1('x'.repeat(40), 30).endsWith('…'));
  });

  test('an exit-cost move names the size, both costs and which way it went', () => {
    const notice = noticeForSignalV1(exitCostChanged(), names)!;
    assert.equal(notice.title, 'MSTR: exit cost up');
    assert.equal(
      notice.message,
      'Round trip at $100,000 (USDC → MSTRc → USDC) now costs 2.18%, was 1.50%. Measured on Base.',
    );
    assert.equal(notice.targetPath, '/stocks/mstr');
  });

  test('issuer events say what the contract did, and nothing it did not', () => {
    const action = noticeForSignalV1(corporateAction(), names)!;
    assert.equal(action.title, 'NVDA: corporate action');
    assert.equal(action.message, 'The NVDAc contract posted a corporate-action announcement on Base.');
    const changed = noticeForSignalV1(
      signal('official_asset_multiplier_changed', {
        event: 'multiplier_updated',
        multiplierWad: '1000377118676784179',
        payloadState: 'decoded',
        transactionHash: `0x${'cd'.repeat(32)}`,
        blockNumber: '51310619',
      }),
      names,
    )!;
    assert.match(changed.message, /multiplier to 1\.000377: one token now tracks 1\.000377 shares/);
    const scheduled = noticeForSignalV1(
      signal('official_asset_multiplier_change_scheduled', {
        event: 'ui_multiplier_updated',
        multiplierWad: '2000000000000000000',
        effectiveAt: '2026-09-30T14:00:00.000Z',
        payloadState: 'decoded',
        transactionHash: `0x${'cd'.repeat(32)}`,
        blockNumber: '51310619',
      }),
      names,
    )!;
    // A plan is not an event: the number is not in force until the date.
    assert.equal(
      scheduled.message,
      'The NVDAc contract scheduled a share multiplier change to 2, effective Sep 30, 2026 14:00 UTC. Until then it stays as it is.',
    );
  });

  test('a lookalike names the official token, never the new token’s own words', () => {
    const lookalike = (matchedValue: string) =>
      noticeForSignalV1(
        signal(
          'official_asset_lookalike_created',
          {
            matchKind: 'symbol_exact',
            matchedAlias: 'underlying',
            matchedValue,
            officialTicker: 'NVDAc',
            launchSymbol: 'NVDA',
            launchName: 'Free NVDA airdrop claim now',
          },
          { subjectAddress: LOOKALIKE, officialAddress: NVDA },
        ),
        names,
      )!;
    const plain = lookalike('NVDA');
    assert.equal(plain.title, 'NVDA: lookalike token');
    assert.equal(plain.message, 'A new token on Base uses “NVDA” but is not NVDAc. The official address is on its Miorail page.');
    assert.doesNotMatch(plain.message, /airdrop/);
    assert.match(lookalike('claim at https://x.example').message, /uses “NVDA”/);
  });

  test('a list entry or exit is not a push, and a token nobody can name is not either', () => {
    const added = signal('official_source_added_asset', {
      sourceKind: 'base_product_list',
      sourceUrl: 'https://brand.base.org/stocks',
      ticker: 'AMZNc',
      displayName: null,
    });
    assert.equal(noticeForSignalV1(added, names), null);
    assert.equal(noticeForSignalV1(corporateAction({ subjectAddress: LOOKALIKE }), names), null);
  });

  test('a Radar event restates the exact question the person watched', () => {
    const notice = noticeForRadarEventV1(radarEvent(), names)!;
    assert.equal(notice.title, 'NVDA: exit cost up');
    assert.equal(notice.message, 'Selling $1,000 of NVDAc for USDC: exit cost 0.31% → 0.71%, $996.90 → $992.90 back.');
    const session = noticeForRadarEventV1(
      radarEvent({
        kind: 'market_session_changed',
        facts: {
          previousMarketSession: 'regular_hours',
          marketSession: 'weekend',
          previousPublicationMode: 'live_reference',
          publicationMode: 'holding_last_close',
        },
      }),
      names,
    )!;
    assert.equal(session.message, 'US market open → Weekend. The reference price went from live to holding the last close.');
  });

  test('every push fits the fields Base allows', () => {
    const long = names;
    const notices = [
      noticeForSignalV1(exitCostChanged(), long),
      noticeForSignalV1(corporateAction(), long),
      noticeForRadarEventV1(radarEvent(), long),
      summaryNoticeV1(Array.from({ length: 40 }, () => noticeForSignalV1(exitCostChanged(), long)!)),
    ];
    for (const notice of notices) {
      assert.ok(notice);
      assert.ok(notice.title.length <= BASE_APP_TITLE_MAX_V1, notice.title);
      assert.ok(notice.message.length <= BASE_APP_MESSAGE_MAX_V1, notice.message);
      assert.match(notice.targetPath, /^\/stocks(\/[a-z0-9.-]+)?$/);
    }
  });

  test('several changes for one wallet become one summary', () => {
    const summary = summaryNoticeV1([
      noticeForSignalV1(exitCostChanged(), names)!,
      noticeForSignalV1(corporateAction(), names)!,
      noticeForRadarEventV1(radarEvent(), names)!,
    ]);
    assert.equal(summary.title, 'Miorail: 3 updates');
    assert.equal(summary.message, 'MSTR exit cost up; NVDA corporate action; NVDA exit cost up. Open Miorail for the details.');
    assert.equal(summary.targetPath, '/stocks');
  });

  test('a user id names its wallet only in the one shape Miorail writes', () => {
    assert.equal(walletOfUserIdV1(`eip155:8453:${ME.toUpperCase().replace('0X', '0x')}`), ME);
    assert.equal(walletOfUserIdV1('default-user'), null);
    assert.equal(walletOfUserIdV1(`eip155:1:${ME}`), null);
  });
});

describe('who gets what', () => {
  const base = {
    radarEvents: [] as RadarEventNoticeRowV1[],
    watchers: [] as { userId: string; tokenAddress: string }[],
    sentToday: new Map<string, number>(),
    names,
    now: NOW,
  };

  test('an issuer event goes to everyone opted in, as one request', () => {
    const plan = planBaseAppNotificationsV1({ ...base, signals: [corporateAction()], enabled: new Set([ME, YOU, THEM]) });
    assert.equal(plan.groups.length, 1);
    assert.deepEqual(plan.groups[0]!.wallets, [YOU, THEM, ME].sort());
    assert.equal(plan.groups[0]!.title, 'NVDA: corporate action');
  });

  test('a market change goes only to watchers of that token who opted in', () => {
    const plan = planBaseAppNotificationsV1({
      ...base,
      signals: [exitCostChanged()],
      watchers: [
        { userId: `eip155:8453:${ME}`, tokenAddress: MSTR },
        { userId: `eip155:8453:${THEM}`, tokenAddress: MSTR },
        { userId: `eip155:8453:${YOU}`, tokenAddress: NVDA },
      ],
      enabled: new Set([ME, YOU]),
    });
    assert.deepEqual(plan.groups.map((group) => group.wallets), [[ME]]);
    assert.equal(plan.notEnabled, 1, 'THEM watches MSTR but has not opted in');
  });

  test('a Radar event goes to the watch’s owner only', () => {
    const plan = planBaseAppNotificationsV1({ ...base, signals: [], radarEvents: [radarEvent()], enabled: new Set([ME, YOU]) });
    assert.deepEqual(plan.groups.map((group) => group.wallets), [[ME]]);
  });

  test('one push per wallet per pass, and none past the day’s cap or the age cut-off', () => {
    const plan = planBaseAppNotificationsV1({
      ...base,
      signals: [corporateAction(), exitCostChanged(), corporateAction({ recordedAt: '2026-09-22T18:00:00.000Z' })],
      radarEvents: [radarEvent()],
      watchers: [{ userId: `eip155:8453:${ME}`, tokenAddress: MSTR }],
      enabled: new Set([ME, YOU, THEM]),
      sentToday: new Map([[THEM, 4]]),
    });
    assert.equal(plan.stale, 1);
    assert.equal(plan.capped, 1);
    const mine = plan.groups.find((group) => group.wallets.includes(ME))!;
    assert.equal(mine.title, 'Miorail: 3 updates');
    const yours = plan.groups.find((group) => group.wallets.includes(YOU))!;
    assert.equal(yours.title, 'NVDA: corporate action');
    assert.equal(plan.groups.flatMap((group) => group.wallets).length, 2);
  });

  test('a big audience is split at Base’s thousand, and a pass has a request budget', () => {
    const many = new Set(Array.from({ length: 2_500 }, (_, index) => `0x${index.toString(16).padStart(40, '0')}`));
    const plan = planBaseAppNotificationsV1({ ...base, signals: [corporateAction()], enabled: many });
    assert.deepEqual(plan.groups.map((group) => group.wallets.length), [1000, 1000, 500]);
    const tight = planBaseAppNotificationsV1({ ...base, signals: [corporateAction()], enabled: many, limits: { maxRequests: 2 } });
    assert.equal(tight.groups.length, 2);
    assert.equal(tight.dropped, 1);
  });
});

function fakeClient(over: Partial<BaseAppNotifyClientV1> = {}) {
  const sends: { wallets: readonly string[]; title: string; message: string; targetPath: string }[] = [];
  let listed = 0;
  const client: BaseAppNotifyClientV1 = {
    enabledWallets: async () => {
      listed += 1;
      return new Set([ME, YOU]);
    },
    send: async (input) => {
      sends.push(input);
      return { sent: [...input.wallets], failed: { notSaved: 0, disabled: 0, other: 0 } };
    },
    ...over,
  };
  return { client, sends, listed: () => listed };
}

describe('one pass', () => {
  const namesFor = async () => names;
  /** The pass that opens the cursors, at OPENED. */
  const open = (repository: InMemoryBaseAppNotificationRepositoryV1, client: BaseAppNotifyClientV1) =>
    runBaseAppNotifyV1({ repository, client, names: namesFor, now: () => OPENED });

  test('the first pass opens its cursors and announces nothing that came before', async () => {
    const repository = new InMemoryBaseAppNotificationRepositoryV1();
    repository.seedSignal(corporateAction({ signalId: '5' }));
    const { client, sends, listed } = fakeClient();
    const report = await runBaseAppNotifyV1({ repository, client, names: namesFor, now: () => NOW });
    assert.equal(report.outcome, 'opened');
    assert.equal(sends.length, 0);
    assert.equal(listed(), 0, 'Base is not even asked');
  });

  test('a new row is pushed once, and the next pass says nothing', async () => {
    const repository = new InMemoryBaseAppNotificationRepositoryV1();
    const { client, sends } = fakeClient();
    await open(repository, client);
    repository.seedSignal(corporateAction({ signalId: '6' }));
    const first = await runBaseAppNotifyV1({ repository, client, names: namesFor, now: () => NOW });
    assert.equal(first.outcome, 'delivered');
    assert.equal(first.sent, 2);
    assert.deepEqual(sends.map((send) => [send.title, [...send.wallets]]), [['NVDA: corporate action', [ME, YOU].sort()]]);
    assert.equal((await repository.sentOn({ day: '2026-09-23', wallets: [ME] })).get(ME), 1);
    const second = await runBaseAppNotifyV1({ repository, client, names: namesFor, now: () => NOW });
    assert.equal(second.outcome, 'idle');
    assert.equal(sends.length, 1);
  });

  test('when Base does not answer, nothing moves, and the next pass delivers', async () => {
    const repository = new InMemoryBaseAppNotificationRepositoryV1();
    const healthy = fakeClient();
    await open(repository, healthy.client);
    repository.seedSignal(corporateAction({ signalId: '7' }));
    const down = fakeClient({
      enabledWallets: async () => {
        throw new BaseAppNotifyErrorV1(503, true, 'base_app_http_503');
      },
    });
    const stopped = await runBaseAppNotifyV1({ repository, client: down.client, names: namesFor, now: () => NOW });
    assert.deepEqual([stopped.outcome, stopped.stoppedBy], ['stopped', 'base_app_http_503']);
    const retried = await runBaseAppNotifyV1({ repository, client: healthy.client, names: namesFor, now: () => NOW });
    assert.equal(retried.outcome, 'delivered');
    assert.equal(healthy.sends.length, 1);
  });

  test('a send Base refuses as malformed is counted and passed; a throttle stops the pass', async () => {
    const repository = new InMemoryBaseAppNotificationRepositoryV1();
    const setup = fakeClient();
    await open(repository, setup.client);
    repository.seedSignal(corporateAction({ signalId: '8' }));
    const refused = fakeClient({
      send: async () => {
        throw new BaseAppNotifyErrorV1(400, false, 'base_app_http_400');
      },
    });
    const report = await runBaseAppNotifyV1({ repository, client: refused.client, names: namesFor, now: () => NOW });
    assert.deepEqual([report.outcome, report.failed], ['delivered', 2]);
    assert.equal((await repository.cursor('rwa_signal'))!.cursorId, '8', 'the same payload would be refused again');

    repository.seedSignal(corporateAction({ signalId: '9' }));
    const throttled = fakeClient({
      send: async () => {
        throw new BaseAppNotifyErrorV1(429, true, 'base_app_http_429');
      },
    });
    const stopped = await runBaseAppNotifyV1({ repository, client: throttled.client, names: namesFor, now: () => NOW });
    assert.equal(stopped.outcome, 'stopped');
    assert.equal((await repository.cursor('rwa_signal'))!.cursorId, '8', 'a throttled pass is tried again');
  });

  test('rows this module does not send move the cursor without asking Base anything', async () => {
    const repository = new InMemoryBaseAppNotificationRepositoryV1();
    const { client, listed } = fakeClient();
    await open(repository, client);
    repository.seedSignal(
      signal('official_source_added_asset', { sourceKind: 'base_product_list', sourceUrl: 'https://brand.base.org/stocks', ticker: 'AMZNc', displayName: null }, { signalId: '10' }),
    );
    const report = await runBaseAppNotifyV1({ repository, client, names: namesFor, now: () => NOW });
    assert.deepEqual([report.outcome, report.unsent], ['idle', 1]);
    assert.equal(listed(), 0);
    assert.equal((await repository.cursor('rwa_signal'))!.cursorId, '10');
  });

  test('a dry pass plans and writes nothing; no key means off', async () => {
    const repository = new InMemoryBaseAppNotificationRepositoryV1();
    const { client, sends } = fakeClient();
    assert.equal((await runBaseAppNotifyV1({ repository, client, names: namesFor, now: () => NOW, dry: true })).outcome, 'dry');
    assert.equal(await repository.cursor('rwa_signal'), null, 'a dry pass opens nothing');
    await open(repository, client);
    repository.seedSignal(corporateAction({ signalId: '11' }));
    const dry = await runBaseAppNotifyV1({ repository, client, names: namesFor, now: () => NOW, dry: true });
    assert.deepEqual([dry.outcome, dry.groups, sends.length], ['dry', 1, 0]);
    assert.equal((await repository.cursor('rwa_signal'))!.cursorId, '', 'still before the row');
    assert.equal((await runBaseAppNotifyV1({ repository, client: null, names: namesFor, now: () => NOW })).outcome, 'off');
  });
});

// ---------------------------------------------------------------------------
// Holders hear it as news about their own tokens; everyone hears the week.
// ---------------------------------------------------------------------------

const GOOGL = '0xb2000000000000000000002d0ba3164cc74f58b7';
const coinbaseNames: NamesOfV1 = (address) =>
  address === GOOGL
    ? { symbol: 'GOOGL', representation: 'GOOGLc', issuer: 'coinbase' }
    : address === NVDA
      ? { symbol: 'NVDA', representation: 'NVDAc', issuer: 'coinbase' }
      : null;
/** GOOGLc on 2026-09-14, as the ratio reader recorded it. */
const GOOGL_DIVIDEND = { from: '1000000000000000000', to: '1000377118676784179' };
const googlMultiplier = (over: Partial<RwaSignalRowV1> = {}) =>
  signal(
    'official_asset_multiplier_changed',
    {
      event: 'multiplier_updated',
      multiplierWad: GOOGL_DIVIDEND.to,
      payloadState: 'decoded',
      transactionHash: `0x${'ab'.repeat(32)}`,
      blockNumber: '51310620',
    },
    { subjectAddress: GOOGL, ...over },
  );

describe('a dividend in shares reaches the people who hold the stock', () => {
  test('the Coinbase multiplier rise of 2026-09-14 reads as a dividend, to a holder', () => {
    assert.equal(multiplierChangePpmV1(GOOGL_DIVIDEND.from, GOOGL_DIVIDEND.to), 377);
    assert.equal(ppmPercentV1(377), '0.038%');
    const notice = holderMultiplierNoticeV1(googlMultiplier(), coinbaseNames, GOOGL_DIVIDEND.from);
    assert.equal(notice?.title, 'GOOGL: dividend in shares');
    assert.equal(
      notice?.message,
      'Your GOOGLc now track 0.038% more GOOGL shares each: the multiplier went from 1 to 1.000377. That is how a reinvested dividend reaches a token holder.',
    );
    assert.ok(notice!.title.length <= BASE_APP_TITLE_MAX_V1 && notice!.message.length <= BASE_APP_MESSAGE_MAX_V1);
    assert.equal(notice?.targetPath, '/stocks/googl');
  });

  test('another issuer, a split, or an unknown previous value is never called a dividend', () => {
    const backed: NamesOfV1 = () => ({ symbol: 'GOOGL', representation: 'bGOOGL', issuer: 'backed' });
    assert.doesNotMatch(holderMultiplierNoticeV1(googlMultiplier(), backed, GOOGL_DIVIDEND.from)?.title ?? '', /dividend/);
    const split = googlMultiplier({ facts: { event: 'multiplier_updated', multiplierWad: '2000000000000000000', payloadState: 'decoded', transactionHash: `0x${'ab'.repeat(32)}`, blockNumber: '1' } });
    assert.equal(holderMultiplierNoticeV1(split, coinbaseNames, GOOGL_DIVIDEND.from)?.message, 'Your GOOGLc now track 2 GOOGL shares each, up from 1.');
    assert.equal(holderMultiplierNoticeV1(googlMultiplier(), coinbaseNames, null)?.message, 'Your GOOGLc now track 1.000377 GOOGL shares each.');
  });

  test('a holder gets the holder version, everyone else the contract version', () => {
    const plan = planBaseAppNotificationsV1({
      signals: [googlMultiplier()],
      radarEvents: [],
      watchers: [],
      enabled: new Set([ME, YOU]),
      sentToday: new Map(),
      names: coinbaseNames,
      now: NOW,
      holdings: new Map([[ME, new Set([GOOGL])]]),
      previousMultiplier: () => GOOGL_DIVIDEND.from,
    });
    assert.deepEqual(
      plan.groups.map((group) => [group.title, group.wallets]).sort(),
      [
        ['GOOGL: dividend in shares', [ME]],
        ['GOOGL: multiplier changed', [YOU]],
      ],
    );
  });

  test('without holdings everyone gets the contract version, exactly as before', () => {
    const plan = planBaseAppNotificationsV1({
      signals: [googlMultiplier()],
      radarEvents: [],
      watchers: [],
      enabled: new Set([ME, YOU]),
      sentToday: new Map(),
      names: coinbaseNames,
      now: NOW,
    });
    assert.deepEqual(plan.groups.map((group) => [group.title, group.wallets]), [['GOOGL: multiplier changed', [ME, YOU].sort()]]);
  });
});

const WEEK: WeeklySummaryV1 = {
  week: {
    weekCloseAt: '2026-09-25T20:00:00.000Z',
    previousCloseAt: '2026-09-18T20:00:00.000Z',
    stocks: [
      { tokenAddress: '0xb200000000000000000000397293cb8cda9a10c5', symbol: 'SNDK', name: 'Sandisk', close: '1800.00', previousClose: '1735.00', changeBps: 375 },
      { tokenAddress: NVDA, symbol: 'NVDA', name: 'NVIDIA', close: '229.00', previousClose: '222.37', changeBps: 298 },
      { tokenAddress: GOOGL, symbol: 'GOOGL', name: 'Alphabet', close: '346.00', previousClose: '348.79', changeBps: -80 },
      { tokenAddress: '0xb200000000000000000000578f3ae29d9e6e0101', symbol: 'AAPL', name: 'Apple', close: '336.00', previousClose: '335.47', changeBps: 16 },
    ],
  },
  dividends: new Set([GOOGL]),
};

describe('the weekly summary', () => {
  const et = (iso: string) => new Date(iso);
  test('due from 20:30 ET after the week closes, for twelve hours, and only before a weekend', () => {
    assert.equal(weeklySummaryDueV1(et('2026-09-26T00:15:00.000Z')), null, 'Friday 20:15 ET');
    assert.deepEqual(weeklySummaryDueV1(et('2026-09-26T00:45:00.000Z')), { weekCloseAt: '2026-09-25T20:00:00.000Z' });
    assert.equal(weeklySummaryDueV1(et('2026-09-26T12:30:00.000Z')), null, 'Saturday 08:30 ET');
    assert.equal(weeklySummaryDueV1(et('2026-09-23T22:00:00.000Z')), null, 'a Wednesday');
    // Thanksgiving: Wednesday's close is followed by one quiet day, not a weekend.
    assert.equal(weeklySummaryDueV1(et('2026-11-26T02:00:00.000Z')), null);
  });

  test('a holder hears their own stocks, and a dividend they were paid', () => {
    const notice = weeklyNoticeV1({ weekly: WEEK, held: new Set([NVDA, GOOGL]) });
    assert.equal(notice?.title, 'Your stocks this week');
    assert.equal(
      notice?.message,
      "NVDA +2.98%, GOOGL −0.80% from last week's close. GOOGL paid a dividend in shares. They keep trading on Base this weekend.",
    );
  });

  test('everyone else hears the market, three biggest moves first', () => {
    const notice = weeklyNoticeV1({ weekly: WEEK, held: null });
    assert.equal(notice?.title, 'The week on Base');
    assert.match(notice?.message ?? '', /^Tokenized stocks this week: SNDK \+3\.75%, NVDA \+2\.98%, GOOGL −0\.80% from last week's close\./);
    assert.ok(notice!.message.length <= BASE_APP_MESSAGE_MAX_V1);
  });

  test('wallets that hold the same stocks share one push; the capped wait for tomorrow', () => {
    const plan = planWeeklySummaryV1({
      weekly: WEEK,
      wallets: [ME, YOU, THEM],
      holdings: new Map([[ME, new Set([NVDA])]]),
      sentToday: new Map([[THEM, 4]]),
    });
    assert.equal(plan.capped, 1);
    assert.deepEqual(plan.groups.map((group) => [group.title, group.wallets]).sort(), [
      ['The week on Base', [YOU]],
      ['Your stocks this week', [ME]],
    ]);
  });

  test('a pass inside the window sends it once per wallet, and an unread balance sends nothing', async () => {
    const repository = new InMemoryBaseAppNotificationRepositoryV1();
    const { client, sends } = fakeClient();
    const friday = new Date('2026-09-26T00:45:00.000Z');
    const deps = {
      repository,
      client,
      names: async () => names,
      now: () => friday,
      weekly: async () => WEEK,
    };
    const unread = await runBaseAppNotifyV1({
      ...deps,
      holdings: async () => {
        throw new Error('rpc down');
      },
    });
    assert.equal(unread.weekly?.sent, 0);
    assert.equal(sends.length, 0, 'a holder is never told the market week instead of their own');

    const first = await runBaseAppNotifyV1({ ...deps, holdings: async () => new Map([[ME, new Set([NVDA])]]) });
    assert.equal(first.weekly?.sent, 2);
    assert.deepEqual(sends.map((send) => send.title).sort(), ['The week on Base', 'Your stocks this week']);
    const again = await runBaseAppNotifyV1({ ...deps, holdings: async () => new Map([[ME, new Set([NVDA])]]) });
    assert.equal(again.weekly?.due, 0);
    assert.equal(sends.length, 2, 'the next pass sends nothing more');
  });

  test('outside the window the week is not even read', async () => {
    const repository = new InMemoryBaseAppNotificationRepositoryV1();
    const { client } = fakeClient();
    let asked = 0;
    await runBaseAppNotifyV1({
      repository,
      client,
      names: async () => names,
      now: () => NOW,
      weekly: async () => {
        asked += 1;
        return WEEK;
      },
    });
    assert.equal(asked, 0);
  });
});

test('the worker is installed by the deploy, runs this script, and prints no key', () => {
  const cwd = process.cwd();
  const root = cwd.endsWith(`${path.sep}scripts`) ? path.join(cwd, '..') : cwd;
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
  const service = read('ops/systemd/miorail-base-app-notify.service');
  const timer = read('ops/systemd/miorail-base-app-notify.timer');
  const deploy = read('ops/deploy.sh');
  assert.match(service, /^ExecStart=.*node --import tsx scripts\/base_app_notify\.ts$/m);
  assert.match(service, /^EnvironmentFile=\/home\/miorail\/mioagent\/\.env$/m);
  assert.match(service, /^User=miorail$/m);
  assert.match(timer, /^OnUnitActiveSec=5min$/m);
  assert.match(deploy, /for stem in [^;]*\bbase-app-notify\b[^;]*; do/);
  // The deploy says whether the key is there without ever reading it out.
  const keyLine = deploy.split('\n').find((line) => line.includes('BASE_DEV_API'));
  assert.ok(keyLine && /grep -qE/.test(keyLine), keyLine);
  assert.doesNotMatch(deploy, /echo[^\n]*\$BASE_DEV_API|cut[^\n]*BASE_DEV_API/);
});
