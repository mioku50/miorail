# o1 Trading API — Miorail compatibility research

**Originally checked:** 2026-08-01

**Superseded:** 2026-08-12 by the official Base MCP o1.exchange skill v0.3.0

**Current verdict:** the standard `POST /api/v2/order` path with
`mevProtection: false` is compatible; the Permit2 `/order/complete` relay path
remains incompatible and disabled.

The original analysis below is retained as historical evidence for the
Permit2 path. It must no longer be read as a verdict on every Trading API
order. The released Miorail adapter decodes standard unsigned RLP transactions,
uses the official shared credential, pins the Base router's ERC-1967 proxy,
admin, implementation and bytecode hashes, replaces provider unlimited approval
with an exact approval, and routes execution through Base Account plus Route
Proof. It does not use `O1_AGGREGATOR_API_KEY`, `signTransaction`,
`/order/complete`, or provider broadcast.

This document records what the official specification and the official sample
implementation actually require, so the verdict below can be re-checked by
someone who does not trust this document.

---

## 1. Sources

| Source | Identity |
|---|---|
| `https://docs.o1.exchange/llms.txt` | Documentation index, fetched 2026-08-01 |
| `https://docs.o1.exchange/api/trading` | Trading API specification, fetched 2026-08-01 |
| `https://docs.o1.exchange/api/dex-aggregator` | DEX Aggregator API — a **different product**, fetched 2026-08-01 |
| `github.com/CohumanSpace/o1-api` | Official sample repository |
| — commit | `09c575bea35e160408192e28f42626e29b480290` (2026-03-06T05:54:06Z, "Solana in SKILL.md (#3)") |
| — sample file | `sampleScripts/execute-trade-interactive.js`, sha256 `b67e3be2c8d32c98cd886a7de6d9fccdcfae4aa808a9f37498b8417451823eb3` |

Fixtures derived from these sources live in `lib/o1-compat/test/fixtures.ts` and
carry their own content hash, so a report built from them is reproducible
without network access.

---

## 2. Trading API surface

- **Host:** `api.o1.exchange`
- **Order endpoint:** `POST /api/v2/order`
- **Completion endpoint:** `POST /api/v2/order/complete` — *not implemented by Miorail, see §5*
- **Authentication:** `Authorization: Bearer <token>`
- **Networks:** Base `8453`, BSC `56`, Solana `1399811149`

### Request

```json
{
  "networkId": 8453,
  "signerAddress": "0x…",
  "tokenAddress": "0x…",
  "uiAmount": "100",
  "direction": "buy" | "sell",
  "slippageBps": 100,
  "mevProtection": true,
  "quoteTokenAddress": "0x…",
  "poolAddress": "0x…"
}
```

### Response

```json
{
  "success": true,
  "id": "…",
  "transactions": [
    {
      "id": "…",
      "unsigned": { "to": "0x…", "data": "0x…", "value": "0x0", "gasLimit": "0x…", "chainId": 8453 },
      "permit2": { "eip712": { "domain": {}, "types": {}, "values": {} } }
    }
  ]
}
```

### Signing sequence (from the official sample, lines 145–185)

1. `wallet.signTypedData(domain, types, values)` — the Permit2 EIP-712 signature.
2. `data = data.replace(SIGNATURE_PLACEHOLDER, signature.slice(2))` — the
   signature is **substituted into the provider's calldata** at a fixed
   placeholder.
3. `wallet.signTransaction(unsignedTx)` — a **raw transaction signature**.
4. `POST /api/v2/order/complete` with the signed raw transaction; **o1
   broadcasts**, and returns `{ hash, status, tokenDelta }`.

`SIGNATURE_PLACEHOLDER` is the fixed 130-hex-character constant
`42f6…62ff1b` (65 bytes: `r ‖ s ‖ v`). The sample comments it "Fixed value,
don't change it".

The sample obtains its key from `EXECUTE_TRADE_PRIVATE_KEY` and constructs
`new Wallet(PRIVATE_KEY)`.

---

## 3. Documentation gaps found

These are gaps, not defects — recorded because a compatibility claim cannot rest
on them either way.

- **Chain binding is not guaranteed by the schema.** The documented request
  carries `networkId: 8453` while the documented `unsigned` response example
  carries `chainId: 1`. Whether that is a documentation slip or real behaviour
  cannot be determined from the specification, so chain binding must be
  re-checked at runtime on every response. `lib/o1-compat` treats a mismatch as
  `provider_chain_mismatch` and refuses.
- **No documented quote evidence.** The response carries no expected output, no
  minimum output, no fee breakdown, no price impact, no route sources, no quote
  expiry and no block number. Slippage is expressed only as a request input
  (`slippageBps`).
