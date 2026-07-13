export function requireTestRunId(): string {
  const runId = process.env.MIOAGENT_TEST_RUN_ID?.trim();
  if (!runId) throw new Error('MIOAGENT_TEST_RUN_ID is required for database fixtures');
  return runId;
}
export function testFixtureId(label: string): string {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  return `mio-test:${requireTestRunId()}:${safeLabel}`;
}

export function testTenantId(): string {
  const tenantId = process.env.MIOAGENT_TEST_TENANT_ID?.trim();
  if (!tenantId || !tenantId.includes(requireTestRunId())) {
    throw new Error('MIOAGENT_TEST_TENANT_ID must be unique to the current database test run');
  }
  return tenantId;
}
