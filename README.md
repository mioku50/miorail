# Miorail

> formerly MioAgent

**Miorail** is a Base-native AI command center for users who want an agent that can watch the market, understand their preferences, prepare onchain actions, and execute only inside clearly defined safety limits.

It is designed as an open-source, self-hostable alternative to Base agent terminals: the same useful primitives — chat, tools, scanners, memory, wallet actions — but with two important upgrades:

1. **x402 pay-per-action economics** — expensive inference, scanner runs, and heavy tool calls can be metered per action instead of hidden inside a subscription or paid by the host.
2. **Safe autonomy** — the agent can eventually act through limited session keys / spend permissions with user-defined limits, whitelist, TTL, and kill switch.

> Current stage: **Base Sepolia MVP**  
> Target product: **Base-first autonomous agent terminal**  
> Demo: `https://98.86.240.34.sslip.io`  
> Mainnet: **disabled by default**

---

## Product vision

Miorail is not just a chatbot and not just a wallet dashboard.

The goal is to become a personal AI operator for Base:

- it monitors tokens, protocols, positions, risks, and opportunities;
- it remembers the user's preferences and risk policy;
- it turns natural language into structured onchain actions;
- it explains every action before execution;
- it charges compute transparently with x402;
- it can graduate from manual approval to limited safe autonomy.

The user should not need to jump between explorers, dashboards, portfolio trackers, protocol UIs, risk tools, and wallet popups. Miorail brings those workflows into one Base-native terminal.

---

## The user problem

A normal Base user faces several problems:

- too many dashboards and protocols to monitor;
- no unified memory of personal preferences;
- no simple way to turn an idea into a safe transaction;
- AI tools can suggest actions, but often cannot execute safely;
- autonomous agents are risky if they have unlimited permissions;
- compute costs are unclear when the agent runs continuously.

Miorail solves this by separating **thinking**, **preparation**, **payment**, and **execution**.

The agent can think and recommend, but actions are routed through safety checks, the Action Inbox, x402 metering, and eventually bounded autonomy.

---

## Core user case

Imagine a user who is active on Base and wants help with tokens, protocols, and opportunities.

They can ask:

```text
Watch my Base portfolio, alert me if risk changes, find useful actions, and only execute inside my daily limit.
```

Miorail should be able to:

1. read the user's configured memory and policy;
2. check Base data through enabled tools and MCP servers;
3. run scanners in the background;
4. emit alerts or recommendations;
5. prepare one-click actions;
6. simulate and screen every action;
7. request x402 payment for billable compute;
8. execute manually through wallet approval or automatically through limited session permissions;
9. write an audit trail for every decision.

This turns the product into a Base-native agent terminal for everyday onchain operations.

---

## How Miorail works

```text
User
  ↓
Terminal UI / Agent Stream
  ↓
Agent Core: LLM loop + tool calling
  ↓
Memory + Policy + Scanners
  ↓
Base MCP / Tool Layer
  ↓
Action Inbox
  ↓
Safety Checks + Simulation + x402 Metering
  ↓
Base Smart Wallet / Base Account
```

### 1. Agent Stream

The user talks to the agent in natural language. The agent can answer, call tools, inspect memory, and prepare structured actions.

### 2. Memory and policy

Miorail is designed around explicit user memory:

- preferred tokens;
- blocked protocols;
- risk tolerance;
- maximum slippage;
- budget limits;
- scanner preferences;
- autonomy boundaries.

The target model is **markdown-as-memory + Postgres for structured data**. The agent stays mostly stateless, while user preferences and decisions remain inspectable.

### 3. Tool layer and Base MCP

Miorail uses a tool layer where each source can be enabled or disabled.

Target integrations include:

- **Base Account MCP** for wallet-aware actions;
- **EIP-5792 batched calls** for prepared transaction execution;
- **Base Smart Wallet / Base Account** for user approval and future session permissions;
- token and portfolio tools;
- risk tools such as GoPlus;
- market and protocol data tools such as CoinGecko, DeFi Llama, Morpho, Bankr, or similar Base-relevant sources.

