# B20 pipeline units

Two long-running workers. No timers: see the header of each unit for why.

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
