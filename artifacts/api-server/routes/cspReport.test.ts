import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';

import type { CspReportFactV1 } from '../lib/cspReports.js';
import { boundedBody, bodyMembersV1, REQUEST_BODY_MAX_MEMBERS_V1 } from '../middleware/bodyBounds.js';
import { cspReportRouter, cspReportRuntime } from './cspReport.js';
import { DOCUMENT_CSP_V1 } from './stockPages.js';

const originalWrite = cspReportRuntime.write;

function app(written: CspReportFactV1[]) {
  cspReportRuntime.write = (fact) => {
    written.push(fact);
  };
  const server = express();
  // As in app.ts: the app's own parser first, then the bound, then the routes.
  server.use(express.json({ inflate: false }));
  server.use(boundedBody());
  server.use('/api/public', cspReportRouter);
  server.post('/api/echo', (req, res) => {
    res.json({ members: bodyMembersV1(req.body, Number.MAX_SAFE_INTEGER) });
  });
  return server;
}

afterEach(() => {
  cspReportRuntime.write = originalWrite;
});

describe('POST /api/public/csp-report', () => {
  it('is the address the page\'s rule reports to', () => {
    assert.match(DOCUMENT_CSP_V1, /; report-uri \/api\/public\/csp-report$/);
  });

  it('takes a browser\'s report in the media type a browser sends, and writes what identifies the script', async () => {
    const written: CspReportFactV1[] = [];
    const report = (blocked: string) => ({
      'csp-report': {
        'document-uri': 'https://miorail.xyz/still?x=1',
        'effective-directive': 'script-src-elem',
        'blocked-uri': blocked,
        'source-file': 'https://miorail.xyz/assets/dist-abc.js',
        disposition: 'report',
      },
    });
    const server = app(written);
    const first = await request(server).post('/api/public/csp-report').set('Content-Type', 'application/csp-report').send(JSON.stringify(report('inline')));
    assert.equal(first.status, 204);
    assert.equal(first.text, '');
    // The same violation again, as every page load sends it: accepted, not written twice.
    await request(server).post('/api/public/csp-report').set('Content-Type', 'application/csp-report').send(JSON.stringify(report('inline')));
    assert.deepEqual(written.map((fact) => ({ ...fact, blocked: fact.blocked.replace(/^.*$/, 'inline') })), [
      { directive: 'script-src-elem', blocked: 'inline', source: 'https://miorail.xyz', page: '/still', disposition: 'report' },
    ]);
  });

  it('answers 204 to what is not a report, and writes nothing', async () => {
    const written: CspReportFactV1[] = [];
    const server = app(written);
    for (const [type, body] of [
      ['application/csp-report', '{"csp-report":{}}'],
      ['application/csp-report', '[]'],
      ['application/reports+json', '[{"type":"deprecation","body":{}}]'],
      ['application/json', '{"anything":true}'],
      ['text/plain', 'hello'],
    ] as const) {
      const res = await request(server).post('/api/public/csp-report').set('Content-Type', type).send(body);
      assert.equal(res.status, 204, `${type} ${body}`);
    }
    assert.deepEqual(written, []);
  });

  it('refuses a report body larger than a report is', async () => {
    const written: CspReportFactV1[] = [];
    const res = await request(app(written))
      .post('/api/public/csp-report')
      .set('Content-Type', 'application/csp-report')
      .send(JSON.stringify({ 'csp-report': { 'effective-directive': 'script-src', padding: 'x'.repeat(40_000) } }));
    assert.equal(res.status, 413);
    assert.deepEqual(written, []);
  });
});

describe('a request body is bounded before any schema reads it', () => {
  it('counts every array element and object entry, at any depth, and stops at the limit', () => {
    assert.equal(bodyMembersV1(undefined, 10), 0);
    assert.equal(bodyMembersV1('text', 10), 0);
    assert.equal(bodyMembersV1({}, 10), 0);
    assert.equal(bodyMembersV1({ a: 1, b: [1, 2, 3], c: { d: [{ e: 1 }] } }, 100), 3 + 3 + 1 + 1 + 1);
    // Stops early: an oversized body costs the limit to refuse, not its size.
    const huge = Array.from({ length: 200_000 }, () => 0);
    assert.equal(bodyMembersV1(huge, 10), 200_000);
    assert.ok(bodyMembersV1({ a: Array.from({ length: 50 }, () => [1, 2, 3]) }, 20) > 20);
  });

  it('lets an ordinary body through and refuses the one that was measured', async () => {
    const server = app([]);
    const plan = { calls: Array.from({ length: 10 }, (_, n) => ({ to: `0x${'11'.repeat(20)}`, data: `0x${'ab'.repeat(900)}`, valueWei: '0', n })), note: 'ordinary' };
    const fine = await request(server).post('/api/echo').send(plan);
    assert.equal(fine.status, 200);
    assert.ok(fine.body.members < 100);

    // Audit SUP-4's measurement: as many elements as fit under the parser's own 100 kb.
    const flood = JSON.stringify({ tokens: Array.from({ length: 51_000 }, () => 0) });
    assert.ok(flood.length < 100 * 1024, 'the parser itself would refuse it, and prove nothing about the bound');
    const refused = await request(server).post('/api/echo').set('Content-Type', 'application/json').send(flood);
    assert.equal(refused.status, 413);
    assert.equal(refused.body.code, 'request_body_too_many_members');

    // Spread over many small arrays it is the same number of members.
    const nested = JSON.stringify({ rows: Array.from({ length: 1_000 }, () => [0, 0, 0, 0, 0, 0]) });
    assert.equal((await request(server).post('/api/echo').set('Content-Type', 'application/json').send(nested)).status, 413);
    // At the limit exactly: through.
    const atLimit = { list: Array.from({ length: REQUEST_BODY_MAX_MEMBERS_V1 - 1 }, () => 0) };
    assert.equal((await request(server).post('/api/echo').send(atLimit)).status, 200);
  });
});
