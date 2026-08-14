# Legacy Spend Permission experiment

`MioSpendPermissionController.sol` is the project’s historical Base Sepolia
experiment. It is intentionally outside Foundry’s default `src`, `test`, and
`script` directories.

It is **not** Miorail’s production Spend Permission primitive and is not
deployed by the product. Production onboarding uses the official Base Account
Spend Permission SDK and verifies the wallet-returned permission onchain before
binding it to an Intelligence Budget.

The old source, test, and deployment script remain here only so earlier testnet
work can be reproduced and audited. Any attempt to revive this controller must
be treated as a new audited contract project; it must not be presented as the
Base Account Spend Permission implementation.
