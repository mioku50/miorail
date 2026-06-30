# MioAgent

**MioAgent** is a self-hostable, no-custody AI agent for Base Sepolia.

It gives users a simple interface where they can talk to an AI assistant, receive blockchain action suggestions, review every action in an Action Inbox, and execute only after backend validation. The project is designed around safety: no frontend private keys, no mainnet by default, no silent execution, and clean fail-closed behavior when an approval provider is not configured.

> Current environment: **Base Sepolia MVP**  
> Live demo: `https://98.86.240.34.sslip.io`  
> Status: local/VPS demo-ready, mainnet disabled

---

## What is MioAgent?

MioAgent is an experimental AI-powered Web3 assistant that connects three layers:

1. **AI chat** — the user gives the agent an instruction in natural language.
2. **Action safety layer** — the backend validates, screens, and prepares possible blockchain actions.
3. **Action Inbox** — the user sees the exact action and decides whether to execute or dismiss it.

The project is not a custodial wallet and not an autonomous trading bot. It is a user-controlled agent interface for safer AI-assisted onchain workflows.

---

## User use case

A user wants to interact with Base without manually navigating many dashboards, explorers, tools, and dApps.

With MioAgent, the user can:

- ask the agent for help with Base Sepolia activity;
- receive suggested actions in a dedicated Action Inbox;
- inspect what the agent wants to do before execution;
- execute only approved actions;
- dismiss unsafe or unwanted suggestions;
- keep AI, database, and API infrastructure self-hosted;
- run the whole stack on their own VPS.

Example flow:

```text
User: Find a safe Base Sepolia action for my wallet.
Agent: Checks available tools and prepares a suggested transfer/swap/task.
Backend: Validates the action and creates an Action Inbox item.
User: Reviews the action and clicks Execute.
System: Produces an approval request or fails closed if approval infrastructure is missing.
```

---

## Core features

### AI Agent Stream

A chat interface powered by an OpenAI-compatible LLM provider. In the current demo, FreeModel is used through an OpenAI-compatible API configuration.

### Action Inbox

All suggested onchain actions appear as reviewable cards. The user can:

- execute a pending action;
- dismiss it;
- see action status;
- see tokens/tags and backend-generated metadata.

### Fail-closed execution

If the backend cannot produce an approval URL or request ID, the action is not executed. The UI shows a clear message instead of pretending that the transaction succeeded.

### Base Sepolia first

The project is intentionally locked to Base Sepolia for the MVP. Mainnet execution is not enabled by default.

### No-custody design

MioAgent does not require private keys in the frontend. The intended model is user approval through a wallet or approval provider, not hidden agent custody.

### Self-hostable stack

The project can run on an Ubuntu VPS using:

- Node.js + pnpm;
- Neon Postgres;
- FreeModel or another OpenAI-compatible LLM;
- Caddy reverse proxy;
- sslip.io free domain;
- HTTPS via automatic Caddy certificates.

---

## Current demo architecture

```text
Browser UI
   ↓
Caddy HTTPS reverse proxy
   ↓
MioAgent API server on localhost:8080
   ↓
Neon Postgres + LLM provider + Base Sepolia runtime
```

Frontend is served as static files. API traffic is proxied through Caddy:

```text
/api/*  →  127.0.0.1:8080
/health →  127.0.0.1:8080
```

---

## Tech stack

- **Frontend:** React, Vite, Tailwind CSS
- **Backend:** Node.js, Express
- **Database:** Neon Postgres + Drizzle
- **LLM:** OpenAI-compatible provider interface
- **Chain:** Base Sepolia
- **Deployment:** Ubuntu VPS, systemd, Caddy, sslip.io
- **Package manager:** pnpm workspace monorepo

---

## Repository structure

```text
mioagent/
├── artifacts/
│   ├── api-server/       # Backend API server
│   └── interface/        # Web interface
├── lib/
│   ├── agent/            # Agent runtime logic
│   ├── api-client-react/ # React API hooks
│   ├── db/               # Database schema and client
│   ├── llm/              # LLM provider abstraction
│   ├── security/         # Action safety layer
│   └── tools/            # Tool aggregation/runtime helpers
├── scripts/              # Smoke tests and seed scripts
├── docs/                 # Technical documentation
├── agent_tasks.json      # Project task tracker
└── README.md
```

---

## Local development

### 1. Install dependencies

```bash
pnpm install
```

If pnpm blocks dependency build scripts, approve only the required packages:

