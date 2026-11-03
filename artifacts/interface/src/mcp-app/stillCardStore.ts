import { stillCardFromStatusV1, stillCardPreparedV1, stillCardStatusV1, type StillCardPhaseV1, type StillCardPreparedV1, type StillCardStatusV1 } from './stillCardView';

// The card's one store: the host's notifications come in, the status reads go
// out through the host with the person's own connection to Miorail. It reads
// once when the card appears and follows only while something can change:
// after the person opens the review, or while a sent one settles. Every read
// counts against the connection's twenty requests a minute, which the
// assistant shares, so it never polls a review nobody has opened.

/** The part of the MCP Apps `App` the card uses; a test supplies its own. */
export interface StillCardHostV1 {
  ontoolresult: ((params: { structuredContent?: unknown; isError?: boolean; content?: unknown }) => void) | undefined;
  onhostcontextchanged: ((params: { theme?: string }) => void) | undefined;
  connect(): Promise<void>;
  getHostContext(): { theme?: string } | undefined;
  callServerTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{ structuredContent?: unknown; isError?: boolean }>;
  openLink(params: { url: string }): Promise<unknown>;
}

export interface StillCardStateV1 {
  prepared: StillCardPreparedV1 | null;
  /** The prepare tool refused: its own words. */
  refusal: string | null;
  status: StillCardStatusV1 | null;
  /** The last status read failed: our failure, never a fact about the review. */
  statusUnread: boolean;
  following: boolean;
  /** The host did not open the review link. */
  linkRefused: boolean;
  dark: boolean;
}

/** How the review screen asks Still, from the card: the page's own routes, as
 * the grant's wallet, through the host. Every answer names that wallet; one
 * that is not the wallet connected in the card is refused here, exactly as the
 * page refuses a review prepared for another wallet, so calls prepared for one
 * address are never sent from another. */
export type StillCardRequestV1 = <T = unknown>(path: string, options?: { method?: string; body?: BodyInit | null }) => Promise<T>;

export function stillCardRequestV1(host: Pick<StillCardHostV1, 'callServerTool'>, connected: string): StillCardRequestV1 {
  return async <T,>(path: string, options?: { method?: string; body?: BodyInit | null }): Promise<T> => {
    const method = options?.method === 'POST' ? 'POST' : 'GET';
    const body = typeof options?.body === 'string' ? JSON.parse(options.body) as Record<string, unknown> : undefined;
    const answer = await host.callServerTool({ name: 'still_card_lending', arguments: { method, path, ...(body ? { body } : {}) } });
    const reply = answer.structuredContent as { status?: unknown; body?: unknown; wallet?: unknown } | undefined;
    if (answer.isError || !reply || typeof reply.status !== 'number') throw new Error('lending_unavailable');
    if (typeof reply.wallet !== 'string' || reply.wallet.toLowerCase() !== connected.toLowerCase()) throw new Error('lending_draft_wrong_wallet');
    if (reply.status >= 400) {
      const failure = reply.body as { error?: unknown; detail?: unknown } | null;
      const code = typeof failure?.error === 'string' ? failure.error : `API error: ${reply.status}`;
      throw new Error(typeof failure?.detail === 'string' && failure.detail ? `${code}: ${failure.detail}` : code);
    }
    return reply.body as T;
  };
}

/** The WalletConnect project id the server wrote into the card; null when there is none. */
export function stillCardProjectIdV1(doc: Pick<Document, 'querySelector'>): string | null {
  const content = doc.querySelector('meta[name="still-walletconnect"]')?.getAttribute('content') ?? '';
  return /^[0-9a-f]{32}$/.test(content) ? content : null;
}

export interface StillCardStoreV1 {
  get(): StillCardStateV1;
  subscribe(listener: () => void): () => void;
  openReview(): Promise<void>;
  checkAgain(): void;
  openShare(): Promise<void>;
  openTransaction(): Promise<void>;
}

const FOLLOW_FOR_MS_V1 = 15 * 60_000;

