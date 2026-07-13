import { createHash } from 'node:crypto';

export type DatabaseIdentity = {
  protocol: 'postgresql:';
  host: string;
  port: string;
  database: string;
  neonEndpointId: string | null;
  projectId: string | null;
  branchId: string | null;
  fingerprint: string;
};

export type DatabaseConnectionResolution = {
  source: 'DATABASE_URL' | 'TEST_DATABASE_URL' | 'disabled';
  url: string | null;
  identity: DatabaseIdentity | null;
};

function normalizedIdentifier(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}
function firstSearchParam(url: URL, names: string[]): string | null {
  for (const name of names) {
    const value = normalizedIdentifier(url.searchParams.get(name));
    if (value) return value;
  }
  return null;
}

function optionValue(url: URL, name: string): string | null {
  const options = url.searchParams.get('options');
  if (!options) return null;
  const match = options.match(new RegExp(`(?:^|\\s|,)-?c?\\s*${name}=([^\\s,]+)`, 'i'))
    ?? options.match(new RegExp(`(?:^|\\s|,)${name}=([^\\s,]+)`, 'i'));
  return normalizedIdentifier(match?.[1]);
}

function normalizeHost(hostname: string): { host: string; neonEndpointId: string | null } {
  const labels = hostname.trim().toLowerCase().replace(/\.$/, '').split('.');
  let neonEndpointId: string | null = null;
  if (labels.length >= 3 && labels.slice(-2).join('.') === 'neon.tech') {
    labels[0] = labels[0]!.replace(/-pooler$/, '');
    if (labels[0]!.startsWith('ep-')) neonEndpointId = labels[0]!;
  }
  return { host: labels.join('.'), neonEndpointId };
}

export function normalizeDatabaseIdentity(rawUrl: string): DatabaseIdentity {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Database URL is invalid');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('Database URL must use postgres:// or postgresql://');
  }
  const database = normalizedIdentifier(decodeURIComponent(parsed.pathname.replace(/^\/+/, '')));
  if (!database) throw new Error('Database URL must include a database name');
  const { host, neonEndpointId: hostEndpointId } = normalizeHost(parsed.hostname);
  const neonEndpointId = firstSearchParam(parsed, ['endpoint', 'endpoint_id', 'neon_endpoint_id'])
    ?? optionValue(parsed, 'endpoint')
    ?? hostEndpointId;
  const projectId = firstSearchParam(parsed, ['project', 'project_id', 'neon_project_id']);
  const branchId = firstSearchParam(parsed, ['branch', 'branch_id', 'neon_branch_id']);
  const canonical = JSON.stringify({
    protocol: 'postgresql:',
    host,
    port: parsed.port || '5432',
    database,
    neonEndpointId,
    projectId,
    branchId,
  });
  return {
    protocol: 'postgresql:',
    host,
    port: parsed.port || '5432',
    database,
    neonEndpointId,
    projectId,
    branchId,
    fingerprint: createHash('sha256').update(canonical).digest('hex').slice(0, 16),
  };
}

export function databaseIdentityConflict(
  testIdentity: DatabaseIdentity,
  productionIdentity: DatabaseIdentity,
): string | null {
  if (
    testIdentity.host === productionIdentity.host
    && testIdentity.port === productionIdentity.port
    && testIdentity.database === productionIdentity.database
  ) {
    return 'normalized host/port/database are identical';
  }
  if (
    testIdentity.neonEndpointId
    && productionIdentity.neonEndpointId
    && testIdentity.neonEndpointId === productionIdentity.neonEndpointId
    && testIdentity.database === productionIdentity.database
  ) {
    return 'Neon endpoint/branch compute and database are identical';
  }
  if (
    testIdentity.branchId
    && productionIdentity.branchId
    && testIdentity.branchId === productionIdentity.branchId
  ) {
    return 'Neon branch identifiers are identical';
  }
  if (
    testIdentity.projectId
    && productionIdentity.projectId
    && testIdentity.projectId === productionIdentity.projectId
    && testIdentity.database === productionIdentity.database
    && !testIdentity.branchId
    && !productionIdentity.branchId
    && !testIdentity.neonEndpointId
    && !productionIdentity.neonEndpointId
  ) {
    return 'Neon project/database identifiers are identical and no distinct branch is proven';
  }
  return null;
}

