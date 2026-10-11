import { useEffect, useState } from 'react';
import { useRoute } from 'wouter';

// ---------------------------------------------------------------------------
// /found/:code — a Found card as its owner shared it on X or Farcaster.
//
// Opens with no session, like a gift. It shows what the card shows (the
// amount, the protocol, the tokens, the block) and offers the reader the one
// thing the card is about: checking their own wallet. The head a preview
// reads was written by the server; noindex is set here too for the copy the
// app replaces.
// ---------------------------------------------------------------------------

interface PublicFoundCardV1 {
  code: string;
  protocol: 'aerodrome' | 'uniswap';
  usdCents: number;
  tokens: { symbol: string; amount: string }[];
  blockNumber: string;
  createdAt: string;
}

function useNoIndex(): void {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex,nofollow';
    document.head.appendChild(meta);
    return () => {
      meta.remove();
    };
  }, []);
}

export function publicFoundHeadlineV1(card: Pick<PublicFoundCardV1, 'protocol' | 'usdCents'>): { amount: string; what: string } {
  return {
    amount: `$${(card.usdCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    what: card.protocol === 'uniswap' ? 'collected in Uniswap fees' : 'claimed in Aerodrome fees and rewards',
  };
}

export function PublicFoundPage() {
  const [, params] = useRoute('/found/:code');
  const code = params?.code ?? '';
  useNoIndex();
  const [card, setCard] = useState<PublicFoundCardV1 | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    if (!/^[A-Za-z0-9_-]{12}$/.test(code)) {
      setState('missing');
      return;
    }
    void (async () => {
      try {
        const response = await fetch(`/api/public/found/${encodeURIComponent(code)}`);
        if (cancelled) return;
        if (response.status === 404) {
          setState('missing');
          return;
        }
        if (!response.ok) {
          setState('error');
          return;
        }
        setCard((await response.json()) as PublicFoundCardV1);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  let body;
  if (state === 'loading') {
    body = (
      <section className="panel">
        <div className="pb"><p className="lnote">Loading the card…</p></div>
      </section>
    );
  } else if (state !== 'ready' || !card) {
    body = (
      <section className="panel">
        <div className="ph"><h3>{state === 'error' ? 'Card unavailable' : 'Card not found'}</h3></div>
        <div className="pb">
          <p className="lnote">
            {state === 'error' ? 'The card could not be loaded just now.' : 'There is no Found card under this link.'}
          </p>
          <a className="btn" href="/extensions">Check what your wallet can claim</a>
        </div>
      </section>
    );
  } else {
    const headline = publicFoundHeadlineV1(card);
    body = (
      <section className="panel">
        <div className="ph">
          <h3>Found with Miorail</h3>
        </div>
        <div className="pb">
          <img
            className="found-card-image"
            src={`/found/${encodeURIComponent(card.code)}.png`}
            width={1200}
            height={630}
            alt={`${headline.amount} ${headline.what}`}
            style={{ width: '100%', height: 'auto', borderRadius: 12 }}
          />
          <div className="qrow">
            <span>{headline.what}</span>
            <span className="v mono">{headline.amount}</span>
          </div>
          {card.tokens.map((token) => (
            <div className="qrow" key={`${token.symbol}:${token.amount}`}>
              <span className="mono">{token.symbol}</span>
              <span className="v mono">{token.amount}</span>
            </div>
          ))}
          <p className="lnote">
            Verified on Base in block {BigInt(card.blockNumber).toLocaleString('en-US')}. The dollar figure is what the
            amounts would have fetched in USDC when the card was made. The card names no wallet.
          </p>
          <p className="lnote">
            Miorail reads what a wallet can claim on Aerodrome and collect on Uniswap from Base itself, and the wallet
            approves the claim. Ask “What can I claim?” in Wallet MCP.
          </p>
          <div className="ctarow">
            <a className="btn" href="/extensions">Check what your wallet can claim</a>
          </div>
        </div>
      </section>
    );
  }

  return (
    <main className="mio-console gift-page">
      <div className="gift-page-inner">
        <p className="gift-brand">
          <a href="/stocks">Miorail</a>
        </p>
        {body}
      </div>
    </main>
  );
}
