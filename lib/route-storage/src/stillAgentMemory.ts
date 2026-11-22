import {
  assertStillAgentIdV1,
  assertStillAgentWalletV1,
  assertStillErrandIdV1,
  type StillAgentPassV1,
  type StillAgentRepositoryV1,
  type StillAgentV1,
  type StillErrandToldV1,
  type StillErrandV1,
} from './stillAgent.js';

// ---------------------------------------------------------------------------
// Still Agent's storage in memory, for tests and local runs: the same contract
// as Postgres (test/stillAgent.contract.ts runs against both).
// ---------------------------------------------------------------------------

type ErrandRowV1 = Omit<StillErrandV1, 'lastRun'>;
interface RunRowV1 { errandId: string; dueAt: string; told: StillErrandToldV1; toldAt: string }
interface CodeRowV1 { walletAddress: string; createdAt: string; expiresAt: string; usedAt: string | null }
interface AgentRowV1 extends StillAgentV1 { tokenEnc: string | null }

const clone = <T>(value: T): T => structuredClone(value);

export function createMemoryStillAgentRepositoryV1(): StillAgentRepositoryV1 {
  const agents = new Map<string, AgentRowV1>();
  const errands = new Map<string, ErrandRowV1>();
  const runs: RunRowV1[] = [];
  const codes = new Map<string, CodeRowV1>();
  const passes = new Map<string, StillAgentPassV1>();

  const publicAgent = (row: AgentRowV1): StillAgentV1 => {
    const { tokenEnc, ...agent } = row;
    void tokenEnc;
    return clone(agent);
  };
  const withRun = (row: ErrandRowV1): StillErrandV1 => {
    const last = runs.filter((run) => run.errandId === row.errandId).sort((a, b) => Date.parse(b.dueAt) - Date.parse(a.dueAt))[0];
    return clone({ ...row, lastRun: last ? { dueAt: last.dueAt, told: last.told, toldAt: last.toldAt } : null });
  };
  const byCreation = (a: { createdAt: string; walletAddress?: string; errandId?: string }, b: typeof a) =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || String(a.errandId ?? a.walletAddress).localeCompare(String(b.errandId ?? b.walletAddress));

  return {
    async agentOf(walletAddress) {
      assertStillAgentWalletV1(walletAddress);
      const row = agents.get(walletAddress);
      return row ? publicAgent(row) : null;
    },

    async saveAgent(input) {
      assertStillAgentWalletV1(input.walletAddress);
      const at = input.now.toISOString();
      const existing = agents.get(input.walletAddress);
      if (existing) {
        Object.assign(existing, { name: input.name, avatar: input.avatar, language: input.language, timeZone: input.timeZone, updatedAt: at });
        return publicAgent(existing);
      }
      const agentNo = Math.max(0, ...[...agents.values()].map((row) => row.agentNo)) + 1;
      const row: AgentRowV1 = {
        walletAddress: input.walletAddress, agentNo, name: input.name, avatar: input.avatar, language: input.language, timeZone: input.timeZone,
        createdAt: at, updatedAt: at, errandsActive: 0, telegram: null, botRequestedAt: null, bot: null, tokenEnc: null,
      };
      agents.set(input.walletAddress, row);
      return publicAgent(row);
    },

    async errandsOf(walletAddress) {
      assertStillAgentWalletV1(walletAddress);
      return [...errands.values()].filter((row) => row.walletAddress === walletAddress && row.active).sort(byCreation).map(withRun);
    },

    async addErrand(input) {
      assertStillAgentWalletV1(input.walletAddress);
      assertStillErrandIdV1(input.errandId);
      const agent = agents.get(input.walletAddress);
      if (!agent) return 'no_agent';
      if (agent.errandsActive >= input.limit) return 'limit';
      if (errands.has(input.errandId)) throw new Error('duplicate key value violates unique constraint');
      const at = input.now.toISOString();
      const { limit, now, nextDueAt, ...fields } = input;
      void limit; void now;
      const row: ErrandRowV1 = { ...clone(fields), active: true, nextDueAt: nextDueAt.toISOString(), createdAt: at, updatedAt: at };
      errands.set(input.errandId, row);
      agent.errandsActive += 1;
      agent.updatedAt = at;
      return withRun(row);
    },

    async removeErrand(input) {
      assertStillAgentWalletV1(input.walletAddress);
      assertStillErrandIdV1(input.errandId);
      const row = errands.get(input.errandId);
      if (!row || row.walletAddress !== input.walletAddress || !row.active) return false;
      row.active = false;
      row.updatedAt = input.now.toISOString();
      const agent = agents.get(input.walletAddress);
      if (agent) agent.errandsActive = Math.max(agent.errandsActive - 1, 0);
      return true;
    },

    async dueErrands(input) {
      return [...errands.values()]
        .filter((row) => row.active && Date.parse(row.nextDueAt) <= input.now.getTime())
        .sort((a, b) => Date.parse(a.nextDueAt) - Date.parse(b.nextDueAt) || a.errandId.localeCompare(b.errandId))
        .slice(0, input.limit)
        .flatMap((row) => {
          const agent = agents.get(row.walletAddress);
          return agent ? [{ errand: withRun(row), agent: publicAgent(agent) }] : [];
        });
    },

    async claimRun(input) {
      const row = errands.get(input.errandId);
      const dueAt = input.dueAt.toISOString();
      if (!row || !row.active || row.nextDueAt !== dueAt) return false;
      if (runs.some((run) => run.errandId === input.errandId && run.dueAt === dueAt)) return false;
      runs.push({ errandId: input.errandId, dueAt, told: input.told, toldAt: input.now.toISOString() });
      row.nextDueAt = input.nextDueAt.toISOString();
      row.updatedAt = input.now.toISOString();
      return true;
    },

    async markRunTold(input) {
      const run = runs.find((row) => row.errandId === input.errandId && row.dueAt === input.dueAt.toISOString() && row.told === 'site');
      if (run) Object.assign(run, { told: input.told, toldAt: input.now.toISOString() });
    },

    async issueLinkCode(input) {
      assertStillAgentWalletV1(input.walletAddress);
      if (codes.has(input.codeHash)) throw new Error('duplicate key value violates unique constraint');
      codes.set(input.codeHash, { walletAddress: input.walletAddress, createdAt: input.now.toISOString(), expiresAt: input.expiresAt.toISOString(), usedAt: null });
    },

    async pruneLinkCodes(input) {
      for (const [hash, row] of codes) if (Date.parse(row.expiresAt) < input.before.getTime()) codes.delete(hash);
    },

    async redeemLinkCode(input) {
      assertStillAgentIdV1(input.chatId);
      const code = codes.get(input.codeHash);
      if (!code || code.usedAt !== null || Date.parse(code.expiresAt) <= input.now.getTime()) return null;
      code.usedAt = input.now.toISOString();
      const agent = agents.get(code.walletAddress);
      if (!agent) return null;
      const linkedNow = agent.telegram?.chatId !== input.chatId;
      if (linkedNow) agent.telegram = { chatId: input.chatId, linkedAt: input.now.toISOString() };
      return { walletAddress: code.walletAddress, linkedNow };
    },

    async agentsOfChat(chatId) {
      assertStillAgentIdV1(chatId);
      return [...agents.values()].filter((row) => row.telegram?.chatId === chatId).sort(byCreation).map(publicAgent);
    },

    async unlinkChat(chatId) {
      assertStillAgentIdV1(chatId);
      const out: string[] = [];
      for (const row of agents.values()) {
        if (row.telegram?.chatId !== chatId) continue;
        row.telegram = null;
        row.botRequestedAt = null;
        out.push(row.walletAddress);
      }
      return out;
    },

    async unlinkWallet(walletAddress) {
      assertStillAgentWalletV1(walletAddress);
      const row = agents.get(walletAddress);
      if (!row?.telegram) return null;
      const chatId = row.telegram.chatId;
      row.telegram = null;
      row.botRequestedAt = null;
      return chatId;
    },

    async requestBot(input) {
      assertStillAgentWalletV1(input.walletAddress);
      const row = agents.get(input.walletAddress);
      if (!row?.telegram || row.bot) return false;
      row.botRequestedAt = input.now.toISOString();
      return true;
    },

    async claimBot(input) {
      assertStillAgentIdV1(input.chatId);
      assertStillAgentIdV1(input.botId);
      if ([...agents.values()].some((row) => row.bot?.botId === input.botId)) return null;
      const since = input.now.getTime() - 60 * 60 * 1000;
      const row = [...agents.values()]
        .filter((agent) => agent.telegram?.chatId === input.chatId && !agent.bot && agent.botRequestedAt && Date.parse(agent.botRequestedAt) > since)
        .sort((a, b) => Date.parse(b.botRequestedAt!) - Date.parse(a.botRequestedAt!) || a.walletAddress.localeCompare(b.walletAddress))[0];
      if (!row) return null;
      row.bot = { botId: input.botId, username: input.username, chatId: null, createdAt: input.now.toISOString() };
      row.tokenEnc = input.tokenEnc;
      row.botRequestedAt = null;
      return publicAgent(row);
    },

    async botOf(botId) {
      assertStillAgentIdV1(botId);
      const row = [...agents.values()].find((agent) => agent.bot?.botId === botId);
      return row ? { agent: publicAgent(row), tokenEnc: row.tokenEnc! } : null;
    },

    async setBotChat(input) {
      assertStillAgentIdV1(input.botId);
      assertStillAgentIdV1(input.chatId);
      const row = [...agents.values()].find((agent) => agent.bot?.botId === input.botId);
      if (row?.bot) row.bot.chatId = input.chatId;
    },

    async setBotToken(input) {
      assertStillAgentIdV1(input.botId);
      const row = [...agents.values()].find((agent) => agent.bot?.botId === input.botId);
      if (row) row.tokenEnc = input.tokenEnc;
    },

    async detachBot(walletAddress) {
      assertStillAgentWalletV1(walletAddress);
      const row = agents.get(walletAddress);
      if (!row?.bot) return null;
      const out = { botId: row.bot.botId, tokenEnc: row.tokenEnc! };
      row.bot = null;
      row.tokenEnc = null;
      return out;
    },

    async passesOf(walletAddress) {
      assertStillAgentWalletV1(walletAddress);
      return [...passes.values()]
        .filter((row) => row.walletAddress === walletAddress)
        .sort((a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt) || a.txHash.localeCompare(b.txHash))
        .map(clone);
    },

    async recordPass(input) {
      assertStillAgentWalletV1(input.walletAddress);
      if (passes.has(input.txHash)) return 'duplicate';
      if (input.plan === 'intro' && [...passes.values()].some((row) => row.walletAddress === input.walletAddress && row.plan === 'intro')) return 'intro_used';
      const { now, ...row } = input;
      passes.set(input.txHash, { ...row, createdAt: now.toISOString() });
      return 'recorded';
    },
  };
}
