import type {
  B20BasePresenceEvidenceV1,
  B20ClaimLinkV1,
  B20ProbeV1,
  B20ProductProbeV1,
  B20RepositoryEvidenceV1,
} from '@mioagent/opportunity-rail';

import {
  B20ClaimFileV1Schema,
  claimFileNamesTokenV1,
  claimFileUrlV1,
  claimUrlAllowedV1,
  githubRepoPathV1,
  type B20ClaimFileV1,
} from './claimFile.js';

// ---------------------------------------------------------------------------
// Turning a claimed domain into evidence.
//
// Every function here does one request and reports what came back. None of
// them decides a state — that is the pure projection's job, and keeping the
// decision out of the fetcher is what makes "unknown never becomes no"
// enforceable: a failed request produces a record saying the request failed,
// and only the projection turns records into words.
//
// Nothing here reads a Miorail secret, and nothing it returns can carry one:
// every URL in the output came out of the project's own claim file, and the
// only header sent is an Accept.
// ---------------------------------------------------------------------------

/** A minimal fetch, injected so tests never reach the network and so the host
 * decides the timeout and redirect policy in one place. */
export interface B20HttpResponseV1 {
  ok: boolean;
  status: number;
  contentType: string | null;
  /** Bounded. A collector never holds a whole third-party response. */
  bodyText: string;
}

export type B20HttpFetchV1 = (input: {
  url: string;
  accept: string;
  /** JSON body for a POST. Absent means GET. */
  postJson?: unknown;
}) => Promise<B20HttpResponseV1>;

export interface B20CollectDepsV1 {
  http: B20HttpFetchV1;
  /** `eth_getCode` at an address on Base, for the declared contract. Returns
   * the code, or null when the read failed. `0x` means no contract. */
  readCode?: (address: string) => Promise<string | null>;
  now: () => string;
}

export interface B20ClaimReadV1 {
  /** The parsed file, when one was served and understood. */
  file: B20ClaimFileV1 | null;
  /** Why there is no file. Null when there is one. */
  refusal: 'unreachable' | 'not_json' | 'invalid_schema' | 'token_not_named' | null;
  readAt: string;
}

/**
 * Reads and validates the claim file for one token.
 *
 * `token_not_named` is a REFUSAL rather than a soft signal: a file that does
 * not name this exact address on this exact chain proves nothing about it,
 * however much else it contains.
 */
export async function readClaimFileV1(
  deps: B20CollectDepsV1,
  input: { domain: string; chainId: number; tokenAddress: string },
): Promise<B20ClaimReadV1> {
  const readAt = deps.now();
  let response: B20HttpResponseV1;
  try {
    response = await deps.http({ url: claimFileUrlV1(input.domain), accept: 'application/json' });
  } catch {
    return { file: null, refusal: 'unreachable', readAt };
  }
  if (!response.ok) return { file: null, refusal: 'unreachable', readAt };

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.bodyText);
  } catch {
    return { file: null, refusal: 'not_json', readAt };
  }
  const result = B20ClaimFileV1Schema.safeParse(parsed);
  if (!result.success) return { file: null, refusal: 'invalid_schema', readAt };
  if (!claimFileNamesTokenV1(result.data, { chainId: input.chainId, address: input.tokenAddress })) {
    return { file: null, refusal: 'token_not_named', readAt };
  }
  return { file: result.data, refusal: null, readAt };
}

/**
 * Which of the three claim links hold.
 *
 * `domain_file` is settled by the read above — a file on the project's domain
 * naming this token IS that link. The other two need something the project
 * cannot write down for itself:
 *
 *   `launch_sender` compares the file's declared sender against the sender
 *   Miorail read from the chain, and only counts a DIRECT launch. On a relayed
 *   transaction the sender is a bundler, and a project could claim a bundler's
 *   address as easily as anyone else could.
 *
 *   `project_publication` fetches a page on the project's own domain and looks
 *   for this token's address in what came back.
 */
export async function verifyClaimLinksV1(
  deps: B20CollectDepsV1,
  input: {
    file: B20ClaimFileV1;
    domain: string;
    tokenAddress: string;
    /** From the chain. Null when the launch transaction has not been read. */
    launchSender: string | null;
    /** Only `direct` supports the sender link, for the reason above. */
    senderRelation: string | null;
  },
): Promise<{ verified: B20ClaimLinkV1[]; refuted: B20ClaimLinkV1[] }> {
  const verified: B20ClaimLinkV1[] = ['domain_file'];
  const refuted: B20ClaimLinkV1[] = [];

  const declaredSender = input.file.launchSender?.toLowerCase() ?? null;
  if (declaredSender !== null && input.launchSender !== null && input.senderRelation === 'direct') {
    if (declaredSender === input.launchSender.toLowerCase()) verified.push('launch_sender');
    // A declared sender that does not match what the chain says is a
    // contradiction, not a gap. It is the one thing here that can refute.
    else refuted.push('launch_sender');
  }

  const publication = input.file.project.publication;
  if (publication) {
    const allowed = claimUrlAllowedV1({ url: publication, domain: input.domain, kind: 'same_domain' });
    if (allowed.allowed) {
      try {
        const response = await deps.http({ url: publication, accept: 'text/html,application/json' });
        if (response.ok && response.bodyText.toLowerCase().includes(input.tokenAddress.toLowerCase())) {
          verified.push('project_publication');
        }
        // A page that answered without the address is NOT a refutation: it may
        // list tokens somewhere this fetch did not reach. Absence of evidence.
      } catch {
        // Unreachable. The link stays unchecked.
      }
    }
  }

  return { verified, refuted };
}

/** A plain reachability probe. Used for the website and the docs, where
 * "it answered" is the whole claim being made. */
