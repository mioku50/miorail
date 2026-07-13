import assert from 'node:assert';
import test from 'node:test';
import {
  assertSafeTestSql,
  databaseIdentityConflict,
  normalizeDatabaseIdentity,
  resolveDatabaseConnection,
} from './testDatabaseGuard';

const TEST_URL = 'postgresql://test:secret@ep-test-branch.eu-central-1.aws.neon.tech/mio_test?sslmode=require&branch_id=br-test';
const PROD_URL = 'postgresql://prod:secret@ep-prod-branch.eu-central-1.aws.neon.tech/mio?sslmode=require&branch_id=br-prod';

test('NODE_ENV=test never falls back to DATABASE_URL', () => {
  const resolution = resolveDatabaseConnection({
    NODE_ENV: 'test',
    MIOAGENT_TEST_SUITE: 'unit',
    DATABASE_URL: PROD_URL,
  });
  assert.deepEqual(resolution, { source: 'disabled', url: null, identity: null });
});
test('database suite fails before connecting when TEST_DATABASE_URL is absent', () => {
  assert.throws(
    () => resolveDatabaseConnection({
      NODE_ENV: 'test',
      MIOAGENT_TEST_SUITE: 'db',
      DATABASE_URL: PROD_URL,
    }, { requireConnection: true }),
    /TEST_DATABASE_URL is required.*fallback is forbidden/,
  );
});

test('normalized Neon pooler/direct URLs for the same endpoint conflict', () => {
  const direct = normalizeDatabaseIdentity(
    'postgres://user:a@ep-same.us-east-2.aws.neon.tech/neondb?sslmode=require',
  );
  const pooler = normalizeDatabaseIdentity(
    'postgresql://other:b@ep-same-pooler.us-east-2.aws.neon.tech:5432/neondb?connect_timeout=5',
  );
  assert.equal(direct.host, pooler.host);
  assert.equal(direct.neonEndpointId, pooler.neonEndpointId);
  assert.match(databaseIdentityConflict(direct, pooler) || '', /identical/);
});

test('matching Neon branch identifiers hard fail despite different URL strings', () => {
  assert.throws(
    () => resolveDatabaseConnection({
      NODE_ENV: 'test',
      MIOAGENT_TEST_SUITE: 'db',
      TEST_DATABASE_URL: 'postgres://test:a@ep-one.neon.tech/testdb?branch_id=br-shared',
      DATABASE_URL: 'postgres://prod:b@ep-two.neon.tech/proddb?branch=br-shared',
    }, { requireConnection: true }),
    /branch identifiers are identical/,
  );
});

test('a distinct test identity is accepted and only TEST_DATABASE_URL is selected', () => {
  const resolution = resolveDatabaseConnection({
    NODE_ENV: 'test',
    MIOAGENT_TEST_SUITE: 'db',
    TEST_DATABASE_URL: TEST_URL,
    DATABASE_URL: PROD_URL,
  }, { requireConnection: true });
  assert.equal(resolution.source, 'TEST_DATABASE_URL');
  assert.equal(resolution.url, TEST_URL);
  assert.notEqual(resolution.identity?.fingerprint, normalizeDatabaseIdentity(PROD_URL).fingerprint);
});

test('destructive SQL guard blocks DROP, TRUNCATE, and unscoped DELETE', () => {
  const runId = 't46-12345678';
  const env = {
    NODE_ENV: 'test',
    MIOAGENT_TEST_SUITE: 'db',
    MIOAGENT_TEST_RUN_ID: runId,
    MIOAGENT_TEST_TENANT_ID: `mio-test:${runId}:tenant`,
    TEST_DATABASE_URL: TEST_URL,
    DATABASE_URL: PROD_URL,
  };
  assert.throws(() => assertSafeTestSql('TRUNCATE users', env), /confirmed test database fingerprint/);
  assert.throws(() => assertSafeTestSql('DROP TABLE users', env), /confirmed test database fingerprint/);
  assert.throws(() => assertSafeTestSql('DELETE FROM users', env), /WHERE clause scoped/);
  assert.throws(() => assertSafeTestSql('DELETE FROM users WHERE id = default-user', env), /current test run id/);
  assert.doesNotThrow(() => assertSafeTestSql(
    `DELETE FROM users WHERE id LIKE 'mio-test:${runId}:%'`,
    env,
  ));
});
