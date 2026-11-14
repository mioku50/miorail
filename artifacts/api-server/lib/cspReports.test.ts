import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CSP_REPORT_LINES_PER_HOUR_V1,
  CSP_REPORT_LINES_PER_SENDER_PER_HOUR_V1,
  CSP_REPORT_OWN_ORIGIN_RESERVE_V1,
  CSP_REPORTS_PER_REQUEST_V1,
  createCspReportRecorderV1,
  cspPageV1,
  cspPlaceV1,
  cspReportFactsV1,
  type CspReportDroppedV1,
  type CspReportFactV1,
} from './cspReports.js';

describe('what is kept of a browser\'s report about the script rule', () => {
  it('reads the report-uri shape: the directive, two origins and the page\'s first segment', () => {
    // What Chromium sent from the deployed page on 2026-11-12: the wallet library's inline telemetry.
    const facts = cspReportFactsV1({
      'csp-report': {
        'document-uri': 'https://miorail.xyz/stocks/NVDA?ref=abc',
        referrer: 'https://example.com/somewhere',
        'violated-directive': 'script-src-elem',
        'effective-directive': 'script-src-elem',
        'original-policy': "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; report-uri /api/public/csp-report",
        disposition: 'report',
        'blocked-uri': 'inline',
        'source-file': 'https://miorail.xyz/assets/dist-Dkamy4DL.js',
        'line-number': 2,
        'script-sample': 'window.secret = 1',
      },
    });
    assert.deepEqual(facts, [
      { directive: 'script-src-elem', blocked: 'inline', source: 'https://miorail.xyz', page: '/stocks', disposition: 'report' },
    ]);
    // Nothing else of the report survives: no query, no referrer, no sample, no file name.
    assert.doesNotMatch(JSON.stringify(facts), /NVDA|abc|example|secret|Dkamy/);
  });

  it('reads the Reporting API shape, a bounded number of entries', () => {
    const entry = (blockedURL: string) => ({
      type: 'csp-violation',
      url: 'https://miorail.xyz/still',
      user_agent: 'Mozilla/5.0',
      body: { documentURL: 'https://miorail.xyz/still', effectiveDirective: 'script-src-elem', blockedURL, sourceFile: null, disposition: 'enforce' },
    });
    const facts = cspReportFactsV1([entry('https://cdn.example.com/x.js'), { type: 'deprecation', body: {} }, entry('eval')]);
    assert.deepEqual(facts, [
      { directive: 'script-src-elem', blocked: 'https://cdn.example.com', source: 'none', page: '/still', disposition: 'enforce' },
      { directive: 'script-src-elem', blocked: 'eval', source: 'none', page: '/still', disposition: 'enforce' },
    ]);
    const many = Array.from({ length: 500 }, () => entry('inline'));
    assert.equal(cspReportFactsV1(many).length, CSP_REPORTS_PER_REQUEST_V1);
  });

  it('takes the name of a directive that arrives with its whole value', () => {
    const [fact] = cspReportFactsV1({ 'csp-report': { 'document-uri': 'https://miorail.xyz/', 'violated-directive': "script-src 'self'", 'blocked-uri': 'eval' } });
    assert.equal(fact?.directive, 'script-src');
    assert.equal(fact?.page, '/');
    assert.equal(fact?.disposition, 'report');
  });

  it('ignores what is not a report', () => {
    for (const body of [undefined, null, '', 'text', 7, {}, [], { 'csp-report': 'x' }, { 'csp-report': {} },
      { 'csp-report': { 'effective-directive': 'DROP TABLE' } }, { 'csp-report': { 'effective-directive': 'x'.repeat(200) } },
      { 'csp-report': { 'effective-directive': 'made-up-src' } },
      [{ type: 'csp-violation' }], [{ type: 'csp-violation', body: { effectiveDirective: 7 } }]]) {
      assert.deepEqual(cspReportFactsV1(body), [], JSON.stringify(body));
    }
  });

  it('reduces an address to its origin, a keyword or a scheme', () => {
    assert.equal(cspPlaceV1('https://Example.com:8443/a/b.js?x=1#y'), 'https://example.com:8443');
    assert.equal(cspPlaceV1('inline'), 'inline');
    assert.equal(cspPlaceV1('wasm-eval'), 'wasm-eval');
    assert.equal(cspPlaceV1('blob:https://miorail.xyz/1234-uuid'), 'blob');
    assert.equal(cspPlaceV1('data:text/javascript,alert(1)'), 'data');
    // A Chrome extension's id names the extension; a Firefox one names the installation.
    assert.equal(cspPlaceV1(`chrome-extension://${'abcdefghijklmnop'.repeat(2)}/inpage.js`), `chrome-extension://${'abcdefghijklmnop'.repeat(2)}`);
    assert.equal(cspPlaceV1('chrome-extension://not-an-id/inpage.js'), 'chrome-extension');
    assert.equal(cspPlaceV1('moz-extension://0a1b2c3d-1111-2222-3333-444455556666/inpage.js'), 'moz-extension');
    for (const value of [undefined, null, 7, '', '   ']) assert.equal(cspPlaceV1(value), 'none');
    assert.equal(cspPlaceV1('not a url'), 'other');
    assert.equal(cspPlaceV1(`https://${'a'.repeat(3000)}.example`), 'other');
    assert.equal(cspPlaceV1('https://user:pass@example.com/x'), 'https://example.com');
  });

  it('keeps the first segment of the page and nothing that could be a code or an address', () => {
    assert.equal(cspPageV1('https://miorail.xyz/'), '/');
    assert.equal(cspPageV1('https://miorail.xyz/Stocks/AAPL'), '/stocks');
    assert.equal(cspPageV1('https://miorail.xyz/r/8f3k2j'), '/r');
    assert.equal(cspPageV1('https://miorail.xyz/0x1111111111111111111111111111111111111111'), '/other');
    assert.equal(cspPageV1('https://miorail.xyz/a%20b'), '/other');
    assert.equal(cspPageV1('nonsense'), '/other');
    assert.equal(cspPageV1(undefined), '/other');
  });
});

