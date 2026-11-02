import { stillCardFromStatusV1, stillCardPreparedV1, stillCardStatusV1, type StillCardPreparedV1, type StillCardStatusV1 } from './stillCardView';

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

export interface StillCardStoreV1 {
  get(): StillCardStateV1;
  subscribe(listener: () => void): () => void;
  openReview(): Promise<void>;
  checkAgain(): void;
  openShare(): Promise<void>;
  openTransaction(): Promise<void>;
}

const FOLLOW_MS_V1 = 6_000, BITREFILL_MS_V1 = 15_000, FOLLOW_FOR_MS_V1 = 15 * 60_000;

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
    timer = setTimeout(() => void read(), status?.phase === 'confirmed' ? BITREFILL_MS_V1 : FOLLOW_MS_V1);
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
    // A status read drawn as the card: no link, and it follows only what is still moving.
    const shown = stillCardFromStatusV1(params.structuredContent, clock.now());
    if (!shown) { set({ refusal: 'This card could not read the result. The assistant’s message has it.' }); return; }
    set({ prepared: shown.prepared, status: shown.status, refusal: null });
    if (!shown.status.settled && shown.status.phase !== 'waiting') follow();
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
