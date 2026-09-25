import { useCallback, useEffect, useState } from 'react';
import { useAccount, useDisconnect, useSwitchChain, useWalletClient } from 'wagmi';
import { mapPaidActionError, runX402PaidFetch, type PaidActionState } from '@mioagent/x402-actions';
import { WalletPicker } from '../../shell/WalletPicker';
import {
  PAID_API_EXAMPLE_TOKEN_V1,
  PAID_RESOURCES_V1,
  X402_INTELLIGENCE_BASE_V1,
  basescanTxUrlV1,
  examplesOfV1,
  paidRequestUrlV1,
  paidStateLineV1,
  payerRefusalV1,
  paymentTermsFromHeaderV1,
  renderedAnswerV1,
  usdcLabelV1,
  type PaidResourceV1,
  type PaymentTermsV1,
} from './paidApiView';

// ---------------------------------------------------------------------------
// /x402 — the paid API, public.
//
// No session: a reader deciding whether to point an agent here should see the
// price and the answers first. A wallet is connected only to pay, and the only
// thing it signs is one USDC authorization for the price the server's own 402
// names.
// ---------------------------------------------------------------------------

const BASE_CHAIN_ID = 8453;
const ORIGIN = typeof window === 'undefined' ? 'https://miorail.xyz' : window.location.origin;

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** The price and payTo, from a request that names no input: the server
 * answers it with its 402 and charges nothing. */