The important idea: the agent does not blindly execute text. It converts intent into typed tool calls and structured actions.

### 4. Scanners

Scanners are background agent loops with write tools disabled.

They can run on intervals and emit two types of output:

- **Alerts** — information, risk warnings, or important changes;
- **Recommendations** — proposed actions that appear in the Action Inbox.

Examples:

- token risk scanner;
- portfolio drift scanner;
- yield opportunity scanner;
- protocol update scanner;
- budget scanner;
- autonomy boundary scanner.

### 5. Action Inbox

Every important action becomes a reviewable card.

The user can see:

- action type;
- reason;
- estimated effect;
- token/protocol tags;
- safety status;
- simulation result;
- cost of compute/action;
- execution status.

The user can then choose:

- **Execute**;
- **Dismiss**;
- **Block similar actions**;
- **Update policy/memory**.

This is the main safety boundary between AI reasoning and onchain execution.

---

## Base MCP role

Base MCP is the execution bridge between the agent and Base-native wallet actions.

In the target architecture, Miorail uses Base MCP to:

- prepare wallet-aware calls;
- build EIP-5792 call bundles;
- route actions through Base Account / Smart Wallet approval;
- receive approval URLs or request IDs;
- keep execution no-custody and user-controlled.

Without the approval provider configured, Miorail must fail closed:

```text
Approval provider is not configured. Action was not executed.
```

That behavior is intentional. The agent should never pretend an action executed if it cannot produce a valid approval flow.

## Spend Permissions Mainnet Rollout

Miorail keeps autonomous spend permissions fail-closed by default:

- bounded execution policies and per-action reservations are persisted in Postgres (`autonomy_policies`, `autonomy_execution_reservations`), separately from x402 fuel permissions;
- `CHAIN_ENV=sepolia` derives Base Sepolia (`84532`, `0x14a34`, `testnet: true`);
- `CHAIN_ENV=mainnet-readonly` derives Base Mainnet metadata but blocks autonomous execution;
- `CHAIN_ENV=mainnet` can prepare mainnet EIP-5792 requests only when `MAINNET_EXECUTION_ENABLED=true` and the user has an explicit server-side mainnet autonomy opt-in;
- only canonical USDC for the selected Base chain is accepted;
- transfer recipients must be in the policy whitelist; approval actions are restricted to `approve(spender, 0)` revocations;
- one execution guard binds the declared action type to the exact calldata semantics before a wallet payload can be prepared, then applies prompt/memory screening, canonical-chain checks, preflight validation, and contract risk gates;
- mainnet USDC transfers require a usable token-level GoPlus verdict; missing, failed, unknown, or high-risk verdicts fail closed, while zero-only approval revocations remain available because they reduce exposure;
- `spent_today + reserved_today + action_amount <= daily_limit` is enforced by one atomic database update, preventing concurrent prepares from overspending the cap;
- a prepare reserves budget but returns only an unsigned EIP-5792 `wallet_sendCalls` payload; it never signs or broadcasts;
- the client verifies the connected Base Account reports atomic batch support before calling the prepare endpoint, so an unsupported wallet cannot create a budget reservation;
- reservations settle only after durable onchain/wallet proof and are released after cancellation, failure, dismissal, expiry, or kill switch;
- the kill switch marks the policy inactive, releases active reservations, and blocks future prepares.

Provider readiness is based on evidence, not configuration alone: GoPlus is reported as connected only after a usable token scan. The same health state is shared by the status endpoint, scanner output, and execution guard.

The production interface exposes capability states (`Active`, `Limited`, `Off`) instead of vendor and transport details. The regular Configure screen contains only wallet-bound permissions, limits, recipients, lifetime, and the kill switch. Operators can build the separate `/diagnostics` surface with `VITE_ENABLE_DIAGNOSTICS=true`; keep it disabled in user builds.

The Configure screen exposes the four independent execution gates: runtime/global flag, per-user mainnet opt-in, DB policy plus wallet match, and mandatory Base Account approval. A saved policy can therefore be honestly shown as **staged** while the runtime remains `mainnet-readonly`.

