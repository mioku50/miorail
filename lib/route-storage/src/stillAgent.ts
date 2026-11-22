import type { SqlTemplateExecutor } from './types.js';

// The shapes lib/still-engine/src/agent.ts validates: storage takes them as they were checked there, and the
// migration's constraints hold them again.
export type StillAgentAvatarV1 = 'pip' | 'orbit' | 'spark' | 'leaf' | 'wave' | 'star';
export type StillAgentLanguageV1 = 'en' | 'ru';
export type StillAgentPassPlanIdV1 = 'intro' | 'month' | 'year';
export type StillErrandKindV1 = 'subscription' | 'gift';
export type StillErrandScheduleV1 = { every: 'month'; day: number } | { every: 'year'; month: number; day: number };
export type StillErrandFundingV1 = { kind: 'usdc' } | { kind: 'loan'; collateral: string };

// ---------------------------------------------------------------------------
// Still Agent's storage (lib/db/drizzle/0110_still_agent.sql): a wallet's
// agent, its errands and the days they came due, the code that joins a
// Telegram chat to it, the bot Telegram made for it, and its Agent Passes.
//
// Wallets are lowercase here and never served to anyone but their owner.
// Telegram ids are strings: a bot's or a chat's id can pass 2^53.
// ---------------------------------------------------------------------------

export interface StillAgentV1 {
  walletAddress: string;
  agentNo: number;
  name: string;
  avatar: StillAgentAvatarV1;
  language: StillAgentLanguageV1;
  timeZone: string;
  createdAt: string;
  updatedAt: string;
  errandsActive: number;
  /** The chat its owner joined to Still's agents bot. */
  telegram: { chatId: string; linkedAt: string } | null;
  /** When its owner last asked for a bot of their own, and the one Telegram made. */
  botRequestedAt: string | null;
  bot: { botId: string; username: string; chatId: string | null; createdAt: string } | null;
}

export interface StillErrandInputV1 {
  walletAddress: string;
  kind: StillErrandKindV1;
  schedule: StillErrandScheduleV1;
  timeZone: string;
  country: string;
  productId: string;
  productName: string;
  packageValue: string;
  packageLabel: string;
  funding: StillErrandFundingV1;
  recipient: string | null;
}

export type StillErrandToldV1 = 'own_bot' | 'agents_bot' | 'site' | 'paused';

export interface StillErrandV1 extends StillErrandInputV1 {
  errandId: string;
  active: boolean;
  nextDueAt: string;
  createdAt: string;
  updatedAt: string;
  /** The last day it came due, and where its reminder went. */
  lastRun: { dueAt: string; told: StillErrandToldV1; toldAt: string } | null;
}

export interface StillAgentPassV1 {
  txHash: string;
  walletAddress: string;
  plan: StillAgentPassPlanIdV1;
  amountAtomic: string;
  blockNumber: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
}

export interface StillAgentRepositoryV1 {
  agentOf(walletAddress: string): Promise<StillAgentV1 | null>;
  /** Makes the wallet's agent, numbered next, or renames it. Its number never changes. */
  saveAgent(input: { walletAddress: string; name: string; avatar: StillAgentAvatarV1; language: StillAgentLanguageV1; timeZone: string; now: Date }): Promise<StillAgentV1>;

  /** Active errands, oldest first. */
  errandsOf(walletAddress: string): Promise<StillErrandV1[]>;
  /** Adds an errand while the agent has fewer than `limit` active: 'limit' otherwise, 'no_agent' without one. */
  addErrand(input: StillErrandInputV1 & { errandId: string; nextDueAt: Date; now: Date; limit: number }): Promise<StillErrandV1 | 'limit' | 'no_agent'>;
  removeErrand(input: { walletAddress: string; errandId: string; now: Date }): Promise<boolean>;
  /** Active errands due at `now`, the earliest first, each with its agent. */
  dueErrands(input: { now: Date; limit: number }): Promise<Array<{ errand: StillErrandV1; agent: StillAgentV1 }>>;
  /** Claims one due day: the run is written once, as told on the site, and the errand moves to its next day.
   * False when another pass claimed it. */
  claimRun(input: { errandId: string; dueAt: Date; nextDueAt: Date; told: 'site' | 'paused'; now: Date }): Promise<boolean>;
  /** Where the claimed day's reminder went, once it was sent. */
  markRunTold(input: { errandId: string; dueAt: Date; told: 'own_bot' | 'agents_bot'; now: Date }): Promise<void>;

