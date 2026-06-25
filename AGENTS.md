# mioagent  — Autonomous Build Instructions

This repository is a clean-room implementation of a self-hostable, no-custody AI agent for Base.

Core documents:

- docs/VISION.md
- docs/TECH-PLAN.md
- skills/orbitlab-base-agent-patterns/SKILL.md
- .agents/skills

- For future MioAgent tasks, you do not need to ask for confirmation before opening a PR if all of the following are true:

- the task is already listed in agent_tasks.json
- the implementation stays within the selected task scope
- no real secrets, credentials, private keys, wallet custody, signing, broadcasting, or mainnet behavior are introduced
- no major architecture change is introduced
- validation commands pass or any known local-only failure is clearly documented
- agent_tasks.json is updated correctly

In those cases, proceed automatically:

1. implement the task
2. run validation
3. update agent_tasks.json
4. open one focused PR
5. summarize changes and validation results

Only stop and ask me if:

- there is a scope ambiguity
- validation fails for reasons related to your changes
- the task would require secrets, live wallet execution, mainnet behavior, or a major architecture decision
- you need to delete/replace large parts of the project

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
