import { z } from 'zod';

// ---------------------------------------------------------------------------
// The file a project serves on its own domain to claim a token.
//
// This file is the ONLY way project information enters Miorail. There is no
// name search, no symbol match and no directory: a project says "this token is
// mine and these are my things", from a domain it controls, and Miorail checks
// the parts it can check.
//
// Two structural rules make the whole layer safe, and both live in the parser
// rather than in a caller's discipline:
//
//   EVERY DECLARED URL MUST BE ON THE CLAIMING DOMAIN. A claim file on
//   example.org may not point Miorail at somebody else's product, at an
//   internal address, or at a host on this machine. The one exception is the
//   repository, which must be on an allowlisted code host — a project's code
//   genuinely does live somewhere else, and the allowlist is three names long.
//
//   A CLAIM NAMES ADDRESSES. Not symbols, not names. Two tokens answer to any
//   given symbol on Base, so a claim keyed on one would hand a project's
//   record to whoever copied its ticker.
// ---------------------------------------------------------------------------

/** Where a claim file lives. Fixed, so nothing chooses a path per project. */
export const B20_CLAIM_FILE_PATH_V1 = '/.well-known/miorail-b20.json';

/** Code hosts whose API Miorail knows how to read. Not a judgement about other
 * hosts — a repository elsewhere simply stays `unknown`, which is a state this
 * layer is comfortable with. */
export const B20_REPOSITORY_HOSTS_V1 = ['github.com'] as const;

const HttpsUrlV1 = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an https URL');

export const B20ClaimFileV1Schema = z
  .object({
    schemaVersion: z.literal('miorail-b20-claim/v1'),
    /** Every token this project claims, by ADDRESS and chain. */
    tokens: z
      .array(
        z
          .object({
            chainId: z.number().int().positive(),
            address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    /** The address the project says launched its tokens. Checked against the
     * sender Miorail read from the chain — the project cannot make this true
     * by writing it down. */
    launchSender: z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullable().default(null),
    project: z
      .object({
        name: z.string().min(1).max(120),
        website: HttpsUrlV1.nullable().default(null),
        /** An endpoint Miorail may CALL. A landing page declared here will be
         * probed and will come back `found`, not `live`. */
        product: HttpsUrlV1.nullable().default(null),
        repository: HttpsUrlV1.nullable().default(null),
        docs: HttpsUrlV1.nullable().default(null),
        /** A page on the project's own domain that publishes the token
         * address. This is what `project_publication` checks. */
        publication: HttpsUrlV1.nullable().default(null),
        /** A contract on Base the project says is theirs. Miorail checks that
         * code exists at it; it does not read what the code does. */
        baseContract: z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullable().default(null),
      })
      .strict(),
  })
  .strict();

export type B20ClaimFileV1 = z.infer<typeof B20ClaimFileV1Schema>;

/** A host is the claiming domain, or a subdomain of it. Compared on labels so
 * `notmiorail.xyz` cannot pass as a subdomain of `miorail.xyz`. */
export function hostBelongsToDomainV1(host: string, domain: string): boolean {
  const left = host.toLowerCase().replace(/\.$/, '');
  const right = domain.toLowerCase().replace(/\.$/, '');
  if (left === right) return true;
  return left.endsWith(`.${right}`);
}

/** An address literal or a name that resolves inside this machine or a private
 * network. Rejected before any request is made — a claim file is third-party
 * input, and a fetcher that follows it is a request forgery primitive. */
export function isNonPublicHostV1(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local')) return true;
  if (value === '::1' || value.startsWith('fc') || value.startsWith('fd')) return true;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    // A name. DNS may still point it anywhere, which is why the caller's own
    // fetch must refuse redirects and non-public results as well.
    return false;
  }
  const [a, b] = value.split('.').map(Number) as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export type B20ClaimUrlRefusalV1 =
  | 'not_https'
  | 'off_domain'
  | 'non_public_host'
  | 'repository_host_not_supported';

/**
 * Whether Miorail may fetch a URL a claim file declared.
 *
 * `kind` decides which rule applies, and the repository is the only kind that
 * may leave the claiming domain.
 */
export function claimUrlAllowedV1(input: {
  url: string;
  domain: string;
  kind: 'same_domain' | 'repository';
}): { allowed: true; host: string } | { allowed: false; refusal: B20ClaimUrlRefusalV1 } {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { allowed: false, refusal: 'not_https' };
  }
  if (parsed.protocol !== 'https:') return { allowed: false, refusal: 'not_https' };
  const host = parsed.hostname;
  if (isNonPublicHostV1(host)) return { allowed: false, refusal: 'non_public_host' };
  if (input.kind === 'repository') {
    return (B20_REPOSITORY_HOSTS_V1 as readonly string[]).includes(host.toLowerCase())
      ? { allowed: true, host }
      : { allowed: false, refusal: 'repository_host_not_supported' };
  }
  return hostBelongsToDomainV1(host, input.domain)
    ? { allowed: true, host }
    : { allowed: false, refusal: 'off_domain' };
}

/** The claim file's own URL, from a bare domain. */
export function claimFileUrlV1(domain: string): string {
  return `https://${domain.toLowerCase().replace(/\.$/, '')}${B20_CLAIM_FILE_PATH_V1}`;
}

/** `owner/repo` from a GitHub URL, or null. Nothing is guessed: a URL with any
 * other shape produces null and the repository stays unknown. */
export function githubRepoPathV1(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo] = parts;
    if (!/^[A-Za-z0-9._-]+$/.test(owner!) || !/^[A-Za-z0-9._-]+$/.test(repo!)) return null;
    return `${owner}/${repo.replace(/\.git$/, '')}`;
  } catch {
    return null;
  }
}

/** Whether a parsed claim file names this exact token on this exact chain. */
export function claimFileNamesTokenV1(
  file: B20ClaimFileV1,
  token: { chainId: number; address: string },
): boolean {
  const wanted = token.address.toLowerCase();
  return file.tokens.some(
    (entry) => entry.chainId === token.chainId && entry.address.toLowerCase() === wanted,
  );
}