The legacy Base Sepolia helper is read-only. API routes no longer read `TESTNET_PRIVATE_KEY` or `PRIVATE_KEY`; testnet mutations must be signed by a connected wallet and submitted with transaction proof.

BaseApp and Base MCP OAuth are independent wallet contexts. In an embedded
BaseApp session, the verified SIWE wallet is always the tenant and execution
wallet: balances use the native portfolio providers, and send/swap actions are
prepared for client-side `wallet_sendCalls`. A different Base MCP OAuth wallet
disables only wallet-scoped MCP tools; protocol and market reads remain
available. See [`docs/T47_BASEAPP_NATIVE_WALLET.md`](docs/T47_BASEAPP_NATIVE_WALLET.md).

Sepolia to mainnet checklist:

1. Run DB migrations through `0008_autonomy_execution_gateway.sql` so the policy and reservation tables exist.
2. Keep `MAINNET_EXECUTION_ENABLED=false` while switching reads to `CHAIN_ENV=mainnet-readonly`.
3. Verify `/api/status.autonomy` reports database persistence and the expected chain mode.
4. Pin `BASE_MAINNET_USDC_ADDRESS` only if you intentionally override the built-in canonical Base USDC address.
5. Configure a wallet-bound policy in the UI, keep it staged, and verify daily/max/TTL/whitelist plus kill-switch behavior.
6. Set `MAINNET_EXECUTION_ENABLED=true` only for the intended rollout window; user-confirmed wallet approval remains required.

---

## Differentiator 1: x402 pay-per-action

Continuous agents consume real compute:

- LLM calls;
- portfolio scans;
- risk checks;
- simulations;
- protocol queries;
- background jobs.

Miorail's target model is to meter billable actions through **x402**.

The desired flow:

```text
User requests a billable action
  ↓
API returns HTTP 402 Payment Required with price
  ↓
User pays in USDC on Base
  ↓
Action unlocks once
  ↓
Ledger records action → cost → payment proof
```

Why this matters:

- transparent compute cost;
- no hidden subscription requirement;
- each heavy action can pay for itself;
- self-hosters do not need to absorb all compute costs;
- scanners can stop automatically when budget is exhausted.

Target x402 features:

- per-action pricing;
- anti-replay payment validation;
- daily/monthly user budgets;
- scanner budget guardrails;
- exportable billing ledger.

---

## Differentiator 2: Safe Autonomy Engine

Manual approval is safe, but slow. Full autonomy is powerful, but dangerous.

Miorail's answer is **bounded autonomy**.

The user can grant a limited session key or spend permission with:

- maximum amount;
- allowed tokens;
- allowed protocols/contracts;
- TTL / expiration time;
- max slippage;
- risk policy;
- kill switch.

Inside those boundaries, the agent can eventually execute actions such as:

- rebalance;
- exit a risky position;
- take profit;
- claim rewards;
- run recurring small actions;
- respond to predefined scanner triggers.

Outside those boundaries, execution must be blocked and logged.

---

## Differentiator 3: Security as a product

Miorail should make safety visible, not hidden.

Every prepared action should eventually include:

- pre-trade simulation;
- expected output;
- slippage impact;
- portfolio impact;
- contract/protocol risk checks;
- MEV-aware routing when relevant;
- policy compliance;
- audit log.

The user should understand not only **what** the agent wants to do, but **why** it is allowed and **what could go wrong**.

---

## Target feature map (русская версия)

| Area | Target behavior |
| --- | --- |
| Chat | Natural language agent interface |
| Actions | Structured Action Inbox with execute/dismiss flow |
| Scanners | Background alerts and recommendations |
| Memory | Markdown memory + Postgres structured state |
| Base MCP | Base-native call preparation and approval flow |
| x402 | USDC pay-per-action compute metering |
| Autonomy | Session keys / spend permissions with limits |
| Security | Simulation, risk checks, policy enforcement |
| Wallet | Base Smart Wallet / Base Account no-custody flow |
| UI | Tabbed terminal: chat, inbox, memory, config, portfolio |

---

