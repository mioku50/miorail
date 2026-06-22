# Cobalt Agent — Autonomous Build Instructions

This repository is a clean-room implementation of a self-hostable, no-custody AI agent for Base.

Core documents:
- docs/VISION.md
- docs/TECH-PLAN.md
- skills/orbitlab-base-agent-patterns/SKILL.md

Important rules:
- Do not copy OrbitLab source code.
- Reimplement everything from scratch using clean-room interfaces and invariants.
- Keep external edges behind interfaces: LLM, Base MCP, chain/signer, data providers, x402 facilitator.
- Start with mocks first, then flip config to Base Sepolia.
- The agent never holds private keys and never broadcasts directly.
- No-custody execution must go through Base MCP send_calls / EIP-5792 approval URLs.
- Action-security screening is mandatory before any executable recommendation reaches the inbox.
- Do not commit secrets, .env files, private keys, OAuth tokens, API keys, or RPC URLs.

Workflow:
- Work in small phases.
- Keep tasks aligned with docs/TECH-PLAN.md.
- Run checks before every commit.
- Commit directly to main locally with clear commit messages.
- Do not create separate PRs unless explicitly requested.
