---
name: orbitlab-base-agent-patterns
description: >
  Clean-room architectural patterns distilled from OrbitLab (the open-source
  Base agent) for building a self-hostable, no-custody AI agent on Base.
  Load this when implementing the agent loop, the tool/provider abstraction,
  the Base MCP OAuth client, the action-security screening layer, workflow
  scanners, markdown-memory injection, or no-custody execution via EIP-5792
  send_calls. Contains interfaces, contracts, and checklists ONLY — never
  copied source. Reimplement everything from scratch.
---

# OrbitLab-derived patterns for a Base agent (clean-room)

> **Legal guardrail.** OrbitLab is licensed **AGPL-3.0-or-later** (network
> copyleft). Do NOT copy, paste, or translate its source. This skill captures
> *ideas, interfaces, and invariants* (not protected the same way as source)
> so you can build a clean-room implementation. If in doubt, write it yourself
> from the contract below without looking at their file.

## 0. Shape of the system

Monorepo, pnpm workspaces. Suggested layout (mirrors the proven split):

- `lib/db` — Drizzle ORM + Postgres schemas and the single `db` client.
- `lib/api-spec` + `lib/api-zod` — API contract + zod request/response types.
- `lib/api-client-react` — generated typed client for the UI.
- `artifacts/api-server` — Express server (`routes/*` thin, `lib/*` logic).
- `artifacts/interface` — React 19 + Vite + Tailwind v4 + wouter + tanstack-query.
- `scripts` — one-off ops.

Keep routes thin: parse with zod → call a `lib/*` function → serialize with zod.

## 1. Tool-provider interface (the core extensibility seam)

Every data/action source implements the SAME triple. The agent never knows
which provider a tool came from.

```ts
export interface ToolProvider {
  id: string;                       // "base-mcp" | "moralis" | "native" | ...
  listTools(): Promise<ToolDef[]>;  // catalog, filtered by isProtocolEnabled(id)
  findTool(name: string): ToolDef | undefined;
  callTool(name: string, args: Record<string, unknown>):
    Promise<{ content: string; isError: boolean }>;
}
```

- The agent aggregates `listTools()` across all enabled providers into one flat
  catalog, then routes a tool call by name to the owning provider.
- Each provider is a **toggle** in `configure → protocols`; a disabled provider
  contributes zero tools. Gate every `listTools` behind `isProtocolEnabled(id)`.
- "Native" tools are COMPOSED: one tool call fans out to several data providers
  and merges the result, so the model gets a complete answer in one round-trip.

## 2. LLM provider abstraction (pluggable, OpenAI-compatible)

```ts
export interface LlmProvider {
  id: string;
  chatCompletionsUrl: string;
  modelsUrl: string;
  fallbackModels: string[];     // tried in order if stored model fails/unset
  authScheme: "Bearer" | "Wallet";
}
```

- All providers expose OpenAI-compatible `chat/completions` + `/models`, so the
  call/stream/list code only needs URL + auth header + default model id.
- Provider priority: a managed/metered gateway can be default, but if the user
  brings their own key, their key wins and you call upstream directly.
- Keep a deterministic **MockLlmProvider** behind this same interface for tests.

## 3. Base MCP client (OAuth, no-custody)

- Use `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`
  against the Base MCP server.
- OAuth: PKCE flow; store `clientInformation`, `tokens`, `codeVerifier`,
  `oauthState`. **Anonymous-before-auth problem:** the wallet address (and
  therefore the userId) is only known *after* the OAuth callback. Hold anon
  state in an in-memory map keyed by a random id with a TTL (~30 min), then
  migrate it into the user's DB-backed settings once the callback completes.
- Keep transport injectable so tests use a mock transport.

## 4. No-custody execution (the safety spine)

- The agent **never holds a key and never broadcasts.** It can only ASK the
  wallet to draft a transaction the user approves.
- Execution path: build the call batch (e.g. ERC-20 `approve` + action) and
  forward via Base MCP **`send_calls` (EIP-5792)**. Extract the returned
  approval URL(s) and surface them to the user to sign in the Base app.
- Fail-closed invariants before ever building an on-chain approve from any
  remote config: assert `chainId === expected Base chain` AND token is the
  canonical USDC address. A compromised config must not induce an approval
  against an attacker-controlled token.

## 5. Action-security screening (mandatory, deterministic)

Screen the **executable instruction** of every action before it reaches the
inbox. Screen only the executable text — never the display title/description
(a warning that says "this contract can drain your wallet" is informational).

```ts
export interface ScreenResult { allowed: boolean; reason?: string }
export function screenAction(a: ScreenableAction): ScreenResult;
```

Block on suspicion of:
- wallet-drain (`send/transfer/withdraw/sweep/drain ... all/everything/100%`),
- unlimited token approval,
- credential exfiltration (seed phrase / private key),
- prompt-injection / jailbreak ("ignore previous instructions", "developer mode",
  "reveal your system prompt").

De-obfuscate before matching: canonicalize unicode (zero-width / full-width /
accented), collapse separators (`s e n d`, `d-r-a-i-n`), undo leetspeak
(`s3nd 4ll`), decode morse. Screen every de-obfuscated variant. Maintain
keyword sets per supported UI language (CJK matched as substrings — no word
boundaries). Ship a regression suite of known payloads.

## 6. Workflow scanners (autonomous, scoped agent loop)

One DB row per user-authored scanner:

```ts
interface Workflow {
  id: string; userId: string; name: string;
  source: "native" | "custom";
  enabled: boolean;
  intervalMs: number;            // scheduler ticks once/min; <60_000 rounds up
  instructions: string;          // freeform: what to watch, when to alert/recommend
  toolAllowlist: string[] | null; // null = all enabled; [] = read-only (emit_* only)
  lastRunAt?: Date; lastRunStatus?: "ok" | "error"; lastRunError?: string;
}
```

- A scanner is the SAME agent loop as chat, with **write tools denied** and two
  pseudo-tools added: `emit_alert` and `emit_recommendation`.
- Scheduler is a once-per-minute tick that runs due scanners (`now - lastRunAt >=
  intervalMs`). Enforce `toolAllowlist` at dispatch time, not by prompt.

## 7. Actions feed (persistence + lifecycle)

- Kinds: `alert` (FYI/risk) vs `recommendation` (carries a `suggestedPrompt`
  that pre-fills chat on "Execute").
- Status: `pending → executed | dismissed`. Retain ALL rows forever as history.
- De-dup `insertAction` only against existing **pending** rows for the same
  `(source, title)`. A previously-dismissed item may fire again as a fresh row.

## 8. Markdown memory (stateless agent, stateful file)

- One user-authored markdown blob on the `user_settings` row.
- Inject it into EVERY agent prompt (chat + scanners) wrapped in clear
  delimiters. The agent stays stateless; the file holds chains, risk tolerance,
  protocol taboos, learned preferences, and is written back as preferences change.

## 9. Secrets at rest

- Derive keys from one `SESSION_SECRET` via HKDF (domain-separated).
- Sessions: HMAC-signed cookie. Stored API keys + wallet OAuth tokens:
  AES-256-GCM. Rotating the secret logs everyone out and orphans encrypted rows.

## 10. Mocks-first → testnet flip

Every external edge (LLM, Base MCP, chain/signer, data providers, payment
facilitator) sits behind an interface from sections 1–4. Build against mocks,
test, then flip a config/env to point the SAME interfaces at **Base Sepolia**
(chain id `84532`) — no agent-core changes. That config seam IS the deliverable
boundary between the "mocks" phase and the "Sepolia" phase.