## Product phases

### Phase 1 — Base agent parity

Build the useful core:

- agent loop;
- Base MCP connection;
- terminal UI;
- Action Inbox;
- scanners;
- memory;
- tool toggles;
- portfolio and token views.

### Phase 2 — x402 economics

Add transparent pay-per-action billing:

- HTTP 402 responses;
- USDC payment verification;
- action ledger;
- budget limits;
- scanner cost controls.

### Phase 3 — Safe autonomy

Add limited execution permissions:

- session keys / spend permissions;
- TTL;
- whitelist;
- kill switch;
- audit logs;
- fallback to manual approval.

### Phase 4 — Security-as-product

Make action safety the core UX:

- simulation cards;
- GoPlus/risk checks;
- MEV-aware routing;
- policy enforcement;
- clear user-facing explanations.

### Phase 5 — Distribution

Make it usable where Base users already live:

- Farcaster;
- Base App;
- Basenames;
- Frames / mini-app flows;
- agent profiles.

---

## Current MVP status (русская версия)

The current MVP already demonstrates the foundation:

- web UI served publicly;
- API server running on a VPS;
- Neon Postgres connected;
- OpenAI-compatible LLM runtime connected;
- Action Inbox rendering backend actions;
- Base Sepolia environment;
- fail-closed execute behavior when approval provider is not configured.

This is not the final product yet. The current version proves the architecture and gives a working base for the next phases.

---

## Safety notice (русская версия)

Miorail is an experimental MVP.

Do not use it with real funds until the wallet approval flow, action simulation, permission boundaries, x402 validation, and security checks are production hardened.

---

## Русская версия

### Miorail (русская версия)

**Miorail** — это Base-native AI command center для пользователей, которым нужен агент, способный следить за рынком, понимать их предпочтения, готовить onchain-действия и выполнять их только внутри заранее заданных границ безопасности.

Проект задуман как open-source, self-hostable альтернатива Base agent terminal: те же полезные элементы — чат, tools, scanners, memory, wallet actions — но с двумя важными усилениями:

1. **x402 pay-per-action экономика** — дорогие inference-запросы, scanner runs и heavy tool calls могут оплачиваться за конкретное действие, а не скрываться в подписке или ложиться на владельца сервера.
2. **Безопасная автономия** — агент в будущем сможет действовать через ограниченные session keys / spend permissions с лимитом, whitelist, TTL и kill switch.

> Текущая стадия: **Base Sepolia MVP**  
> Целевой продукт: **Base-first autonomous agent terminal**  
> Демо: `https://98.86.240.34.sslip.io`  
> Mainnet: **отключён по умолчанию**

---

## Видение продукта

MioAgent — это не просто chatbot и не просто wallet dashboard.

Цель проекта — стать персональным AI-оператором для Base:

- он мониторит tokens, protocols, positions, risks и opportunities;
- помнит пользовательские предпочтения и risk policy;
- превращает natural language в structured onchain actions;
- объясняет каждое действие перед execution;
- прозрачно считает compute через x402;
- может перейти от manual approval к ограниченной безопасной автономии.

Пользователь не должен постоянно прыгать между explorers, dashboards, portfolio trackers, protocol UIs, risk tools и wallet popups. Miorail собирает эти workflows в один Base-native terminal.

---

## Проблема пользователя

Обычный пользователь Base сталкивается с несколькими проблемами:

- слишком много dashboards и protocols для мониторинга;
- нет единой памяти личных предпочтений;
- сложно превратить идею в безопасную транзакцию;
- AI tools могут советовать, но часто не могут безопасно исполнять;
- автономные агенты опасны, если им дать неограниченные права;
- compute costs непрозрачны при постоянной работе агента.

Miorail решает это через разделение **мышления**, **подготовки**, **оплаты** и **исполнения**.

Агент может думать и рекомендовать, но действия проходят через safety checks, Action Inbox, x402 metering и в будущем bounded autonomy.

---

## Основной user case

Представим пользователя, который активно работает в Base и хочет помощь с tokens, protocols и opportunities.

Он может сказать:

