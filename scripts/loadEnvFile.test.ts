import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyEnvValueV1 } from './loadEnvFile.js';

// A pasted inline comment is the failure mode this classifier exists for:
// dotenv strips it, systemd EnvironmentFile and docker --env-file do not.

test('a plain value passes through', () => {
  assert.deepEqual(classifyEnvValueV1('true'), { kind: 'value', value: 'true' });
  assert.deepEqual(classifyEnvValueV1('  abc123  '), { kind: 'value', value: 'abc123' });
});

test('a comment-only value is treated as UNSET, not as a credential', () => {
  // `BITREFILL_ACCESS_TOKEN=                # SIWX→JWT, ~2h`
  assert.deepEqual(classifyEnvValueV1('                # SIWX session token'), {
    kind: 'comment_only',
    value: '',
  });
  assert.deepEqual(classifyEnvValueV1('#anything'), { kind: 'comment_only', value: '' });
});

test('a trailing comment keeps the raw value and is reported', () => {
  // Kept raw on purpose: stripping it here would make the smoke pass against a
  // value the server never sees.
  assert.deepEqual(classifyEnvValueV1('false        # comparison only'), {
    kind: 'trailing_comment',
    value: 'false        # comparison only',
  });
});

test('a quoted value is unambiguous and never flagged', () => {
  assert.deepEqual(classifyEnvValueV1('"false # not a comment"'), {
    kind: 'value',
    value: 'false # not a comment',
  });
  assert.deepEqual(classifyEnvValueV1("'sk-abc#123'"), { kind: 'value', value: 'sk-abc#123' });
});

test('a hash inside a value without whitespace is a real value', () => {
  assert.deepEqual(classifyEnvValueV1('sk-abc#123'), { kind: 'value', value: 'sk-abc#123' });
});
