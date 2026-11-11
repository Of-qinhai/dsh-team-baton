# Baton

English | [中文](README.zh-CN.md)

Hand a task from one person's DSH to another. The recipient's panel shows a
pending request; only after they click **Accept and start** does a DSH Session
get created and receive the first message. The server only relays rooms, tasks,
and approval state — it never touches code and never stores a Session ID.

The socket server lives in this repository. The DSH plugin is a separate public
repository, checked out here as the `dsh-baton/` git submodule. The public build
connects to no server by default: deploy `baton-server` yourself, or obtain your
team's endpoint and shared secret from its administrator. The author's runtime is
not a public service.

Publication notes are in [PUBLICATION.md](PUBLICATION.md) (Chinese). This project
is licensed under [MIT](LICENSE).

## Repository layout

| Path | Contents |
|---|---|
| `baton-server/` | Rust WebSocket server (tokio + axum + rusqlite) |
| `dsh-baton/` | DSH plugin submodule → [dsh-team-baton-client](https://github.com/Of-qinhai/dsh-team-baton-client) |
| `compose.yaml` / `Caddyfile` / `Dockerfile` | Single-host container deployment |
| `scripts/backup.sh` | Consistent SQLite backup + seven-day retention |
| `plan.md` | Design and acceptance specification (Chinese) |

## Status

- **M0**: Session creation, naming, idle state, and first-message admission were
  verified on a real DSH install. See `dsh-baton/API-NOTES.md`.
- **M1**: Transaction, protocol, and WebSocket tests; two-client smoke test,
  reconnect, and state recovery are verified.
- **M2**: Plugin connection, the three agent tools, panel routes, and the full
  accept → start flow are integrated; a real panel click was accepted and the
  Session executed.
- **M3**: Containers, Caddy TLS/WSS, daily backups, and a Tencent Cloud deployment
  are verified. A two-machine acceptance run is still up to the user.

The current panel is a three-column layout: room navigation, task list, and task
detail/approval. On narrow screens it becomes list → detail. Sending, room
management, and manual review each have their own dialog. A failed send keeps its
draft; an unknown result keeps the original `taskId` until confirmed.

Each install configures directories in the panel and advertises only environment
keys and labels to room peers. Senders select a recipient environment; its actual
canonical path stays on the recipient's machine and is confirmed before execution.
Tasks support deleted-items archiving, restore and separately confirmed permanent
deletion by each participant. Both confirmations remove the live task content,
while linked DSH sessions remain. The left navigation collapses, and all three
task tabs scroll within the panel on narrow screens and short desktop windows.

The panel UI strings are currently Chinese; the protocol and code are
language-neutral.

Recent fixes cover concurrent approvals, concurrent state-file writes, crash
recovery, real-path revalidation, send idempotency, offline requests, and the
per-user room-join limit. The installed DSH plugin must be reloaded to pick up a
new panel; a reload does not replace a running plugin in place.

## Run locally first

The local flow exercises send → receive → inspect the local directory → manual
accept/decline → DSH Session → receipt.

```sh
cd dsh-baton
npm run local:setup
npm run local:start
```

`local:setup` initializes `data/`, a test workspace, and a stable `.baton-secret`,
preserving an existing key, and prints the config block for the DSH plugin.
`local:start` launches a loopback-only Rust server; if a matching service is
already listening on the same port it is reused. Restarts keep the same key and
local database.

Check the service in another terminal:

```sh
cd dsh-baton
npm run local:check
```

The check authenticates and syncs with a separate diagnostic identity; it creates
no room, task, or DSH Session and never prints the secret. The default endpoint is
`ws://127.0.0.1:8080/ws`; pass the same `BATON_BIND` to setup, start, and check for
another loopback port. A key mismatch between the environment and the file is
reported instead of being ignored.

Then reload the local Baton plugin in DSH and refresh the Client. Confirm the
panel reports a connection, then run a text-only task through accept and decline;
only a confirmed directory may start. Do not substitute the preview's sample
tasks for the real acceptance run.

## Server configuration

Environment variables:

| Variable | Meaning |
|---|---|
| `BATON_SECRET` | Required, at least 32 characters; the plugin must use the same value |
| `BATON_DB` | Absolute database path, default `/data/baton.db`; the parent must exist |
| `BATON_BIND` | Default `127.0.0.1:8080` |
| `TRUSTED_PROXY_CIDRS` | Only these peers' `X-Forwarded-For` is trusted; in production use Caddy's fixed `/32` |
| `BATON_LOG` | `error/warn/info/debug`, default `info` |

Tests and smoke scripts:

```sh
cd baton-server && cargo test
BATON_SECRET=... node smoke.mjs
BATON_SECRET=... node peer.mjs create <userId> <name>
BATON_SECRET=... node peer.mjs join <userId> <name> <code> --accept
```

`peer.mjs` is a development script, not part of the product.

## Plugin

Install inside DSH:

```text
plugin_manager install_bundle target=/absolute/path/to/dsh-team-baton-client
```

The plugin has its own repository:

```sh
git clone https://github.com/Of-qinhai/dsh-team-baton-client.git dsh-team-baton-client
cd dsh-team-baton-client
cp cordis.patch.example.yml cordis.patch.yml
```

If you cloned the server repository with `--recurse-submodules`, the same files
live under `dsh-baton/`; install target is still the plugin directory root.

Fill in your own server URL and directories, then install.
`cordis.patch.yml` is Git-ignored in the plugin repository, so your local configuration is not published.
You can also add a complete override row to the profile patch instead.

```yaml
serverUrl: wss://baton.example.com/ws
secretEnv: BATON_SECRET
secretFile: /Users/you/.config/baton/secret   # needed when launched from the desktop without shell env
displayName: Your name
environments:
  - { key: frontend, label: Frontend, cwd: /Users/you/workspace/web }
  - { key: backend,  label: Backend,  cwd: /Users/you/workspace/api }
```

- `secretFile` must be absolute and mode 0600; a non-empty environment variable
  wins. Authentication failure never silently falls back to another file.
- A non-localhost `serverUrl` must use `wss://`.
- The plugin is verified on DSH Desktop (Electron 44 / Node 24). Other DSH
  versions may change `sessionController` / `workspaceRegistry` / `uiWorkspace`.
- The first start creates a `userId` at `~/.dsh/baton/identity.json`; local start
  state lives at `~/.dsh/baton/state.json` (0600).
- The sender chooses an environment key; the recipient maps it to its own `cwd`.
  Remote paths are never sent, and there is no fallback directory.

The panel opens from the sidebar entry. The left column switches rooms, the middle
selects a task, and the right shows the full brief plus the canonical local
directory. Only **Accept and start** creates a Session; declining only updates
state. Room management copies room codes and member userIds; on narrow screens the
room icon in the header opens it. A `needs review` state can only be dismissed by
an explicit human confirmation and is never resent automatically.

Only three agent tools are registered: `team_rooms`, `team_task_send`, and
`team_tasks`. Approval is not exposed as a tool, and remote titles, briefs, and
display names never enter the current Agent context.

A failed `team_task_send` result carries the original `taskId`; retries must reuse
it. An unconfirmed send with identical content is matched against the locally
retained request. The **Sent** view can confirm a pending delivery. Never retry an
unknown result with a new `taskId`.

## Share with teammates

```sh
sh scripts/package-plugin.sh
# produces dist/dsh-baton-0.1.0/ and dist/dsh-baton-0.1.0.tgz
```

The public package contains only runtime code and install instructions. Its
`serverUrl` is empty and it includes no secret, local path, or dev dependency. A
private team build can prefill its endpoint:

```sh
BATON_PACKAGE_SERVER_URL=wss://baton.example.com/ws sh scripts/package-plugin.sh
```

Send the tarball, the service URL, and the team secret over a secure channel, then
follow the bundled `INSTALL.md`:

1. write the secret to `~/.config/baton/secret` (0600);
2. extract and run `plugin_manager install_bundle target=/absolute/path/to/dsh-baton-0.1.0`;
3. edit the package's `cordis.patch.yml` before installing, or add a **complete**
   override row in the profile patch (same id replaces the whole `config`, so keep
   `serverUrl`), then fill in `displayName` and `environments`;
4. restart DSH and refresh the page.

All clients share one server secret; anyone holding it can impersonate a `userId`,
so only share it with trusted people. Publishing to npm would require setting
`private` to `false` and publishing to a reachable registry; a tarball is simpler
for local testing.

## UI preview and plugin tests

```sh
cd dsh-baton
npm ci
npm test
npm run preview
```

Open `http://127.0.0.1:4371`. The preview uses the real `client.js` against
in-memory sample data, so rooms, sending, approval, and light/dark themes can be
exercised without connecting to DSH, reading a secret, or running a model. React,
React DOM, and esbuild are development-only; the installed plugin reuses DSH's
React and needs no build.

Browser regression: start the preview and run `npm run test:client`. It needs
`playwright/test` and Chromium; use `NODE_PATH` for an existing Playwright install
and `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for an existing browser. Five cases cover the
initial preview load and sample navigation, a late workspace service, retrying
after an unavailable service or a failed async navigation, and Escape/Tab order in
the environment menu. The tests use real React and the plugin Client with adapters
for DSH services and navigation; no real model runs.

To check protocol compatibility with a real server, build `baton-server` first,
then run `npm run test:integration` in `dsh-baton`. It starts a temporary server
with a random secret and temporary database, and cleans up without touching a
running service.

The full local flow is `npm run test:flow`. It starts a temporary Rust server and
two real plugin Hosts, covering room create/join, zero execution before accept,
concurrent accept submitting once, two-way decline receipts, offline restart
recovery, and a directory-change block. Only DSH's Session service and the
authenticated route dispatcher use in-memory adapters; loading into real DSH and
model execution still require the manual acceptance above.

A directory plugin in an installed DSH is not guaranteed to hot-reload. After the
preview, reload the local bundle through the current DSH plugin flow and refresh
the Client, then run the real Session acceptance. The M0 probe and older panel
acceptance do not replace the current real-install check.

## Server deployment

The following uses a standalone Linux host, Docker Compose, and Caddy. The domain,
secret, and certificate are configured by the deployer. The author's Tencent
Cloud/Podman-specific records are not published in this repository.

<details>
<summary>Container, Tencent Cloud, and backup/restore details</summary>

1. Create directories and place the secret:

```sh
mkdir -p /opt/baton/{data,backups,secrets}
cp server.env.example /opt/baton/secrets/server.env
chmod 700 /opt/baton/secrets && chmod 600 /opt/baton/secrets/server.env
# edit BATON_SECRET (openssl rand -hex 32) and TRUSTED_PROXY_CIDRS=172.28.0.11/32
```

2. Give the data directory to UID 10001, mode 0700:

```sh
chown -R 10001:10001 /opt/baton/data
chmod 700 /opt/baton/data
```

3. Set the domain and start:

```sh
cd /opt/baton
BATON_DOMAIN=baton.example.com docker compose up -d --build
```

4. Health and logs:

```sh
curl -fsS https://baton.example.com/healthz   # also reachable through Caddy, or inside the container on 127.0.0.1
docker compose logs -f baton-server
```

Caddy terminates TLS and exposes only 80/443; `baton-server`'s 8080 is not
published. `TRUSTED_PROXY_CIDRS` must equal Caddy's fixed internal address,
otherwise every client shares Caddy's IP rate-limit bucket.

Caddy closes existing WebSockets on `caddy reload` (default behavior); the plugin
reconnects with backoff. `stream_timeout` has no default timeout; do not set it
too low.

</details>

## Backup and restore

- Host root cron: `0 3 * * * /opt/baton/scripts/backup.sh`
- Requires host `sqlite3`; `BATON_DB_PATH`, `BATON_BACKUP_DIR`, and
  `BATON_BACKUP_KEEP_DAYS` override the defaults.
- The script writes a temporary snapshot, publishes `baton-YYYYmmdd-HHMMSS.db`
  only after success, and removes only this application's expired files.
- Restore: stop the container, replace `/opt/baton/data/baton.db` with the backup
  (and remove the old `-wal`/`-shm`), then start it again.
- Backups contain task briefs; treat them as sensitive data.

## First-version limits

- Shared-secret identity means anyone holding the secret can impersonate a `userId`.
- Single process, single host; a server failure does not stop an already started
  local Session, but relay pauses.
- No approval while offline; an ambiguous submit result needs manual review.
- No broadcast, chat, file transfer, execution result return, or remote Session
  viewing.
