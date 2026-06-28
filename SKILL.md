---
name: worktree-compose
description: How to run multiple git worktrees in parallel, each with isolated Docker containers and ports, using worktree-compose (`wtc`). Use when working with multi-worktree Docker setups, the `pnpm worktree` / `wtc` commands, per-worktree port allocation, `.wtcrc.json` config, the wtc MCP server, or promoting changes between worktrees.
---

# Multi-Worktree Docker Compose

Run multiple git worktrees in parallel, each with isolated Docker containers and ports.

Powered by [`worktree-compose`](https://github.com/mostafasudo/worktree-compose#readme) (`wtc`).

| Command | What it does |
|---------|-------------|
| `pnpm worktree start` | Build and start containers for all worktrees |
| `pnpm worktree stop` | Stop containers for all worktrees |
| `pnpm worktree restart` | Restart containers (after migrations, config changes) |
| `pnpm worktree list` | Print URLs and ports for every worktree |
| `pnpm worktree promote <index>` | Copy changed files from a worktree into the current branch |
| `pnpm worktree clean` | Stop containers and remove all worktrees |

All commands accept optional indices: `pnpm worktree start 1`, `pnpm worktree start 1 2 3`.

## Port allocation

`wtc` auto-detects services with `${VAR:-default}` port patterns in `docker-compose.yml`. Formula: `20000 + default_port + worktree_index`.

| Service  | Main (default) | Worktree 1 | Worktree 2 |
|----------|---------------|------------|------------|
| Postgres | 5434          | 25435      | 25436      |
| Redis    | 6380          | 26381      | 26382      |
| Backend  | 8000          | 28001      | 28002      |
| Frontend | 5173          | 25174      | 25175      |

## Project naming

`COMPOSE_PROJECT_NAME` follows the pattern `{repo}-wt-{index}-{branch}`, lowercased with non-alphanumeric characters replaced by hyphens.

## Configuration

Warpy-specific config lives in `.wtcrc.json`:

```json
{
  "sync": ["backend/alembic", "backend/alembic.ini"],
  "envOverrides": {
    "VITE_API_URL": "http://localhost:${BACKEND_PORT}"
  }
}
```

- **sync**: Extra files/dirs copied from main into each worktree on start.
- **envOverrides**: Additional env vars injected with `${PORT}` interpolation.

## MCP server

Agents can manage their worktree stack via MCP tools (`wtc_start`, `wtc_stop`, `wtc_restart`, `wtc_list`, `wtc_promote`, `wtc_clean`). See the [wtc README](https://github.com/mostafasudo/worktree-compose#mcp-server) for setup.

## How it works

`docker-compose.yml` uses `${VAR:-default}` syntax for all host ports. `wtc` copies a fresh `.env` from main, appends port overrides in a delimited block, and runs `docker compose up` with an isolated `COMPOSE_PROJECT_NAME`.
