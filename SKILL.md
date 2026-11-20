---
name: worktree-compose
description: Run several git worktrees in parallel, each with its own isolated Docker Compose stack (ports, containers, networks, volumes), using worktree-compose (`wtc`). Use when starting, stopping, inspecting, or cleaning up per-worktree Docker stacks, finding a worktree's ports or URL, promoting a worktree's changes, configuring `.wtcrc.json`, or calling the wtc MCP tools (`wtc_start`, `wtc_list`, …).
---

# worktree-compose (`wtc`)

`wtc` gives every git worktree its own Docker Compose stack: its own host ports, containers, networks, and volumes, from the repo's existing compose file. Docs: https://www.worktree-compose.com

## Invoke it as `wtc`

- Installed globally: `npm install -g worktree-compose`, then run `wtc <command>`.
- Never run `npx wtc`: an unrelated npm package is named `wtc`. Without a global install, use `npx worktree-compose <command>`.
- Run from the main checkout or any worktree. Compose file, config, and env files always come from the main checkout.

## Everyday loop

```bash
git worktree add -b my-feature ../myapp-my-feature   # 1. create the worktree
cd ../myapp-my-feature
wtc start .            # 2. sync infra files, inject ports, compose up -d --build
wtc list               # 3. status, URL and ports (wtc list --json for parsing)
wtc restart .          # after Dockerfile, compose, env or migration changes
wtc stop .             # pause; containers and data are kept, start resumes them
```

Prefer `.` (the worktree containing the current directory) when working inside a worktree. Other selectors: the stable **index** (`2`), the **branch** (`my-feature`), the **directory name** (`myapp-my-feature`), or a **path**. No selector = all worktrees. A number that is both an index and another worktree's branch/directory name is rejected as ambiguous; pass the branch, directory name, or the path the error suggests (e.g. `../2`).

## Commands

| Command | Effect |
|---------|--------|
| `wtc start [wt...] [--env <file>] [--workspace <ws>]... [--no-build]` | Sync compose/Dockerfiles/`sync` paths from main, copy env files fresh from main, inject ports + `COMPOSE_PROJECT_NAME`, remap hardcoded host ports and `container_name` at runtime, `compose up -d --build`. Stops at the first failure. |
| `wtc stop [wt...]` | `compose stop`. Containers and **all volumes are kept**. |
| `wtc restart [wt...] [same flags]` | `compose stop`, then start with `--remove-orphans`; changed services are recreated, volumes kept. |
| `wtc list` / `wtc ls` `[--json]` | Read-only. Rows: `index, branch, path, project, status, running, total, url, ports, orphan, unavailable`. Status: `up`, `partial`, `exited` (stopped), `down` (no containers), `?` (engine unreachable). `unavailable`: `"missing"` (locked, directory missing — e.g. unmounted drive), `"main"` (became the main checkout), or `null`. |
| `wtc promote <wt> [--force]` | Copy the worktree's changes (committed since it branched, staged, unstaged, untracked; deletions too) into the checkout you run it from, uncommitted. Skips compose files and local env files. |
| `wtc prune [--dry-run]` | Tear down (`down -v`, **deletes volumes**) and forget stacks of worktrees that were already deleted. |
| `wtc clean [--dry-run] [--force] [--keep-worktrees] [--sweep]` | `down -v` on **every** stack (**deletes all their volumes**), remove worktrees that hold no work, sweep leftovers this checkout owns. |
| `wtc doctor [--json]` | Diagnose git, compose file, config, engine + daemon, port isolation (and what is remapped at runtime, or why not), `container_name` / shared volumes, collisions, orphans, busy ports. Exit 1 on any ✖. |
| `wtc skill [--install] [--dir <path>]` | Print this skill, or install it to `~/.claude/skills/worktree-compose/SKILL.md` (or `<path>/worktree-compose/`). |
| `wtc mcp` | MCP server on stdio. |

## Data safety: stop vs. clean

- To pause or free CPU/RAM, use `wtc stop`. Data survives; `wtc start` resumes.
- `wtc clean` and `wtc prune` delete volumes (databases, caches). `clean` deletes them for **every** stack, including worktrees it keeps and with `--keep-worktrees`. Get the user's go-ahead before running them, preview with `--dry-run`, and never add `--force` on your own.
- `clean` never removes the main checkout or the worktree it runs from. Without `--force` it also keeps worktrees with uncommitted changes (other than files wtc wrote), commits on a detached HEAD that no branch/tag/remote has, unpushed submodule commits, or a lock, and prints why.
- `clean` only removes Docker resources of stacks this checkout owns. `--sweep` also removes `<repo>-wt-<n>-…` stacks whose worktree directory no longer exists (e.g. left by wtc 0.2), as long as they still have a container; volumes or networks with no container left are listed for the user to remove, never removed.

## Identity, ports, project names

