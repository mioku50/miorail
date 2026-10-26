import { useMemo } from 'react';
import { useSession, useStillTerms } from '@mioagent/api-client-react';
import { skyEarningsFromTermsV1, useStillSkyV1, type SkyStateV1 } from '@mioagent/ui/still';
import { useAuthGate } from '../../app/AuthProvider';

/** The market sky with the earnings clouds Still's terms name. Until they are read it names no limits. */
export function useStillSky(): SkyStateV1 {
  const terms = useStillTerms();
  const read = useMemo(() => (terms.data ? skyEarningsFromTermsV1(terms.data) : undefined), [terms.data]);
  return useStillSkyV1(read);
}

/**
 * The wallet this session signed in with, or null. Read from the session
 * rather than the connector: Still's pages show the session's own wallet, the
 * one the server reads for /api/still/mine.
 */
export function useStillWallet(): { signedIn: boolean; booting: boolean; wallet: string | null } {
  const gate = useAuthGate();
  const session = useSession({ retry: false, staleTime: 60_000 });
  const signedIn = gate.showPrivateSurfaces;
  return { signedIn, booting: gate.phase === 'booting', wallet: signedIn ? session.data?.user?.address ?? null : null };
}