- **MEV protection is a request boolean.** There is no returned evidence that a
  private mempool was used, and no verifiable artefact to check afterwards.
- **Permit2 parameters are not documented.** `domain`, `types` and `values` are
  typed only as `object`. Amount, spender, nonce, expiration and `sigDeadline`
  bounds are therefore unknown until a live response is inspected.
- **No documented statement of EIP-1271 support** for the Permit2 typed data,
  which is what a smart-contract wallet would need.

---

## 4. Why this is incompatible with the Miorail execution path

Miorail has exactly one execution path:

```
provider response → normalisation → full decode → ExecutionBlueprint
→ Safety Kernel → Alchemy simulation → user Review → wallet_sendCalls
→ receipt reconciliation
```

The Trading API is incompatible with it in six independent ways. Any one of
them is sufficient; all six hold.

### 4.1 It requires a raw private key

The official flow signs with an EOA key held by the integrator. Miorail holds no
user key and never will. This is not a configuration difference — it is the
opposite custody model.

### 4.2 It requires `signTransaction`

A Base Account is an ERC-4337 smart contract wallet. It has no raw-transaction
signing primitive at all: it signs *user operations*, and `wallet_sendCalls`
submits *calls*. There is no adapter shape that turns a `signTransaction`
requirement into an EIP-5792 batch, because the artefact o1 needs (a signed
RLP transaction from an EOA) is one a smart wallet cannot produce.

### 4.3 It requires provider-side broadcast

`/order/complete` is what puts the transaction on chain. Miorail would therefore
never receive a Base Account batch id — which is the handle the entire
submission-recovery path is built on (T67C.2). The provider's returned `hash`
is a claim, not a receipt Miorail observed.

### 4.4 The calldata changes after the quote

The Permit2 signature is substituted into `unsigned.data` at a fixed
placeholder. The bytes that execute are therefore *not* the bytes that were
quoted. Simulation before substitution simulates something that will not run;
simulation after substitution happens on bytes the user has not reviewed unless
the Review is re-run — and the substitution is performed on calldata Miorail
did not construct.

### 4.5 Builder Code attribution cannot survive

ERC-8021 attribution is appended to the outer call. Appending bytes to a
*signed* raw transaction invalidates the signature; appending them before
signing changes the bytes o1 expects to receive back. There is no ordering in
which a suffix is both attributed and valid.

### 4.6 The result cannot be reconciled

Route Proof binds `approvedCallsHash → batchId → receipts → actual delta`.
Without a batch id and without Miorail observing the submission, the chain
breaks at its first link. `tokenDelta` from `/order/complete` is a
provider-reported number, and a provider response is not a proof.

---

## 5. What Miorail therefore does NOT implement

- No `/api/v2/order/complete` client.
- No `signTransaction` anywhere.
- No private-key environment variable.
- No raw-transaction broadcast.
- No Permit2 approval transaction.
- No second wallet path beside `useSubmitApprovedBlueprint`.

`lib/o1-compat` is a read-only compatibility gate. It can request an unsigned
order batch (only under an explicit live flag and an interactive confirmation)
and it decodes and judges what comes back. It signs nothing and moves nothing.

---

## 6. The DEX Aggregator API is a different product

`swap.o1.exchange` / the DEX Aggregator API is architecturally much closer to
Miorail and **must not be conflated with the Trading API**:

- Base mainnet only (`chainId: 8453`).
- `POST /quote` → `quoteId`, `expectedAmountOut`, `routePlan`.
- `POST /submit` → `{ to, data, value }` for the O1Router contract.
- The user signs and submits directly. **No `/complete` endpoint.**
- Slippage is enforced inside the router, per-leg and globally.

That shape — provider returns calls, user's wallet submits them — is the shape
Miorail already supports. It is *not* evaluated here and is *not* connected. Its
own gaps (no documented minimum output, quote expiry, block number or price
impact in the published spec) would have to be closed before a Route Candidate
could be built honestly.

Nothing in this document should be read as the DEX Aggregator being integrated,
approved, or scheduled.

---

## 7. Verdict

`incompatible` — recorded as `incompatible_with_base_account_v1`.

Hard blockers present: requires user private key; requires server-side or raw
signing; requires `signTransaction`; requires provider broadcast; requires
`/order/complete`; cannot preserve Builder Code; cannot reconcile the onchain
result.

Re-running `pnpm o1:compat` reproduces the finding list and the report hash from
the pinned fixtures. If o1 later publishes a flow that returns calls for the
user's own wallet to submit — as the DEX Aggregator already does — this gate is
the thing to re-run, not a decision to revisit from memory.
