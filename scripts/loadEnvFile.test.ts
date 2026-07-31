import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyEnvValueV1, loadRootEnvFileV1 } from './loadEnvFile.js';

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

// --- duplicate keys --------------------------------------------------------
//
// The loader and the server must resolve a repeated key the SAME way. When they
// disagreed, a `.env` carrying `LLM_BASE_URL` twice — the second one blank —
// made `pnpm smoke:llm` read the working value while the server read the empty
// one, so the smoke passed on a router that was already down.

/**
 * Runs the loader against a throwaway workspace.
 *
 * `repoRoot()` walks up from the working directory, so the fixture needs a
 * `pnpm-workspace.yaml` and the loader needs to run from inside it. Both the
 * cwd and `process.env` are restored afterwards — the loader's whole job is to
 * mutate the environment, so a test of it necessarily mutates this one.
 */
function loadIn(
  envFile: string,
  preset: Record<string, string> = {},
): { env: NodeJS.ProcessEnv; duplicateKeys: string[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mioagent-env-'));
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
  writeFileSync(join(dir, '.env'), envFile);

  const originalCwd = process.cwd();
  const originalEnv = process.env;
  process.env = { ...preset };
  process.chdir(dir);
  try {
    const loaded = loadRootEnvFileV1();
    return { env: process.env, duplicateKeys: loaded.duplicateKeys, dir };
  } finally {
    process.chdir(originalCwd);
    process.env = originalEnv;
  }
}

test('the LAST assignment wins, exactly as node --env-file resolves it', () => {
  const { env, dir } = loadIn('DUP=first\nOTHER=kept\nDUP=second\n');
  assert.equal(env.DUP, 'second');
  assert.equal(env.OTHER, 'kept');

  // Not asserted from memory — node is asked directly, on the same file.
  const fromNode = execFileSync(process.execPath, ['--env-file=.env', '-e', 'console.log(process.env.DUP)'], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  assert.equal(env.DUP, fromNode);
});

test('a blank second assignment wins too — that is the shape that broke production', () => {
  // LLM_BASE_URL=https://api.freemodel.dev ... LLM_BASE_URL=
  const { env } = loadIn('LLM_BASE_URL=https://api.example\nLLM_BASE_URL=\n');
  assert.equal(env.LLM_BASE_URL, '');
});

test('duplicated keys are reported once, by name', () => {
  const { duplicateKeys } = loadIn('A=1\nB=1\nA=2\nA=3\n');
  assert.deepEqual(duplicateKeys, ['A']);
});

test('a real process environment still beats the file', () => {
  const { env } = loadIn('FROM_FILE=file-value\n', { FROM_FILE: 'process-value' });
  assert.equal(env.FROM_FILE, 'process-value');
});