describe('the journal gets each fact once an hour, and only so many', () => {
  const fact = (blocked: string): CspReportFactV1 => ({ directive: 'script-src-elem', blocked, source: 'none', page: '/', disposition: 'report' });

  it('writes a first sighting, stays silent on a repeat, and writes it again the next hour', () => {
    let now = Date.parse('2026-11-12T10:05:00.000Z');
    const written: CspReportFactV1[] = [];
    const recorder = createCspReportRecorderV1({ write: (value) => written.push(value), nowMs: () => now });
    assert.equal(recorder.record(fact('inline')), true);
    assert.equal(recorder.record(fact('inline')), false);
    assert.equal(recorder.record(fact('eval')), true);
    now += 3_600_000;
    assert.equal(recorder.record(fact('inline')), true);
    assert.deepEqual(written.map((value) => value.blocked), ['inline', 'eval', 'inline']);
  });

  it('stops writing at the hour\'s budget, whatever is posted', () => {
    const written: CspReportFactV1[] = [];
    const recorder = createCspReportRecorderV1({ write: (value) => written.push(value), nowMs: () => 0, linesPerHour: 3 });
    for (let n = 0; n < 1_000; n += 1) recorder.record(fact(`https://host${n}.example`));
    assert.equal(written.length, 3);
  });
});

// Four posts of made-up reports at the top of the hour took all 40 lines, and a real report after them left
// no trace, not even a count (audit AUTH-2, 2026-11-14).
describe('noise cannot hide a real report', () => {
  const fact = (blocked: string, source = 'none'): CspReportFactV1 => ({ directive: 'script-src-elem', blocked, source, page: '/still', disposition: 'enforce' });
  const OWN = 'https://miorail.xyz';

  it('one sender writes only its share, and another sender\'s report is still written', () => {
    const written: CspReportFactV1[] = [];
    const recorder = createCspReportRecorderV1({ write: (value) => written.push(value), nowMs: () => 0, ownOrigins: [OWN] });
    for (let n = 0; n < 1_000; n += 1) recorder.record(fact(`https://noise${n}.example`), '198.51.100.7');
    assert.equal(written.length, CSP_REPORT_LINES_PER_SENDER_PER_HOUR_V1);
    assert.equal(recorder.record(fact('chrome-extension://abcdefghijklmnopabcdefghijklmnop'), '203.0.113.9'), true);
    assert.equal(written.length, CSP_REPORT_LINES_PER_SENDER_PER_HOUR_V1 + 1);
  });

  it('many senders fill the rest of the hour, and a report naming Still\'s own files keeps the lines saved for it', () => {
    const written: CspReportFactV1[] = [];
    const recorder = createCspReportRecorderV1({ write: (value) => written.push(value), nowMs: () => 0, ownOrigins: [OWN] });
    for (let n = 0; n < 400; n += 1) recorder.record(fact(`https://noise${n}.example`), `2001:db8:${n.toString(16)}:1::/64`);
    assert.equal(written.length, CSP_REPORT_LINES_PER_HOUR_V1 - CSP_REPORT_OWN_ORIGIN_RESERVE_V1);
    assert.equal(recorder.record(fact('inline', OWN), '192.0.2.10'), true);
    assert.equal(recorder.record(fact(`${OWN}`, 'none'), '192.0.2.11'), true);
    assert.deepEqual(written.slice(-2).map((value) => value.source === OWN || value.blocked === OWN), [true, true]);
  });

  it('what was not written is counted once per report and said when the hour turns, without a sender', () => {
    let now = Date.parse('2026-11-14T10:01:00.000Z');
    const written: CspReportFactV1[] = [];
    const dropped: CspReportDroppedV1[] = [];
    const recorder = createCspReportRecorderV1({ write: (value) => written.push(value), writeDropped: (value) => dropped.push(value), nowMs: () => now,
      linesPerHour: 4, linesPerSender: 2 });
    for (const blocked of ['https://a.example', 'https://b.example', 'https://c.example', 'https://c.example', 'https://d.example']) recorder.record(fact(blocked), 'one');
    recorder.record(fact('https://e.example'), 'two');
    recorder.record(fact('https://f.example'), 'two');
    recorder.record(fact('https://g.example'), 'three');
    recorder.record(fact('https://g.example'), 'three');
    assert.equal(written.length, 4);
    assert.deepEqual(dropped, []);
    // A quiet hour with nothing lost says nothing; the hour that lost some says how much, once.
    now += 3_600_000;
    recorder.record(fact('https://a.example'), 'one');
    assert.deepEqual(dropped, [{ hour: '2026-11-14T10:00:00.000Z', overSenderShare: 2, overHourBudget: 1, senders: 2 }]);
    now += 3_600_000;
    recorder.record(fact('https://a.example'), 'one');
    assert.equal(dropped.length, 1);
  });
});
