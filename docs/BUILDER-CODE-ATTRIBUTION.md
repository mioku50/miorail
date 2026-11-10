# Builder Code attribution

Every transaction a person sends from Miorail or Still carries Miorail's Base
Builder Code as an ERC-8021 attribution suffix. Without it, Base cannot
attribute the activity to the app, and there is no error and no warning: the
data is lost silently and for good.

## What the Builder Code is

The `bc_…` value registered at [base.dev](https://base.dev) > Settings >
Builder Codes. It is a **public** value, not a secret. The production build
gets it from `BASE_BUILDER_CODE` in the server's environment, as
`VITE_BASE_BUILDER_CODE` for the web app and `NEXT_PUBLIC_BASE_BUILDER_CODE`
for the Next.js surface (`ops/deploy.sh`); a build without a valid code is
refused. The older names `VITE_BUILDER_CODE` and `NEXT_PUBLIC_BUILDER_CODE`
are still read, and a build where the two disagree is refused too.

## How a transaction carries it

The server prepares unsigned calls only; the person's own wallet signs and
sends them. `lib/wallet-actions/src/attribution.ts` turns the code into the
ERC-8021 suffix (`builderCodeToDataSuffix`, through `ox/erc8021`) and
attaches it in one of two ways:

- **As a capability.** Each `wallet_sendCalls` batch carries
  `capabilities.dataSuffix` with `optional: true`. A wallet that supports it
  appends the code to the transaction itself, so the calls go exactly as
  approved.
- **In each call's data** (`attributedCallsV1`). A wallet that does not name
  the capability, such as MetaMask, drops it, so each call gets the code
  appended to its own data instead: the approved bytes, zero bytes up to the
  next 32-byte word, then the code. Contracts ignore what follows their
  arguments, and the server's checks accept exactly this shape. A call sent as
  its own transaction, by a wallet without batches, ends with the code too.

A call never carries the code twice. While the wallet has not answered
`wallet_getCapabilities`, and for a batch whose network fee Still's sponsor
pays, the calls go exactly as approved, because the wallet appends the code to
the user operation itself and the sponsor checks the calls byte for byte.
Attribution never changes what a call does and never blocks a transaction.

## Checking it

- On [base.dev](https://base.dev) > Onchain > Total Transactions, attributed
  transactions are counted after they confirm.
- On Basescan, a confirmed transaction's input ends with the ERC-8021 marker,
  `8021` repeated, when the code is attached.
- Validator: <https://builder-code-checker.vercel.app/>

## Rule

Every transaction this app asks a wallet to send carries the Builder Code, by
the capability or in its calls. A path that sends without it is a bug.
