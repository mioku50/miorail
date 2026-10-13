import type { ConsoleSectionV1, TodayRouteV1 } from '@mioagent/ui';

/** A server session is not the connected wallet until both identities match. */
export function miniTodaySessionReadyV1(input: {
  walletAddress?: string;
  walletChainId?: number;
  sessionUser?: { address: string; chainId: number } | null;
}): boolean {
  return Boolean(
    input.walletAddress &&
      input.walletChainId === 8453 &&
      input.sessionUser?.chainId === 8453 &&
      input.sessionUser.address.toLowerCase() === input.walletAddress.toLowerCase(),
  );
}

/** Resume always wins over the first-visit default, including drawer pages. */
export function miniTodayHomeSectionV1(input: {
  stored: string | null;
  mounted: readonly ConsoleSectionV1[];
  signedIn: boolean;
}): ConsoleSectionV1 {
  if (input.stored && (input.mounted as readonly string[]).includes(input.stored)) {
    return input.stored as ConsoleSectionV1;
  }
  return input.signedIn ? 'today' : 'market';
}

type KnownTodayRouteV1 = Exclude<TodayRouteV1, { kind: 'unknown' }>;
export type MiniTodayHandoffV1 =
  | { kind: 'navigate'; href: string }
  | { kind: 'stock'; symbol: string }
  | { kind: 'wallet'; question: string }
  | { kind: 'routes'; goal: string };

/** Navigation and a draft only: no model, preparation or wallet execution. */
export function miniTodayHandoffV1(
  route: KnownTodayRouteV1,
  signedIn: boolean,
  appPath = '/app',
): MiniTodayHandoffV1 {
  if (route.kind === 'investigate') {
    return { kind: 'navigate', href: `/is-it-real/${encodeURIComponent(route.tokenAddress)}` };
  }
  if (route.kind === 'stock') return { kind: 'stock', symbol: route.symbol };
  if (signedIn) return route;
  const query = route.kind === 'wallet' ? 'ask' : 'goal';
  const draft = route.kind === 'wallet' ? route.question : route.goal;
  const next = `${appPath || '/'}?${query}=${encodeURIComponent(draft)}`;
  return { kind: 'navigate', href: `/signin?next=${encodeURIComponent(next)}` };
}

/** A returned sign-in/deep link fills its owner's box, never submits it. */
export function miniTodayDraftFromSearchV1(search: string):
  | Extract<MiniTodayHandoffV1, { kind: 'wallet' | 'routes' }>
  | null {
  const params = new URLSearchParams(search);
  const goal = params.get('goal')?.trim();
  if (goal && goal.length <= 500) return { kind: 'routes', goal };
  const question = params.get('ask')?.trim();
  if (question && question.length <= 500) return { kind: 'wallet', question };
  return null;
}