function usePaymentTerms(): PaymentTermsV1 | null | undefined {
  const [terms, setTerms] = useState<PaymentTermsV1 | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    fetch(`${X402_INTELLIGENCE_BASE_V1}/address/identity`, { headers: { accept: 'application/json' } })
      .then((response) => {
        if (!cancelled) setTerms(paymentTermsFromHeaderV1(response.headers.get('payment-required')));
      })
      .catch(() => {
        if (!cancelled) setTerms(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return terms;
}

interface AnswerV1 {
  body: unknown;
  txHash: string | null;
}

function ResourceCard({
  resource,
  price,
  payBlocked,
}: {
  resource: PaidResourceV1;
  price: string;
  payBlocked: string | null;
}) {
  const { isConnected, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { switchChain } = useSwitchChain();
  const [values, setValues] = useState<Record<string, string>>(() => examplesOfV1(resource));
  const [state, setState] = useState<PaidActionState | 'idle'>('idle');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AnswerV1 | null>(null);

  const busy = ['preparing_payment', 'awaiting_wallet_confirmation', 'awaiting_wallet', 'submitted', 'settling_payment', 'settling', 'running_action'].includes(state);

  const pay = useCallback(async () => {
    if (busy) return;
    setRefusal(null);
    setAnswer(null);
    const built = paidRequestUrlV1(resource, values);
    if (!built.ok) {
      setRefusal(built.refusal);
      return;
    }
    if (payBlocked) {
      setRefusal(payBlocked);
      return;
    }
    if (!isConnected || !walletClient) {
      setState('unsupported_wallet');
      return;
    }
    if (chainId !== BASE_CHAIN_ID) {
      switchChain?.({ chainId: BASE_CHAIN_ID });
      return;
    }
    try {
      const result = await runX402PaidFetch({
        route: built.url,
        walletClient,
        expectedChainId: BASE_CHAIN_ID,
        onState: setState,
      });
      setAnswer({ body: result.body, txHash: result.receipt?.txHash ?? null });
      setState(result.receipt?.txHash ? 'succeeded' : 'settled_degraded');
    } catch (error) {
      const mapped = mapPaidActionError(error);
      setState(mapped.state);
      // The server checks the input and loads its evidence BEFORE it names a
      // price, so a 4xx here never reached the wallet. A 5xx may have come
      // after, and is reported without that claim.
      if (mapped.state === 'failed' && mapped.status) {
        setRefusal(
          mapped.status >= 400 && mapped.status < 500
            ? `The server answered HTTP ${mapped.status} before naming a price, so nothing was signed or paid.`
            : `The server answered HTTP ${mapped.status}.`,
        );
      }
    }
  }, [busy, chainId, isConnected, payBlocked, resource, switchChain, values, walletClient]);

  const line = paidStateLineV1(state, price);
  const txUrl = basescanTxUrlV1(answer?.txHash);

  return (
    <section className="panel pi-verdict">
      <div className="cr-top">
        <span className="cr-name">{resource.title}</span>
        <span className="pill cr-status" data-tone="neutral">{price}</span>
      </div>
      <p className="lnote">{resource.question}</p>
      <form
        className="pi-form"
        onSubmit={(event) => {
          event.preventDefault();
          void pay();
        }}
      >
        {resource.fields.map((field) => (
          <FieldInput
            key={field.name}
            id={`${resource.id}-${field.name}`}
            label={`${field.label}${field.required ? '' : ' (optional)'}`}
            hint={field.hint}
            value={values[field.name] ?? ''}
            onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
          />
        ))}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Paying…' : `Pay ${price}`}
        </button>
      </form>
      <p className="lnote mono">
        GET {resource.path}
      </p>
      {line && <p className="cr-verdict">{line}</p>}
      {refusal && <p className="empty">{refusal}</p>}
      {answer && (
        <>
          {txUrl ? (
            <p className="lnote">
              Settled on Base: <a href={txUrl} target="_blank" rel="noreferrer" className="mono">{shortAddress(answer.txHash!)}</a>
            </p>
          ) : null}
          <pre className="aitext mono">{renderedAnswerV1(answer.body)}</pre>
        </>
      )}
    </section>
  );
}

function FieldInput(props: { id: string; label: string; hint: string; value: string; onChange: (value: string) => void }) {
  return (
    <>
      <label className="pi-label" htmlFor={props.id}>
        {props.label} — {props.hint}
      </label>
      <input
        id={props.id}
        className="pi-input mono"
        value={props.value}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => props.onChange(event.target.value)}
      />
    </>
  );
}

function WalletPanel({ terms }: { terms: PaymentTermsV1 | null | undefined }) {
  const { address, isConnected } = useAccount();
  const { connectors, disconnectAsync } = useDisconnect();
  const blocked = payerRefusalV1(address, terms ?? null);
  return (
    <section className="panel">
      {isConnected && address ? (
        <>
          <div className="cr-top">
            <span className="cr-name">Paying from <span className="mono">{shortAddress(address)}</span></span>
            <button
              className="btn"
              type="button"
              onClick={() =>
                void (async () => {
                  for (const connected of connectors) {
                    try {
                      await disconnectAsync({ connector: connected });
                    } catch {
                      /* Already gone */
                    }
                  }
                })()
              }
            >
              Use another wallet
            </button>
          </div>
          {blocked ? <p className="empty">{blocked}</p> : (
            <p className="lnote">
              Each answer asks this wallet for one signature: a USDC authorization for exactly the price below. No
              transaction is sent from your wallet, and nothing else is approved.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="lnote">Connect a wallet that holds USDC on Base to buy an answer here. Reading this page needs none.</p>
          <WalletPicker />
        </>
      )}
    </section>
  );
}

export function PaidApiPage() {
  const terms = usePaymentTerms();
  const { address } = useAccount();
  const price = terms ? usdcLabelV1(terms.amountAtomic) : '0.002 USDC';
  const payBlocked = payerRefusalV1(address, terms ?? null);
  const example = `${ORIGIN}${X402_INTELLIGENCE_BASE_V1}/address/identity?tokenAddress=${PAID_API_EXAMPLE_TOKEN_V1}`;

  return (
    <main className="mio-console pi-page">
      <header className="pi-head">
        <p className="pi-eyebrow">Miorail · x402 on Base</p>
        <h1>Paid API</h1>
        <p className="lnote">
          Five answers about Base tokens that an agent cannot compute for itself, sold per request over x402 for{' '}
          {price} on Base. No account and no API key: the request answers 402 with the price, the client pays with a
          USDC authorization, and the same request returns the answer. Every answer reports stored evidence and what
          was not established; none is a recommendation or an executable quote.
        </p>
      </header>

      <WalletPanel terms={terms} />

      {PAID_RESOURCES_V1.map((resource) => (
        <ResourceCard key={resource.id} resource={resource} price={price} payBlocked={payBlocked} />
      ))}

      <section className="panel">
        <div className="cr-top">
          <span className="cr-name">For agents</span>
        </div>
        <p className="lnote">Ask without paying to read the price. The terms ride in the PAYMENT-REQUIRED header:</p>
        <pre className="aitext mono">{`curl -i "${example}"`}</pre>
        <p className="lnote">
          Any x402 v2 client pays and retries, for example <span className="mono">@x402/fetch</span>. The catalog is at{' '}
          <a className="mono" href={`${X402_INTELLIGENCE_BASE_V1}/catalog`}>{`${X402_INTELLIGENCE_BASE_V1}/catalog`}</a>, and
          the whole surface is described for agents as OpenAPI at{' '}
          <a className="mono" href="/openapi.json">/openapi.json</a>. The free read tools are an MCP server at{' '}
          <span className="mono">{`${ORIGIN}/mcp`}</span>.
        </p>
      </section>
    </main>
  );
}
