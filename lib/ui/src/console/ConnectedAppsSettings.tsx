import React, { useState } from 'react';
import { useIssueMcpHandoff, useMcpHandoffGrants, useRevokeMcpHandoff } from '@mioagent/api-client-react';

import { ConnectedAppsCard, type ConnectedAppClientKindV1 } from './ConnectedAppsCard';

void React;

// ---------------------------------------------------------------------------
// Connect Miorail to your AI, wired to the server: the grants a wallet handed
// to an assistant, a temporary key, and revoking one.
//
// One component for the web's Settings page and the Base App's. What this
// card says when a read fails IS the card ("could not read" must never pass
// for "you have none"), and two copies of that wording drift.
//
// The minted key is held in component state for exactly as long as the reader
// is looking at it — never in the query cache, because a credential in a cache
// outlives the moment it was shown.
// ---------------------------------------------------------------------------

export function ConnectedAppsSettingsV1() {
  const grants = useMcpHandoffGrants();
  // Availability comes from the endpoint that knows, not from a guess at
  // /api/status: the grants route answers `mcp_private_disabled` when the
  // surface is off, and that is a different thing from a read that failed.
  const mcpDisabled = /mcp_private_disabled/.test(grants.error?.message ?? '');
  const mcpEnabled = !mcpDisabled;
  const [issuedKey, setIssuedKey] = useState<
    { token: string; tokenId: string; expiresAt: string; notice: string } | null
  >(null);
  const issueHandoff = useIssueMcpHandoff({
    onSuccess: (issued) => setIssuedKey(issued),
  });
  const revokeHandoff = useRevokeMcpHandoff();

  return (
    <ConnectedAppsCard
      available={mcpEnabled}
      unavailableReason={
        mcpEnabled ? null : 'The private MCP surface is switched off on this server, so there is nothing to connect to.'
      }
      grants={grants.data?.grants ?? []}
      loading={grants.isPending}
      // Never an empty list on failure: "could not read" and "you have none"
      // are the two states an owner must not confuse on this page.
      error={
        grants.error && !mcpDisabled
          ? 'Your connected apps could not be read right now. This is not a statement that you have none.'
          : issueHandoff.error
            ? 'That key could not be issued. Nothing was connected.'
            : revokeHandoff.error
              ? 'That key could not be revoked. It is still connected.'
              : null
      }
      permissions={grants.data?.permissions ?? null}
      oauth={grants.data?.oauth ?? null}
      issued={issuedKey}
      issuing={issueHandoff.isPending}
      revokingTokenId={revokeHandoff.isPending ? (revokeHandoff.variables?.tokenId ?? null) : null}
      onIssueTemporary={(clientKind: ConnectedAppClientKindV1) => issueHandoff.mutate({ clientKind })}
      onRevoke={(tokenId: string) => revokeHandoff.mutate({ tokenId })}
      onDismissIssued={() => setIssuedKey(null)}
    />
  );
}
