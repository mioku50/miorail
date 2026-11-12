import { useMemo, useState, type ReactNode } from 'react';
import { Redirect, useLocation } from 'wouter';
import { useMyDividends, useStillCheck, useStillMine, useStillUsdcV1 } from '@mioagent/api-client-react';
import { useTelegramAlertsV1, useWalletBasenameV1, type ConsoleFrameV1Props } from '@mioagent/ui';
import {
  StillAgent,
  StillAssets,
  StillAssistants,
  StillConsolePage,
  StillFrame,
  StillHeader,
  StillHomeSignedIn,
  StillHomeSignedOut,
  StillMore,
  StillSafety,
  assetsViewV1,
  homeViewV1,
  stillCheckMessageV1,
  stillTabForPathV1,
} from '@mioagent/ui/still';
import { useAuthGate } from '../../app/AuthProvider';
import { AppLoading } from '../../app/AppLoading';
import { RequireSession } from '../../app/RequireSession';
import { useCreateWalletV1 } from './useCreateWallet';
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
    wallet,
    report: mine.data ?? null,
    dividends: dividends.data ?? null,
    dividendsReadState: dividends.error ? 'unavailable' as const : dividends.isPending ? 'loading' as const : dividends.data ? 'read' as const : 'not_loaded' as const,
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
  // A new wallet opens the reader's own Home too.
  const createWallet = useCreateWalletV1('/');
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
          onCheck: (next) => {
            const normalized = next.trim();
            if (normalized === subject) void check.refetch();
            else navigate(`/w/${encodeURIComponent(normalized)}`);
          },
          // Signing in opens the reader's own Home, not the public subject.
          signInHref: '/signin?next=%2F',
          createWallet,
        }}
      />
    </StillFrame>
  );
}

function StillHomePage() {
  const sky = useStillSky();
  const signInHref = useSignInHref();
  const createWallet = useCreateWalletV1('/');
  const still = useMyStill();
  const telegram = useTelegramAlertsV1({ enabled: still.signedIn });
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
          model={{ sky, view, reading: still.report?.reading ?? null, loading: still.loading, failed: still.failed, onRetry: still.retry, telegram,
            subject: still.report ? still.report.subject.name ?? still.report.subject.address : null }}
        />
      ) : (
        <StillHomeSignedOut
          model={{
            sky,
            result,
            checking: check.isFetching,
            message: answer ? stillCheckMessageV1(answer) : null,
            onCheck: (next) => {
              const normalized = next.trim();
              if (normalized === subject) void check.refetch();
              else setSubject(normalized);
            },
            signInHref,
            createWallet,
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
  // The report reads what can be collateral; USDC, what a loan pays out and a repayment takes, is read beside it.
  const usdc = useStillUsdcV1(still.wallet, { enabled: still.signedIn });
  const view = useMemo(
    () => (still.report ? assetsViewV1({ report: still.report, dividends: still.dividends, usdc: usdc.data ?? (usdc.error ? 'unread' : 'loading') }) : null),
    [still.report, still.dividends, usdc.data, usdc.error],
  );
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
  return (
    <StillFrame tab="agent" sky={sky}>
      <StillAgent model={{ sky, report: still.report, dividends: still.dividends, dividendsReadState: still.dividendsReadState, reading: still.loading, signedIn: still.signedIn, walletIdentity: still.wallet, russian: false }} />
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

/**
 * Watch, for a reader who is not signed in (audit UI-7, 2026-11-10).
 *
 * The gate used to stand alone on an empty page: no header, no way back into Still, no first-level
 * heading, and the old console's words ("chats, actions, fuel"). A link to /watch, or to any of the four
 * old addresses that redirect here, was a dead end. Now it is drawn in Still's frame, with its own
 * heading and what the sign-in is for; signed in, the page is the page.
 */
export function StillWatchGate({ children }: { children: ReactNode }) {
  const gate = useAuthGate();
  const sky = useStillSky();
  if (gate.showPrivateSurfaces) return <>{children}</>;
  return (
    <StillFrame tab="more" sky={sky}>
      <StillHeader title="Watch" sky={sky}
        lede="Look into a wallet or a token on Base, and keep a list of the ones you watch. The list is kept for your wallet, so this page opens once you sign in." />
      <RequireSession copy={{ eyebrow: 'Watch', body: 'One signature shows this is your wallet, so your watchlist opens. It does not send a transaction.' }}>
        {children}
      </RequireSession>
    </StillFrame>
  );
}

export function StillSafetyPage() {
  const sky = useStillSky();
  return (
    <StillFrame tab="more" sky={sky}>
      <StillSafety model={{ sky }} />
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
