import { NextResponse, type NextRequest } from "next/server";

/**
 * The script rule the web console has, for the mini app's pages too (audit AUTH-1, 2026-11-14).
 *
 * The console's documents carry `script-src 'self'` (enforced since 2026-11-12), and `/app` carried no
 * policy at all, although its lending, repayment and stock-action pages ask a wallet to sign on the same
 * origin, with the same session cookie. Next writes its own small inline scripts into every page, so the
 * rule here names a nonce made for each request: Next reads it from the request's policy header and puts
 * it on every script it writes, and anything else inline is not run. The pages are rendered per request
 * for that (app/layout.tsx): a page built once could not carry a nonce made later.
 *
 * Otherwise the same policy as the console's: no plugin content, no <base>, only the page's own files
 * and WebAssembly, workers from the page or a blob, and what it stops reported to the API.
 */
export function miniappDocumentCspV1(nonce: string): string {
  return [
    "object-src 'none'",
    "base-uri 'self'",
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "worker-src 'self' blob:",
    "report-uri /api/public/csp-report",
  ].join("; ");
}

/** Sixteen random bytes, base64: a nonce nobody can guess. */
function freshNonceV1(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = freshNonceV1();
  const policy = miniappDocumentCspV1(nonce);
  const headers = new Headers(request.headers);
  // Where Next looks for the nonce it puts on its own scripts.
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  // Documents only: not the built files, not the API the app proxies, and not Next's own prefetches. The
  // app's own root is named apart: under basePath the pattern below begins with `/app/`, and `/app` alone,
  // the page the Base App opens first, went out with no policy at all.
  matcher: [
    {
      source: "/",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
    {
      source: "/((?!_next/static|_next/image|api/|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
