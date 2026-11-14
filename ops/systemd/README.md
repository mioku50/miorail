# Production units

`miorail-miniapp.service` serves the built Base App on `127.0.0.1:3020`. The
`miorail-b20-*` units are the canonical production workers. `ops/deploy.sh`
installs all three on every deploy, including their checked-in runtime
drop-ins.

**Nothing proxies to the Base App yet.** This file used to say the production
Nginx MiniApp host pointed at `3010`; that routing lives in a
`sites-available/ritual-familiars` server block which is not enabled, so the
sentence had become false without anything failing. Two consequences worth
knowing before changing either:

* the surface is built and health-checked on every deploy but is unreachable
  from the internet, and reaching it needs a hostname and a server block that
  do not exist;
* `3010` is held by an unrelated PM2 application on this host, in a restart
  loop. Port 3020 moved Miorail off a port it was contesting and losing.

Those drop-ins deliberately reset `EnvironmentFile` to the project `.env`.
Do not add a second, unmanaged RPC environment file: an endpoint that answers
`eth_blockNumber` but refuses historical `eth_getLogs` leaves discovery active
while its cursor never moves. The worker journal exposes
`logWindowsCompleted/logWindowsAttempted` so this failure is visible.

The older `mioagent-b20-*` files remain adaptable templates for another host.
The two long-running B20 workers have no timers: see the header of each unit
for why.

## The RWA vertical's four oneshot workers

`miorail-rwa-*.service` are oneshots driven by a `.timer` of the same stem, and
`ops/deploy.sh` installs and enables all four pairs on every deploy. They are
what makes Discover's Official Assets tab able to say anything:

| Timer | Every | What a pass costs |
| --- | --- | --- |
| `miorail-rwa-official` | 1h | Coinbase Stocks API, two Base publications and Backed API |
| `miorail-rwa-cash-exit` | 1h, plus Fri 20:01/20:14/20:27 ET | one bounded chain batch plus paced quotes for the reviewed corpus |
| `miorail-rwa-lookalikes` | 6h | nothing outbound at all — two stored tables |
| `miorail-rwa-market-tail` | 1h | ~4 `eth_getLogs` for the whole vertical |
| `miorail-rwa-watchlist` | 5m | whatever is due: 1 `eth_call` + 8 quotes each |

None of them holds a signer, a key or a wallet, and none writes to the chain.

`miorail-rwa-watchlist`'s timer is not its promise. The promise is the interval
each watched address is scheduled at, derived from how many addresses are
watched across every account; the timer only decides how often the queue is
looked at, and running it more often than the promise is what keeps a
fifteen-minute schedule near fifteen minutes instead of drifting by a tick. A
pass with nothing due exits in milliseconds.

## Base App notifications

`miorail-base-app-notify` is a oneshot on a 5-minute timer, installed by the
same loop in `ops/deploy.sh`. It turns what the workers above record into Base
App pushes: issuer events to every wallet that pinned Miorail in Base App and
turned notifications on, market transitions to the wallets that watch the
token, Radar events to the watch's owner — at most one push per wallet per pass
and four per day. It needs `BASE_DEV_API` (the Base Dashboard key) in the env
file and reports `off` without it; `MIORAIL_BASE_APP_NOTIFICATIONS_V1=off`
stops it with the key in place. Its first pass only opens its cursors, so
nothing recorded before it existed is ever sent. Migration 0071 must be applied
before the first deploy that enables it.

The order matters once, on a new host: nothing else can run usefully until
`miorail-rwa-official` has recorded a corpus, because the other three read the
official universe to decide what to look at.

Each emitter opens its signal watch before its first pass and reports nothing
on that pass — a transition can only be seen by something that was already
watching. So the Signals tab is empty after the first run of each, by design,
and the tab states the date it started watching rather than implying silence.

Check them:

```bash
systemctl list-timers 'miorail-rwa-*' --no-pager
journalctl -u miorail-rwa-cash-exit -n 50 --no-pager
```

