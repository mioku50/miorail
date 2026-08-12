# Production units

`miorail-miniapp.service` serves the built Base App on `127.0.0.1:3010`, where
the production Nginx MiniApp host proxies. `ops/deploy.sh` installs and verifies
this unit on every deploy.

The remaining checked-in units are the two long-running B20 workers. No timers:
see the header of each worker unit for why.

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
