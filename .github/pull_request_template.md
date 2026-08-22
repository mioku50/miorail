## What this changes

One or two sentences. If it changes anything a user reads, quote the old text
and the new one, and say why the old one was wrong.

## Why

Name the problem, not the patch. The best comments in this codebase say what
broke last time; the best PR descriptions do too.

## Evidence

- [ ] `pnpm test:unit` green
- [ ] `pnpm -r exec tsc -b` clean
- [ ] `pnpm lint` clean
- [ ] New behaviour has a test that fails without this change

If this touches signing, submission, the Safety Kernel, the host allowlist or
credential handling, say so here — that review is slower on purpose.

## Anything you are unsure about