```bash
pnpm approve-builds esbuild protobufjs
pnpm install
```

### 2. Configure environment

Create `.env` in the repository root:

```env
CHAIN_ENV=sepolia
NODE_ENV=development
PORT=8080

DATABASE_URL=postgresql://USER:PASSWORD@HOST/neondb?sslmode=require
SESSION_SECRET=replace-with-a-long-random-secret

LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.freemodel.dev
LLM_API_KEY=your_llm_key
LLM_MODEL=gpt-5.4-mini

BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BASE_RPC_URL=https://sepolia.base.org

# Optional. If missing, execution fails closed.
# MCP_SERVER_URL=
```

Never commit `.env` or private keys.

### 3. Check database and LLM

```bash
pnpm db:probe
pnpm smoke:llm
```

### 4. Start API

```bash
PORT=8080 pnpm exec tsx artifacts/api-server/index.ts
```

Check health:

```bash
curl http://127.0.0.1:8080/health
```

Expected:

```json
{"status":"ok"}
```

### 5. Start frontend

```bash
pnpm --filter @mioagent/interface dev -- --host 0.0.0.0
```

Open:

```text
http://localhost:5173
```

---

## Production/VPS deployment summary

1. Clone the repository on an Ubuntu VPS.
2. Install Node.js 22 and pnpm.
3. Add `.env` with Neon, LLM, and Base Sepolia settings.
4. Run:

```bash
pnpm install
pnpm db:probe
pnpm smoke:llm
```

5. Run the API with systemd on port `8080`.
6. Build the frontend:

```bash
pnpm --filter @mioagent/interface build
```

7. Copy build output to `/var/www/mioagent`:

```bash
sudo mkdir -p /var/www/mioagent
sudo rsync -a --delete artifacts/interface/dist/ /var/www/mioagent/
sudo chown -R caddy:caddy /var/www/mioagent
```

8. Serve with Caddy:

```caddy
YOUR_SERVER_IP.sslip.io {
    encode gzip

    handle /api/* {
        reverse_proxy 127.0.0.1:8080
    }

    handle /health {
        reverse_proxy 127.0.0.1:8080
    }

    handle {
        root * /var/www/mioagent
        try_files {path} /index.html
        file_server
    }
}
```

9. Open ports `80` and `443` in the cloud firewall/security group.
10. Open the sslip.io domain in a browser.

---

## Smoke tests

```bash
pnpm db:probe
pnpm smoke:llm
pnpm smoke:api
pnpm smoke:sepolia-action
```

Expected behavior without `MCP_SERVER_URL`:

```text
Execute failed closed as expected.
```

This is correct. It means the backend refused to fake an execution result.

---

## Security model

MioAgent follows a conservative security model:

- no mainnet by default;
- no private keys in the frontend;
- no silent transaction execution;
- all actions go through an Action Inbox;
- backend validation before execution;
- fail-closed behavior when approval infrastructure is unavailable;
- self-hostable runtime;
- explicit environment configuration.

This project is a demo/MVP and should not be used with real funds until the wallet approval flow, security checks, and production hardening are complete.

---

## Roadmap

- Real wallet connection for Base Sepolia
- Full approval provider integration
- Better action simulation UI
- More Base tools and protocols
- User-level settings and memory controls
- Improved action history and audit logs
- Optional x402 metering for agent/tool usage
- Production deployment guide

---

## Русская версия

# MioAgent

**MioAgent** — это self-hosted AI-агент для Base Sepolia с no-custody архитектурой.

Он даёт пользователю простой интерфейс: можно общаться с AI-ассистентом, получать предложенные onchain-действия, проверять их в Action Inbox и выполнять только после backend-валидации. Проект построен вокруг безопасности: никаких приватных ключей во frontend, mainnet по умолчанию отключён, скрытого выполнения нет, а при отсутствии approval provider система корректно останавливается в fail-closed режиме.

> Текущая среда: **Base Sepolia MVP**  
> Демо: `https://98.86.240.34.sslip.io`  
> Статус: готово для локального/VPS demo, mainnet отключён

---

## Что такое MioAgent?

MioAgent — это экспериментальный AI-powered Web3 ассистент, который соединяет три слоя:

1. **AI chat** — пользователь пишет агенту инструкцию обычным языком.
2. **Action safety layer** — backend проверяет, фильтрует и подготавливает возможные blockchain actions.
3. **Action Inbox** — пользователь видит точное действие и сам решает: выполнить или отклонить.

