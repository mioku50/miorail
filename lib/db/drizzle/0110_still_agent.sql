-- Still Agent (2026-11-22): a person's own agent and its errands.
--
-- still_agents: one per wallet, named by its owner, numbered in the order
-- agents were made (the number is a badge, it grants nothing). errands_active
-- counts its active errands, so the limit holds in one statement even when
-- the same errand is added twice at once. The Telegram
-- columns hold the chat the owner joined to Still's agents bot, and the bot
-- Telegram made for them through that bot (Managed Bots), whose token is kept
-- encrypted with a key that is not in this database.
--
-- still_agent_errands: a card the person wants on a day. Nothing is bought
-- here: on the day the agent prepares a review, and the person signs it in
-- their own wallet. The product and package are Bitrefill's, as read when the
-- errand was set; funding is how the person chose to pay, and a loan's
-- collateral is the one they chose. A removed errand is kept, inactive, so a
-- reminder already sent still names what it was about.
--
-- still_agent_errand_runs: one row per errand per day it came due, written
-- once, saying where the reminder went: the person's own bot, Still's agents
-- bot, the site alone, or nowhere because the errand was over the free one
-- after a pass ended ('paused').
--
-- still_agent_link_codes: the one-time code that joins a Telegram chat to an
-- agent, stored as its SHA-256 only, like the alerts bot's.
--
-- still_agent_passes: an Agent Pass, one row per USDC transfer that paid it,
-- read from its receipt. A wallet's first-month price is taken once.
--
-- Stored: wallets (never served to anyone but their owner), the names the
-- owner typed, Bitrefill's product names, Telegram chat and bot ids. No email,
-- no order id. Applied as the app user, like every migration here. Re-runnable.