- A worktree's index and compose project are recorded in `.git/wtc/state.json` the first time wtc acts on it (`list`, `doctor` and dry runs only read) and never change: removing a worktree never renumbers the others, renaming its branch keeps the project, `git worktree move` keeps everything. A new worktree gets the lowest free index.
- A deleted worktree becomes an orphan: `wtc list` shows `(removed)` and its index stays reserved until `wtc prune` or `wtc clean`. A worktree git still lists is never an orphan: a locked one whose directory is missing shows `(locked, missing on disk)` and `prune`/`clean` leave its stack alone.
- If wtc cannot tell which checkout is the main one (bare repo whose default-branch worktree is mid-rebase/on another branch, or a `--separate-git-dir` repo seen from a linked worktree before wtc ran in the main checkout), `start`, `restart` and `clean` refuse with the fix in the message; tell the user rather than working around it.
- Ports: `20000 + default_port + index × portStride` (`portStride` default `1`). A host port written as `${VAR:-default}` (upper-case `VAR`) gets `VAR` in the worktree's env file. A hardcoded one (`"8080:80"`) and a fixed `container_name` are remapped at runtime by a generated compose override in `.git/wtc/compose/` (needs Docker Compose 2.24.4+; the compose file is never edited; the old container name stays a network alias inside the stack). A remapped port has no variable: `wtc list` shows it as `<service>:<default port>` (`web:8080=28081`). With an engine that can't remap, hardcoded ports and `container_name` are only warned about.
- Project: `{repo}-wt-{index}-{branch}`, sanitized (e.g. `myapp-wt-1-feature-auth`).

## Env files

- Every start/restart copies `<envFile>` (default `.env`, fallback `.env.example`) **fresh from main**, then writes `COMPOSE_PROJECT_NAME` (root only), the allocated `*_PORT` variables, and `envOverrides`. Existing keys are rewritten in place; the rest go in a `# --- wtc port overrides ---` block.
- Edits made only in a worktree's env file are lost on the next start. Put lasting values in main's env file or in `envOverrides` / `workspaceEnvOverrides`.
- Only those keys are written. A value with a port inside (`DATABASE_URL=…:5434/app`) needs an override: `"DATABASE_URL": "postgresql://app:app@localhost:${POSTGRES_PORT}/app"`. `${COMPOSE_PROJECT_NAME}` interpolates too.
- With the default `.env`, a plain `docker compose ps|logs|exec` inside the worktree reaches the worktree's stack. When hardcoded settings are remapped, the root env file also gets `COMPOSE_FILE`, so a plain `docker compose up` from the worktree's root uses the same ports (not from a subdirectory: prefer `wtc restart .`). With a custom `envFile` (e.g. `.env.development`), add `--env-file .env.development` or `-p <project>` (from `wtc list --json`).
- Monorepos: `--env .env.development --workspace server` (repeatable) also copies and injects `apps/server/.env.development`. Use `--env`, never `--env-file` (Node intercepts it).

## Promote rules

`wtc promote <wt>` runs from the checkout that should receive the changes (usually main) and aborts before writing anything when:

- a file it would touch has uncommitted or untracked changes there: commit or stash first;
- a file it would touch was also committed on that branch since the worktree branched: promoting would revert those commits. Merge that branch into the worktree first (the error prints the command); `--force` overwrites anyway;
- a path escapes the repo or goes through a symlinked directory, or the worktree is the current checkout.

## Diagnose

Run `wtc doctor` first when a stack won't start, ports look wrong, or `wtc list` shows `?` or `(removed)` rows. Typical fixes: drop fixed `name:`/`external` on volumes and networks, raise `portStride` on collisions, give a port a `${VAR:-default}` variable when an env value (e.g. `DATABASE_URL` via `envOverrides`) needs it; where runtime remapping is unavailable, remove `container_name` (or use `${COMPOSE_PROJECT_NAME}`) and write host ports as `${VAR:-default}`; `wtc prune` for orphans, start the Docker/Podman daemon or set `WTC_COMPOSE_COMMAND`.

## Config (optional)

`.wtcrc.json` at the main checkout's root (or `"wtc"` in `package.json`):

```json
{
  "$schema": "https://unpkg.com/worktree-compose/wtc.schema.json",
  "sync": [".generated/prisma-client"],
  "envFile": ".env.development",
  "workspaces": ["server"],
  "envOverrides": { "VITE_API_URL": "http://localhost:${BACKEND_PORT}" },
  "workspaceEnvOverrides": { "server": { "DATABASE_URL": "postgresql://app:app@localhost:${POSTGRES_PORT}/app" } },
  "portStride": 100,
  "composeCommand": "podman compose"
}
```

Engines: auto-detects `docker compose` → `podman compose` → `docker-compose` → `podman-compose` (preferring one whose daemon answers). `composeCommand` may only be one of those four; anything custom (e.g. `docker --context colima compose`) goes in the `WTC_COMPOSE_COMMAND` environment variable.

## MCP tools

Register: `claude mcp add --scope user wtc -- wtc mcp` (Claude Code), or `{"command": "wtc", "args": ["mcp"]}` in `.mcp.json` / `.cursor/mcp.json`, or `[mcp_servers.wtc]` with `command = "wtc"`, `args = ["mcp"]` in `~/.codex/config.toml`. The server acts on the repo of the directory it starts in.

| Tool | Parameters | Notes |
|------|-----------|-------|
| `wtc_start` | `indices?`, `envFile?`, `workspaces?`, `build?` (default true) | |
| `wtc_stop` | `indices?` | keeps containers and volumes |
| `wtc_restart` | `indices?`, `envFile?`, `workspaces?`, `build?` | |
| `wtc_list` | — | read-only; `content[0]` is the JSON array, warnings follow |
| `wtc_promote` | `index`, `force?` | destructive: writes into the server's checkout |
| `wtc_clean` | `force?`, `keepWorktrees?`, `dryRun?`, `sweep?` | destructive: deletes volumes, removes worktrees |
| `wtc_prune` | `dryRun?` | destructive: deletes removed worktrees' volumes |
| `wtc_doctor` | — | read-only; returns JSON |

`indices` is an array of numbers (always indices) or strings (index, branch, directory name, path, `.`); omit it for all worktrees. Failures return `isError: true` with the reason. Mutating tools run one at a time; cancelling a request stops its compose command, and a request cancelled while it waits its turn does not run.
