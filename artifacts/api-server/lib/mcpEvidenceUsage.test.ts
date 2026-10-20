import assert from 'node:assert/strict';
import test from 'node:test';
import { logger } from '@mioagent/utils';
import { evidenceReadUsageV1 } from './mcpEvidenceUsage.js';

test('usage logs contain a tool and opaque client groups, never request contents or raw identity', t => {
  const events: Record<string, unknown>[] = [];
  const saved = logger.info;
  logger.info = (_message, metadata) => { events.push(metadata ?? {}); };
  t.after(() => { logger.info = saved; });
  const actorKey = `eip155:8453:0x${'11'.repeat(20)}`;
  const userAgent = 'ExampleClient/1 secret-test-header';
  const read = evidenceReadUsageV1({ surface: 'connected', actorKey, userAgent });
  read('list_reviewed_stocks');
  read('get_representations');
  const other = evidenceReadUsageV1({ surface: 'connected', actorKey: 'other-test-actor', userAgent });
  other('list_reviewed_stocks');
  assert.equal(events.length, 3);
  assert.equal(events[0]!.actorFingerprint, events[1]!.actorFingerprint);
  assert.equal(events[0]!.clientFingerprint, events[1]!.clientFingerprint);
  assert.notEqual(events[0]!.clientFingerprint, events[2]!.clientFingerprint);
  assert.deepEqual(Object.keys(events[0]!).sort(), ['actorFingerprint', 'clientFamily', 'clientFingerprint', 'surface', 'toolName', 'usageVersion']);
  assert.doesNotMatch(JSON.stringify(events), /secret-test-header|ExampleClient|eip155|0x111/);
});

test('known robots and operator smokes have an explicit exclusion family', t => {
  const saved = logger.info, families: unknown[] = [];
  logger.info = (_message, metadata) => { families.push(metadata?.clientFamily); };
  t.after(() => { logger.info = saved; });
  for (const userAgent of ['BrickBlueBot/1', 'Taifoon/1', 'B20Verifier/1', 'MiorailEvidenceQA/1', 'curl/8', 'ExampleClient']) {
    evidenceReadUsageV1({ surface: 'public', actorKey: 'test', userAgent })('get_representations');
  }
  assert.deepEqual(families, ['brickbluebot', 'taifoon', 'internal', 'internal', 'curl', 'unclassified']);
});