/** How long between two reads. Each is one of the connection's twenty a minute,
 * which the assistant shares; two cards at six seconds once took all of them
 * (2026-11-02). A review being read on Still's site is slow, a transaction on its
 * way a little faster, and Bitrefill finishing an order slowest. */
export function stillCardIntervalMsV1(phase: StillCardPhaseV1 | undefined): number {
  if (phase === 'wallet' || phase === 'sent' || phase === 'unknown') return 8_000;
  return phase === 'confirmed' ? 20_000 : 15_000;
}

function refusalOfV1(content: unknown): string {
  const first = Array.isArray(content) ? content[0] as { text?: unknown } | undefined : undefined;
  const text = typeof first?.text === 'string' ? first.text : '';
  // "still_spend_over_cap: One purchase is at most…" reads as its sentence.
  return text.replace(/^[a-z0-9_]+: /, '').slice(0, 400) || 'The assistant’s request was refused. Nothing was prepared.';
}

export function createStillCardStoreV1(host: StillCardHostV1, clock: { now: () => Date } = { now: () => new Date() }): StillCardStoreV1 {
  let state: StillCardStateV1 = { prepared: null, refusal: null, status: null, statusUnread: false, following: false, linkRefused: false,
    dark: host.getHostContext()?.theme === 'dark' };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<StillCardStateV1>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  let timer: ReturnType<typeof setTimeout> | null = null, until = 0, reading = false;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const status = state.status;
    if (!state.following || (status !== null && status.settled) || clock.now().getTime() > until) {
      if (state.following) set({ following: false });
      return;
    }
    timer = setTimeout(() => void read(), stillCardIntervalMsV1(status?.phase));
  };
  const read = async () => {
    const prepared = state.prepared;
    if (!prepared || reading) return;
    reading = true;
    try {
      const answer = await host.callServerTool({ name: 'miorail_get_still_review_status', arguments: { reviewId: prepared.reviewId } });
      const status = answer.isError ? null : stillCardStatusV1(answer.structuredContent, prepared, clock.now());
      set(status ? { status, statusUnread: false } : { statusUnread: true });
      // Something is moving: keep following it without a press.
      if (status && !status.settled && status.phase !== 'waiting' && !state.following) {
        until = clock.now().getTime() + FOLLOW_FOR_MS_V1;
        set({ following: true });
      }
    } catch {
      set({ statusUnread: true });
    } finally {
      reading = false;
      schedule();
    }
  };
  const follow = () => {
    until = clock.now().getTime() + FOLLOW_FOR_MS_V1;
    set({ following: true });
    void read();
  };

  host.ontoolresult = (params) => {
    if (params.isError) { set({ refusal: refusalOfV1(params.content) }); return; }
    const prepared = stillCardPreparedV1(params.structuredContent);
    if (prepared) { set({ prepared, refusal: null }); void read(); return; }
    // A status read drawn as the card: a snapshot with no link. The card of the
    // prepared review is the one that follows; this one reads again when pressed.
    const shown = stillCardFromStatusV1(params.structuredContent, clock.now());
    if (!shown) { set({ refusal: 'This card could not read the result. The assistant’s message has it.' }); return; }
    set({ prepared: shown.prepared, status: shown.status, refusal: null });
  };
  host.onhostcontextchanged = (context) => { if (context.theme) set({ dark: context.theme === 'dark' }); };
  void host.connect().then(() => set({ dark: host.getHostContext()?.theme === 'dark' }), () => undefined);

  return {
    get: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async openReview() {
      const url = state.prepared?.reviewUrl;
      if (!url) return;
      try { await host.openLink({ url }); set({ linkRefused: false }); }
      catch { set({ linkRefused: true }); }
      follow();
    },
    checkAgain: follow,
    async openShare() {
      const url = state.status?.shareUrl;
      if (url) await host.openLink({ url }).catch(() => undefined);
    },
    async openTransaction() {
      const hash = state.status?.transactionHash;
      if (hash) await host.openLink({ url: `https://basescan.org/tx/${hash}` }).catch(() => undefined);
    },
  };
}
