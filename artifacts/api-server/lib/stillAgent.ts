import type { SpendProductV1 } from '@mioagent/commerce-engine';
import {
  STILL_AGENT_FREE_ERRANDS_V1,
  STILL_AGENT_PASS_ERRANDS_V1,
  STILL_ERRAND_READY_MS_V1,
  type StillAgentWireV1,
  type StillErrandWireV1,
} from '@mioagent/still-engine/agent';
import { STILL_SPEND_CAP_ATOMIC_V1 } from '@mioagent/still-engine/spend-cap';
import type { StillAgentPassV1, StillAgentV1, StillErrandV1 } from '@mioagent/route-storage';

import { spendBuyableV1, spendNeedsPhoneV1, spendPriceAtomicV1 } from './stillSpendOrders.js';

// ---------------------------------------------------------------------------
// Still Agent on the server (2026-11-22): what is open, what a wallet may
// keep, and what its page reads.
//
// STILL_AGENT_V1=on opens the agent and its errands. STILL_AGENT_PASS_V1=on,
// with STILL_AGENT_PASS_PAYEE set, opens the Agent Pass on the site; it stays
// off until Bitrefill has answered whether a pass costs its referral
// (affiliate terms §14(iii)).
// ---------------------------------------------------------------------------

export function stillAgentEnabledV1(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.STILL_AGENT_V1 ?? '').trim().toLowerCase() === 'on';
}

/** The address an Agent Pass is paid to, from the server's own configuration only; null without one. */
export function stillAgentPayeeV1(env: NodeJS.ProcessEnv = process.env): string | null {
  const payee = (env.STILL_AGENT_PASS_PAYEE ?? '').trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(payee) && !/^0x0{40}$/.test(payee) ? payee : null;
}

export function stillAgentPassOfferedV1(env: NodeJS.ProcessEnv = process.env): boolean {
  return stillAgentEnabledV1(env) && (env.STILL_AGENT_PASS_V1 ?? '').trim().toLowerCase() === 'on' && stillAgentPayeeV1(env) !== null;
}

/** The pass running at `now`, if any: the one ending last among those begun. */
export function stillAgentActivePassV1(passes: readonly StillAgentPassV1[], now: Date): StillAgentPassV1 | null {
  return passes
    .filter((pass) => Date.parse(pass.startsAt) <= now.getTime() && Date.parse(pass.endsAt) > now.getTime())
    .sort((a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt))[0] ?? null;
}

/** When the wallet's paid days run out: the end of the latest pass, if it is still ahead. */
export function stillAgentPassRunsUntilV1(passes: readonly StillAgentPassV1[], now: Date): Date | null {
  const end = Math.max(0, ...passes.map((pass) => Date.parse(pass.endsAt)));
  return end > now.getTime() ? new Date(end) : null;
}

/** Errands a wallet may keep active: one, or ten while a pass runs. */
export function stillAgentLimitV1(passes: readonly StillAgentPassV1[], now: Date): number {
  return stillAgentActivePassV1(passes, now) ? STILL_AGENT_PASS_ERRANDS_V1 : STILL_AGENT_FREE_ERRANDS_V1;
}

/** The errands that go quiet when no pass runs: all but the first ones, oldest first, up to the limit. */
export function stillAgentPausedV1(errands: readonly Pick<StillErrandV1, 'errandId' | 'createdAt'>[], limit: number): Set<string> {
  const ordered = [...errands].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.errandId.localeCompare(b.errandId));
  return new Set(ordered.slice(limit).map((errand) => errand.errandId));
}

export function stillErrandWireV1(errand: StillErrandV1, now: Date, paused: boolean): StillErrandWireV1 {
  const last = errand.lastRun;
  const fresh = last && last.told !== 'paused' && now.getTime() - Date.parse(last.dueAt) < STILL_ERRAND_READY_MS_V1;
  return {
    errandId: errand.errandId,
    kind: errand.kind,
    schedule: errand.schedule,
    timeZone: errand.timeZone,
    country: errand.country,
    productId: errand.productId,
    productName: errand.productName,
    packageValue: errand.packageValue,
    packageLabel: errand.packageLabel,
    funding: errand.funding,
    recipient: errand.recipient,
    nextDueAt: errand.nextDueAt,
    ready: fresh ? { dueAt: last.dueAt } : null,
    paused,
  };
}

export function stillAgentWirePageV1(input: {
  agent: StillAgentV1 | null;
  errands: readonly StillErrandV1[];
  passes: readonly StillAgentPassV1[];
  now: Date;
  telegramAvailable: boolean;
  ownBotAvailable: boolean;
  passOffered: boolean;
}): StillAgentWireV1 {
  const limit = stillAgentLimitV1(input.passes, input.now);
  const paused = stillAgentPausedV1(input.errands, limit);
  const active = stillAgentActivePassV1(input.passes, input.now);
  const agent = input.agent;
  return {
    outcome: 'agent',
    agent: agent ? { agentNo: agent.agentNo, name: agent.name, avatar: agent.avatar, language: agent.language, timeZone: agent.timeZone } : null,
    errands: input.errands.map((errand) => stillErrandWireV1(errand, input.now, paused.has(errand.errandId))),
    limit: { active: input.errands.length, max: limit },
    telegram: {
      available: input.telegramAvailable,
      linked: agent?.telegram !== null && agent?.telegram !== undefined,
      ownBotAvailable: input.ownBotAvailable,
      ownBot: agent?.bot ? { username: agent.bot.username, started: agent.bot.chatId !== null } : null,
    },
    pass: {
      offered: input.passOffered,
      active: active ? { plan: active.plan, endsAt: stillAgentPassRunsUntilV1(input.passes, input.now)!.toISOString() } : null,
      introUsed: input.passes.some((pass) => pass.plan === 'intro'),
    },
  };
}

/** A package as a person reads it: "15 EUR" for a card's face value, the plan's own words for anything else. */
export function stillErrandPackageLabelV1(pkg: { value: string; faceCurrency?: string | null }): string {
  const face = typeof pkg.faceCurrency === 'string' && /^[A-Z]{3}$/.test(pkg.faceCurrency) && /^\d+(?:\.\d+)?$/.test(pkg.value) ? ` ${pkg.faceCurrency}` : '';
  return `${pkg.value}${face}`;
}

export type StillErrandProductRefusalV1 = 'errand_product_unavailable' | 'errand_package_unknown' | 'errand_package_over_cap' | 'errand_needs_a_number';

/** Whether a product and package can be an errand: a card Still can pay, under its cap, with nothing more to ask. */
export function stillErrandProductCheckV1(product: SpendProductV1, packageValue: string):
  { ok: true; productName: string; packageLabel: string } | { ok: false; refusal: StillErrandProductRefusalV1 } {
  if (!product.inStock || !spendBuyableV1(product)) return { ok: false, refusal: 'errand_product_unavailable' };
  // A top-up is paid only with the number it goes to, asked at the time: not an errand.
  if (spendNeedsPhoneV1(product)) return { ok: false, refusal: 'errand_needs_a_number' };
  const pkg = product.packages.find((row) => row.value === packageValue);
  if (!pkg) return { ok: false, refusal: 'errand_package_unknown' };
  const price = spendPriceAtomicV1(pkg.priceUsdc);
  if (price === null || price > STILL_SPEND_CAP_ATOMIC_V1) return { ok: false, refusal: 'errand_package_over_cap' };
  return { ok: true, productName: product.name.trim().slice(0, 120), packageLabel: stillErrandPackageLabelV1(pkg).slice(0, 84) };
}
