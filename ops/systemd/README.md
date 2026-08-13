# Production units

`miorail-miniapp.service` serves the built Base App on `127.0.0.1:3010`, where
the production Nginx MiniApp host proxies. The `miorail-b20-*` units are the
canonical ritual-vps workers. `ops/deploy.sh` installs all three on every
deploy, including their checked-in runtime drop-ins.

Those drop-ins deliberately reset `EnvironmentFile` to the project `.env`.
Do not add a second, unmanaged RPC environment file: an endpoint that answers
`eth_blockNumber` but refuses historical `eth_getLogs` leaves discovery active
while its cursor never moves. The worker journal exposes
`logWindowsCompleted/logWindowsAttempted` so this failure is visible.

The older `mioagent-b20-*` files remain adaptable templates for another host.
No timers: see the header of each worker unit for why.

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