  issueLinkCode(input: { codeHash: string; walletAddress: string; now: Date; expiresAt: Date }): Promise<void>;
  pruneLinkCodes(input: { before: Date }): Promise<void>;
  /** Joins the chat to the code's agent. Null for a code unknown, used or expired, or a wallet without an agent. */
  redeemLinkCode(input: { codeHash: string; chatId: string; now: Date }): Promise<{ walletAddress: string; linkedNow: boolean } | null>;
  agentsOfChat(chatId: string): Promise<StillAgentV1[]>;
  /** Every agent of the chat lets it go; the wallets, for nothing else. */
  unlinkChat(chatId: string): Promise<string[]>;
  /** The chat the wallet's agent let go, if it had one. */
  unlinkWallet(walletAddress: string): Promise<string | null>;

  /** Notes that the owner asked for a bot of their own: only with a joined chat and no bot yet. */
  requestBot(input: { walletAddress: string; now: Date }): Promise<boolean>;
  /** Gives a bot Telegram just made to the agent of the chat that asked for one last, within the hour. */
  claimBot(input: { chatId: string; botId: string; username: string; tokenEnc: string; now: Date }): Promise<StillAgentV1 | null>;
  botOf(botId: string): Promise<{ agent: StillAgentV1; tokenEnc: string } | null>;
  setBotChat(input: { botId: string; chatId: string }): Promise<void>;
  setBotToken(input: { botId: string; tokenEnc: string }): Promise<void>;
  /** Lets the wallet's bot go; what it was, so its webhook can be removed. */
  detachBot(walletAddress: string): Promise<{ botId: string; tokenEnc: string } | null>;

  /** The wallet's passes, the latest ending first. */
  passesOf(walletAddress: string): Promise<StillAgentPassV1[]>;
  /** One row per transfer: 'duplicate' for a transfer already counted, 'intro_used' for a second first-month price. */
  recordPass(input: Omit<StillAgentPassV1, 'createdAt'> & { now: Date }): Promise<'recorded' | 'duplicate' | 'intro_used'>;
}

const WALLET_V1 = /^0x[0-9a-f]{40}$/;
const ID_V1 = /^[1-9][0-9]{0,19}$/;

export function assertStillAgentWalletV1(walletAddress: string): void {
  if (!WALLET_V1.test(walletAddress)) throw new Error('still_agent_wallet_invalid');
}

