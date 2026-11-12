import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { LendingReviewScreen, STILL_PUBLIC_ORIGIN_V1, useLendingReviewConsoleV1, type LendingStepsWalletV1 } from '@mioagent/ui';
import { builderCodeForSurfaceV1, builderCodeToDataSuffix } from '@mioagent/wallet-actions/attribution';
import { connectStillCardWalletV1, type StillCardProviderV1, type StillCardWalletV1 } from './stillCardWallet';
import { stillCardHandsHashV1, stillCardLooksUpBatchV1 } from './stillCardRecovery';
import { stillCardRequestV1, type StillCardHostV1, type StillCardRequestV1 } from './stillCardStore';

// Signing inside the chat: the person's phone wallet pairs by WalletConnect,
// and the card shows the review Still's page shows, through the same controller
// and screen, asked through the host as the grant's wallet. Nothing is asked of
// Still before a wallet is connected here, and the wallet asks the person.

const BUILDER_SUFFIX_V1 = builderCodeToDataSuffix(builderCodeForSurfaceV1({
  VITE_BASE_BUILDER_CODE: import.meta.env?.VITE_BASE_BUILDER_CODE as string | undefined,
  VITE_BUILDER_CODE: import.meta.env?.VITE_BUILDER_CODE as string | undefined,
})) ?? null;

/** Before a wallet is connected, the review is not asked for at all. */
const NOT_CONNECTED_V1: StillCardRequestV1 = async () => { throw new Error('authentication_required'); };

function PairingCodeV1({ uri }: { uri: string }) {
  // Drawn here from the pairing link: no image is fetched, no data URL is needed.
  const svg = useMemo(() => {
    const code = qrcode(0, 'M');
    code.addData(uri);
    code.make();
    return code.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [uri]);
  return <div className="still-mcp-qr" role="img" aria-label="WalletConnect pairing code" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function StillCardSign({ host, draft, projectId, reviewHost, onSent }: {
  host: Pick<StillCardHostV1, 'callServerTool'>; draft: string; projectId: string;
  /** Where the review opens, as the card's button names it. */
  reviewHost: string;
  /** The wallet sent it: the card's own status starts following. */
  onSent: () => void;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const [wallet, setWallet] = useState<StillCardWalletV1 | null>(null);
  const [pairing, setPairing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const provider = useRef<StillCardProviderV1 | null>(null);

  const pair = useCallback(async () => {
    setPairing(true);
    setFailure(null);
    try {
      const { UniversalProvider } = await import('@walletconnect/universal-provider');
      const instance = await UniversalProvider.init({ projectId, metadata: {
        name: 'Still', description: 'A Still review, signed in your own wallet.',
        // The chat's own sandbox is where this runs, and a wallet that checks would read Still's host as a mismatch.
        // A sandbox with no origin of its own ("null") has nothing to check against; then the wallet is told Still's.
        url: window.location.origin && window.location.origin !== 'null' ? window.location.origin : STILL_PUBLIC_ORIGIN_V1,
        icons: [`${STILL_PUBLIC_ORIGIN_V1}/miniapp-icon.png`],
      } });
      instance.on('display_uri', (value: string) => setUri(value));
      provider.current = instance as unknown as StillCardProviderV1;
      setWallet(await connectStillCardWalletV1(provider.current, { builderSuffix: BUILDER_SUFFIX_V1 }));
      setUri(null);
    } catch (error) {
      setUri(null);
      setFailure(error instanceof Error && error.message === 'wallet_not_on_base'
        ? `The wallet connected without Base. Connect it on Base, or review on ${reviewHost}.`
        : `The wallet did not connect. Try again, or review on ${reviewHost}.`);
    } finally {
      setPairing(false);
    }
  }, [projectId, reviewHost]);
  const disconnect = useCallback(async () => {
    await provider.current?.disconnect().catch(() => undefined);
    provider.current = null;
    setWallet(null);
  }, []);
  useEffect(() => () => { void provider.current?.disconnect().catch(() => undefined); }, []);

  const request = useMemo(() => (wallet ? stillCardRequestV1(host, wallet.address) : NOT_CONNECTED_V1), [host, wallet]);
  const steps = useMemo<LendingStepsWalletV1 | null>(() => (wallet && !wallet.batches
    ? { send: (call) => wallet.sendOne(call), receipt: (hash) => wallet.receipt(hash) } : null), [wallet]);
  const review = useLendingReviewConsoleV1({
    draft: wallet ? draft : null, sessionWalletAddress: wallet?.address ?? null, walletAddress: wallet?.address ?? null,
    sendCalls: async ({ calls }) => (wallet ? wallet.sendCalls(calls) : null), steps, walletName: 'Your wallet', request,
    // The card follows the wallet's own status below, on its own clock, through the host.
    autoResult: false,
  });

  // A batch only Coinbase's wallets can name from Still's server is found by
  // its transaction hash, asked of the wallet itself, then verified by Still.
  const { batchId, execution, transactionHint, checking, onTransactionHint, onFindTransaction } = review.model;
  const found = useRef<string | null>(null);
  const handed = useRef<string | null>(null);
  // Another review starts with nothing found and nothing handed.
  useEffect(() => { found.current = null; handed.current = null; }, [draft]);
  const looking = stillCardLooksUpBatchV1({ paired: Boolean(wallet), batchId: batchId ?? null, executionState: execution?.state ?? null, found: found.current });
  useEffect(() => {
    if (!wallet || !batchId || !looking) return undefined;
    let live = true;
    const timer = setInterval(() => {
      void wallet.batchHashes(batchId).then((hashes) => {
        if (!live || !hashes?.length || found.current) return;
        found.current = hashes[hashes.length - 1]!;
        onTransactionHint?.(found.current);
      });
    }, 3_000);
    return () => { live = false; clearInterval(timer); };
  }, [wallet, batchId, looking, onTransactionHint]);
  useEffect(() => {
    if (!stillCardHandsHashV1({ found: found.current, hint: transactionHint ?? '', checking, handed: handed.current })) return;
    handed.current = found.current;
    void onFindTransaction?.();
  }, [transactionHint, checking, onFindTransaction]);
  const sent = Boolean(batchId) || (execution !== null && execution.state !== 'ready');
  const told = useRef(false);
  // Once: the card's status then follows on its own clock.
  useEffect(() => { if (sent && !told.current) { told.current = true; onSent(); } }, [sent, onSent]);

  if (!wallet) {
    return (
      <div className="still-mcp-sign">
        {uri ? (
          <>
            <PairingCodeV1 uri={uri} />
            <p className="still-note">Scan it with your wallet app: Base App, MetaMask, Rabby, Rainbow or any wallet with WalletConnect. Connect the wallet this review was prepared for.</p>
            <details className="still-note"><summary>The pairing link</summary><code className="still-mcp-uri">{uri}</code></details>
          </>
        ) : (
          <button type="button" className="still-btn sec" disabled={pairing} onClick={() => void pair()}>
            {pairing ? 'Preparing the code…' : 'Sign here with a phone wallet'}
          </button>
        )}
        {failure ? <p className="still-warn" role="alert">{failure}</p> : null}
      </div>
    );
  }
  return (
    <div className="still-mcp-sign">
      <p className="still-note">
        Connected: <span className="mono">{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</span> · {wallet.batches ? 'sends it as one transaction' : 'sends it in steps'}
        {' '}<button type="button" className="still-mcp-link" onClick={() => void disconnect()}>Disconnect</button>
      </p>
      <LendingReviewScreen model={review.model} />
    </div>
  );
}
