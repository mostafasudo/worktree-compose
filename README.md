<div align="center">

# worktree-compose · `wtc`

### Zero-config Docker Compose isolation for git worktrees

Every worktree gets its own ports, database, cache, and containers — **automatically**.

[![npm version](https://img.shields.io/npm/v/worktree-compose?label=npm&color=cb3837&logo=npm)](https://www.npmjs.com/package/worktree-compose)
[![downloads](https://img.shields.io/npm/dm/worktree-compose?color=cb3837)](https://www.npmjs.com/package/worktree-compose)
[![node](https://img.shields.io/node/v/worktree-compose?color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/worktree-compose?color=blue)](./LICENSE)
[![DevHunt](https://img.shields.io/badge/DevHunt-%231%20Product%20of%20the%20Week-ff6154)](https://devhunt.org/tool/worktree-compose)

<img src="https://raw.githubusercontent.com/mostafasudo/worktree-compose/main/wtc-explainer.gif" alt="worktree-compose demo — isolated Docker stacks per git worktree" width="820" />

<em>The full <code>wtc</code> workflow: an isolated Docker stack per worktree, several AI agents building in parallel, compared live on their own ports — then promote the winner.</em>

</div>

```bash
npm install -D worktree-compose
```

```
npx wtc list

┌───────┬───────────────┬────────┬────────────────────────┬─────────────────────────────────────────────────────────┐
│ Index │ Branch        │ Status │ URL                    │ Ports                                                   │
├───────┼───────────────┼────────┼────────────────────────┼─────────────────────────────────────────────────────────┤
│ -     │ main          │ -      │ -                      │ postgres:5434 redis:6380 backend:8000 frontend:5173     │
├───────┼───────────────┼────────┼────────────────────────┼─────────────────────────────────────────────────────────┤
│ 1     │ feature-auth  │ up     │ http://localhost:25174 │ postgres:25435 redis:26381 backend:28001 frontend:25174 │
├───────┼───────────────┼────────┼────────────────────────┼─────────────────────────────────────────────────────────┤
│ 2     │ fix-billing   │ down   │ http://localhost:25175 │ postgres:25436 redis:26382 backend:28002 frontend:25175 │
└───────┴───────────────┴────────┴────────────────────────┴─────────────────────────────────────────────────────────┘
```

## Contents

- [Why wtc?](#why-wtc)
- [How is this different from `docker compose -p`?](#how-is-this-different-from-docker-compose--p)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Preparing your docker-compose.yml](#preparing-your-docker-composeyml)
- [How It Works](#how-it-works)
- [Commands](#commands)
- [Configuration (Optional)](#configuration-optional)
- [MCP Server](#mcp-server)
- [Full Example](#full-example)
- [Requirements](#requirements)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Why wtc?

Spin up multiple developers or AI agents on the same repo — each in its own [git worktree](https://git-scm.com/docs/git-worktree) — and they immediately fight over a single Docker Compose setup: port conflicts, a shared database, a shared cache, colliding containers. You can't run two stacks side by side.

`wtc` reads your existing `docker-compose.yml` and turns every worktree into a fully isolated, side-by-side environment — unique host ports, separate containers, networks, and volumes — with **zero configuration**.

- ⚡ **Zero config** — reads your existing `docker-compose.yml`, no new files required
- 🔌 **Automatic ports** — unique, collision-free host ports per worktree
- 📦 **Full isolation** — separate containers, networks, and volumes for each stack
- 🧪 **True side-by-side** — run `N` stacks at once and compare them in the browser
- 🔄 **One-command promote** — pull a worktree's changes back into your branch
- 🤖 **Built-in MCP server** — let AI agents start, stop, and manage their own stacks

<table>
<tr><th>Without <code>wtc</code></th><th>With <code>wtc</code></th></tr>
<tr><td>

```bash
git worktree add ../app-feat feat
# hand-pick non-colliding host ports
# edit ../app-feat/.env per service
# copy compose file + Dockerfiles over
docker compose -p app-feat up -d --build
# ...remember to tear it all down later
```

</td><td>

```bash
git worktree add ../app-feat feat
wtc start

# ...and when you're done:
wtc clean
```

</td></tr>
</table>

## How is this different from `docker compose -p`?

`docker compose -p` only namespaces the project. You'd still hand-pick free host ports, hand-edit each worktree's `.env`, copy infra files in, and tear everything down yourself. `wtc` builds on that same project-name isolation and automates the rest: collision-free **port allocation**, per-worktree **`.env` injection**, infra-file **sync**, one-command **`promote`**, and a built-in **MCP server** so AI agents can drive it all themselves.

## Quick Start

```bash
# 1. Install
npm install -D worktree-compose

# 2. Create a worktree for some parallel work
git worktree add ../myapp-feature feature-branch

# 3. Boot an isolated stack for it
npx wtc start

# 4. See everything that's running
npx wtc list
```

## Usage

```bash
# Start isolated stacks for all worktrees
npx wtc start

# Start specific worktrees
npx wtc start 1
npx wtc start 1 2 3

# See what's running
npx wtc list

# Stop worktrees
npx wtc stop
npx wtc stop 1

# Restart (re-sync files, rebuild containers)
npx wtc restart 1

# Pull a worktree's changes into your current branch
npx wtc promote 1

# Tear down everything (containers, worktrees, volumes)
npx wtc clean
```

## Preparing your docker-compose.yml

For `wtc` to isolate a service's port, the host port must use the `${VAR:-default}` pattern:

```yaml
# wtc CAN isolate this
ports:
  - "${BACKEND_PORT:-8000}:8000"

# wtc CANNOT isolate this (hardcoded)
ports:
  - "8080:8080"
```

If `wtc` finds hardcoded ports, it warns you and suggests the fix:

```
⚠ Service "nginx" uses a raw port mapping (8080:80).
  To enable port isolation, change it to: "${NGINX_PORT:-8080}:80"
```

### Supported port formats

```yaml
# Standard
- "${BACKEND_PORT:-8000}:8000"

# Same var for host and container
- "${FRONTEND_PORT:-5173}:${FRONTEND_PORT:-5173}"

# IP-bound
- "127.0.0.1:${API_PORT:-3000}:3000"

# With protocol
- "${BACKEND_PORT:-8000}:8000/tcp"

# Multiple ports per service
- "${BACKEND_PORT:-8000}:8000"
- "${DEBUG_PORT:-9229}:9229"

# Long-form syntax
- target: 8000
  published: "${BACKEND_PORT:-8000}"
  protocol: tcp
```

### Included compose files

If your compose file pulls in others via the top-level [`include:`](https://docs.docker.com/reference/compose-file/include/) directive, `wtc` follows them recursively — services defined in included files get the same port isolation as top-level ones, and the included files are copied into each worktree alongside the main one.

```yaml
include:
  - ./db/compose.yml
  - path: ./services/api/compose.yml
```

Build contexts in an included file resolve relative to that file's own directory, just as Docker Compose does. (Included files that live outside the repo still have their ports isolated, but aren't copied into the worktree.)

## How It Works

### Port Allocation

Each worktree N gets unique ports: `20000 + default_port + (worktree_index × portStride)`

`portStride` defaults to `1`, so by default the table below holds:

| Service  | Main (default) | Worktree 1 | Worktree 2 | Worktree 3 |
|----------|---------------|------------|------------|------------|
| postgres | 5434          | 25435      | 25436      | 25437      |
| redis    | 6380          | 26381      | 26382      | 26383      |
| backend  | 8000          | 28001      | 28002      | 28003      |
| frontend | 5173          | 25174      | 25175      | 25176      |

The table is illustrative — every value follows the formula above. (If an allocation would exceed `65535`, `wtc` falls back to `default_port + 100 × index`.)

#### Clustered default ports and `portStride`

With the default stride of `1`, two worktrees collide on a port whenever a pair of services has default host ports whose difference equals the worktrees' index difference. Projects with **clustered** default ports (e.g. mocks on `8081`–`8086`) therefore collide even between adjacent worktrees, and the second `docker compose up` fails to bind.

When `wtc` detects such a collision across your current worktrees it prints a warning naming the colliding ports and the recommended stride. Set `portStride` in your config (`.wtcrc.json` or `package.json#wtc`) to spread each worktree's ports far enough apart:

```json
{ "portStride": 100 }
```

A stride of `100` gives every worktree a 100-port band, which is collision-free unless some pair of default ports differs by an exact multiple of the stride. The recommended value in the warning is the smallest stride that is collision-free over a generous worktree horizon. The canonical `docker compose up` (no `wtc` env) is unaffected — only each worktree's `.env` override block changes.

### Container Isolation

Each worktree gets its own `COMPOSE_PROJECT_NAME` — `{repo}-wt-{index}-{branch}`, lowercased and sanitized to a Docker-safe name. That means separate containers, networks, and volumes. Nothing is shared.

### File Sync

Before starting, `wtc` copies infrastructure files from main into each worktree: the compose file (plus any files it pulls in via `include:`), every Dockerfile referenced by a service's `build`, and your base `.env` (falling back to `.env.example`, or an empty file if neither exists). This keeps every worktree on the latest Docker setup.

### Env Injection

After copying `.env`, `wtc` appends an idempotent block with allocated port overrides:

```bash
# existing .env content stays untouched...

# --- wtc port overrides ---
POSTGRES_PORT=25435
REDIS_PORT=26381
BACKEND_PORT=28001
FRONTEND_PORT=25174
# --- end wtc ---
```

Re-running `wtc start` strips and rewrites this block, so it never accumulates.

## Commands

### `wtc start [indices...]`

Start Docker Compose stacks. Syncs files, injects ports, runs `docker compose up -d --build`.

```bash
npx wtc start         # all worktrees
npx wtc start 1       # worktree 1 only
npx wtc start 1 2 3   # worktrees 1, 2, and 3
```

### `wtc stop [indices...]`

Stop stacks. Runs `docker compose down`. Volumes are preserved.

```bash
npx wtc stop          # all
npx wtc stop 1        # worktree 1 only
```

### `wtc restart [indices...]`

Full restart: stop, re-sync files, re-inject env, rebuild, start. Use after migrations, Dockerfile changes, or config updates.

```bash
npx wtc restart 1
```

### `wtc list` / `wtc ls`

Show all worktrees with branch, status, URL, and ports.

```bash
npx wtc list
```

### `wtc promote <index>`

Copy a worktree's changed files — added, modified, and deleted — into your current branch as uncommitted changes. Skips `.env` and compose files, and aborts if any file it would touch has uncommitted local changes.

```bash
npx wtc promote 1
```

### `wtc clean`

Stop all containers, remove all worktrees, prune stale Docker resources.

```bash
npx wtc clean
```

## Configuration (Optional)

`wtc` works zero-config. For project-specific needs, create `.wtcrc.json` in your repo root:

```json
{
  "sync": [".generated/prisma-client", "local-certs/"],
  "envOverrides": {
    "VITE_API_URL": "http://localhost:${BACKEND_PORT}"
  },
  "portStride": 100
}
```

Or use a `"wtc"` key in `package.json`. (`.wtcrc.json` takes precedence.)

### `sync`

Extra files/directories to copy from main into each worktree on start. Use for gitignored or generated files that Docker needs but aren't committed — like generated clients, local certificates, or build artifacts.

### `envOverrides`

Additional env vars injected into `.env`. Supports `${VAR}` interpolation with allocated port values. Use when env vars depend on allocated ports (e.g. `VITE_API_URL`).

### `portStride`

Port spacing between consecutive worktree indices (default `1`). Allocated port = `20000 + default_port + worktree_index × portStride`. Raise it (e.g. `100`) when your project exposes clustered default ports that would otherwise collide across worktrees — see [Port Allocation](#port-allocation). `wtc` warns and recommends a value when it detects a collision.

## MCP Server

Built-in [MCP](https://modelcontextprotocol.io/) server so AI agents can manage their stack programmatically.

### Setup

**Claude Code** (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "wtc": {
      "command": "npx",
      "args": ["wtc", "mcp"]
    }
  }
}
```

**Codex:**

```json
{
  "servers": {
    "wtc": {
      "command": "npx",
      "args": ["wtc", "mcp"]
    }
  }
}
```

### Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `wtc_start` | `indices?: number[]` | Start worktree stacks |
| `wtc_stop` | `indices?: number[]` | Stop worktree stacks |
| `wtc_restart` | `indices?: number[]` | Restart after migrations/config changes |
| `wtc_list` | none | List worktrees (returns JSON) |
| `wtc_promote` | `index: number` | Pull worktree changes into current branch |
| `wtc_clean` | none | Tear down everything |

## Full Example

```bash
cd myapp
pnpm add -D worktree-compose

git branch agent-1-auth
git branch agent-2-auth
git worktree add ../myapp-agent-1 agent-1-auth
git worktree add ../myapp-agent-2 agent-2-auth

npx wtc start
# Worktree 1: backend:28001 frontend:25174
# Worktree 2: backend:28002 frontend:25175

# Compare side by side
# http://localhost:25174  (agent 1)
# http://localhost:25175  (agent 2)

npx wtc promote 1
git add -A && git commit -m "feat: auth from agent 1"
npx wtc clean
```

## Requirements

- **Node.js** >= 18
- **Git** with worktree support
- **Docker** with Compose v2 (`docker compose`)
- `docker-compose.yml` with `${VAR:-default}` port patterns

## Troubleshooting

**"No compose file found"** — `wtc` looks in the git repo root, not the current directory.

**"No extra worktrees found"** — Create worktrees first: `git worktree add ../my-feature my-branch`

**Ports not changing** — Use `${VAR:-default}` for host ports, not hardcoded numbers.

**Stale containers** — Run `wtc clean`, or manually: `docker ps -a --filter "name=-wt-" -q | xargs docker rm -f`

## Contributing

Issues and pull requests are welcome. Found a bug or have an idea? [Open an issue](https://github.com/mostafasudo/worktree-compose/issues) — and if `wtc` saves you time, a ⭐ on the [repo](https://github.com/mostafasudo/worktree-compose) helps others find it.

## License

[MIT](./LICENSE)
</content>
</invoke>
