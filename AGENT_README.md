# Agent README — Builder Code Attribution

This project sends onchain transactions on Base via the **user-confirmed flow**
(Task T19). Every transaction MUST carry a Base Builder Code as an ERC-8021
attribution suffix. Without it, Base cannot attribute the activity to this app
— there is **no error and no warning**, just silent, permanent data loss.

## What the Builder Code is

The `builder_code` value returned by the Base API during registration at
[base.dev](https://base.dev) > Settings > Builder Codes (e.g. `bc_a1b2c3d4`).
It is a **public** value — not a secret — and is embedded in every
`wallet_sendCalls` batch as a `dataSuffix` capability (ERC-8021). This is how
Base tracks which builder originated which onchain activity.

## How attribution is attached in this project

**Framework:** wagmi v3 (`useSendCalls`) targeting Base Account (ERC-4337 smart
wallet). There is no server-side signer on Base Mainnet — the server only
prepares unsigned EIP-5792 payloads (`POST /api/actions/:id/prepare`) and
records results (`POST /api/actions/:id/confirm`). The user signs every
transaction in their Base Account.

**Attribution path:** per-`sendCalls` via the `capabilities.dataSuffix` field
(wagmi v3 has no config-level `dataSuffix`). The suffix is computed from a
public frontend env var:

| Surface | Env var | Consumer |
| ------- | ------- | -------- |
| Web interface (Vite) | `VITE_BUILDER_CODE` | `artifacts/interface/src/features/inbox/ActionCard.tsx` |
| Miniapp (Next.js) | `NEXT_PUBLIC_BUILDER_CODE` | `artifacts/miniapp/app/inbox/[actionId]/page.tsx` |

Both call `builderCodeToDataSuffix(code)` from
`lib/wallet-actions/src/attribution.ts`, which uses
`Attribution.toDataSuffix({ codes: [code] })` from `ox/erc8021`. When the env
var is unset, the suffix is omitted and a one-time console warning is emitted;
transactions still proceed but are **unattributed**.

The shared hook `useWalletConfirmAction` (`lib/wallet-actions/src/useWalletConfirmAction.ts`)
passes the suffix into `useSendCalls` as:

```ts
capabilities: dataSuffix
  ? { dataSuffix: { value: dataSuffix, optional: true } }
  : undefined,
```

## Setup

1. Register at https://base.dev > Settings > Builder Codes to obtain a `bc_…` code.
2. Set the env var for each surface:
   - `artifacts/interface/.env` → `VITE_BUILDER_CODE=bc_yourcode`
   - `artifacts/miniapp/.env` → `NEXT_PUBLIC_BUILDER_CODE=bc_yourcode`
3. Rebuild the frontend so the value is embedded at build time.

## Verification

- On [base.dev](https://base.dev) > Onchain > Total Transactions, attribution
  counts appear after confirmed transactions.
- On Basescan, inspect a confirmed tx's input data: the last 16 bytes are
  `8021` repeating when attribution is attached.
- Validator: https://builder-code-checker.vercel.app/

## Rule

> From this point forward, every `wallet_sendCalls` batch this app submits MUST
> include the Builder Code attribution via the ERC-8021 `dataSuffix` capability.
> Never submit a batch without it. Without it, transactions are untracked
> silently and permanently.