```text
Watch my Base portfolio, alert me if risk changes, find useful actions, and only execute inside my daily limit.
```

Miorail должен уметь:

1. читать user memory и policy;
2. проверять Base data через включённые tools и MCP servers;
3. запускать scanners в фоне;
4. создавать alerts или recommendations;
5. готовить one-click actions;
6. симулировать и проверять каждое действие;
7. запрашивать x402 payment за billable compute;
8. исполнять вручную через wallet approval или автономно через ограниченные session permissions;
9. записывать audit trail по каждому решению.

Так продукт превращается в Base-native agent terminal для повседневных onchain operations.

---

## Как работает Miorail

```text
User
  ↓
Terminal UI / Agent Stream
  ↓
Agent Core: LLM loop + tool calling
  ↓
Memory + Policy + Scanners
  ↓
Base MCP / Tool Layer
  ↓
Action Inbox
  ↓
Safety Checks + Simulation + x402 Metering
  ↓
Base Smart Wallet / Base Account
```

### 1. Agent Stream

Пользователь общается с агентом обычным языком. Агент может отвечать, вызывать tools, читать memory и готовить structured actions.

### 2. Memory and policy

Miorail строится вокруг явной пользовательской памяти:

- preferred tokens;
- blocked protocols;
- risk tolerance;
- maximum slippage;
- budget limits;
- scanner preferences;
- autonomy boundaries.

Целевая модель — **markdown-as-memory + Postgres для structured data**. Агент остаётся относительно stateless, а предпочтения и решения пользователя остаются inspectable.

### 3. Tool layer and Base MCP

Miorail использует tool layer, где каждый источник можно включить или выключить.

Целевые интеграции:

- **Base Account MCP** для wallet-aware actions;
- **EIP-5792 batched calls** для подготовленного execution;
- **Base Smart Wallet / Base Account** для user approval и будущих session permissions;
- token и portfolio tools;
- risk tools вроде GoPlus;
- market/protocol data tools вроде CoinGecko, DeFi Llama, Morpho, Bankr или похожих Base-relevant sources.

Главная идея: агент не исполняет текст вслепую. Он превращает intention в typed tool calls и structured actions.

### 4. Scanners

Scanners — это фоновые agent loops с отключёнными write-tools.

Они могут работать по интервалам и создавать два типа output:

- **Alerts** — информация, risk warnings или важные изменения;
- **Recommendations** — предложенные actions, которые появляются в Action Inbox.

Примеры:

- token risk scanner;
- portfolio drift scanner;
- yield opportunity scanner;
- protocol update scanner;
- budget scanner;
- autonomy boundary scanner.

### 5. Action Inbox

Каждое важное действие превращается в карточку для проверки.

Пользователь видит:

- action type;
- reason;
- estimated effect;
- token/protocol tags;
- safety status;
- simulation result;
- compute/action cost;
- execution status.

После этого пользователь может:

- **Execute**;
- **Dismiss**;
- **Block similar actions**;
- **Update policy/memory**.

Это главный safety boundary между AI reasoning и onchain execution.

---

## Роль Base MCP

Base MCP — это execution bridge между агентом и Base-native wallet actions.

В целевой архитектуре Miorail использует Base MCP, чтобы:

- готовить wallet-aware calls;
- собирать EIP-5792 call bundles;
- отправлять actions через Base Account / Smart Wallet approval;
- получать approval URLs или request IDs;
- сохранять execution no-custody и user-controlled.

Если approval provider не настроен, Miorail обязан fail closed:

```text
Approval provider is not configured. Action was not executed.
```

Это не ошибка, а намеренная защита. Агент не должен делать вид, что action выполнен, если он не может создать валидный approval flow.

---

## Дифференциатор 1: x402 pay-per-action

Постоянно работающие агенты потребляют реальный compute:

- LLM calls;
- portfolio scans;
- risk checks;
- simulations;
- protocol queries;
- background jobs.

Целевая модель Miorail — metering billable actions через **x402**.

Желаемый flow:

