# Contributing to Miorail

Thanks for looking. This project has an unusual bar in one specific place, so
it is worth reading the short version before you write code.

## The bar

**Miorail is an evidence product. It must never claim more than it measured.**

Most review comments you will get here are about that, not about style. A
patch that makes a number appear is easy; a patch that makes a number appear
*only when it was actually measured* is the one that gets merged. Concretely:

- A read that failed is not a read that returned nothing.
- A capability that is configured is not a capability that works — prove it.
- "Not measured" and "measured as zero" are different values and must stay
  different all the way to the screen.
- If you cannot state where a number came from, it does not go on the screen.

Comments in this codebase explain *why*, usually by naming the bug the code
prevents. Please write them that way. A comment restating what the line does
adds nothing; a comment saying what broke last time is the reason the line is
shaped like that.

## Getting set up

```bash
pnpm install
pnpm test:unit      # the gate — must be green
pnpm typecheck
pnpm -r exec tsc -b # catches what typecheck does not; the deploy runs this
pnpm lint
```

Node 22, pnpm 10+. Copy `.env.example` to `.env`; everything that needs a
credential reports itself unconfigured rather than failing, so most of the
product runs with none.

`pnpm test:unit` stops at the first failing group. If you are surprised by how
few tests ran, that is why — fix the first failure and run it again.

## Before you open a pull request

- `pnpm test:unit` green, `pnpm -r exec tsc -b` clean, `pnpm lint` clean.
- New behaviour has a test that would fail without your change.
- If you changed anything a user reads, say what it said before and what it
  says now, and why the old one was wrong.
- Dependencies: this repo enforces a 7-day minimum release age. If pnpm
  refuses a version, pin a mature one; do not relax the policy.

## Security

Do not open a public issue for a security bug — see [SECURITY.md](SECURITY.md).

Pull requests touching signing, submission, the Safety Kernel, the host
allowlist or credential handling get a slower and more sceptical review. That
is not distrust of you; it is the part where a mistake costs somebody money.

## Licence

Miorail is licensed under the **GNU Affero General Public License v3.0**. By
contributing you agree that your contribution is licensed under the same terms.

AGPL means that if you run a modified Miorail as a network service, the people
using it are entitled to your modified source. If that does not suit your use,
open an issue and say what you are trying to do before writing the code.
