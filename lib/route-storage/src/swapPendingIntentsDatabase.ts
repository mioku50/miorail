import {
  assertSwapPendingIntentV1,
  type SwapPendingIntentBindingV1,
  type SwapPendingIntentRepositoryV1,
  type SwapPendingIntentRowV1,
} from './swapPendingIntents.js';
import type { SqlTemplateExecutor } from './types.js';

function rowToPendingIntentV1(row: Record<string, unknown>): SwapPendingIntentRowV1 {
  const mode = row.protocol_mode as string | null;
  const names = row.protocol_names as string[] | null;
  return assertSwapPendingIntentV1(
    {
      tenantId: row.tenant_id,
      walletAddress: row.wallet_address,
      chainId: Number(row.chain_id),
      sourceRequestId: row.source_request_id,
      createdAt: new Date(row.created_at as string).toISOString(),
      expiresAt: new Date(row.expires_at as string).toISOString(),
      amountDecimal: row.amount_decimal ?? null,
      fromAssetSymbol: row.from_asset_symbol ?? null,
      toAssetSymbol: row.to_asset_symbol ?? null,
      optimizationMode: row.optimization_mode ?? null,
      verificationDepth: row.verification_depth ?? null,
      protocolConstraint: mode && names ? { mode, protocols: names } : null,
      // Numbers, not strings: an integer read back as text would compare and
      // serialise as a different constraint than the one stored.
      slippageMaxBps: row.slippage_max_bps === null ? null : Number(row.slippage_max_bps),
      executionRequested: row.execution_requested === null ? null : Boolean(row.execution_requested),
    },
    'read',
  );
}

export function createDatabaseSwapPendingIntentRepository(
  sql: SqlTemplateExecutor,
): SwapPendingIntentRepositoryV1 {
  return {
    async readPendingIntent(
      binding: SwapPendingIntentBindingV1,
      now: Date,
    ): Promise<SwapPendingIntentRowV1 | null> {
      // Expiry is applied by the query, not by the caller: a row that outlived
      // its question must be invisible even to a caller that forgot to check.
      const rows = await sql`
        SELECT * FROM swap_pending_intents
        WHERE tenant_id = ${binding.tenantId}
          AND wallet_address = ${binding.walletAddress.toLowerCase()}
          AND expires_at > ${now.toISOString()}::timestamptz
        LIMIT 1`;
      const row = rows[0] as Record<string, unknown> | undefined;
      return row ? rowToPendingIntentV1(row) : null;
    },

    async upsertPendingIntent(row: SwapPendingIntentRowV1): Promise<SwapPendingIntentRowV1> {
      const parsed = assertSwapPendingIntentV1(row, 'write');
      await sql`
        INSERT INTO swap_pending_intents (
          tenant_id, wallet_address, chain_id, source_request_id,
          created_at, expires_at, amount_decimal, from_asset_symbol, to_asset_symbol,
          optimization_mode, verification_depth, protocol_mode, protocol_names,
          slippage_max_bps, execution_requested
        ) VALUES (
          ${parsed.tenantId}, ${parsed.walletAddress}, ${parsed.chainId},
          ${parsed.sourceRequestId},
          ${parsed.createdAt}::timestamptz, ${parsed.expiresAt}::timestamptz,
          ${parsed.amountDecimal}, ${parsed.fromAssetSymbol}, ${parsed.toAssetSymbol},
          ${parsed.optimizationMode}, ${parsed.verificationDepth},
          ${parsed.protocolConstraint?.mode ?? null},
          ${parsed.protocolConstraint?.protocols ?? null}::text[],
          ${parsed.slippageMaxBps}, ${parsed.executionRequested}
        )
        ON CONFLICT (tenant_id, wallet_address) DO UPDATE SET
          chain_id = EXCLUDED.chain_id,
          source_request_id = EXCLUDED.source_request_id,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at,
          amount_decimal = EXCLUDED.amount_decimal,
          from_asset_symbol = EXCLUDED.from_asset_symbol,
          to_asset_symbol = EXCLUDED.to_asset_symbol,
          optimization_mode = EXCLUDED.optimization_mode,
          verification_depth = EXCLUDED.verification_depth,
          protocol_mode = EXCLUDED.protocol_mode,
          protocol_names = EXCLUDED.protocol_names,
          slippage_max_bps = EXCLUDED.slippage_max_bps,
          execution_requested = EXCLUDED.execution_requested`;
      const stored = await this.readPendingIntent(
        { tenantId: parsed.tenantId, walletAddress: parsed.walletAddress },
        new Date(parsed.createdAt),
      );
      if (!stored) throw new Error('The pending intent vanished immediately after being written');
      return stored;
    },

    async clearPendingIntent(binding: SwapPendingIntentBindingV1): Promise<void> {
      await sql`
        DELETE FROM swap_pending_intents
        WHERE tenant_id = ${binding.tenantId}
          AND wallet_address = ${binding.walletAddress.toLowerCase()}`;
    },
  };
}
