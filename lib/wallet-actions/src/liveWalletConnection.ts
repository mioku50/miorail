// The page's connection to the wallet, live before the wallet is asked anything.
//
// After a reload wagmi restores the last connection from storage as a bare
// record ({ id, name, type, uid }) and keeps it until its reconnect finishes.
// useAccount already gives the address from that record, so the page says
// "Connected", but every wallet action in that window throws
// "connector.getChainId is not a function": wagmi's getConnectorClient calls
// the record's methods. On 2026-11-09 a wallet's reconnect never finished:
// four swaps failed so in one evening, the wallet was never asked, and the
// first failure even took the fee sponsor off the next press.
//
// So a press first makes sure the connection is live: it waits a moment for
// wagmi's own reconnect, then connects the same wallet again itself (the press
// is the person's gesture, and a locked wallet asks to be unlocked), and says
// plainly when neither worked.

import type { Config, Connector } from 'wagmi';
import { connect as wagmiConnect } from 'wagmi/actions';
import { WALLET_CONNECTION_NOT_READY_V1, walletAccountChangedSentenceV1 } from '@mioagent/ui';

/** How long a press waits for wagmi's own reconnect before it connects the wallet again. */
export const RECONNECT_WAIT_MS_V1 = 3_000;
/** How long the wallet has to answer that connect: it may ask to be unlocked first. */
export const CONNECT_WAIT_MS_V1 = 90_000;

/**
 * What this module reads of a wagmi config, by shape: the interface and the
 * miniapp each resolve their own copy of wagmi's types, and both fit this.
 */
export interface WalletConnectionConfigV1 {
  readonly state: {
    readonly status: string;
    readonly current: string | null;
    readonly connections: ReadonlyMap<string, { readonly connector: object; readonly accounts?: readonly string[] }>;
  };
  readonly connectors: readonly object[];
  readonly subscribe: (selector: never, listener: never) => () => void;
}

type ConnectorShapeV1 = { readonly id?: unknown; readonly getChainId?: unknown; readonly getProvider?: unknown };
type SubscribeV1 = (selector: (state: unknown) => unknown, listener: () => void) => () => void;

/** Thrown when the connection could not be brought back; its message is the page's sentence. */
export class WalletConnectionNotReadyErrorV1 extends Error {
  override name = 'WalletConnectionNotReadyError';
  constructor(options?: { cause?: unknown }) {
    super(WALLET_CONNECTION_NOT_READY_V1, options);
  }
}

/** Thrown when the wallet's connection no longer holds the account a review was made for. The wallet
 * was not asked; its message is the page's sentence. */
export class WalletAccountChangedErrorV1 extends Error {
  override name = 'WalletAccountChangedError';
  /** The account the review was made for. */
  readonly expected: string;
  constructor(expected: string) {
    super(walletAccountChangedSentenceV1(expected));
    this.expected = expected;
  }
}

/** The accounts the page's current connection to the wallet answers with, lowercase. */
export function connectedAccountsV1(config: Pick<WalletConnectionConfigV1, 'state'>): string[] {
  const uid = config.state.current;
  const accounts = uid ? config.state.connections.get(uid)?.accounts : undefined;
  return Array.isArray(accounts) ? accounts.filter((account): account is string => typeof account === 'string').map((account) => account.toLowerCase()) : [];
}

/** The current connection's connector when it is a live one, or null for a bare record. */
export function liveConnectorV1(config: Pick<WalletConnectionConfigV1, 'state'>): object | null {
  const uid = config.state.current;
  const connector = uid ? (config.state.connections.get(uid)?.connector as ConnectorShapeV1 | undefined) : undefined;
  return connector && typeof connector.getChainId === 'function' && typeof connector.getProvider === 'function' ? connector : null;
}

function rejectedByPersonV1(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (record.code === 4001 || record.name === 'UserRejectedRequestError') return true;
    current = record.cause;
  }
  return false;
}

/**
 * The live connector of the connected wallet, bringing it back when the page
 * holds only the restored record. `restored` says it had to: what the page
 * read from the wallet before (its capabilities) came through the record and
 * is worth asking again. Throws WalletConnectionNotReadyErrorV1 when it could
 * not, and the person's own refusal as it came.
 */
export async function requireLiveWalletConnectionV1(
  config: WalletConnectionConfigV1,
  options: {
    reconnectWaitMs?: number;
    connectWaitMs?: number;
    /** wagmi's connect on this config; tests pass their own. */
    connect?: (parameters: { connector: object }) => Promise<unknown>;
  } = {},
): Promise<{ connector: object; restored: boolean }> {
  const live = liveConnectorV1(config);
  if (live) return { connector: live, restored: false };

  const reconnecting = () => config.state.status === 'reconnecting' || config.state.status === 'connecting';
  if (reconnecting()) {
    const subscribe = config.subscribe as unknown as SubscribeV1;
    await new Promise<void>((resolve) => {
      let stop: () => void = () => {};
      const finish = () => {
        clearTimeout(timer);
        stop();
        resolve();
      };
      const timer = setTimeout(finish, options.reconnectWaitMs ?? RECONNECT_WAIT_MS_V1);
      stop = subscribe((state) => state, () => {
        if (liveConnectorV1(config) || !reconnecting()) finish();
      });
    });
    const after = liveConnectorV1(config);
    if (after) return { connector: after, restored: true };
  }

  // The record names the wallet: connect that one again, on this press.
  const uid = config.state.current;
  const record = uid ? (config.state.connections.get(uid)?.connector as ConnectorShapeV1 | undefined) : undefined;
  const connector = record ? config.connectors.find((candidate) => (candidate as ConnectorShapeV1).id === record.id) : undefined;
  if (!connector) throw new WalletConnectionNotReadyErrorV1();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      options.connect
        ? options.connect({ connector })
        : wagmiConnect(config as unknown as Config, { connector: connector as Connector }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new WalletConnectionNotReadyErrorV1()), options.connectWaitMs ?? CONNECT_WAIT_MS_V1);
      }),
    ]);
  } catch (cause) {
    // The person's own No stays theirs.
    if (rejectedByPersonV1(cause)) throw cause;
    // Connected meanwhile, by wagmi's own reconnect or another press.
    const meanwhile = liveConnectorV1(config);
    if (meanwhile) return { connector: meanwhile, restored: true };
    throw cause instanceof WalletConnectionNotReadyErrorV1 ? cause : new WalletConnectionNotReadyErrorV1({ cause });
  } finally {
    clearTimeout(timer);
  }
  const connected = liveConnectorV1(config);
  if (!connected) throw new WalletConnectionNotReadyErrorV1();
  return { connector: connected, restored: true };
}

/**
 * A live connection that holds `account`, the wallet a review was made for (audit WAL-1, 2026-11-10).
 *
 * Bringing a restored connection back asks the wallet which account it is now, and the answer may
 * be another one than the page showed and the server reviewed. A send that names no account goes
 * from whichever account answered: a swap of the other account's tokens, or its USDC repaying this
 * one's loan. So every send is preceded by this, and names the same account itself; wagmi then
 * refuses a connection that does not hold it before the wallet is asked.
 */
export async function requireLiveWalletAccountV1(
  config: WalletConnectionConfigV1,
  account: string,
  options: Parameters<typeof requireLiveWalletConnectionV1>[1] = {},
): Promise<{ connector: object; restored: boolean }> {
  const live = await requireLiveWalletConnectionV1(config, options);
  if (!connectedAccountsV1(config).includes(account.toLowerCase())) throw new WalletAccountChangedErrorV1(account);
  return live;
}