CREATE TABLE IF NOT EXISTS still_agents (
  wallet_address   text         PRIMARY KEY,
  agent_no         integer      NOT NULL,
  name             text         NOT NULL,
  avatar           text         NOT NULL,
  language         text         NOT NULL,
  time_zone        text         NOT NULL,
  created_at       timestamptz  NOT NULL,
  updated_at       timestamptz  NOT NULL,
  tg_chat_id       bigint,
  tg_linked_at     timestamptz,
  bot_requested_at timestamptz,
  bot_id           bigint,
  bot_username     text,
  bot_token_enc    text,
  bot_chat_id      bigint,
  bot_created_at   timestamptz,
  errands_active   smallint     NOT NULL DEFAULT 0,
  CONSTRAINT still_agents_no UNIQUE (agent_no),
  CONSTRAINT still_agents_bot UNIQUE (bot_id),
  CONSTRAINT still_agents_number CHECK (agent_no >= 1),
  CONSTRAINT still_agents_wallet CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT still_agents_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 24),
  CONSTRAINT still_agents_avatar CHECK (avatar IN ('pip', 'orbit', 'spark', 'leaf', 'wave', 'star')),
  CONSTRAINT still_agents_language CHECK (language IN ('en', 'ru')),
  CONSTRAINT still_agents_zone CHECK (time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]{1,63}$'),
  CONSTRAINT still_agents_errands CHECK (errands_active BETWEEN 0 AND 100),
  CONSTRAINT still_agents_telegram CHECK ((tg_chat_id IS NULL) = (tg_linked_at IS NULL) AND (tg_chat_id IS NULL OR tg_chat_id > 0)),
  CONSTRAINT still_agents_bot_whole CHECK (
    (bot_id IS NULL AND bot_username IS NULL AND bot_token_enc IS NULL AND bot_chat_id IS NULL AND bot_created_at IS NULL)
    OR (bot_id > 0 AND bot_username ~ '^[A-Za-z0-9_]{5,32}$' AND length(bot_token_enc) BETWEEN 20 AND 400 AND bot_created_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS still_agents_chat_idx ON still_agents (tg_chat_id) WHERE tg_chat_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS still_agent_errands (
  errand_id      uuid         PRIMARY KEY,
  wallet_address text         NOT NULL REFERENCES still_agents (wallet_address) ON DELETE CASCADE,
  kind           text         NOT NULL,
  every          text         NOT NULL,
  month          smallint,
  day            smallint     NOT NULL,
  time_zone      text         NOT NULL,
  country        text         NOT NULL,
  product_id     text         NOT NULL,
  product_name   text         NOT NULL,
  package_value  text         NOT NULL,
  package_label  text         NOT NULL,
  funding        text         NOT NULL,
  collateral     text,
  recipient      text,
  active         boolean      NOT NULL DEFAULT true,
  next_due_at    timestamptz  NOT NULL,
  created_at     timestamptz  NOT NULL,
  updated_at     timestamptz  NOT NULL,
  CONSTRAINT still_agent_errands_kind CHECK ((kind = 'subscription' AND every = 'month') OR (kind = 'gift' AND every = 'year')),
  CONSTRAINT still_agent_errands_when CHECK (
    (every = 'month' AND month IS NULL AND day BETWEEN 1 AND 28)
    OR (every = 'year' AND month BETWEEN 1 AND 12 AND day BETWEEN 1 AND 31)),
  CONSTRAINT still_agent_errands_zone CHECK (time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]{1,63}$'),
  CONSTRAINT still_agent_errands_country CHECK (country ~ '^[A-Z]{2}$'),
  CONSTRAINT still_agent_errands_product CHECK (product_id ~ '^[a-z0-9][a-z0-9_.-]{0,99}$'
    AND char_length(btrim(product_name)) BETWEEN 1 AND 120
    AND char_length(btrim(package_value)) BETWEEN 1 AND 64
    AND char_length(btrim(package_label)) BETWEEN 1 AND 84),
  CONSTRAINT still_agent_errands_funding CHECK (
    (funding = 'usdc' AND collateral IS NULL) OR (funding = 'loan' AND collateral ~ '^[A-Za-z]{2,8}$')),
  CONSTRAINT still_agent_errands_recipient CHECK (recipient IS NULL OR (kind = 'gift' AND char_length(btrim(recipient)) BETWEEN 1 AND 30))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS still_agent_errands_due_idx ON still_agent_errands (next_due_at) WHERE active;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS still_agent_errands_wallet_idx ON still_agent_errands (wallet_address) WHERE active;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS still_agent_errand_runs (
  errand_id  uuid         NOT NULL REFERENCES still_agent_errands (errand_id) ON DELETE CASCADE,
  due_at     timestamptz  NOT NULL,
  told       text         NOT NULL,
  told_at    timestamptz  NOT NULL,
  PRIMARY KEY (errand_id, due_at),
  CONSTRAINT still_agent_errand_runs_told CHECK (told IN ('own_bot', 'agents_bot', 'site', 'paused'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS still_agent_link_codes (
  code_hash      text         PRIMARY KEY,
  wallet_address text         NOT NULL,
  created_at     timestamptz  NOT NULL,
  expires_at     timestamptz  NOT NULL,
  used_at        timestamptz,
  CONSTRAINT still_agent_link_codes_hash CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT still_agent_link_codes_wallet CHECK (wallet_address ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS still_agent_passes (
  tx_hash        text           PRIMARY KEY,
  wallet_address text           NOT NULL,
  plan           text           NOT NULL,
  amount_atomic  numeric(20, 0) NOT NULL,
  block_number   bigint         NOT NULL,
  starts_at      timestamptz    NOT NULL,
  ends_at        timestamptz    NOT NULL,
  created_at     timestamptz    NOT NULL,
  CONSTRAINT still_agent_passes_hash CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT still_agent_passes_wallet CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT still_agent_passes_plan CHECK (plan IN ('intro', 'month', 'year')),
  CONSTRAINT still_agent_passes_amount CHECK (amount_atomic > 0),
  CONSTRAINT still_agent_passes_span CHECK (ends_at > starts_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS still_agent_passes_intro_idx ON still_agent_passes (wallet_address) WHERE plan = 'intro';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS still_agent_passes_wallet_idx ON still_agent_passes (wallet_address, ends_at DESC);
