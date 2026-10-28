import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeMirror } from '@mioagent/still-engine';
import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';
import { EXAMPLE, calendar, snapshot, universe } from '../../still-engine/test/fixtures';
import { agentAnswerV1, type DividendReadStateV1 } from '../src/still/agentAnswers';
import { assetsViewV1 } from '../src/still/assetsView';
import { homeViewV1 } from '../src/still/homeView';
import { dividendMoneyV1, positiveDividendMoneyV1, sumDividendMoneyV1 } from '../src/still/dividendMoney';
import { skyStateV1 } from '../src/still/skyState';

const NOW = new Date('2026-10-28T15:00:00Z');
const sky = skyStateV1({ now: NOW });
function report(): MirrorReport {
  return JSON.parse(JSON.stringify(computeMirror({ universe: universe(), snapshot: snapshot(EXAMPLE), calendar: calendar(),
    subject: { address: '0x00000000000000000000000000000000000b0b0b', name: null, input: 'example' }, assembledAt: NOW })));
}
function dividends(usd: string | null = '0.0001'): DividendWalletResponseV1 {
  return {
    schemaVersion: 'dividend-wallet/v1', generatedAt: NOW.toISOString(), blockNumber: 53_000_000,
    receivedUsd: usd ?? '0.0000', passThroughPercent: '49.5', holdings: [{
      underlyingKey: 'security:isin:US0378331005', symbol: 'AAPL', company: 'Apple',
      tokenAddress: '0xb200000000000000000000c2e324d24d7eecd1fb', tokenSymbol: 'AAPLc', tokens: '1.5',
      received: [{ state: 'effective', reason: null, amountPerShare: '0.27', payDate: '2026-08-13', payDateApproximate: false, kind: 'measured', tokens: '1.5', shares: null, usd, at: null }],
      upcoming: [{ state: 'estimated', reason: null, amountPerShare: '0.27', payDate: '2026-11-12', payDateApproximate: true, kind: 'estimate', tokens: '1.5', shares: null, usd, at: null }],
    }],
  };
}

describe('dividend amounts remain honest below a cent', () => {
  for (const value of ['0.000000000000000001', '0.0001', '0.0099', '000.009999']) {
    it(`preserves positive ${value} on Agent, Home and Assets`, () => {
      assert.equal(dividendMoneyV1(value), '<$0.01');
      const r = report(), d = dividends(value);
      const answer = agentAnswerV1({ question: 'dividend?', report: r, sky, dividends: d });
      assert.match(answer.text, /<\$0\.01 as more AAPLc/);
      assert.doesNotMatch(answer.text, /about <|\$0\.00/);
      const coming = homeViewV1({ report: r, sky, dividends: d }).comingUp.find(row => row.icon === 'dividend');
      assert.match(coming!.text, /dividend · <\$0\.01 as more AAPLc/);
      assert.doesNotMatch(coming!.text, /≈ </);
      const assets = assetsViewV1({ report: r, dividends: d });
      assert.equal(assets.receivedDividends, '<$0.01');
      assert.match(assets.rows.find(row => row.id === 'AAPLc')!.lines.at(-1)!.text, /Dividend ahead: <\$0\.01/);
    });
  }
  it('keeps an exact zero distinct from a positive fraction', () => {
    assert.equal(dividendMoneyV1('0.0000'), '$0.00');
    assert.equal(positiveDividendMoneyV1('0.0000'), null);
    const text = agentAnswerV1({ question: 'dividend?', report: report(), sky, dividends: dividends('0.0000') }).text;
    assert.match(text, /\$0\.00/); assert.doesNotMatch(text, /<\$0\.01/);
  });
  for (const value of [null, undefined, '', 'NaN', 'Infinity', '-0.1', '1e-5', ' 0.01', '0.01x']) {
    it(`keeps invalid or absent ${String(value)} unknown`, () => {
      assert.equal(dividendMoneyV1(value), null);
      assert.equal(positiveDividendMoneyV1(value), null);
    });
  }
  it('formats cents exactly, including a decimal tie without floating point loss', () => {
    assert.equal(dividendMoneyV1('0.0100'), '$0.01');
    assert.equal(dividendMoneyV1('0.015'), '$0.02');
    assert.equal(dividendMoneyV1('1.995'), '$2.00');
    assert.equal(dividendMoneyV1('9007199254740993.01'), '$9007199254740993.01');
  });
  it('sums received readings exactly but does not treat an unknown event as zero', () => {
    assert.equal(sumDividendMoneyV1(['0.0001', '0.0002']), '<$0.01');
    assert.equal(sumDividendMoneyV1(['0.0099', '0.0001']), '$0.01');
    assert.equal(sumDividendMoneyV1(['0.03', null]), null);
    assert.equal(sumDividendMoneyV1(['0.03', 'malformed']), null);
    assert.equal(sumDividendMoneyV1([]), '$0.00');
  });
  it('retains a known payment date when its value was not read', () => {
    const r = report(), d = dividends(null);
    const answer = agentAnswerV1({ question: 'dividend?', report: r, sky, dividends: d });
    assert.match(answer.text, /2026-11-12, amount not read/);
    assert.doesNotMatch(answer.text, /\$0\.00|NaN/);
    assert.match(homeViewV1({ report: r, sky, dividends: d }).comingUp.find(row => row.icon === 'dividend')!.text, /amount not read/);
    assert.equal(assetsViewV1({ report: r, dividends: d }).rows.find(row => row.id === 'AAPLc')!.lines.some(row => row.text.startsWith('Dividends reinvested')), false);
  });
});

