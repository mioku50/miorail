import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { editorialCardSvgV1, editorialDraftsV1, type EditorialSnapshotV1 } from './editorialDraft.js';

// No social credentials, LLM requests, RPC, scheduling or public share rows.
// Run manually: node --import tsx scripts/editorial_draft.ts --at <ISO instant>
//   --out work/editorial/<date>
// Offline review: add --snapshot <a saved public-fact snapshot.json>.
// A historical run must name its own --since and --at, never today's date.
function argumentV1(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function readSnapshotV1(since: string, at: string): Promise<EditorialSnapshotV1> {
  // Import only in the explicit database mode: fixtures never load .env.
  const { client, closeDb } = await import('@mioagent/db');
  try {
    // Project only public event fields and address-bound display metadata.
    // No wallets, sessions, game participants, chat ids or arbitrary URI.
    const rows = await client`
      SELECT s.id, s.kind, s.chain_id, s.subject_address, s.official_address,
             s.occurred_at, s.recorded_at, s.facts,
             u.display_symbol AS symbol,
             (SELECT a.ticker FROM official_assets a
               WHERE a.chain_id = s.chain_id AND a.token_address = s.subject_address
               ORDER BY a.last_seen_at DESC, a.id DESC LIMIT 1) AS ticker
        FROM rwa_signals s
        LEFT JOIN representation_underlying b
          ON b.chain_id = s.chain_id AND b.token_address = s.subject_address
        LEFT JOIN underlying_asset u ON u.underlying_key = b.underlying_key
       WHERE s.chain_id = 8453 AND s.occurred_at >= ${since}::timestamptz
         AND s.occurred_at < ${at}::timestamptz AND s.recorded_at <= ${at}::timestamptz
         AND s.kind = ANY(${['official_source_added_asset', 'official_asset_dividend_declared', 'official_asset_corporate_action_announced']}::text[])
       ORDER BY s.occurred_at DESC, s.id DESC LIMIT 201`;
    const rounds = await client`
      SELECT round_id, round_number, close_at, locks_at, settled_at, stocks, calls, results
        FROM reopen_rounds
       WHERE settled_at IS NOT NULL AND settled_at >= ${since}::timestamptz
         AND settled_at <= ${at}::timestamptz
       ORDER BY settled_at DESC LIMIT 2`;
    const conversions = await client`
      SELECT to_jsonb(a) AS announcement, to_jsonb(m) AS setter,
             to_jsonb(e) AS end_announcement, to_jsonb(r) AS confirmation,
             u.display_symbol AS symbol, b.issuer_id AS issuer,
             (SELECT o.ticker FROM official_assets o
               WHERE o.chain_id = r.chain_id AND o.token_address = r.token_address
               ORDER BY o.last_seen_at DESC, o.id DESC LIMIT 1) AS ticker
        FROM representation_ratio_change r
        JOIN LATERAL (
          SELECT x.* FROM b20_corporate_actions x
           WHERE x.chain_id = r.chain_id AND x.token_address = r.token_address
             AND x.event IN ('multiplier_updated', 'ui_multiplier_updated')
             AND x.block_number <= r.block_number::bigint
             AND coalesce(x.effective_at, x.block_time) <= r.observed_at
           ORDER BY coalesce(x.effective_at, x.block_time) DESC, x.block_number DESC, x.log_index DESC
           LIMIT 1
        ) m ON m.payload_state = 'decoded'
         AND m.multiplier_wad::numeric * r.scale::numeric = r.to_raw_value::numeric * 1000000000000000000
        JOIN b20_corporate_actions a
          ON a.chain_id = m.chain_id AND a.token_address = m.token_address
         AND a.transaction_hash = m.transaction_hash AND a.event = 'announcement'
         AND a.payload_state = 'decoded' AND lower(trim(a.description)) = 'cash dividend'
         AND a.log_index < m.log_index
        JOIN b20_corporate_actions e
          ON e.chain_id = a.chain_id AND e.token_address = a.token_address
         AND e.transaction_hash = a.transaction_hash AND e.event = 'end_announcement'
         AND e.payload_state = 'decoded' AND e.announcement_id = a.announcement_id
         AND e.log_index > m.log_index
        JOIN representation_underlying b
          ON b.chain_id = r.chain_id AND b.token_address = r.token_address AND b.issuer_id = 'coinbase'
        JOIN underlying_asset u ON u.underlying_key = b.underlying_key
       WHERE r.chain_id = 8453 AND r.ratio_kind = 'b20_multiplier'
         AND r.recorded_at >= ${since}::timestamptz AND r.recorded_at <= ${at}::timestamptz
         AND r.observed_at <= ${at}::timestamptz
         AND a.observed_at <= ${at}::timestamptz
         AND m.observed_at <= ${at}::timestamptz
         AND e.observed_at <= ${at}::timestamptz
         AND NOT EXISTS (
           SELECT 1 FROM b20_corporate_actions cancelled
            WHERE cancelled.chain_id = m.chain_id AND cancelled.token_address = m.token_address
              AND cancelled.event = 'ui_multiplier_update_cancelled'
              AND cancelled.multiplier_wad = m.multiplier_wad AND cancelled.effective_at = m.effective_at
              AND cancelled.block_number >= m.block_number AND cancelled.block_number <= r.block_number::bigint
         )
       ORDER BY r.recorded_at DESC LIMIT 51`;
    const iso = (value: unknown) => new Date(value as string | Date).toISOString();
    const action = (value: unknown) => {
      const row = value as Record<string, unknown>;
      return { chainId: Number(row.chain_id), tokenAddress: row.token_address, event: row.event, payloadState: row.payload_state,
        announcementId: row.announcement_id ?? null, caller: row.caller ?? null, description: row.description ?? null, uri: row.uri ?? null,
        multiplierWad: row.multiplier_wad === null ? null : String(row.multiplier_wad), effectiveAt: row.effective_at ? iso(row.effective_at) : null,
        topics: row.topics, data: row.data, blockNumber: Number(row.block_number), blockTime: iso(row.block_time),
        transactionHash: row.transaction_hash, logIndex: Number(row.log_index), observedAt: iso(row.observed_at) };
    };
    return {
      readAt: new Date().toISOString(), signalsCapped: rows.length > 200,
      signals: rows.slice(0, 200).map((row) => ({ symbol: typeof row.symbol === 'string' ? row.symbol : null, ticker: typeof row.ticker === 'string' ? row.ticker : null,
        signal: { signalId: String(row.id), kind: row.kind as EditorialSnapshotV1['signals'][number]['signal']['kind'], chainId: Number(row.chain_id),
          subjectAddress: String(row.subject_address), officialAddress: typeof row.official_address === 'string' ? row.official_address : null,
          occurredAt: iso(row.occurred_at), recordedAt: iso(row.recorded_at), facts: row.facts as Record<string, unknown> } })),
      rounds: rounds.map((row) => ({ roundId: String(row.round_id), number: Number(row.round_number), closeAt: iso(row.close_at), locksAt: iso(row.locks_at),
        settledAt: iso(row.settled_at), stocks: row.stocks as unknown[], calls: row.calls as unknown[], results: row.results as unknown[] })),
      conversionsCapped: conversions.length > 50,
      conversions: conversions.slice(0, 50).map((row) => {
        const ratio = row.confirmation as Record<string, unknown>;
        return { issuer: String(row.issuer), symbol: typeof row.symbol === 'string' ? row.symbol : null, ticker: typeof row.ticker === 'string' ? row.ticker : null,
          announcement: action(row.announcement), setter: action(row.setter), endAnnouncement: action(row.end_announcement),
          confirmation: { chainId: Number(ratio.chain_id), tokenAddress: ratio.token_address, ratioKind: ratio.ratio_kind,
            fromRawValue: String(ratio.from_raw_value), toRawValue: String(ratio.to_raw_value), scale: String(ratio.scale),
            blockNumber: String(ratio.block_number), blockHash: ratio.block_hash, evidenceHash: ratio.evidence_hash,
            observedAt: iso(ratio.observed_at), recordedAt: iso(ratio.recorded_at) } };
      }),
    };
  } finally { await closeDb(); }
}

async function main(): Promise<void> {
  const at = new Date(argumentV1('--at') ?? Date.now()).toISOString();
  const since = new Date(argumentV1('--since') ?? Date.parse(at) - 24 * 3_600_000).toISOString();
  const snapshotPath = argumentV1('--snapshot');
  const snapshot = snapshotPath ? JSON.parse(await readFile(resolve(snapshotPath), 'utf8')) as EditorialSnapshotV1 : await readSnapshotV1(since, at);
  if (!snapshot || !Array.isArray(snapshot.signals) || !Array.isArray(snapshot.rounds) || typeof snapshot.signalsCapped !== 'boolean') throw new Error('editorial_snapshot_invalid');
  if (snapshot.conversions !== undefined && !Array.isArray(snapshot.conversions)) throw new Error('editorial_snapshot_invalid');
  const drafts = editorialDraftsV1({ snapshot, since, until: at });
  const out = resolve(argumentV1('--out') ?? `work/editorial/${at.slice(0, 10)}/${at.replace(/[:.]/g, '-')}`);
  await mkdir(out, { recursive: true, mode: 0o700 });
  // Refuse to mix today's no-news manifest with files from a previous pass.
  // Each run makes a new pack; a failed run cannot overwrite a reviewed one.
  if ((await readdir(out)).length > 0) throw new Error('editorial_output_not_empty');
  // Keep only projected draft facts. The raw snapshot may hold issuer prose;
  // neither it nor an arbitrary external URI is copied to the output pack.
  const manifest = { status: drafts.length ? 'drafts_ready' : 'no_fresh_verified_facts',
    generatedAt: snapshot.readAt, window: { since, until: at }, signalsCapped: snapshot.signalsCapped,
    signalsRead: snapshot.signals.length, roundsRead: snapshot.rounds.length, conversionsRead: snapshot.conversions?.length ?? 0,
    conversionsCapped: snapshot.conversionsCapped ?? false, drafts: drafts.map((draft) => ({ id: draft.id, kind: draft.kind })) };
  if (drafts.length) {
    const { renderCardPngV1 } = await import('../artifacts/api-server/lib/cardImage.js');
    for (const draft of drafts) {
      const svg = editorialCardSvgV1(draft);
      await writeFile(resolve(out, `${draft.id}.json`), `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
      await writeFile(resolve(out, `${draft.id}.txt`), `DRAFT — operator reviews and publishes\n\n${draft.text}\n`, { mode: 0o600 });
      await writeFile(resolve(out, `${draft.id}.svg`), svg, { mode: 0o600 });
      await writeFile(resolve(out, `${draft.id}.png`), await renderCardPngV1(svg), { mode: 0o600 });
    }
  }
  // A ready manifest is written only when every named image was rendered.
  await writeFile(resolve(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ event: 'editorial_draft', ...manifest }));
}

main().catch(() => {
  // Provider errors can contain database URLs. Report only our safe class.
  console.error(JSON.stringify({ event: 'editorial_draft', status: 'failed', errorCode: 'editorial_draft_failed' }));
  process.exitCode = 1;
});
