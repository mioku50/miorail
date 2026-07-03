# MioAgent — Base App (standard web app)

Mobile-first MioAgent shell that runs as a **standard Next.js web app**, registered
on [Base.dev](https://base.dev). It opens inside Base App with automatic wallet
context (no manual connect) and works in any browser with a normal connect flow.
It shares the **data layer** (`@mioagent/api-client-react`) and **design tokens +
UI primitives** (`@mioagent/ui`) with the web `interface` — no logic fork. The
shell/IA is its own (reduced: Autonomy status + kill, Action Inbox, Agent Stream;
deep-link `/inbox/:actionId`).

> Base deprecated OnchainKit and, since 9 Apr 2026, Base App treats every app as a
> standard web app — mini-app wrappers (MiniKit / OnchainKit) no longer receive
> onchain-transaction support. This app therefore uses **wagmi + viem + the Base
> Account SDK** (`@base-org/account`) with no OnchainKit / MiniKit dependency.
> Farcaster is kept only as an optional, isolated, static distribution manifest.

Stack: Next.js 15 (app router) + wagmi + viem + `@base-org/account`. The Base
Account (`baseAccount()` connector) is the default wallet — passkey sign-in,
automatic context inside Base App, popup connect in a browser; Coinbase Wallet and
injected browser wallets are fallbacks. **No-custody is preserved** — this UI never
signs or broadcasts; execution still goes through the Base MCP `send_calls` /
approval URL flow.

## Develop

```bash
pnpm install            # from the monorepo root (links workspace packages)
pnpm --filter @mioagent/miniapp dev
```

The Next.js rewrite in `next.config.ts` proxies `/api/:path*` to the MioAgent
api-server (`MIOAGENT_API_URL`, default `http://localhost:8080`). Start it in
another terminal:

```bash
pnpm --filter @mioagent/api-server dev
```

## Wallet flow (standard web app)

- `app/wagmi.ts` — wagmi config: chains `base` + `baseSepolia`, connectors
  `baseAccount` (Base Account SDK, primary) + `coinbaseWallet` + `injected`,
  `http()` transports, `cookieStorage` + `ssr`.
- `app/rootProvider.tsx` — `WagmiProvider` + `QueryClientProvider` + `ThemeProvider`
  (dark-first, shared via `@mioagent/ui`). No OnchainKitProvider.
- `app/components/WalletConnect.tsx` — connect/disconnect UI on the shared design
  tokens ("Sign in with Base" primary; Coinbase Wallet + browser-wallet fallbacks).
  Shows a truncated address when connected.
- `next.config.ts` sets `Cross-Origin-Opener-Policy: same-origin-allow-popups` —
  required for the Base Account popup (`same-origin` breaks it).

Inside Base App the Base Account SDK provides wallet context automatically; in a
normal browser the user taps **Connect** and picks Sign in with Base. The wallet is
context/identity only — no `useSignMessage` / `useSendTransaction` /
`useWriteContract` (no-custody).

## Shared layer (no logic fork)

- `@mioagent/api-client-react` — TanStack Query hooks (`useStatus`,
  `useActionsFeed`, `useChatHistory`, `useSendMessage`, …) imported directly.
- `@mioagent/ui` — `tokens.css` (dark-first, imported in `app/globals.css`) +
  `Card` / `StateBadge` / `Button` primitives + `ThemeProvider`.
- `next.config.ts` lists both in `transpilePackages` (they ship TS source).

## Honest states

The app renders the same honest states as the web interface. Autonomy and x402
spend have no backend data yet → `StateBadge` "off / missing" + CTAs, never
fabricated numbers. See the T12 plan for the full honest-states rationale.

## Registration & manifests

**Base.dev (primary):** a `base:app_id` meta tag is set in `app/layout.tsx`
(currently `mioagent-placeholder`). Register at [base.dev](https://base.dev),
replace it with your registered app id, and verify your domain there.

**Farcaster (optional distribution):** `/.well-known/farcaster.json` is served from
`app/manifest.ts` (static JSON only — no Farcaster runtime SDK). An `fc:miniapp`
meta tag in `app/layout.tsx` enables Farcaster embed/distribution. Both are isolated
from the app's runtime; nothing in the app imports a Farcaster SDK.

## External steps (require YOUR accounts — not done by the agent)

1. **Base App registration (base.dev).** Register at [base.dev](https://base.dev),
   then set the `base:app_id` meta value in `app/layout.tsx` to your registered app
   id, and verify your domain.
2. **Farcaster manifest + account association (JFS).** Fill `accountAssociation` +
   `baseBuilder` in `app/manifest.ts` by running `npx create-onchain --manifest`
   from this directory with your domain/key. This proves domain ownership for
   Farcaster distribution.
3. **Deploy + set `NEXT_PUBLIC_URL`.** Set `NEXT_PUBLIC_URL` (in `.env` or your
   host) to the deployed HTTPS URL — the manifest's `homeUrl` / `iconUrl` / etc.
   derive from it.
4. **Testnet gasless confirmation (Paymaster).** End-to-end gasless confirmation via
   Paymaster requires testnet funds + your Base Account. Drive it manually from
   inside Base App on Base Sepolia after deploying. (Wiring `paymasterUrls` into the
   Base Account SDK is a future config.) Execution still routes through the Base MCP
   approval URL — no signing from this UI.

## Notifications + deep-links

Scanner notifications should deep-link to `/inbox/:actionId` (handled by
`app/inbox/[actionId]/page.tsx`). The notification itself must NOT sign or spend —
only notify + deep-link (no-custody).