export async function probeUrlV1(
  deps: B20CollectDepsV1,
  input: { url: string; domain: string },
): Promise<B20ProbeV1 | null> {
  const allowed = claimUrlAllowedV1({ url: input.url, domain: input.domain, kind: 'same_domain' });
  if (!allowed.allowed) return null;
  const observedAt = deps.now();
  try {
    const response = await deps.http({ url: input.url, accept: 'text/html,application/xhtml+xml' });
    return { url: input.url, reachable: response.ok, observedAt };
  } catch {
    return { url: input.url, reachable: false, observedAt };
  }
}

/**
 * The product probe, and the only place `live` can come from.
 *
 * A GET that returns HTML is a page. `functional` requires the endpoint to
 * answer with STRUCTURED data — JSON, or the event stream an MCP server
 * answers a handshake with. The probe tries the MCP handshake first because a
 * product that speaks a protocol can be asked to prove it; a plain JSON API is
 * accepted on the same terms.
 *
 * What this deliberately does not do is judge the content. A JSON endpoint
 * returning `{}` is live and useless, and `live` says only the first half.
 */
export async function probeProductV1(
  deps: B20CollectDepsV1,
  input: { url: string; domain: string },
): Promise<B20ProductProbeV1 | null> {
  const allowed = claimUrlAllowedV1({ url: input.url, domain: input.domain, kind: 'same_domain' });
  if (!allowed.allowed) return null;
  const observedAt = deps.now();

  // 1. Ask it to behave like an MCP server.
  try {
    const handshake = await deps.http({
      url: input.url,
      accept: 'application/json, text/event-stream',
      postJson: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    if (handshake.ok && mcpAnsweredV1(handshake)) {
      return { url: input.url, reachable: true, functional: true, observedAt };
    }
  } catch {
    // Not an MCP server, or not reachable. Both fall through to the GET.
  }

  // 2. Ask it for anything, and see whether structured data comes back.
  try {
    const response = await deps.http({ url: input.url, accept: 'application/json' });
    if (!response.ok) return { url: input.url, reachable: false, functional: false, observedAt };
    return {
      url: input.url,
      reachable: true,
      functional: jsonAnsweredV1(response),
      observedAt,
    };
  } catch {
    return { url: input.url, reachable: false, functional: false, observedAt };
  }
}

function jsonAnsweredV1(response: B20HttpResponseV1): boolean {
  const type = (response.contentType ?? '').toLowerCase();
  if (!type.includes('application/json')) return false;
  // A JSON content type with a body that does not parse is a server saying one
  // thing and doing another, and it is not evidence of a working product.
  try {
    const value: unknown = JSON.parse(response.bodyText);
    return value !== null && typeof value === 'object';
  } catch {
    return false;
  }
}

function mcpAnsweredV1(response: B20HttpResponseV1): boolean {
  const type = (response.contentType ?? '').toLowerCase();
  const body = response.bodyText;
  if (type.includes('text/event-stream')) {
    // Streamable HTTP: the answer arrives as an SSE `data:` line carrying the
    // JSON-RPC response.
    const line = body.split('\n').find((entry) => entry.startsWith('data: '));
    if (!line) return false;
    try {
      const value = JSON.parse(line.slice(6)) as { result?: { tools?: unknown } };
      return Array.isArray(value.result?.tools);
    } catch {
      return false;
    }
  }
  if (!type.includes('application/json')) return false;
  try {
    const value = JSON.parse(body) as { result?: { tools?: unknown } };
    return Array.isArray(value.result?.tools);
  } catch {
    return false;
  }
}

/** GitHub's public repository read. Two dates and nothing else: no stars, no
 * forks, no commit total — none of which is evidence of anything this layer
 * claims to know. */
export async function readRepositoryV1(
  deps: B20CollectDepsV1,
  input: { url: string },
): Promise<B20RepositoryEvidenceV1 | null> {
  const path = githubRepoPathV1(input.url);
  if (path === null) return null;
  const observedAt = deps.now();
  try {
    const response = await deps.http({
      url: `https://api.github.com/repos/${path}`,
      accept: 'application/vnd.github+json',
    });
    if (!response.ok) return null;
    const value = JSON.parse(response.bodyText) as {
      created_at?: unknown;
      pushed_at?: unknown;
    };
    return {
      url: input.url,
      createdAt: typeof value.created_at === 'string' ? value.created_at : null,
      // `pushed_at` is the last push to ANY branch. It is the closest thing the
      // repository read gives to "somebody worked on this", and it is reported
      // as a date rather than turned into a rate.
      lastCommitAt: typeof value.pushed_at === 'string' ? value.pushed_at : null,
      observedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Presence on Base, in the order of how much it proves.
 *
 * A contract read is the strongest: Miorail asks Base itself. A declared MCP
 * endpoint that answered is the next — it is a Base-facing surface that works.
 * Neither is an endorsement by Base, and the projection's copy says so.
 */
export async function readBasePresenceV1(
  deps: B20CollectDepsV1,
  input: { contract: string | null; productFunctional: boolean; productUrl: string | null },
): Promise<B20BasePresenceEvidenceV1 | null> {
  if (input.contract && deps.readCode) {
    const observedAt = deps.now();
    try {
      const code = await deps.readCode(input.contract);
      if (code !== null && code !== '0x' && code.length > 2) {
        return { kind: 'onchain_contract', reference: input.contract, observedAt };
      }
    } catch {
      // A failed read is not an absent contract.
    }
  }
  if (input.productFunctional && input.productUrl) {
    return { kind: 'mcp_endpoint', reference: input.productUrl, observedAt: deps.now() };
  }
  return null;
}
