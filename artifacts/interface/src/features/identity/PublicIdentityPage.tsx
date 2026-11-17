import { PublicIdentityCheck } from '@mioagent/ui';

export function PublicIdentityPage({ tokenAddress }: { tokenAddress?: string }) {
  return (
    <PublicIdentityCheck
      tokenAddress={tokenAddress ?? null}
      productHref="/"
      productLabel="Open Still"
    />
  );
}
