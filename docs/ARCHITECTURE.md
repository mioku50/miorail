# ARCHITECTURE

This document explains the current MioAgent architecture. It is concise and practical for coding agents.

## Core Architecture

MioAgent uses a clean-room, pnpm monorepo structure.

1. **API Server (`artifacts/api-server`)**
   - An Express.js backend that serves REST API endpoints.
   - Uses request-context (AsyncLocalStorage), session middleware, rate-limiting, and structured logging.

2. **Packages (`lib/*`)**
   - Modular internal packages containing isolated logic.
   - Examples include `lib/utils`, `lib/db`, `lib/llm`, `lib/tools`, `lib/mcp`, `lib/data-providers`, `lib/settings`.

3. **Agent Loop (`lib/agent-loop`)**
   - Core orchestrator for the AI interactions.
   - Assembles system prompts by combining user context (from `lib/memory` and `lib/settings`) and live context.
   - Dispatches tools and handles streaming responses.

4. **LLM Provider (`lib/llm`)**
   - Interacts with LLM models.
   - Has a real OpenAI-compatible client and a `MockLlmProvider` for deterministic testing.

5. **Tools and Aggregator (`lib/tools`)**
   - Provides a `ToolProvider` interface.
   - Aggregates multiple tool providers (e.g., native tools and remote MCP tools).

6. **Base MCP (`lib/mcp`)**
   - Base MCP client with injectable transports (including a Mock transport for early phases).
   - Used for interacting with the Base network and extracting execution payloads securely.

7. **Data Providers (`lib/data-providers`)**
   - Provides external data (e.g., token prices, portfolio balances).
   - Kept behind interfaces with mock implementations (MockMoralis, MockCoinGecko, etc.) for offline testing.

8. **Memory & Settings (`lib/memory`, `lib/settings`)**
   - Manage Markdown-based user memory contexts and system settings (model selection, encrypted API keys).
   - Persisted in the PostgreSQL database.

9. **Database (`lib/db`)**
   - PostgreSQL managed by Drizzle ORM.
   - Single source of truth for runtime data (users, chats, workflows, etc.).

10. **Frontend (Future)**
    - A React-based web interface and chat UI that will consume the REST API endpoints.
