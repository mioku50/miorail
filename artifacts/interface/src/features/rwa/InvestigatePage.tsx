import { useEffect, useMemo, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import {
  B20PublicContextCard,
  InvestigateScreen,
  investigateViewV1,
} from '@mioagent/ui';
import {
  useAddB20Watch,
  useB20PublicContext,
  useRwaAddressDossier,
  useStatus,
} from '@mioagent/api-client-react';
import { useUiStore } from '../../lib/state';

// ---------------------------------------------------------------------------
// Phase 7 — Investigate.
//
// The address lives in the URL, so a refresh, a Back press and a link from
// Discover all land on the same read. Nothing here creates a clearance,
// prepares a plan or opens a wallet: "Find route" hands the address to the
// flow that already owns that boundary.
//
// The unverified public-context lookup is rendered but never RUN until a
// reader asks for it. A search costs money and a false link costs more.
// ---------------------------------------------------------------------------

const ADDRESS_V1 = /^0x[0-9a-fA-F]{40}$/;


function failureCopyV1(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/\b404\b/.test(message) || message.includes('route_intelligence_disabled')) {
    return 'This server does not serve Investigate yet. The endpoint is part of a newer build than the one deployed here.';
  }
  if (message.includes('authentication_required') || /\b401\b/.test(message)) {
    return 'Your session is not valid for this server, so nothing was read. Signing in again is the fix.';
  }
  if (message.includes('storage_unavailable')) {
    return 'The evidence database did not answer, so this address could not be read. Nothing here is a statement about it.';
  }
  if (message.includes('invalid_type') || message.includes('unrecognized_keys')) {
    return 'This server answered with a shape this build does not understand. The API and this interface are on different versions.';
  }
  return 'This address could not be read on this server. Nothing here is a statement about it.';
}

/** Investigate, as the first section of Watch: any Base address, read in full. */
export function InvestigateSection() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const status = useStatus();
  const showToast = useUiStore((state) => state.showToast);

  // The URL is the source of truth; the input box is a draft of it.
  const urlToken = useMemo(() => {
    // A `?token=` handed to "Your tokens" (#tokens) is not an address to read here.
    if (window.location.hash === '#tokens') return null;
    const value = new URLSearchParams(search).get('token') ?? '';
    return ADDRESS_V1.test(value) ? value.toLowerCase() : null;
  }, [search]);
  const [query, setQuery] = useState(urlToken ?? '');
  useEffect(() => {
    if (urlToken) setQuery(urlToken);
  }, [urlToken]);
  const [refused, setRefused] = useState<string | null>(null);

  const enabled = status.data?.productMigration?.routeIntelligenceV1 === true;
  const dossier = useRwaAddressDossier(urlToken, { enabled });
  const publicContext = useB20PublicContext();
  const [publicContextToken, setPublicContextToken] = useState<string | null>(null);

  const watchAvailable = status.data?.productMigration?.b20ControlV1 === true;
  const addWatch = useAddB20Watch({
    onSuccess: () => showToast('Added to your watchlist. The background sweep reads it from here.'),
    onError: () => showToast('Miorail could not add this token to your watchlist.'),
  });

  const now = useMemo(() => new Date(), [dossier.dataUpdatedAt]);
  const view = useMemo(
    () => (dossier.data ? investigateViewV1(dossier.data, now) : null),
    [dossier.data, now],
  );

  const submit = () => {
    const value = query.trim();
    if (!ADDRESS_V1.test(value)) {
      // Refused in the browser, so a ticker never becomes a request. The
      // sentence says why rather than just rejecting the input.
      setRefused(
        'That is not a Base contract address. Investigate takes an exact address — a symbol identifies nothing here, because most indexed launches share one with another launch.',
      );
      return;
    }
    setRefused(null);
    navigate(`/watch?token=${value.toLowerCase()}#investigate`);
  };

  return (
      <InvestigateScreen
        model={{
          query,
          onQuery: setQuery,
          onSubmit: submit,
          inputRefusal: refused,
          loading: dossier.isFetching && urlToken !== null,
          view,
          error: enabled
            ? dossier.error
              ? failureCopyV1(dossier.error)
              : null
            : 'Route intelligence is off on this server, so no address can be read.',
          publicContext:
            view === null ? null : (
              <B20PublicContextCard
                tokenAddress={view.tokenAddress}
                symbol={view.displaySymbol ?? view.tokenAddress}
                model={{
                  tokenAddress: publicContextToken,
                  loading: publicContext.isPending,
                  context: (publicContext.data as never) ?? null,
                  error: publicContext.error
                    ? 'Miorail could not complete a public search for this token. That is about the search, not about the token.'
                    : null,
                  onLook: (token: string, domain?: string) => {
                    setPublicContextToken(token);
                    publicContext.mutate({ tokenAddress: token, ...(domain ? { domain } : {}) });
                  },
                }}
              />
            ),
          onFindRoute: (tokenAddress) => navigate(`/routes?token=${tokenAddress}`),
          onWatch: watchAvailable
            ? (tokenAddress: string) => addWatch.mutate({ tokenAddress })
            : null,
        }}
      />
  );
}