describe('an unread dividend calendar is not an empty calendar', () => {
  for (const state of ['not_loaded', 'loading', 'unavailable'] as DividendReadStateV1[]) {
    it(`distinguishes ${state} from confirmed none, even with stale data`, () => {
      const answer = agentAnswerV1({ question: 'dividend?', report: report(), sky, dividends: dividends(), dividendsReadState: state });
      assert.doesNotMatch(answer.text, /no upcoming dividend|Apple: paid|No dividend ahead/);
      assert.deepEqual(answer.sources, []);
      assert.match(answer.text, state === 'not_loaded' ? /not been loaded/ : state === 'loading' ? /still loading/ : /could not be read/);
    });
  }
  it('treats omitted/null data as unknown even if a caller labels it read', () => {
    for (const input of [{}, { dividends: null }, { dividends: null, dividendsReadState: 'read' as const }]) {
      const answer = agentAnswerV1({ question: 'dividend?', report: report(), sky, ...input });
      assert.match(answer.text, /not been loaded/);
      assert.doesNotMatch(answer.text, /no upcoming dividend|No dividend ahead/);
    }
  });
  it('only a loaded, empty calendar can state that it lists no upcoming event', () => {
    const d = { ...dividends(), holdings: [] };
    const answer = agentAnswerV1({ question: 'dividend?', report: report(), sky, dividends: d, dividendsReadState: 'read' });
    assert.equal(answer.text, 'The loaded calendar lists no upcoming dividend for the stocks it covers in your wallet.');
    assert.deepEqual(answer.sources, ['CALENDAR · Miorail dividends']);
  });
  it('preserves the same distinctions in a Russian question', () => {
    const answer = agentAnswerV1({ question: 'Когда дивиденды?', report: report(), sky });
    assert.match(answer.text, /ещё не загружены/);
    assert.doesNotMatch(answer.text, /дивидендов.*нет/);
  });
});

describe('the Agent distinguishes a model from an executable loan', () => {
  it('names the model and the live supported path instead of offering stock borrowing', () => {
    const answer = agentAnswerV1({ question: 'How much can I borrow?', report: report(), sky });
    assert.match(answer.text, /^Modelled borrowing room:/);
    assert.match(answer.text, /not a loan ready to sign/);
    assert.match(answer.text, /cbBTC and WETH through Morpho/);
    assert.match(answer.text, /Stock-backed borrowing is not available here yet/);
    assert.doesNotMatch(answer.text, /^Now \$/);
  });
  it('reports held tokens with unread valuations without claiming the wallet has none', () => {
    const r = report(); r.assets.forEach(row => { row.valueCents = null; });
    const answer = agentAnswerV1({ question: 'What do I hold?', report: r, sky });
    assert.match(answer.text, /Reviewed holdings:.*NVIDIA \(value not read\)/);
    assert.doesNotMatch(answer.text, /No holdings|Nothing here/);
  });
});
