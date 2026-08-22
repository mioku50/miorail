# Security policy

Miorail composes transactions that people sign with their own wallets. A bug
here can cost someone money, so security reports are handled ahead of features.

## Reporting a vulnerability

**Do not open a public issue for a security bug.**

Use GitHub's private reporting — *Security → Report a vulnerability* on this
repository — or email **speedhall50@gmail.com** with `SECURITY` in the subject.

Please include what you need to make the finding reproducible: the affected
route or package, the input, what happened, and what you expected. A proof of
concept against your own wallet on Base mainnet or Base Sepolia is welcome; a
proof of concept against somebody else's funds is not.

**Response commitment:** acknowledgement within 3 business days, an assessment
with a fix or a rejection within 14 days. If a report is rejected you will be
told why, in terms specific enough to argue with.

## Scope

In scope, in rough order of severity:

- anything that moves a user's funds without an approval they saw and accepted
- anything that makes Miorail sign, hold, or transmit a private key
- a Safety Kernel bypass — a blueprint reaching a wallet without its checks
- prompt injection that changes which host, contract or calldata is reached
- a provider response that can alter a route's parameters after review
- credential exposure: a key in a log line, an evidence field, a hash, or an
  API response
- x402 payment handling: double settlement, wrong recipient, wrong amount

Out of scope:

- the public Base RPC, or any third-party plugin's own servers, being slow,
  rate-limited or down
- a plugin behaving badly on its own surface — report that to its authors
- missing hardening headers with no demonstrated impact
- volumetric denial of service

## What Miorail guarantees

These are structural invariants, not aspirations, and each is enforced in code
with tests. A report that breaks one of them is a valid finding by definition:

- The server never holds, requests, derives or transmits a private key.
- The server never calls `signTransaction` and never broadcasts a signed
  transaction. Every state change is submitted by the user's own Base Account.
- The client cannot choose calldata, router, recipient, deadline or minimum
  output. Those come from the server, and what the user approves is what is
  submitted — the approved calls are hashed and the hash is checked again at
  submission.
- A provider-written or server-written calldata route must simulate
  successfully before it may be signed. No simulation, no signature.
- Outbound HTTP is pinned to hosts declared in a code-owned allowlist. Model
  output can never introduce a host.

`docs/SECURITY-MODEL.md` states the boundary in full, including what Miorail
deliberately does **not** protect you from.

## Disclosure

Coordinated. We will agree a date with you, credit you unless you ask us not
to, and publish what was wrong and what changed. Miorail runs a hosted instance
at miorail.xyz; a fix ships there before the details are public.
