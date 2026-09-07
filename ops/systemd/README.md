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
| `miorail-rwa-official` | 6h | two HTTPS requests to published documents |
| `miorail-rwa-cash-exit` | 1h | 13 `eth_call` + ~104 aggregator quotes, paced |
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

## Prerequisites

`B20_DISCOVER_START_BLOCK` must be set once, before the first run, or discovery
refuses with `configuration_required` rather than guessing where history begins.
`BASE_MAINNET_RPC_URL` and `DATABASE_URL` come from the same `.env` the API
reads.