Это не custodial wallet и не автономный trading bot. Это пользовательский интерфейс для более безопасных AI-assisted onchain workflows.

---

## Пользовательский сценарий

Пользователь хочет взаимодействовать с Base без постоянного переключения между множеством dashboards, explorers, tools и dApps.

С MioAgent пользователь может:

- попросить агента помочь с активностью в Base Sepolia;
- получить предложенные действия в Action Inbox;
- проверить, что именно агент хочет сделать;
- выполнить только подтверждённое действие;
- отклонить нежелательное или небезопасное действие;
- держать AI, database и API на собственном сервере;
- запустить весь стек на своём VPS.

Пример flow:

```text
User: Find a safe Base Sepolia action for my wallet.
Agent: Checks available tools and prepares a suggested transfer/swap/task.
Backend: Validates the action and creates an Action Inbox item.
User: Reviews the action and clicks Execute.
System: Produces an approval request or fails closed if approval infrastructure is missing.
```

---

## Основные возможности

### AI Agent Stream

Чат-интерфейс, работающий через OpenAI-compatible LLM provider. В текущем demo используется FreeModel через OpenAI-compatible API.

### Action Inbox

Все предложенные onchain-действия отображаются как карточки для проверки. Пользователь может:

- выполнить pending action;
- отклонить действие;
- увидеть статус;
- посмотреть tags/tokens и metadata от backend.

### Fail-closed execution

Если backend не может создать approval URL или request ID, действие не выполняется. UI показывает понятное сообщение, а не имитирует успешную транзакцию.

### Base Sepolia first

MVP намеренно ограничен Base Sepolia. Mainnet execution по умолчанию не включён.

### No-custody дизайн

MioAgent не требует приватных ключей во frontend. Целевая модель — подтверждение пользователем через wallet или approval provider, а не скрытое хранение ключей агентом.

### Self-hostable stack

Проект можно запустить на Ubuntu VPS с использованием:

- Node.js + pnpm;
- Neon Postgres;
- FreeModel или другого OpenAI-compatible LLM;
- Caddy reverse proxy;
- бесплатного sslip.io домена;
- HTTPS через automatic Caddy certificates.

---

## Архитектура demo

```text
Browser UI
   ↓
Caddy HTTPS reverse proxy
   ↓
MioAgent API server on localhost:8080
   ↓
Neon Postgres + LLM provider + Base Sepolia runtime
```

Frontend отдаётся как static build. API проксируется через Caddy:

```text
/api/*  →  127.0.0.1:8080
/health →  127.0.0.1:8080
```

---

## Технологии

- **Frontend:** React, Vite, Tailwind CSS
- **Backend:** Node.js, Express
- **Database:** Neon Postgres + Drizzle
- **LLM:** OpenAI-compatible provider interface
- **Chain:** Base Sepolia
- **Deployment:** Ubuntu VPS, systemd, Caddy, sslip.io
- **Package manager:** pnpm workspace monorepo

---

## Локальный запуск

```bash
pnpm install
pnpm db:probe
pnpm smoke:llm
PORT=8080 pnpm exec tsx artifacts/api-server/index.ts
```

В отдельном терминале:

```bash
pnpm --filter @mioagent/interface dev -- --host 0.0.0.0
```

Открыть:

```text
http://localhost:5173
```

---

## VPS deployment

1. Склонировать репозиторий на Ubuntu VPS.
2. Установить Node.js 22 и pnpm.
3. Создать `.env` с Neon, LLM и Base Sepolia настройками.
4. Проверить:

```bash
pnpm db:probe
pnpm smoke:llm
```

5. Запустить API через systemd на `localhost:8080`.
6. Собрать frontend:

```bash
pnpm --filter @mioagent/interface build
```

7. Скопировать build в `/var/www/mioagent` и отдать через Caddy.
8. Открыть порты `80` и `443`.
9. Перейти на sslip.io домен.

---

## Модель безопасности

MioAgent использует консервативную модель безопасности:

- mainnet отключён по умолчанию;
- приватные ключи не используются во frontend;
- нет скрытого выполнения транзакций;
- все действия попадают в Action Inbox;
- backend проверяет action перед execution;
- при отсутствии approval provider система fail-closed;
- runtime можно self-hosted запустить на своём сервере;
- конфигурация задаётся явно через environment variables.

Проект является demo/MVP. Его не следует использовать с реальными средствами, пока wallet approval flow, security checks и production hardening не будут полностью завершены.

---

## License

TBD.
