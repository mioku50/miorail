# MioAgent — BaseApp Mini App

Mobile-first MioAgent shell that lives inside Base App (and Farcaster clients).
Shares the **data layer** (`@mioagent/api-client-react`) and **design tokens +
UI primitives** (`@mioagent/ui`) with the web `interface` — no logic fork. The
shell/IA is its own (reduced: Autonomy status + kill, Action Inbox, Agent
Stream; deep-link `/inbox/:actionId`).

Stack: Next.js 15 (app router) + MiniKit + OnchainKit + Wagmi, scaffolded with
`npx create-onchain --mini`. Base Account (passkey) is the default wallet via
MiniKit; **no-custody is preserved** — execution still goes through the Base MCP
`send_calls` / approval URL flow, never signed from this UI.

## Develop

```bash
pnpm install            # from the monorepo root (links workspace packages)
pnpm --filter @mioagent/miniapp dev
```

The Next.js rewrite in `next.config.ts` proxies `/api/:path*` to the MioAgent
api-server (`MIOAGENT_API_URL`, default `http://localhost:8080`). Start the
api-server in another terminal:

```bash
pnpm --filter @mioagent/api-server dev
```

## Shared layer (no logic fork)

- `@mioagent/api-client-react` — TanStack Query hooks (`useStatus`,
  `useActionsFeed`, `useChatHistory`, `useSendMessage`, …) imported directly.
- `@mioagent/ui` — `tokens.css` (dark-first, imported in `app/globals.css`) +
  `Card` / `StateBadge` / `Button` primitives + `ThemeProvider`.
- `next.config.ts` lists both in `transpilePackages` (they ship TS source).

## Honest states

The Mini App renders the same honest states as the web interface. Autonomy and
x402 spend have no backend data yet → `StateBadge` "off / missing" + CTAs, never
fabricated numbers. See the T12 plan for the full honest-states rationale.

## External steps (require YOUR accounts — not done by the agent)

1. **Base App registration (base.dev).** Register the app at
   [base.dev](https://base.dev), then set the `base:app_id` meta value in
   `app/layout.tsx` (currently `mioagent-placeholder`) to your registered app id.
2. **Farcaster manifest + account association (JFS).** The
   `/.well-known/farcaster.json` route is wired
   (`app/.well-known/farcaster.json/route.ts`, served from `minikit.config.ts`).
   Fill `accountAssociation` + `baseBuilder` by running
   `npx create-onchain --manifest` from this directory with your domain/key. This
   proves domain ownership for Farcaster distribution.
3. **Deploy + set `NEXT_PUBLIC_URL`.** Set `NEXT_PUBLIC_URL` (in `.env` or your
   host) to the deployed HTTPS URL — the manifest's `homeUrl`/`iconUrl`/etc.
   derive from it. Set `NEXT_PUBLIC_ONCHAINKIT_API_KEY` from the
   [CDP portal](https://portal.cdp.coinbase.com).
4. **Testnet gasless confirmation (Paymaster).** End-to-end gasless
   confirmation via Paymaster requires testnet funds + your Base Account. Drive
   it manually from inside Base App on Base Sepolia after deploying. Execution
   still routes through the Base MCP approval URL (no signing from this UI).

## Notifications + deep-links

Scanner notifications should deep-link to `/inbox/:actionId` (handled by
`app/inbox/[actionId]/page.tsx`). The notification itself must NOT sign or
spend — only notify + deep-link (no-custody).
