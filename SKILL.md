---
name: worktree-compose
description: How to run multiple git worktrees in parallel, each with isolated Docker containers and ports, using worktree-compose (`wtc`). Use when working with multi-worktree Docker setups, the `wtc` / `npx wtc` commands, per-worktree port allocation, `.wtcrc.json` config, the wtc MCP server, or promoting changes between worktrees.
---

# Multi-Worktree Docker Compose

Run multiple git worktrees in parallel, each with isolated Docker containers and ports.

Powered by [`worktree-compose`](https://github.com/mostafasudo/worktree-compose#readme) (`wtc`). Install once, globally, with `npm install -g worktree-compose` (it's a cross-project devtool), then drive it with `npx wtc <command>`.

| Command | What it does |
|---------|-------------|
| `npx wtc start` | Sync files, inject ports, build and start containers for all worktrees |
| `npx wtc stop` | Stop containers (`docker compose down`); volumes are preserved |
| `npx wtc restart` | Stop, re-sync files, re-inject env, rebuild, start (after migrations, Dockerfile or config changes) |
| `npx wtc list` (`ls`) | Print branch, status, URL, and ports for every worktree |
| `npx wtc promote <index>` | Copy a worktree's changed files into the current branch as uncommitted changes |
| `npx wtc clean` | Stop containers, remove all worktrees, prune stale Docker resources |

All commands except `promote`/`clean` accept optional indices: `npx wtc start 1`, `npx wtc start 1 2 3`.

Worktrees come first — create one before starting a stack:

```bash
git worktree add ../myapp-feature feature-branch
npx wtc start
```

## Port allocation

`wtc` auto-detects services whose host port uses the `${VAR:-default}` pattern in `docker-compose.yml` (hardcoded ports like `8080:80` can't be isolated — `wtc` warns and suggests the `${VAR:-default}` fix). Formula: `20000 + default_port + (worktree_index × portStride)`, where `portStride` defaults to `1`.

| Service  | Main (default) | Worktree 1 | Worktree 2 |
|----------|---------------|------------|------------|
| Postgres | 5434          | 25435      | 25436      |
| Redis    | 6380          | 26381      | 26382      |
| Backend  | 8000          | 28001      | 28002      |
| Frontend | 5173          | 25174      | 25175      |

The table is illustrative — every value follows the formula. If your project exposes **clustered** default ports (e.g. mocks on `8081`–`8086`) that collide between adjacent worktrees, `wtc` warns and recommends raising `portStride` (e.g. `100`) to give each worktree its own port band.

## Project naming

`COMPOSE_PROJECT_NAME` follows the pattern `{repo}-wt-{index}-{branch}`, lowercased with non-alphanumeric characters replaced by hyphens — so each worktree gets its own containers, networks, and volumes. Nothing is shared.

## Configuration (optional)

`wtc` works zero-config. For project-specific needs, add `.wtcrc.json` to the repo root (or a `"wtc"` key in `package.json`; `.wtcrc.json` wins):

```json
{
  "sync": [".generated/prisma-client", "local-certs/"],
  "envOverrides": {
    "VITE_API_URL": "http://localhost:${BACKEND_PORT}"
  },
  "portStride": 100
}
```

- **sync**: Extra files/dirs copied from main into each worktree on start. Use for gitignored or generated files Docker needs but that aren't committed (generated clients, local certs, build artifacts).
- **envOverrides**: Additional env vars injected into `.env`, with `${VAR}` interpolation against allocated port values. Use when a var depends on an allocated port (e.g. `VITE_API_URL`).
- **portStride**: Port spacing between consecutive worktree indices (default `1`). Raise it when clustered default ports would otherwise collide across worktrees.

## MCP server

Agents can manage their worktree stack via MCP tools (`wtc_start`, `wtc_stop`, `wtc_restart`, `wtc_list`, `wtc_promote`, `wtc_clean`). Register it once (Claude Code `.claude/settings.json`):

```json
{ "mcpServers": { "wtc": { "command": "npx", "args": ["wtc", "mcp"] } } }
```

See the [wtc README](https://github.com/mostafasudo/worktree-compose#mcp-server) for full setup.

## How it works

`docker-compose.yml` uses `${VAR:-default}` syntax for all host ports. On `start`, `wtc` syncs infrastructure files from main (compose file plus any `include:`d files, referenced Dockerfiles, and base `.env`), copies a fresh `.env`, appends allocated port overrides in an idempotent delimited block, and runs `docker compose up -d --build` with an isolated `COMPOSE_PROJECT_NAME`. Re-running `start` strips and rewrites the block, so it never accumulates.