export function assertStillAgentIdV1(id: string): void {
  if (!ID_V1.test(id)) throw new Error('still_agent_telegram_id_invalid');
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function idOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function stillAgentOfRowV1(row: Record<string, unknown>): StillAgentV1 {
  const chatId = idOrNull(row.tg_chat_id);
  const botId = idOrNull(row.bot_id);
  return {
    walletAddress: String(row.wallet_address),
    agentNo: Number(row.agent_no),
    name: String(row.name),
    avatar: String(row.avatar) as StillAgentAvatarV1,
    language: String(row.language) as StillAgentLanguageV1,
    timeZone: String(row.time_zone),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    errandsActive: Number(row.errands_active ?? 0),
    telegram: chatId ? { chatId, linkedAt: iso(row.tg_linked_at) } : null,
    botRequestedAt: isoOrNull(row.bot_requested_at),
    bot: botId
      ? { botId, username: String(row.bot_username), chatId: idOrNull(row.bot_chat_id), createdAt: iso(row.bot_created_at) }
      : null,
  };
}

function errandOfRowV1(row: Record<string, unknown>): StillErrandV1 {
  const schedule: StillErrandScheduleV1 = row.every === 'month'
    ? { every: 'month', day: Number(row.day) }
    : { every: 'year', month: Number(row.month), day: Number(row.day) };
  const funding: StillErrandFundingV1 = row.funding === 'loan' ? { kind: 'loan', collateral: String(row.collateral) } : { kind: 'usdc' };
  const lastDue = isoOrNull(row.last_due_at);
  return {
    errandId: String(row.errand_id),
    walletAddress: String(row.wallet_address),
    kind: String(row.kind) as StillErrandKindV1,
    schedule,
    timeZone: String(row.time_zone),
    country: String(row.country),
    productId: String(row.product_id),
    productName: String(row.product_name),
    packageValue: String(row.package_value),
    packageLabel: String(row.package_label),
    funding,
    recipient: row.recipient === null || row.recipient === undefined ? null : String(row.recipient),
    active: row.active === true,
    nextDueAt: iso(row.next_due_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastRun: lastDue ? { dueAt: lastDue, told: String(row.last_told) as StillErrandToldV1, toldAt: iso(row.last_told_at) } : null,
  };
}

function passOfRowV1(row: Record<string, unknown>): StillAgentPassV1 {
  return {
    txHash: String(row.tx_hash),
    walletAddress: String(row.wallet_address),
    plan: String(row.plan) as StillAgentPassPlanIdV1,
    amountAtomic: String(row.amount_atomic),
    blockNumber: String(row.block_number),
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    createdAt: iso(row.created_at),
  };
}

const UUID_V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertStillErrandIdV1(errandId: string): void {
  if (!UUID_V1.test(errandId)) throw new Error('still_errand_id_invalid');
}

export function createDatabaseStillAgentRepositoryV1(sql: SqlTemplateExecutor): StillAgentRepositoryV1 {
  const agentOf = async (walletAddress: string): Promise<StillAgentV1 | null> => {
    assertStillAgentWalletV1(walletAddress);
    const rows = await sql`SELECT * FROM still_agents WHERE wallet_address = ${walletAddress}`;
    return rows[0] ? stillAgentOfRowV1(rows[0]) : null;
  };
  const errandsWhere = async (walletAddress: string | null, errandIds: string[] | null): Promise<StillErrandV1[]> => {
    const rows = await sql`
      SELECT e.*, r.due_at AS last_due_at, r.told AS last_told, r.told_at AS last_told_at
      FROM still_agent_errands e
      LEFT JOIN LATERAL (
        SELECT due_at, told, told_at FROM still_agent_errand_runs WHERE errand_id = e.errand_id ORDER BY due_at DESC LIMIT 1
      ) r ON true
      WHERE (${walletAddress}::text IS NULL OR (e.wallet_address = ${walletAddress} AND e.active))
        AND (${errandIds === null ? null : `{${errandIds.join(',')}}`}::uuid[] IS NULL OR e.errand_id = ANY(${errandIds === null ? null : `{${errandIds.join(',')}}`}::uuid[]))
      ORDER BY e.created_at, e.errand_id`;
    return rows.map(errandOfRowV1);
  };
  return {
    agentOf,

    async saveAgent(input) {
      assertStillAgentWalletV1(input.walletAddress);
      const at = input.now.toISOString();
      const renamed = await sql`
        UPDATE still_agents SET name = ${input.name}, avatar = ${input.avatar}, language = ${input.language},
          time_zone = ${input.timeZone}, updated_at = ${at}::timestamptz
        WHERE wallet_address = ${input.walletAddress} RETURNING *`;
      if (renamed[0]) return stillAgentOfRowV1(renamed[0]);
      // A new agent takes the next number in one statement; two made at once race for it, and the loser
      // asks again.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const made = await sql`
          INSERT INTO still_agents (wallet_address, agent_no, name, avatar, language, time_zone, created_at, updated_at)
          SELECT ${input.walletAddress}, COALESCE((SELECT max(agent_no) FROM still_agents), 0) + 1, ${input.name}, ${input.avatar},
            ${input.language}, ${input.timeZone}, ${at}::timestamptz, ${at}::timestamptz
          ON CONFLICT DO NOTHING RETURNING *`;
        if (made[0]) return stillAgentOfRowV1(made[0]);
        const existing = await agentOf(input.walletAddress);
        if (existing) return existing;
      }
      throw new Error('still_agent_number_contended');
    },

    errandsOf: (walletAddress) => {
      assertStillAgentWalletV1(walletAddress);
      return errandsWhere(walletAddress, null);
    },

    async addErrand(input) {
      assertStillAgentWalletV1(input.walletAddress);
      assertStillErrandIdV1(input.errandId);
      const at = input.now.toISOString();
      const schedule = input.schedule;
      // The slot and the errand in one statement: the agent's row is locked by the UPDATE, so a second add at
      // the same moment sees the count the first one left.
      const rows = await sql`
        WITH slot AS (
          UPDATE still_agents SET errands_active = errands_active + 1, updated_at = ${at}::timestamptz
          WHERE wallet_address = ${input.walletAddress} AND errands_active < ${input.limit}
          RETURNING wallet_address
        )
        INSERT INTO still_agent_errands (errand_id, wallet_address, kind, every, month, day, time_zone, country, product_id, product_name,
          package_value, package_label, funding, collateral, recipient, active, next_due_at, created_at, updated_at)
        SELECT ${input.errandId}::uuid, slot.wallet_address, ${input.kind}, ${schedule.every},
          ${schedule.every === 'year' ? schedule.month : null}::smallint, ${schedule.day}::smallint, ${input.timeZone}, ${input.country},
          ${input.productId}, ${input.productName}, ${input.packageValue}, ${input.packageLabel}, ${input.funding.kind},
          ${input.funding.kind === 'loan' ? input.funding.collateral : null}, ${input.recipient}, true, ${input.nextDueAt.toISOString()}::timestamptz,
          ${at}::timestamptz, ${at}::timestamptz
        FROM slot
        RETURNING errand_id`;
      if (!rows[0]) return (await agentOf(input.walletAddress)) ? 'limit' : 'no_agent';
      return (await errandsWhere(null, [input.errandId]))[0]!;
    },

    async removeErrand(input) {
      assertStillAgentWalletV1(input.walletAddress);
      assertStillErrandIdV1(input.errandId);
      const rows = await sql`
        WITH gone AS (
          UPDATE still_agent_errands SET active = false, updated_at = ${input.now.toISOString()}::timestamptz
          WHERE errand_id = ${input.errandId}::uuid AND wallet_address = ${input.walletAddress} AND active
          RETURNING wallet_address
        )
        UPDATE still_agents a SET errands_active = GREATEST(a.errands_active - 1, 0)
        FROM gone WHERE a.wallet_address = gone.wallet_address
        RETURNING a.wallet_address`;
      return rows.length > 0;
    },

    async dueErrands(input) {
      const due = await sql`
        SELECT errand_id FROM still_agent_errands
        WHERE active AND next_due_at <= ${input.now.toISOString()}::timestamptz
        ORDER BY next_due_at, errand_id LIMIT ${input.limit}`;
      if (due.length === 0) return [];
      const errands = await errandsWhere(null, due.map((row) => String(row.errand_id)));
      const order = new Map(due.map((row, index) => [String(row.errand_id), index]));
      errands.sort((a, b) => order.get(a.errandId)! - order.get(b.errandId)!);
      const wallets = [...new Set(errands.map((errand) => errand.walletAddress))];
      const agents = await sql`SELECT * FROM still_agents WHERE wallet_address = ANY(${`{${wallets.join(',')}}`}::text[])`;
      const byWallet = new Map(agents.map((row) => [String(row.wallet_address), stillAgentOfRowV1(row)]));
      return errands.flatMap((errand) => {
        const agent = byWallet.get(errand.walletAddress);
        return agent ? [{ errand, agent }] : [];
      });
    },

    async claimRun(input) {
      const rows = await sql`
        WITH run AS (
          INSERT INTO still_agent_errand_runs (errand_id, due_at, told, told_at)
          SELECT ${input.errandId}::uuid, ${input.dueAt.toISOString()}::timestamptz, ${input.told}, ${input.now.toISOString()}::timestamptz
          WHERE EXISTS (SELECT 1 FROM still_agent_errands WHERE errand_id = ${input.errandId}::uuid AND active
            AND next_due_at = ${input.dueAt.toISOString()}::timestamptz)
          ON CONFLICT DO NOTHING
          RETURNING errand_id
        )
        UPDATE still_agent_errands e SET next_due_at = ${input.nextDueAt.toISOString()}::timestamptz, updated_at = ${input.now.toISOString()}::timestamptz
        FROM run WHERE e.errand_id = run.errand_id
        RETURNING e.errand_id`;
      return rows.length > 0;
    },

    async markRunTold(input) {
      await sql`
        UPDATE still_agent_errand_runs SET told = ${input.told}, told_at = ${input.now.toISOString()}::timestamptz
        WHERE errand_id = ${input.errandId}::uuid AND due_at = ${input.dueAt.toISOString()}::timestamptz AND told = 'site'`;
    },

    async issueLinkCode(input) {
      assertStillAgentWalletV1(input.walletAddress);
      await sql`
        INSERT INTO still_agent_link_codes (code_hash, wallet_address, created_at, expires_at)
        VALUES (${input.codeHash}, ${input.walletAddress}, ${input.now.toISOString()}::timestamptz, ${input.expiresAt.toISOString()}::timestamptz)`;
    },

    async pruneLinkCodes(input) {
      await sql`DELETE FROM still_agent_link_codes WHERE expires_at < ${input.before.toISOString()}::timestamptz`;
    },

    async redeemLinkCode(input) {
      assertStillAgentIdV1(input.chatId);
      const at = input.now.toISOString();
      const rows = await sql`
        WITH code AS (
          UPDATE still_agent_link_codes SET used_at = ${at}::timestamptz
          WHERE code_hash = ${input.codeHash} AND used_at IS NULL AND expires_at > ${at}::timestamptz
          RETURNING wallet_address
        ),
        prior AS (SELECT a.wallet_address, a.tg_chat_id FROM still_agents a JOIN code USING (wallet_address)),
        joined AS (
          UPDATE still_agents a SET tg_chat_id = ${input.chatId}::bigint,
            tg_linked_at = CASE WHEN a.tg_chat_id = ${input.chatId}::bigint THEN a.tg_linked_at ELSE ${at}::timestamptz END
          FROM code WHERE a.wallet_address = code.wallet_address
          RETURNING a.wallet_address
        )
        SELECT joined.wallet_address, prior.tg_chat_id AS prior_chat FROM joined JOIN prior USING (wallet_address)`;
      const row = rows[0];
      if (!row) return null;
      return { walletAddress: String(row.wallet_address), linkedNow: idOrNull(row.prior_chat) !== input.chatId };
    },

    async agentsOfChat(chatId) {
      assertStillAgentIdV1(chatId);
      const rows = await sql`SELECT * FROM still_agents WHERE tg_chat_id = ${chatId}::bigint ORDER BY created_at, wallet_address`;
      return rows.map(stillAgentOfRowV1);
    },

    async unlinkChat(chatId) {
      assertStillAgentIdV1(chatId);
      const rows = await sql`
        UPDATE still_agents SET tg_chat_id = NULL, tg_linked_at = NULL, bot_requested_at = NULL
        WHERE tg_chat_id = ${chatId}::bigint RETURNING wallet_address`;
      return rows.map((row) => String(row.wallet_address));
    },

    async unlinkWallet(walletAddress) {
      assertStillAgentWalletV1(walletAddress);
      const rows = await sql`
        WITH prior AS (SELECT tg_chat_id FROM still_agents WHERE wallet_address = ${walletAddress})
        UPDATE still_agents SET tg_chat_id = NULL, tg_linked_at = NULL, bot_requested_at = NULL
        WHERE wallet_address = ${walletAddress} AND tg_chat_id IS NOT NULL
        RETURNING (SELECT tg_chat_id FROM prior) AS chat_id`;
      return rows[0] ? idOrNull(rows[0].chat_id) : null;
    },

    async requestBot(input) {
      assertStillAgentWalletV1(input.walletAddress);
      const rows = await sql`
        UPDATE still_agents SET bot_requested_at = ${input.now.toISOString()}::timestamptz
        WHERE wallet_address = ${input.walletAddress} AND tg_chat_id IS NOT NULL AND bot_id IS NULL
        RETURNING wallet_address`;
      return rows.length > 0;
    },

    async claimBot(input) {
      assertStillAgentIdV1(input.chatId);
      assertStillAgentIdV1(input.botId);
      const at = input.now.toISOString();
      const rows = await sql`
        UPDATE still_agents SET bot_id = ${input.botId}::bigint, bot_username = ${input.username}, bot_token_enc = ${input.tokenEnc},
          bot_chat_id = NULL, bot_created_at = ${at}::timestamptz, bot_requested_at = NULL
        WHERE wallet_address = (
          SELECT wallet_address FROM still_agents
          WHERE tg_chat_id = ${input.chatId}::bigint AND bot_id IS NULL
            AND bot_requested_at > ${at}::timestamptz - interval '1 hour'
          ORDER BY bot_requested_at DESC, wallet_address LIMIT 1
        ) AND bot_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM still_agents WHERE bot_id = ${input.botId}::bigint)
        RETURNING *`;
      return rows[0] ? stillAgentOfRowV1(rows[0]) : null;
    },

    async botOf(botId) {
      assertStillAgentIdV1(botId);
      const rows = await sql`SELECT * FROM still_agents WHERE bot_id = ${botId}::bigint`;
      return rows[0] ? { agent: stillAgentOfRowV1(rows[0]), tokenEnc: String(rows[0].bot_token_enc) } : null;
    },

    async setBotChat(input) {
      assertStillAgentIdV1(input.botId);
      assertStillAgentIdV1(input.chatId);
      await sql`UPDATE still_agents SET bot_chat_id = ${input.chatId}::bigint WHERE bot_id = ${input.botId}::bigint`;
    },

    async setBotToken(input) {
      assertStillAgentIdV1(input.botId);
      await sql`UPDATE still_agents SET bot_token_enc = ${input.tokenEnc} WHERE bot_id = ${input.botId}::bigint`;
    },

    async detachBot(walletAddress) {
      assertStillAgentWalletV1(walletAddress);
      const rows = await sql`
        WITH prior AS (SELECT bot_id, bot_token_enc FROM still_agents WHERE wallet_address = ${walletAddress} AND bot_id IS NOT NULL)
        UPDATE still_agents SET bot_id = NULL, bot_username = NULL, bot_token_enc = NULL, bot_chat_id = NULL, bot_created_at = NULL
        WHERE wallet_address = ${walletAddress} AND bot_id IS NOT NULL
        RETURNING (SELECT bot_id FROM prior) AS bot_id, (SELECT bot_token_enc FROM prior) AS token_enc`;
      return rows[0] ? { botId: String(rows[0].bot_id), tokenEnc: String(rows[0].token_enc) } : null;
    },

    async passesOf(walletAddress) {
      assertStillAgentWalletV1(walletAddress);
      const rows = await sql`SELECT * FROM still_agent_passes WHERE wallet_address = ${walletAddress} ORDER BY ends_at DESC, tx_hash`;
      return rows.map(passOfRowV1);
    },

    async recordPass(input) {
      assertStillAgentWalletV1(input.walletAddress);
      const rows = await sql`
        INSERT INTO still_agent_passes (tx_hash, wallet_address, plan, amount_atomic, block_number, starts_at, ends_at, created_at)
        VALUES (${input.txHash}, ${input.walletAddress}, ${input.plan}, ${input.amountAtomic}::numeric, ${input.blockNumber}::bigint,
          ${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz, ${input.now.toISOString()}::timestamptz)
        ON CONFLICT DO NOTHING RETURNING tx_hash`;
      if (rows[0]) return 'recorded';
      const counted = await sql`SELECT 1 FROM still_agent_passes WHERE tx_hash = ${input.txHash}`;
      return counted[0] ? 'duplicate' : 'intro_used';
    },
  };
}