export function resolveDatabaseConnection(
  env: NodeJS.ProcessEnv,
  options: { requireConnection?: boolean } = {},
): DatabaseConnectionResolution {
  const isTest = env.NODE_ENV === 'test';
  if (isTest) {
    if (env.MIOAGENT_TEST_SUITE === 'unit') {
      return { source: 'disabled', url: null, identity: null };
    }
    const testUrl = env.TEST_DATABASE_URL?.trim();
    if (!testUrl) {
      if (options.requireConnection || env.MIOAGENT_TEST_SUITE === 'db') {
        throw new Error('TEST_DATABASE_URL is required for database tests; DATABASE_URL fallback is forbidden');
      }
      return { source: 'disabled', url: null, identity: null };
    }
    const testIdentity = normalizeDatabaseIdentity(testUrl);
    const productionUrl = env.DATABASE_URL?.trim();
    if (productionUrl) {
      const productionIdentity = normalizeDatabaseIdentity(productionUrl);
      const conflict = databaseIdentityConflict(testIdentity, productionIdentity);
      if (conflict) {
        throw new Error(`Refusing test database connection: TEST_DATABASE_URL conflicts with DATABASE_URL (${conflict})`);
      }
    }
    return { source: 'TEST_DATABASE_URL', url: testUrl, identity: testIdentity };
  }

  const productionUrl = env.DATABASE_URL?.trim();
  if (!productionUrl) {
    if (options.requireConnection) throw new Error('DATABASE_URL is not set in environment variables');
    return { source: 'disabled', url: null, identity: null };
  }
  return {
    source: 'DATABASE_URL',
    url: productionUrl,
    identity: normalizeDatabaseIdentity(productionUrl),
  };
}

export function assertSafeTestDatabaseEnvironment(env: NodeJS.ProcessEnv = process.env): DatabaseConnectionResolution {
  if (env.NODE_ENV !== 'test' || env.MIOAGENT_TEST_SUITE !== 'db') {
    throw new Error('Destructive database test operation requires NODE_ENV=test and MIOAGENT_TEST_SUITE=db');
  }
  return resolveDatabaseConnection(env, { requireConnection: true });
}

export function assertScopedTestCleanup(env: NodeJS.ProcessEnv = process.env): {
  runId: string;
  tenantId: string;
  connection: DatabaseConnectionResolution;
} {
  const connection = assertSafeTestDatabaseEnvironment(env);
  const runId = env.MIOAGENT_TEST_RUN_ID?.trim();
  const tenantId = env.MIOAGENT_TEST_TENANT_ID?.trim();
  if (!runId || !/^[a-z0-9-]{8,80}$/i.test(runId)) {
    throw new Error('Scoped cleanup requires a valid MIOAGENT_TEST_RUN_ID');
  }
  if (!tenantId || !tenantId.includes(runId)) {
    throw new Error('Scoped cleanup requires a run-specific MIOAGENT_TEST_TENANT_ID');
  }
  return { runId, tenantId, connection };
}

export function assertSafeTestSql(
  statement: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { runId, connection } = assertScopedTestCleanup(env);
  const normalized = statement.replace(/\s+/g, ' ').trim().toLowerCase();
  const destructiveDdl = /\b(drop|truncate)\b/.test(normalized);
  if (destructiveDdl && env.TEST_DATABASE_DESTRUCTIVE_CONFIRMATION !== connection.identity?.fingerprint) {
    throw new Error('DROP/TRUNCATE requires the confirmed test database fingerprint');
  }
  if (/\bdelete\s+from\b/.test(normalized)) {
    if (!/\bwhere\b/.test(normalized) || !normalized.includes(runId.toLowerCase())) {
      throw new Error('DELETE requires a WHERE clause scoped to the current test run id');
    }
  }
}
