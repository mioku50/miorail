// The person's own wallet, from inside the chat: WalletConnect, paired by a
// QR code or a wallet link, because a sandboxed card has no browser wallet
// and may open no popup. The card never holds a key: it asks the wallet to
// send exactly the calls the review approved, and the wallet asks the person.
//
// What it can send decides how: a wallet that sends one batch atomically gets
// the loan and its payment as one (EIP-5792), with Still's builder code as a
// dataSuffix capability; any other gets the review in steps, each transaction
// carrying the builder code in its own calldata, as on Still's site.

export interface StillCardCallV1 { to: string; data: string; value: string }

/** The slice of WalletConnect's UniversalProvider the card uses; a test supplies its own. */
export interface StillCardProviderV1 {
  on(event: 'display_uri', listener: (uri: string) => void): void;
  connect(params: { optionalNamespaces: Record<string, { methods: string[]; chains: string[]; events: string[] }> }): Promise<unknown>;
  request<T = unknown>(args: { method: string; params?: unknown[] }, chain?: string): Promise<T>;
  disconnect(): Promise<void>;
  session?: { namespaces?: Record<string, { accounts?: string[]; methods?: string[] }> };
}

export interface StillCardWalletV1 {
  address: string;
  /** The wallet sends one atomic batch on Base. */
  batches: boolean;
  sendCalls(calls: StillCardCallV1[]): Promise<string | null>;
  sendOne(call: StillCardCallV1): Promise<string>;
  receipt(hash: string): Promise<'success' | 'reverted' | null>;
  /** The transaction hashes a sent batch landed as, once the wallet knows them. */
  batchHashes(id: string): Promise<string[] | null>;
  disconnect(): Promise<void>;
}

export const BASE_CAIP2_V1 = 'eip155:8453';
const METHODS_V1 = ['eth_sendTransaction', 'wallet_sendCalls', 'wallet_getCallsStatus', 'wallet_getCapabilities', 'eth_chainId', 'eth_accounts'];

function concatSuffixV1(data: string, suffix: string | null): string {
  return suffix ? `${data}${suffix.replace(/^0x/, '')}` : data;
}

/** Connects, reads what the wallet can send, and hands back the card's wallet. */
export async function connectStillCardWalletV1(provider: StillCardProviderV1, input: { builderSuffix: string | null; sleep?: (ms: number) => Promise<void> }):
  Promise<StillCardWalletV1> {
  await provider.connect({ optionalNamespaces: { eip155: { methods: METHODS_V1, chains: [BASE_CAIP2_V1], events: ['accountsChanged', 'chainChanged'] } } });
  const namespace = provider.session?.namespaces?.eip155;
  const account = namespace?.accounts?.find((row) => row.startsWith(`${BASE_CAIP2_V1}:`));
  if (!account) {
    await provider.disconnect().catch(() => undefined);
    throw new Error('wallet_not_on_base');
  }
  const address = account.slice(BASE_CAIP2_V1.length + 1).toLowerCase();
  const allowed = new Set(namespace?.methods ?? []);
  let batches = false;
  if (allowed.has('wallet_sendCalls') && allowed.has('wallet_getCapabilities')) {
    try {
      const capabilities = await provider.request<Record<string, { atomic?: { status?: string } }>>({ method: 'wallet_getCapabilities', params: [address, ['0x2105']] }, BASE_CAIP2_V1);
      const atomic = capabilities?.['0x2105']?.atomic?.status;
      batches = atomic === 'supported' || atomic === 'ready';
    } catch { batches = false; }
  }
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const suffix = input.builderSuffix;
  return {
    address,
    batches,
    async sendCalls(calls) {
      const answer = await provider.request<{ id?: string } | string>({ method: 'wallet_sendCalls', params: [{
        version: '2.0.0', chainId: '0x2105', from: address, atomicRequired: true,
        calls: calls.map((call) => ({ to: call.to, data: call.data, value: `0x${BigInt(call.value).toString(16)}` })),
        ...(suffix ? { capabilities: { dataSuffix: { value: suffix, optional: true } } } : {}),
      }] }, BASE_CAIP2_V1);
      return typeof answer === 'string' ? answer : answer?.id ?? null;
    },
    async sendOne(call) {
      return provider.request<string>({ method: 'eth_sendTransaction', params: [{
        from: address, to: call.to, data: concatSuffixV1(call.data, suffix), value: `0x${BigInt(call.value).toString(16)}`,
      }] }, BASE_CAIP2_V1);
    },
    async receipt(hash) {
      // Read through WalletConnect's own RPC for Base, three minutes at most.
      for (let tries = 0; tries < 90; tries++) {
        const receipt = await provider.request<{ status?: string } | null>({ method: 'eth_getTransactionReceipt', params: [hash] }, BASE_CAIP2_V1).catch(() => null);
        if (receipt?.status === '0x1') return 'success';
        if (receipt?.status === '0x0') return 'reverted';
        await sleep(2_000);
      }
      return null;
    },
    async batchHashes(id) {
      const status = await provider.request<{ status?: number; receipts?: Array<{ transactionHash?: string }> }>(
        { method: 'wallet_getCallsStatus', params: [id] }, BASE_CAIP2_V1).catch(() => null);
      const hashes = status && typeof status.status === 'number' && status.status >= 200 ? (status.receipts ?? []).map((row) => row.transactionHash ?? '') : [];
      return hashes.length > 0 && hashes.every((hash) => /^0x[0-9a-fA-F]{64}$/.test(hash)) ? hashes.map((hash) => hash.toLowerCase()) : null;
    },
    disconnect: () => provider.disconnect(),
  };
}