```text
User requests a billable action
  ↓
API returns HTTP 402 Payment Required with price
  ↓
User pays in USDC on Base
  ↓
Action unlocks once
  ↓
Ledger records action → cost → payment proof
```

Почему это важно:

- прозрачная стоимость compute;
- не нужна скрытая подписка;
- каждое тяжёлое действие может платить само за себя;
- self-hosters не обязаны покрывать все compute costs;
- scanners могут автоматически останавливаться при исчерпании бюджета.

Целевые x402 features:

- per-action pricing;
- anti-replay payment validation;
- daily/monthly user budgets;
- scanner budget guardrails;
- exportable billing ledger.

---

## Дифференциатор 2: Safe Autonomy Engine

Manual approval безопасен, но медленный. Полная автономия мощная, но опасная.

Ответ Miorail — **bounded autonomy**.

Пользователь может выдать ограниченный session key или spend permission с параметрами:

- maximum amount;
- allowed tokens;
- allowed protocols/contracts;
- TTL / expiration time;
- max slippage;
- risk policy;
- kill switch.

Внутри этих границ агент в будущем сможет выполнять действия:

- rebalance;
- exit из рискованной позиции;
- take profit;
- claim rewards;
- recurring small actions;
- реакция на predefined scanner triggers.

Всё, что выходит за границы, должно блокироваться и логироваться.

---

## Дифференциатор 3: Security as a product

Miorail должен делать безопасность видимой.

Каждое подготовленное действие в целевой версии должно включать:

- pre-trade simulation;
- expected output;
- slippage impact;
- portfolio impact;
- contract/protocol risk checks;
- MEV-aware routing где это важно;
- policy compliance;
- audit log.

Пользователь должен понимать не только **что** агент хочет сделать, но и **почему** это разрешено и **что может пойти не так**.

---

## Target feature map

| Area | Target behavior |
| --- | --- |
| Chat | Natural language agent interface |
| Actions | Structured Action Inbox with execute/dismiss flow |
| Scanners | Background alerts and recommendations |
| Memory | Markdown memory + Postgres structured state |
| Base MCP | Base-native call preparation and approval flow |
| x402 | USDC pay-per-action compute metering |
| Autonomy | Session keys / spend permissions with limits |
| Security | Simulation, risk checks, policy enforcement |
| Wallet | Base Smart Wallet / Base Account no-custody flow |
| UI | Tabbed terminal: chat, inbox, memory, config, portfolio |

---

## Фазы продукта

### Phase 1 — Base agent parity

Собрать полезное ядро:

- agent loop;
- Base MCP connection;
- terminal UI;
- Action Inbox;
- scanners;
- memory;
- tool toggles;
- portfolio and token views.

### Phase 2 — x402 economics

Добавить прозрачный pay-per-action billing:

- HTTP 402 responses;
- USDC payment verification;
- action ledger;
- budget limits;
- scanner cost controls.

### Phase 3 — Safe autonomy

Добавить ограниченные execution permissions:

- session keys / spend permissions;
- TTL;
- whitelist;
- kill switch;
- audit logs;
- fallback to manual approval.

### Phase 4 — Security-as-product

Сделать action safety основой UX:

- simulation cards;
- GoPlus/risk checks;
- MEV-aware routing;
- policy enforcement;
- clear user-facing explanations.

### Phase 5 — Distribution

Сделать продукт доступным там, где уже живут Base users:

- Farcaster;
- Base App;
- Basenames;
- Frames / mini-app flows;
- agent profiles.

---

## Current MVP status

Текущий MVP уже показывает фундамент:

- public web UI;
- API server;
- Neon Postgres;
- OpenAI-compatible LLM runtime;
- Action Inbox с backend actions;
- Base Sepolia environment;
- fail-closed execute behavior, если approval provider не настроен.

Это ещё не финальный продукт. Текущая версия доказывает архитектуру и даёт основу для следующих фаз.

---

## Safety notice

Miorail — экспериментальный MVP.

Не используйте его с реальными средствами, пока wallet approval flow, action simulation, permission boundaries, x402 validation и security checks не будут production hardened.

---

## License

TBD.