Install the MiniApp unit manually only when bootstrapping a host without the
deploy script:

```bash
sudo install -m 0644 ops/systemd/miorail-miniapp.service /etc/systemd/system/miorail-miniapp.service
sudo systemctl daemon-reload
sudo systemctl enable --now miorail-miniapp
```

Install the B20 worker templates after adapting their user and paths to the
host:

```bash
sudo cp ops/systemd/mioagent-b20-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mioagent-b20-discover mioagent-b20-measure
```

Check them:

```bash
systemctl status mioagent-b20-discover mioagent-b20-measure
journalctl -u mioagent-b20-discover -n 50 --no-pager
```

Every log line is JSON with counts and categories only — no endpoint, no token
address in an error, no credential.

Stopping is clean: `SIGTERM` ends the loop after the pass in flight, so a
restart never interrupts a commit and never leaves a lease held by a process
that no longer exists (the lease expires on its own regardless).

## Service alerts

`miorail-ops-alerts` is a oneshot on a two-minute timer, installed by the same
loop in `ops/deploy.sh`. It exists because a failed unit used to be a line in
a journal nobody reads: `miorail-rwa-official` failed every hour from
2026-10-07 to 2026-10-09 before anyone looked.

A pass reads every `miorail-*` unit's state and keeps one episode per failed
unit in `/var/lib/miorail-ops-alerts/state.json`. Each episode is announced
once in Telegram, reminded once a day while the unit stays failed, and closed
with one message once the unit has settled and stayed out of `failed` for ten
minutes. Units that fail together go out as one message. The message names
the unit, systemd's result and the time, never a journal line, so nothing a
failing process printed can reach a chat.

The same pass reads what never shows as `failed` and says it the same way:

* `postgresql@18-main`, `nginx` and `miorail-api` stopped for more than a
  minute and a half, and `certbot` failed;
* a unit systemd started again by itself since the last pass (a crash, or the
  kernel ending it for memory), from `NRestarts`;
* the API running and not answering `GET /health` on its own port, asked twice;
* no backup finished for a day and a half;
* the certificate the server presents for each public host, from two weeks
  before it ends (`OPS_ALERT_TLS_HOSTS` adds hosts);
* the disk, from 80% full, and the dates the environment names.

Every pass starts Node. When `OPS_ALERT_HEARTBEAT_URL` is set, every pass asks
for that address once, so a monitor outside the server can tell when the passes
themselves have stopped; nothing on the server can say that.

Chats subscribe with a one-time link issued on the server (node by its full
path: a non-interactive shell does not load nvm):

```bash
sudo -u miorail bash -c 'cd /home/miorail/mioagent && /home/miorail/.nvm/versions/node/v22.23.1/bin/node --import tsx scripts/ops_alert_link.ts'
```

The link works once, for ten minutes. `/stop` in the chat turns the alerts
off, together with any wallet the chat follows. The subscribed chats are also
copied to `chats.json` in the state directory, so a pass can still speak while
the database is the thing that is down. A pass that sends something writes
the copy, and so does a quiet pass once the copy is missing or six hours old,
so a new chat is in it within six hours, before anything fails.

## Pending Route Proofs

`miorail-route-proofs` is a oneshot on an hourly timer, installed by the same
loop (audit OPS-1, 2026-11-14). Only the page reconciled a Route Proof, once,
so a page that closed early or a reconcile that failed left a proof `pending`
after its transactions had landed. A pass reads at most fifty proofs that
recorded transactions, untouched for ten minutes and less than thirty days
old, and settles each as the reconcile route would: receipts from Base, the
same append-only proof events. It signs and sends nothing. A proof with no
transaction recorded is left as it is. `--dry-run` only counts them.

## Prerequisites

`B20_DISCOVER_START_BLOCK` must be set once, before the first run, or discovery
refuses with `configuration_required` rather than guessing where history begins.
`BASE_MAINNET_RPC_URL` and `DATABASE_URL` come from the same `.env` the API
reads.
