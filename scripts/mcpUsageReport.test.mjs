import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { mcpUsageReportV1 } from './mcpUsageReport.mjs';

const since = '2026-10-13T12:00:00.000Z', until = '2026-10-20T12:00:00.000Z';
const log = (ua, path = '/mcp', status = 200, day = '19', ip = '192.0.2.1') =>
  `${ip} - - [${day}/Oct/2026:10:00:00 +0000] "POST ${path} HTTP/1.1" ${status} 100 "-" "${ua}"`;
const hash = text => createHash('sha256').update(text).digest('hex');
const actorKey = 'test-operator';
const event = (overrides = {}) => JSON.stringify({
  message: 'MCP evidence read', usageVersion: 1, timestamp: '2026-10-19T12:00:00.000Z',
  toolName: 'get_representations', surface: 'connected', clientFamily: 'unclassified',
  actorFingerprint: hash(`miorail-evidence-usage/v1|connected|${actorKey}`), clientFingerprint: hash('client-a'), ...overrides,
});

test('POST counts never become tool counts; known bots, failures, other paths and the operator are excluded', async () => {
  const report = await mcpUsageReportV1({ since, until,
    nginxLines: [log('BrickBlueBot'), log('Taifoon'), log('B20Verifier'), log('curl/8'),
      log('MiorailEvidenceQA'), log('ExampleClient'), log('ExampleClient'),
      log('NoAuth', '/mcp/private', 401), log('Other', '/api/mcp'), log('Old', '/mcp', 200, '12'),
      log('Operator', '/mcp', 200, '19', '192.0.2.2')],
    journalLines: [event(), event(), event({ clientFamily: 'internal' }),
      event({ actorFingerprint: hash('another'), clientFingerprint: hash('other-client') }),
      event({ toolName: 'prepare_something' }), 'unrelated journal entry with secret'],
    excludedActors: { public: ['192.0.2.2'], connected: [actorKey] },
  });
  assert.equal(report.nginx.publicPosts, 8);
  assert.equal(report.nginx.connectedPosts, 1);
  assert.equal(report.nginx.excludedPosts, 6);
  assert.equal(report.nginx.candidateClientFingerprints, 1, 'duplicate requests do not become new clients');
  assert.equal(report.evidence.successfulReads, 4);
  assert.equal(report.evidence.excludedReads, 3);
  assert.equal(report.evidence.candidateClientFingerprints, 1);
  assert.deepEqual(report.evidence.byTool, { get_representations: 1 });
  assert.equal(report.verifiedForeignPeople, null, 'an unverified client is not a person');
  assert.doesNotMatch(JSON.stringify(report), /192\.0\.2|test-operator|other-client|secret|ExampleClient/);
});

test('empty retained journals mean unknown measurement coverage, not zero historical tool usage', async () => {
  const report = await mcpUsageReportV1({ since, until, nginxLines: [log('ExampleClient')], journalLines: [] });
  assert.equal(report.nginx.coversWindowStart, false);
  assert.equal(report.evidence.firstRetainedReadAt, null);
  assert.equal(report.evidence.successfulReads, 0);
  assert.match(report.limitations[1], /cannot be reconstructed/);
  await assert.rejects(() => mcpUsageReportV1({ since: 'bad', until, nginxLines: [], journalLines: [] }), /invalid_report_window/);
});

test('CLI reads rotated gzip logs and streams journals while returning aggregates only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'miorail-mcp-usage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'access.log'), `${log('MiorailEvidenceQA')}\n`);
  await writeFile(join(directory, 'access.log.2.gz'), gzipSync(`${log('ExampleClient')}\n`));
  await writeFile(join(directory, 'error.log'), 'should not be read');
  const result = spawnSync(process.execPath, ['scripts/mcpUsageReport.mjs', '--since', since, '--until', until,
    '--nginx-dir', directory, '--journal-stdin'], { input: `${event()}\n`, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.sources.nginxFilesRead, 2);
  assert.equal(report.nginx.publicPosts, 2);
  assert.equal(report.evidence.successfulReads, 1);
  assert.doesNotMatch(result.stdout, /192\.0\.2|test-operator|ExampleClient/);
});
