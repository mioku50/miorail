# Miorail security model

What this program does, what it refuses to do, and where each refusal is
enforced. This document is the contract; the code is the implementation. If
they disagree, that is a bug — please report it.

## The one-sentence version

Miorail reads public data, composes a transaction, shows you exactly what it
will do, and hands it to your wallet. It never holds a key, never signs, and
never broadcasts.

## The boundary

### Keys and signing

| Miorail never | Enforced by |
| --- | --- |
| Holds, requests or derives a user private key | No key material in any schema, store or env read by the request path |
| Calls `signTransaction` | Absent from the codebase; a regression test asserts it stays absent |
| Broadcasts a signed transaction | Submission is `wallet_sendCalls` from the user's Base Account |
| Creates a second execution path | One submission hook, `useSubmitApprovedBlueprint` |

The server's own wallet exists only as an x402 *spender* for metered reads it
pays for. It cannot touch a user's funds.

### What the client may decide

The client sends an intent — "swap 100 USDC to ETH". It does **not** send, and
cannot influence, the calldata, the router, the route, the factory, the
recipient, the deadline, or the minimum output. Those are server decisions,
which is what makes the review screen meaningful: if the client could name the
router, reviewing the router would prove nothing.

### What you approve is what is submitted

The approved calls are hashed. The hash is recomputed at submission and again
by the simulation provider before it will simulate. A blueprint whose calls do
not match its hash is refused, not repaired.

### Simulation is a precondition, not a nicety

For any provider whose calldata Miorail writes itself, or whose calldata is
opaque (Aerodrome, Balancer, Hydrex, o1.exchange), a **passing simulation is
required before a signature is offered.** If no configured provider can execute
the batch, the route reports `unavailable` — it does not fall back to hope.

Simulation outcomes are mutually exclusive and named: `simulation_passed`,
`simulation_reverted`, `insufficient_funds`, `simulation_method_unsupported`,
`simulation_provider_unavailable`. The screen can never show two of them.

### Outbound network

Every outbound request goes through a host allowlist owned by code, generated
from the plugin specs Base publishes. A model can write text; it cannot
introduce a host, and it never receives a generic HTTP primitive. Provider
links shown in the UI come from a code-owned registry keyed by the plugin the
router resolved — never from model output.

### Secrets

API keys and RPC URLs are server-side only. They must not appear in evidence
fields, hashes, logs, tool traces, or any response body. Upstream error text is
redacted by value and every URL is stripped before it can be logged.

## What Miorail does NOT protect you from

Stating this plainly is part of the model.

- **The protocols themselves.** Miorail routes to third-party contracts. It
  does not audit them, and a measured route is not a safe investment.
- **Third-party plugins.** Base publishes them; Base does not operate, endorse
  or audit them, and neither does Miorail.
- **Market risk.** A measured exit is a measurement of the past. Liquidity can
  leave between the measurement and your transaction.
- **Your own approval.** Miorail shows you what a transaction does. If you
  approve it, it happens.
- **A compromised wallet or device.** Nothing here can help if the signer is
  already controlled by someone else.

## Reporting

See [SECURITY.md](../SECURITY.md).
