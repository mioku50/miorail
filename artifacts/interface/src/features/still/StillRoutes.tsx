import { useMemo, useState } from 'react';
import { Redirect, useLocation } from 'wouter';
import { useMyDividends, useStillCheck, useStillMine } from '@mioagent/api-client-react';
import { useWalletBasenameV1, type ConsoleFrameV1Props } from '@mioagent/ui';
import {
  StillAgent,
  StillAssets,
  StillAssistants,
  StillConsolePage,
  StillFrame,
  StillHomeSignedIn,
  StillHomeSignedOut,
  StillMore,
  assetsViewV1,
  homeViewV1,
  stillCheckMessageV1,
  stillTabForPathV1,
} from '@mioagent/ui/still';
import { useAuthGate } from '../../app/AuthProvider';
import { AppLoading } from '../../app/AppLoading';
import { useStillSky, useStillWallet } from './useStillSky';

// ---------------------------------------------------------------------------
// Still's own places on the web: Home, Assets, Agent, More and the page for
// assistants, and the frame every console page is drawn in.
//
// Eager, not lazy like the console's screens: Home is the first screen of
// every visit, and the frame around the rest needs this same module anyway.
// ---------------------------------------------------------------------------

function useSignInHref(): string {
  const [location] = useLocation();
  return `/signin?next=${encodeURIComponent(location)}`;
}

/** The signed-in wallet's own Mirror and dividends, shared by Home, Assets and the Agent. */
function useMyStill() {
  const { signedIn, booting, wallet } = useStillWallet();
  const mine = useStillMine(wallet, { enabled: signedIn });
  const dividends = useMyDividends({ enabled: signedIn });
  return {
    signedIn,
    booting,
    report: mine.data ?? null,
    dividends: dividends.data ?? null,
    loading: signedIn && !mine.data && !mine.error,
    failed: mine.error ? mine.error.message : null,
    retry: () => void mine.refetch(),
  };
}

/** Console pages, in Still's frame. Provided to the console shell by the app. */
export function StillConsoleFrame(props: ConsoleFrameV1Props) {
  const [location] = useLocation();
  const sky = useStillSky();
  return <StillConsolePage tab={stillTabForPathV1(location)} sky={sky} {...props} />;
}

/**
 * "/". A link that carried a question here keeps landing where it always
 * did: the Stocks board reads its query, for a session and without one.
 */
export function StillHomeRoute() {
  const gate = useAuthGate();
  const search = window.location.search;
  if (!search) return <StillHomePage />;
  if (gate.phase === 'booting') return <AppLoading />;
  return <Redirect to={`${gate.showPrivateSurfaces ? '/market' : '/stocks'}${search}`} replace />;
}

/** Decode the old wallet permalink once, from the browser's encoded path. */
function legacyWalletSubjectV1(pathname: string): string | null {
  const match = /^\/w\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    const subject = decodeURIComponent(match[1]!).trim();
    const hasControl = Array.from(subject).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    return subject.length > 0 && subject.length <= 256 && !subject.includes('/') && !subject.includes('\\') && !hasControl
      ? subject
      : null;
  } catch {
    return null;
  }
}

/**
 * Still's original public wallet links. The URL names the wallet to read,
 * even when another wallet has signed in: a session never replaces its subject.
 */
export function StillWalletPage() {
  const [, navigate] = useLocation();
  const sky = useStillSky();
  // Wouter decodes parts of a path before matching. Read the encoded browser
  // path so a literal percent, an escaped slash and malformed escapes cannot
  // be decoded twice into a different subject.
  const subject = legacyWalletSubjectV1(window.location.pathname);
  const check = useStillCheck(subject);
  const answer = check.data ?? null;
  const result = useMemo(
    () => (answer?.outcome === 'report' ? { view: homeViewV1({ report: answer.report, sky }), report: answer.report } : null),
    [answer, sky],
  );
  return (
    <StillFrame tab="home" sky={sky}>
      <StillHomeSignedOut
        model={{
          sky,
          result,
          checking: check.isFetching,
          message: subject === null
            ? stillCheckMessageV1({ outcome: 'invalid_subject', reason: 'not_an_address_or_name' })
            : answer ? stillCheckMessageV1(answer) : null,
          onCheck: (next) => navigate(`/w/${encodeURIComponent(next.trim())}`),
          // Signing in opens the reader's own Home, not the public subject.
          signInHref: '/signin?next=%2F',
        }}
      />
    </StillFrame>
  );
}

function StillHomePage() {
  const sky = useStillSky();
  const signInHref = useSignInHref();
  const still = useMyStill();
  const [subject, setSubject] = useState<string | null>(null);
  const check = useStillCheck(still.signedIn ? null : subject);
  const view = useMemo(
    () => (still.report ? homeViewV1({ report: still.report, sky, dividends: still.dividends }) : null),
    [still.report, still.dividends, sky],
  );
  const answer = check.data ?? null;
  const result = useMemo(
    () => (answer?.outcome === 'report' ? { view: homeViewV1({ report: answer.report, sky }), report: answer.report } : null),
    [answer, sky],
  );
  return (
    <StillFrame tab="home" sky={sky}>
      {still.booting ? (
        // A session being checked is not a visitor yet: the sky alone, until it settles.
        <StillHomeSignedIn model={{ sky, view: null, reading: null, loading: false, failed: null, onRetry: still.retry }} />
      ) : still.signedIn ? (
        <StillHomeSignedIn
          model={{ sky, view, reading: still.report?.reading ?? null, loading: still.loading, failed: still.failed, onRetry: still.retry }}
        />
      ) : (
        <StillHomeSignedOut
          model={{
            sky,
            result,
            checking: check.isFetching,
            message: answer ? stillCheckMessageV1(answer) : null,
            onCheck: setSubject,
            signInHref,
          }}
        />
      )}
    </StillFrame>
  );
}

export function StillAssetsPage() {
  const sky = useStillSky();
  const signInHref = useSignInHref();
  const still = useMyStill();
  const view = useMemo(() => (still.report ? assetsViewV1({ report: still.report, dividends: still.dividends }) : null), [still.report, still.dividends]);
  return (
    <StillFrame tab="assets" sky={sky}>
      {/* While the session is checked the page stays empty rather than asking a signed-in reader to sign in. */}
      <StillAssets model={{ sky, view, loading: still.loading, failed: still.failed, onRetry: still.retry, signedIn: still.signedIn || still.booting, signInHref }} />
    </StillFrame>
  );
}

export function StillAgentPage() {
  const sky = useStillSky();
  const still = useMyStill();
  const russian = typeof navigator !== 'undefined' && /^ru\b/i.test(navigator.language);
  return (
    <StillFrame tab="agent" sky={sky}>
      <StillAgent model={{ sky, report: still.report, dividends: still.dividends, reading: still.loading, signedIn: still.signedIn, russian }} />
    </StillFrame>
  );
}

export function StillMorePage() {
  const sky = useStillSky();
  const signInHref = useSignInHref();
  const { wallet } = useStillWallet();
  const short = wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : null;
  const basename = useWalletBasenameV1(short);
  return (
    <StillFrame tab="more" sky={sky}>
      <StillMore model={{ sky, account: basename ?? short, signInHref }} />
    </StillFrame>
  );
}

export function StillAssistantsPage() {
  const sky = useStillSky();
  return (
    <StillFrame tab="more" sky={sky}>
      <StillAssistants model={{ sky }} />
    </StillFrame>
  );
}
