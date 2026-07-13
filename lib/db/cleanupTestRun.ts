import postgres from 'postgres';
import { assertSafeTestSql, assertScopedTestCleanup } from './testDatabaseGuard';

async function main(): Promise<void> {
  const { runId, tenantId, connection } = assertScopedTestCleanup();
  const runPrefix = `mio-test:${runId}:%`;

  // This representative statement makes the destructive policy explicit before
  // any connection is opened. DROP/TRUNCATE and unscoped DELETE remain blocked.
  assertSafeTestSql(`DELETE FROM users WHERE id = '${tenantId}' OR id LIKE '${runPrefix}'`);

  const sql = postgres(connection.url!, {
    max: 1,
    prepare: false,
    ssl: connection.identity?.host.endsWith('.neon.tech') ? 'require' : false,
  });

  try {
    await sql.begin(async (tx) => {
    await tx`delete from spend_permission_proofs where permission_id in (
      select id from spend_permissions where user_id = ${tenantId} or user_id like ${runPrefix}
    )`;
    await tx`delete from autonomy_execution_reservations where user_id = ${tenantId} or user_id like ${runPrefix}`;
    await tx`delete from prepared_transaction_intents where user_id = ${tenantId} or user_id like ${runPrefix}`;
    await tx`delete from base_mcp_oauth_states where user_id = ${tenantId} or user_id like ${runPrefix}`;
    await tx`delete from base_mcp_oauth_tokens where user_id = ${tenantId} or user_id like ${runPrefix}`;
    await tx`delete from user_settings where user_id = ${tenantId} or user_id like ${runPrefix}`;
    await tx`delete from audit_logs where user_id = ${tenantId} or user_id like ${runPrefix}`;
    await tx`delete from x402_receipts where user_id = ${tenantId} or user_id like ${runPrefix} or id like ${runPrefix}`;
    await tx`delete from chats where user_id = ${tenantId} or user_id like ${runPrefix}`;
    await tx`delete from actions where user_id = ${tenantId} or user_id like ${runPrefix}`;
    await tx`delete from workflows where user_id = ${tenantId} or user_id like ${runPrefix}`;
    await tx`delete from spend_permissions where user_id = ${tenantId} or user_id like ${runPrefix}`;
    await tx`delete from autonomy_policies where user_id = ${tenantId} or user_id like ${runPrefix}`;
    await tx`delete from users where id = ${tenantId} or id like ${runPrefix}`;
    });
    console.log(`Cleaned fixtures for test run ${runId}.`);
  } finally {
    await sql.end();
  }
}

void main();
