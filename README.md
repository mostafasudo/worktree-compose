<div align="center">

<img src="https://raw.githubusercontent.com/mostafasudo/worktree-compose/main/worktree-compose.jpg" alt="worktree-compose logo" width="140" />

# worktree-compose · `wtc`

### Zero-config Docker Compose isolation for git worktrees

Every worktree gets its own ports, database, cache, and containers — **automatically**.

[![npm version](https://img.shields.io/npm/v/worktree-compose?label=npm&color=cb3837&logo=npm)](https://www.npmjs.com/package/worktree-compose)
[![downloads](https://img.shields.io/npm/dm/worktree-compose?color=cb3837)](https://www.npmjs.com/package/worktree-compose)
[![node](https://img.shields.io/node/v/worktree-compose?color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/worktree-compose?color=blue)](https://github.com/mostafasudo/worktree-compose/blob/main/LICENSE)
[![DevHunt](https://img.shields.io/badge/DevHunt-%231%20Product%20of%20the%20Week-ff6154)](https://devhunt.org/tool/worktree-compose)

**[worktree-compose.com](https://www.worktree-compose.com)** · [Changelog](https://github.com/mostafasudo/worktree-compose/blob/main/CHANGELOG.md) · [Agent skill](https://github.com/mostafasudo/worktree-compose/blob/main/SKILL.md) · [GitHub](https://github.com/mostafasudo/worktree-compose)

<img src="https://raw.githubusercontent.com/mostafasudo/worktree-compose/main/wtc-explainer.gif" alt="worktree-compose demo — isolated Docker stacks per git worktree" width="820" />

<em>The full <code>wtc</code> workflow: an isolated Docker stack per worktree, four AI agents building in parallel, compared live on their own ports — then promote the winner and clean up. <a href="https://www.worktree-compose.com/#demo">Watch the video</a>.</em>

</div>

```bash
npm install -g worktree-compose
```

```
wtc list

┌───────┬──────────────┬────────┬────────────────────────┬────────────────────────────────────────────────────────────┐
│ Index │ Branch       │ Status │ URL                    │ Ports                                                      │
├───────┼──────────────┼────────┼────────────────────────┼────────────────────────────────────────────────────────────┤
│ -     │ main         │ -      │ -                      │ postgres:5434 backend:8000 frontend:5173                   │
├───────┼──────────────┼────────┼────────────────────────┼────────────────────────────────────────────────────────────┤
│ 1     │ feature-auth │ up     │ http://localhost:25174 │ POSTGRES_PORT=25435 BACKEND_PORT=28001 FRONTEND_PORT=25174 │
├───────┼──────────────┼────────┼────────────────────────┼────────────────────────────────────────────────────────────┤
│ 2     │ fix-billing  │ exited │ http://localhost:25175 │ POSTGRES_PORT=25436 BACKEND_PORT=28002 FRONTEND_PORT=25175 │
└───────┴──────────────┴────────┴────────────────────────┴────────────────────────────────────────────────────────────┘
```

> **Type `wtc`, not `npx wtc`.** An unrelated npm package is named `wtc`, so without the global install `npx wtc` downloads and runs that package instead. For a one-off run without installing, use `npx worktree-compose <command>` (for example `npx worktree-compose list`).

## Contents

- [Why wtc?](#why-wtc)
- [How is this different from `docker compose -p`?](#how-is-this-different-from-docker-compose--p)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Selecting worktrees](#selecting-worktrees)
- [Preparing your compose file](#preparing-your-compose-file)
- [Monorepos & custom env files](#monorepos--custom-env-files)
- [How It Works](#how-it-works) — [stable identity](#stable-worktree-identity), [ports](#port-allocation), [project names](#container-isolation-and-compose_project_name), [runtime remapping](#runtime-remapping), [file sync](#file-sync), [env files](#env-files)
- [Commands](#commands) — [what each one does to your data](#what-each-command-does-to-your-data)
- [Configuration (Optional)](#configuration-optional)
- [Docker, Podman, OrbStack, Colima](#docker-podman-orbstack-colima)
- [MCP Server](#mcp-server)
- [Agent Skill](#agent-skill)
- [Full Example](#full-example)
- [Upgrading from 0.2](#upgrading-from-02)
- [Requirements](#requirements)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Why wtc?

Spin up multiple developers or AI agents on the same repo — each in its own [git worktree](https://git-scm.com/docs/git-worktree) — and they immediately fight over a single Docker Compose setup: port conflicts, a shared database, a shared cache, colliding containers. You can't run two stacks side by side.

`wtc` reads your existing compose file and turns every worktree into a fully isolated, side-by-side environment — unique host ports, separate containers, networks, and volumes — with **zero configuration**.

- ⚡ **Zero config** — reads your existing `docker-compose.yml` / `compose.yaml` as it is: hardcoded host ports and `container_name` are remapped at runtime, never edited
- 🔌 **Automatic ports** — unique, collision-free host ports per worktree
- 📦 **Full isolation** — separate containers, networks, and volumes for each stack
- 📌 **Stable identity** — a worktree keeps its index, ports, and project name; removing one never renumbers the others
- 🧪 **True side-by-side** — run `N` stacks at once and compare them in the browser
- 🔄 **One-command promote** — pull a worktree's changes back into your branch
- 🐳 **Docker or Podman** — Docker Compose v2, Podman, OrbStack, Colima
- 🩺 **`wtc doctor`** — finds what would break isolation before it bites
- 🤖 **Built-in MCP server + agent skill** — let AI agents start, stop, and manage their own stacks

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

`docker compose -p` only namespaces the project. You'd still hand-pick free host ports, hand-edit each worktree's `.env`, copy infra files in, remember which project belongs to which worktree, and tear everything down yourself. `wtc` builds on that same project-name isolation and automates the rest: collision-free **port allocation** (hardcoded host ports included), a **stable index and project name** per worktree, per-worktree **env file injection** (including `COMPOSE_PROJECT_NAME`, so plain `docker compose` in the worktree hits the right stack), infra-file **sync**, one-command **`promote`**, safe **cleanup**, and a built-in **MCP server** so AI agents can drive it all themselves.

## Quick Start

```bash
# 1. Install once, globally
npm install -g worktree-compose

# 2. Create a worktree for some parallel work
git worktree add -b feature ../myapp-feature

# 3. Boot an isolated stack for it ("." = the worktree you're in)
cd ../myapp-feature
wtc start .

# 4. See every stack, its status, URL, and ports
wtc list

# 5. Something off? Ask the doctor
wtc doctor
```

`wtc` works from the main checkout or from any worktree: it always reads the compose file, config, and env files from the main checkout.

## Usage

```bash
wtc start                     # start every worktree's stack
wtc start .                   # just the worktree you're in
wtc start 1 fix-billing       # by index, branch, directory name, or path
wtc start --no-build          # skip the image rebuild
wtc start --env .env.development --workspace server   # monorepo env files

wtc list                      # status, URL, and ports (alias: wtc ls; --json for scripts)
wtc stop 1                    # stop the containers; data is kept and start resumes them
wtc restart .                 # re-sync files and env, recreate what changed

wtc promote fix-billing       # copy a worktree's changes into the current checkout

wtc prune                     # tear down stacks of worktrees you already deleted
wtc clean --dry-run           # preview the full cleanup
wtc clean                     # tear down every stack (deletes volumes), remove worktrees that hold no work

wtc doctor                    # check git, engine, ports, isolation, orphans
wtc skill --install           # install the agent skill
wtc mcp                       # MCP server for AI agents (stdio)
```

## Selecting worktrees

`start`, `stop`, and `restart` take any number of worktrees (none means all); `promote` takes exactly one. Each one can be given as:

| Selector | Example | Matches |
|----------|---------|---------|
| index | `2` | the worktree's stable index (the `Index` column of `wtc list`) |
| branch | `fix-billing` | the branch checked out in the worktree |
| directory name | `myapp-fix-billing` | the basename of the worktree's directory |
| path | `../myapp-fix-billing` | a path, resolved against the current directory (symlinks such as macOS `/tmp` are followed) |
| `.` | `.` | the worktree that contains the current directory |

- A name that matches several worktrees (say, two directories with the same basename in different places) is an error listing them; use the index instead.
- A number is an index, unless it also names a *different* worktree (a branch or directory called `2`). Then `wtc` refuses and asks for the branch, the directory name, or a path — the message suggests one that works from where you are (e.g. `../2`).
- Through MCP, a JSON number is always an index; a string follows the rules above.

## Preparing your compose file

`wtc` looks for `compose.yaml`, `compose.yml`, `docker-compose.yaml`, or `docker-compose.yml` (in that order) at the root of the main checkout.

You don't have to change it. Each worktree gets its own host ports either way:

```yaml
# A variable (upper-case name): wtc sets it per worktree and writes it to the worktree's env file
ports:
  - "${BACKEND_PORT:-8000}:8000"

# Hardcoded: wtc remaps it per worktree at runtime; the file stays as it is
ports:
  - "8080:8080"
```

Hardcoded host ports (and a fixed `container_name`) are [remapped at runtime](#runtime-remapping) through a compose override `wtc` generates, which needs Docker Compose 2.24.4 or newer. `wtc start` says what it remapped:

```
ℹ Remapping hardcoded host ports per worktree at runtime (your compose file is unchanged): nginx 8080:80. To use one in env values, give it a variable, e.g. "${NGINX_PORT:-8080}:80".
```

Use a variable when something else needs the port's per-worktree value: the variable is written to the worktree's env file and can be used in [`envOverrides`](#envoverrides) (a `DATABASE_URL`, an API URL), while a remapped port is only published. With an engine that can't remap, `wtc` warns about hardcoded ports instead, and they stay the same in every worktree:

```
⚠ Service "nginx" uses a raw port mapping (8080:80). To enable port isolation, change it to: "${NGINX_PORT:-8080}:80"
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

### Settings that break isolation

`wtc start` and `wtc doctor` warn about compose settings that make worktree stacks collide or share data (`wtc list` only prints how many there are):

- **Hardcoded host ports and `container_name: db`** — every stack would publish the same ports and use the same container name, so the second one fails to start. `wtc` [remaps both at runtime](#runtime-remapping) and only warns when it can't; then write the port as `"${DB_PORT:-5432}:5432"`, and remove `container_name` or make it per-stack: `container_name: ${COMPOSE_PROJECT_NAME:-myapp}-db`.
- **Host port ranges** (`"8000-8010:8000-8010"`) — not remapped: every stack binds the same ports.
- **Top-level volumes or networks with a fixed `name:` or `external: true`** — every stack shares them. A `name:` that contains `${COMPOSE_PROJECT_NAME}` is per-stack and fine.
- **Cross-worktree port collisions** — see [`portStride`](#clustered-default-ports-and-portstride).

### Included compose files

If your compose file pulls in others via the top-level [`include:`](https://docs.docker.com/reference/compose-file/include/) directive, `wtc` follows them recursively — services defined in included files get the same port isolation as top-level ones, and the included files are copied into each worktree alongside the main one.

```yaml
include:
  - ./db/compose.yml
  - path: ./services/api/compose.yml
```

Build contexts in an included file resolve relative to that file's own directory, just as Docker Compose does. (Included files that live outside the repo still have their ports isolated, but aren't copied into the worktree.)

## Monorepos & custom env files

In a monorepo, local env files usually live next to each app (`apps/server/.env.development`) instead of at the repo root, and the filename isn't always `.env`. Use `envFile` plus workspace selectors to keep every worktree's env files consistent:

```bash
# Copy + inject apps/server/.env.development and apps/homepage/.env.development
# into the worktree, in addition to the root env file
wtc start --env .env.development --workspace server --workspace homepage
```

Or make it the project default in `.wtcrc.json`:

```json
{
  "$schema": "https://unpkg.com/worktree-compose/wtc.schema.json",
  "envFile": ".env.development",
  "workspaces": ["server", "homepage"],
  "workspaceEnvOverrides": {
    "server": {
      "DATABASE_URL": "postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/postgres"
    }
  }
}
```

How workspace selection works:

- Workspaces come from `package.json#workspaces` (npm/bun/yarn) or `pnpm-workspace.yaml#packages`. Only directories with a `package.json` count. In a repo that declares no workspaces, `--workspace server` looks for a `package.json` in `server`, `apps/server`, `packages/server`, or `libs/server`.
- `--workspace` matches by package **name**, directory name, or repo-relative path, and may be repeated. On the command line it replaces the configured `workspaces` for that run; `--env` likewise replaces `envFile`.
- The **repo root is always processed** — docker compose interpolates `${POSTGRES_PORT:-5434}` from the root env file, so skipping it would break port isolation. Only the root env file gets `COMPOSE_PROJECT_NAME`.
- Every target gets the allocated port variables. A selected workspace with no env file (and no `.env.example`) is skipped with a warning.
- `workspaceEnvOverrides` keys match a workspace by package name, then by directory name (only when no other workspace shares it), then by repo-relative path.
- `restart` checks `--env` and `--workspace` before stopping anything, so a typo never leaves stacks stopped.

> **Why `--env`, not `--env-file`?** Node.js intercepts `--env-file` in its own argv parsing — even after the script path — so the flag never reaches `wtc`. `--env` is the safe spelling; the config key stays `envFile`. It must be a bare filename such as `.env.development`.

## How It Works

### Stable worktree identity

The first time `wtc` acts on a worktree (`start`, `stop`, …), it records the worktree's **index** (which decides its ports) and its **compose project name** in `.git/wtc/state.json`: inside the git directory every worktree shares, never committed. From then on they don't change. `wtc list`, `wtc doctor`, and dry runs only read: they show the identity a new worktree will get without recording it.

- **Removing a worktree never renumbers the others.** (0.2 derived the index from the position in `git worktree list`, so removing worktree 1 silently moved worktree 2 onto new ports and a new project, orphaning its running stack — [#9](https://github.com/mostafasudo/worktree-compose/issues/9).)
- **A new worktree gets the lowest index no record holds.**
- **Renaming the branch keeps the project name**, and **`git worktree move` keeps the index, ports, and project**: `wtc` keeps an id in the worktree's git admin directory (`.git/worktrees/<name>/wtc-id`), which a move keeps and `git worktree remove` deletes. Restart a moved worktree so bind mounts follow the new path.
- **A worktree you delete becomes an orphan.** After `git worktree remove` or `rm -rf`, `wtc list` shows it as `(removed)`. Its index stays reserved, because its stack may still be running on those ports, until `wtc prune` (or `wtc clean`) tears the stack down and forgets it.
- **A worktree git still lists is never an orphan**, even when `wtc` can't start it: a [locked](https://git-scm.com/docs/git-worktree#_commands) worktree whose directory is missing (an unmounted drive) shows as `(locked, missing on disk)` and keeps its index, record, and stack until it is back; `prune` and `clean` leave it alone.

```
git worktree remove ../myapp-spike-cache
git worktree add -b docs ../myapp-docs
wtc list

┌───────┬───────────────────────┬────────┬────────────────────────┬────────────────────────────────────────────────────────────┐
│ Index │ Branch                │ Status │ URL                    │ Ports                                                      │
├───────┼───────────────────────┼────────┼────────────────────────┼────────────────────────────────────────────────────────────┤
│ -     │ main                  │ -      │ -                      │ postgres:5434 backend:8000 frontend:5173                   │
├───────┼───────────────────────┼────────┼────────────────────────┼────────────────────────────────────────────────────────────┤
│ 1     │ feature-auth          │ up     │ http://localhost:25174 │ POSTGRES_PORT=25435 BACKEND_PORT=28001 FRONTEND_PORT=25174 │
├───────┼───────────────────────┼────────┼────────────────────────┼────────────────────────────────────────────────────────────┤
│ 2     │ fix-billing           │ exited │ http://localhost:25175 │ POSTGRES_PORT=25436 BACKEND_PORT=28002 FRONTEND_PORT=25175 │
├───────┼───────────────────────┼────────┼────────────────────────┼────────────────────────────────────────────────────────────┤
│ 3     │ spike-cache (removed) │ up     │ -                      │ POSTGRES_PORT=25437 BACKEND_PORT=28003 FRONTEND_PORT=25176 │
├───────┼───────────────────────┼────────┼────────────────────────┼────────────────────────────────────────────────────────────┤
│ 4     │ docs                  │ down   │ http://localhost:25177 │ POSTGRES_PORT=25438 BACKEND_PORT=28004 FRONTEND_PORT=25177 │
└───────┴───────────────────────┴────────┴────────────────────────┴────────────────────────────────────────────────────────────┘
(removed) = the worktree is gone but its stack/record remains. Run 'wtc prune' to tear it down.
```

**Coming from 0.2?** On the first run, `wtc` gives existing worktrees the same positional indices 0.2 used, and a worktree whose 0.2 stack is still running adopts that stack's index and project (matched by the directory compose ran in). Running stacks are picked up, not duplicated. If `state.json` is ever lost or unreadable, it is rebuilt the same way (an unreadable file is first moved aside as `state.json.bak-<time>`).

### Port Allocation

Each worktree gets unique ports from its index: `20000 + default_port + (worktree_index × portStride)`

`portStride` defaults to `1`, so by default the table below holds:

| Service  | Main (default) | Worktree 1 | Worktree 2 | Worktree 3 |
|----------|---------------|------------|------------|------------|
| postgres | 5434          | 25435      | 25436      | 25437      |
| backend  | 8000          | 28001      | 28002      | 28003      |
| frontend | 5173          | 25174      | 25175      | 25176      |

The table is illustrative — every value follows the formula above. (If an allocation would exceed `65535`, `wtc` falls back to `default_port + 100 × index`.)

#### Clustered default ports and `portStride`

With the default stride of `1`, two worktrees collide on a port whenever a pair of services has default host ports whose difference equals the worktrees' index difference. Projects with **clustered** default ports (e.g. mocks on `8081`–`8086`) therefore collide even between adjacent worktrees, and the second `docker compose up` fails to bind.

When `wtc` detects such a collision across the indices in use (live worktrees and orphans) it warns, naming the colliding ports and the recommended stride. Set `portStride` in your config (`.wtcrc.json` or `package.json#wtc`) to spread each worktree's ports far enough apart:

```json
{ "portStride": 100 }
```

A stride of `100` gives every worktree a 100-port band, which is collision-free unless some pair of default ports differs by an exact multiple of the stride. The recommended value in the warning is the smallest stride that is collision-free over a generous worktree horizon. The canonical `docker compose up` in the main checkout is unaffected — only the worktrees' ports change.

### Container isolation and `COMPOSE_PROJECT_NAME`

Each worktree's stack runs as the compose project `{repo}-wt-{index}-{branch}`, lowercased with anything other than `a-z`, `0-9`, and `-` turned into `-` — for example `myapp-wt-1-feature-auth`. Compose names containers, networks, and volumes after the project, so nothing is shared. `{repo}` is the main checkout's directory name (for a bare repository, the repository's own name), so it is the same from every worktree.

`wtc` passes `-p <project>` on every compose call, exports `COMPOSE_PROJECT_NAME` and the allocated ports into compose's environment, and writes `COMPOSE_PROJECT_NAME=<project>` into the worktree's root env file (plus `COMPOSE_FILE` when it [remaps hardcoded settings](#runtime-remapping)). With the default `.env`, a plain `docker compose ps` / `logs` / `exec` (or a Makefile) run inside the worktree therefore reaches the same stack on the same ports.

Compose only reads a file named `.env` on its own. With a custom `envFile` such as `.env.development`, pass it explicitly (`docker compose --env-file .env.development ps`) or pass `-p <project>` (the `project` field of `wtc list --json`).

`${COMPOSE_PROJECT_NAME}` is also available in `envOverrides` and `workspaceEnvOverrides` values, e.g. `"QUEUE_PREFIX": "${COMPOSE_PROJECT_NAME}-jobs"`.

### Runtime remapping

A hardcoded host port (`"8080:80"`) or a fixed `container_name` would make every worktree stack collide. Instead of asking you to edit the compose file, `wtc` writes a compose override for each worktree stack:

```yaml
# .git/wtc/compose/myapp-wt-1-feature-auth.yaml (generated, rewritten on every start)
services:
  web:
    ports: !override
      - "28081:80"
    container_name: !reset null
    networks:
      default:
        aliases:
          - "web"
```

- `ports: !override` replaces the service's port list: every entry as written, with only the hardcoded host ports swapped for the worktree's (same IP, protocol, and long-form fields). A plain override can't do this, because compose merges port lists and would still publish `8080`.
- `container_name: !reset null` drops the fixed name, so compose names the containers after the project (`myapp-wt-1-feature-auth-web-1`). The old name stays a network alias on the stack's own networks, so containers that reach the service by it (`DB_HOST=mydb`) still do, and reach this stack's copy. Not on a network every stack shares (fixed `name:` or `external`), where the alias would answer for all of them, nor with `network_mode`.
- Every compose call on the stack (`start`, `stop`, teardown) runs with `COMPOSE_FILE` listing the compose file, the worktree's own `compose.override.yaml` if it has one, and this file. `wtc` also writes that `COMPOSE_FILE` into the worktree's root env file, so a plain `docker compose up` run from the worktree's root uses the same ports. (From a subdirectory, compose finds the compose file itself and ignores `COMPOSE_FILE` in `.env`.)
- The file lives in `.git/wtc/compose/`, never in your working tree. `start` rewrites it after syncing the compose file; `stop` and teardown use it as the stack was started. It is deleted when `wtc prune` or `wtc clean` forgets the worktree; a worktree that `clean` keeps also keeps its override, since its env file still lists it.
- `wtc list` shows a remapped port as `<service>:<default port>`, e.g. `web:8080=28081`. It has no variable, so nothing is written to env files for it and `envOverrides` can't refer to it; give it a variable in the compose file when an env value needs it.

`!override` and `!reset` need Docker Compose 2.24.4 or newer. `wtc` checks once per run that the engine applies them (`compose config` on a throwaway file; no containers, no daemon) and otherwise remaps nothing and warns as before. It also leaves alone:

- what the worktree's own `compose.override.yaml` (or `docker-compose.override.yml`, …) sets for a service: its `ports` (or `extends`) or `container_name` would be discarded;
- the ports of a service that uses `extends`, which may inherit ports `wtc` can't see;
- the ports of a service from an `include:`d file whose ports use variables: compose fills those in from that file's own `.env`, while an override is filled in from the main project's;
- host port ranges, and a hardcoded port too high to move (it stays as it is, with a warning);
- everything, when you set `COMPOSE_FILE` yourself: in your environment, the root env file, the main checkout's `.env`, `envOverrides`, or a worktree's own `.env`. A `COMPOSE_FILE` that names `wtc`'s own override (a worktree's `.env` exported by direnv, say) doesn't count.

`wtc doctor` lists what is remapped, or why it can't be.

### File Sync

Before every start, `wtc` copies infrastructure files from the main checkout into the worktree, so every worktree runs the latest Docker setup:

- the compose file, plus every file it pulls in via `include:` (inside the repo);
- every Dockerfile a service's `build` points to (remote build contexts and `dockerfile_inline` have none);
- the extra paths listed in [`sync`](#sync). Entries must stay inside the repository; absolute or `../` entries are skipped with a warning.

Sync copies over what is at those paths and removes nothing else: files that only the worktree has stay. Symlinks are recreated as symlinks, never followed. `wtc` never writes through a symlink it finds at a destination (it replaces the link) and skips any destination whose directory resolves outside the worktree. Where main has a symlink but the worktree has a real directory, the directory is left alone with a warning.

### Env Files

On every `start` and `restart`, for the root and each selected workspace:

1. **Copy fresh from main:** `<envFile>` (default `.env`), falling back to `.env.example`. The root gets an empty file if neither exists; a workspace with neither is skipped.
2. **Inject:** `COMPOSE_PROJECT_NAME` (root only; with [runtime remapping](#runtime-remapping) also `COMPOSE_FILE`), every allocated port variable, then `envOverrides` (root) or `workspaceEnvOverrides` (that workspace). **A key that already exists is rewritten in place** — comments, ordering, and all other lines are preserved. Keys that don't exist are appended in a marked block, which is replaced on every run and never accumulates.

With `"envOverrides": { "DATABASE_URL": "postgresql://app:app@localhost:${POSTGRES_PORT}/app" }` and a main `.env` of

```bash
POSTGRES_PORT=5434
DATABASE_URL=postgresql://app:app@localhost:5434/app
```

worktree 1 gets:

```bash
POSTGRES_PORT=25435
DATABASE_URL=postgresql://app:app@localhost:25435/app

# --- wtc port overrides ---
COMPOSE_PROJECT_NAME=myapp-wt-1-feature-auth
BACKEND_PORT=28001
FRONTEND_PORT=25174
# --- end wtc ---
```

Two consequences of copying fresh every time:

- **Edits made only in a worktree's env file are lost on the next start.** Put lasting values in main's env file, or in `envOverrides` / `workspaceEnvOverrides`.
- **Only the keys above are written.** A value with a port inside it, like `DATABASE_URL` above, keeps main's port unless you add an override for it.

If a worktree's env file is a symlink (for example to main's `.env`), `wtc` replaces the link with a regular copy and never writes through it.

The allocated ports are also exported into the environment of the compose process `wtc` launches. Compose resolves `${VAR:-default}` from the process environment, `--env-file`, and the project `.env` — never from a service's `env_file:`, and never from a custom filename like `.env.development`. Exporting the ports keeps published host ports correct when the project uses a custom `envFile`.

### Repository layouts

Besides a plain clone, `wtc` handles bare repositories with worktrees (the worktree on the repository's default branch acts as the main checkout and is never started, synced into, or removed), submodules, and `--separate-git-dir` checkouts. Locked worktrees work normally; a locked worktree whose directory is missing (an unmounted drive) is skipped with a warning, and its stack and index are kept.

Two layouts don't tell from every worktree which checkout is the main one: a bare repository whose default-branch worktree is mid-rebase, mid-bisect, or on another branch for now, and a `--separate-git-dir` repository seen from a linked worktree. `wtc` remembers the main checkout (in `.git/wtc/state.json`) once it has run there or found it, and uses that. When it can't tell at all, it warns, uses the current checkout's compose and config files for `list`, `doctor`, `stop`, `promote`, and `prune`, records nothing, and refuses `start`, `restart`, and `clean` — they would sync files into, start, or remove checkouts based on the wrong one. The error says how to fix it: check the default branch out in your main worktree, or run `wtc start` from the main checkout.

## Commands

### `wtc start`

```
wtc start [worktrees...] [--env <name>] [--workspace <name>]... [--no-build]
```

For each selected worktree (all when none are given): sync infrastructure files, copy and inject env files, then run `compose -p <project> up -d --build`. Stops at the first failure; on success it prints `wtc list`. A worktree whose directory is missing is refused (see `wtc prune`). The main checkout's own stack is not managed by `wtc`: run `docker compose` there as usual.

| Flag | |
|------|-|
| `--env <name>` | Env filename to copy and inject for this run (default: `envFile`, else `.env`) |
| `--workspace <name>` | Workspace to also inject env into; repeatable (see [Monorepos](#monorepos--custom-env-files)) |
| `--no-build` | Run `compose up -d` without `--build` |

### `wtc stop`

```
wtc stop [worktrees...]
```

Runs `compose stop`: containers are stopped, **not removed**, and all volumes are kept — including the anonymous ones images like postgres and redis create — so `wtc start` resumes the same containers with their data. `wtc list` shows a stopped stack as `exited`. One failure doesn't stop the rest; the exit code is 1 if any stack failed to stop.

### `wtc restart`

```
wtc restart [worktrees...] [--env <name>] [--workspace <name>]... [--no-build]
```

`compose stop`, then everything `start` does, with `up -d --build --remove-orphans`: unchanged services start again, changed ones are recreated (keeping their volumes), and containers of services you removed from the compose file go away. Use it after migrations, Dockerfile changes, or config updates. Env options and selectors are validated before anything is stopped.

### `wtc list`

```
wtc list [--json]        # alias: wtc ls
```

Every worktree with its index, branch, status, URL, and ports, plus a row for main's default ports. Status is `up`, `partial` (with running/total, e.g. `partial 2/3`), `exited` (containers stopped), `down` (no containers), or `?` (no reachable engine). One-off `docker compose run` containers are not counted. Removed worktrees whose record remains are shown as `(removed)`; worktrees git still lists but `wtc` can't start as `(locked, missing on disk)` or `(now the main checkout)`. Read-only: it never writes the registry.

`--json` prints an array of `{ index, branch, path, project, status, running, total, url, ports, orphan, unavailable }` to stdout (`unavailable` is `"missing"`, `"main"`, or `null`); warnings go to stderr. The URL is the first service whose name contains `frontend`, `web`, `app`, or `ui`, else the last isolated port.

### `wtc promote`

```
wtc promote <worktree> [--force]
```

Copies a worktree's changes into the checkout you run it from (usually main) as uncommitted changes: everything it changed since it branched — committed, staged, unstaged, and untracked — with deleted files deleted and renames applied as delete + add. Compose files and local env files (`.env`, `.env.development`, … — committed templates like `.env.example` still promote) are skipped, because `wtc` rewrites them per worktree. Symlinks are copied as symlinks; directories such as submodules are skipped with a warning. Works without Docker.

It refuses, before writing anything:

- **conflicts** — a file it would touch has uncommitted or untracked changes in the target (unless the target already has identical content). Commit or stash first.
- **reverts** — a file it would touch was also changed (committed) on the target branch since the worktree branched. Promote copies whole files, so this would silently undo those commits. Merge the target branch into the worktree first (the error prints the command), or pass `--force` to overwrite them anyway.
- **unsafe paths** — a path that escapes the repository or passes through a symlinked directory on either side.
- promoting a worktree into itself.

### `wtc clean`

```
wtc clean [--dry-run] [--force] [--keep-worktrees] [--sweep]
```

Ends the session for every worktree:

1. **Tears down every stack `wtc` knows** — all live worktrees and all orphans — with `compose down -v --remove-orphans`. **This deletes their volumes**, including the stacks of worktrees that step 2 keeps and with `--keep-worktrees`. To stop everything but keep the data, use `wtc stop`.
2. **Removes worktrees that hold no work of their own** (skipped entirely with `--keep-worktrees`). Never removed: the main checkout and the worktree you run `clean` from. Kept unless you pass `--force`:
   - uncommitted changes, tracked or untracked — other than the files `wtc` itself wrote there (the env files it injects, and compose/Dockerfile/`sync` copies that still match main);
   - a detached HEAD with commits no branch, tag, or remote contains;
   - submodules with commits not pushed to any remote;
   - locked worktrees.

   Each kept worktree is listed with the reason.
3. **Sweeps leftover containers, networks, and volumes, one at a time — only of stacks this checkout owns:** projects in its registry, or `<repo>-wt-<n>-…` projects whose containers ran from the main checkout, one of its worktrees, or a recorded worktree path. Stacks that are merely *named* like this repo's (another clone with the same directory name) are listed and never removed. Ownership is judged from containers: volumes and networks of a project with **no container left** carry no working directory, so they are listed, never removed — see [leftovers](#troubleshooting).
4. Runs `git worktree prune`, and forgets the records of removed worktrees and torn-down orphans. Worktrees that stay keep their index.

| Flag | |
|------|-|
| `--dry-run` | Print exactly what would be stopped, removed, and swept; change nothing (not even `wtc`'s registry) |
| `--force` | Also remove worktrees with uncommitted changes, unreachable commits, unpushed submodule commits, and locked ones |
| `--keep-worktrees` | Tear down the stacks (deleting their volumes), keep every worktree |
| `--sweep` | Also remove `<repo>-wt-<n>-…` stacks whose working directory no longer exists — e.g. left behind by wtc 0.2 — judged from their containers: volumes or networks with no container left are listed, never removed. Never a stack whose directory exists |

### `wtc prune`

```
wtc prune [--dry-run]
```

Tears down (`compose down -v --remove-orphans`, deleting volumes) and forgets **orphans only**: stacks of worktrees you deleted with `git worktree remove` or `rm -rf`. Live worktrees are not touched — nor is any worktree git still lists, such as a locked one on an unmounted drive; each orphan is re-checked right before teardown. Also runs `git worktree prune` when git still lists worktrees whose directory is gone.

### `wtc doctor`

```
wtc doctor [--json]
```

A ✔ / ⚠ / ✖ checklist with hints: git version; repository and main-checkout detection; compose file found and parsed (services, included files); config parsed (`.wtcrc.json` or `package.json#wtc`); compose engine and version (when it doesn't work, whether `WTC_COMPOSE_COMMAND`, `composeCommand`, or auto-detection chose it); daemon reachable; isolatable ports, including hardcoded ones [remapped at runtime](#runtime-remapping) (or why they can't be); [isolation warnings](#settings-that-break-isolation); cross-worktree port collisions; missing worktrees; orphaned stacks; each worktree's stack state; and allocated ports already taken by something else for worktrees whose stack isn't running. Read-only. Exits 1 if any check fails.

### `wtc skill`

```
wtc skill [--install] [--dir <path>]
```

Prints the bundled [agent skill](#agent-skill). `--install` writes it to `~/.claude/skills/worktree-compose/SKILL.md`; `--dir <path>` installs it to `<path>/worktree-compose/SKILL.md` instead.

### `wtc mcp`

Starts the [MCP server](#mcp-server) on stdio.

### What each command does to your data

| Command | Containers | Volumes (your data) | Worktrees |
|---------|-----------|---------------------|-----------|
| `wtc stop` | stopped, kept | kept | kept |
| `wtc restart` | stopped, then started; changed services recreated | kept | kept |
| `wtc prune` | removed (deleted worktrees' stacks only) | **deleted** (those stacks only) | — |
| `wtc clean` | removed (every stack) | **deleted** (every stack) | removed unless they hold work; never main or the current one |
| `wtc clean --keep-worktrees` | removed (every stack) | **deleted** (every stack) | kept |

Exit codes: any error exits 1. `stop`, `clean`, and `prune` also exit 1 when a stack, removal, or sweep failed (worktrees kept on purpose don't count); `doctor` exits 1 when a check fails.

## Configuration (Optional)

`wtc` works zero-config. For project-specific needs, create `.wtcrc.json` at the root of the main checkout:

```json
{
  "$schema": "https://unpkg.com/worktree-compose/wtc.schema.json",
  "sync": [".generated/prisma-client", "local-certs/"],
  "envFile": ".env.development",
  "workspaces": ["server", "homepage"],
  "envOverrides": {
    "VITE_API_URL": "http://localhost:${BACKEND_PORT}"
  },
  "workspaceEnvOverrides": {
    "server": {
      "DATABASE_URL": "postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/postgres"
    }
  },
  "portStride": 100,
  "composeCommand": "podman compose"
}
```

Or use a `"wtc"` key in `package.json`. (`.wtcrc.json` takes precedence.) The `$schema` line gives editors completion and validation for every key; `wtc` ignores it.

### `sync`

Extra files/directories to copy from main into each worktree on start. Use for gitignored or generated files that Docker needs but aren't committed — like generated clients, local certificates, or build artifacts. Paths are repo-relative; entries that are absolute or leave the repository are skipped with a warning.

### `envFile`

Env filename to copy from main and inject overrides into, for the root and every selected workspace. Defaults to `.env`. Must be a bare filename. Per-run override: `--env`.

### `workspaces`

Monorepo workspaces that also get their env file copied and injected, in addition to the root. Accepts package names, directory names, or repo-relative paths. Omitted → root only. Per-run override: `--workspace`. See [Monorepos & custom env files](#monorepos--custom-env-files).

### `envOverrides`

Additional env vars injected into the **root** env file. Values interpolate `${VAR}` with the allocated port variables and `${COMPOSE_PROJECT_NAME}`. Existing keys are rewritten in place; new keys are appended in the override block.

### `workspaceEnvOverrides`

Per-workspace overrides, keyed by workspace package name (a unique directory name or the repo-relative path also work). Applied only to that workspace's env file, with the same interpolation and in-place rewrite behavior as `envOverrides`.

### `portStride`

Port spacing between consecutive worktree indices (default `1`, must be a positive integer). Allocated port = `20000 + default_port + worktree_index × portStride`. Raise it (e.g. `100`) when your project exposes clustered default ports that would otherwise collide across worktrees — see [Port Allocation](#port-allocation). `wtc` warns and recommends a value when it detects a collision.

### `composeCommand`

Which compose tool to use instead of auto-detection: exactly one of `"docker compose"`, `"podman compose"`, `"docker-compose"`, or `"podman-compose"` (a string, or an array such as `["podman", "compose"]`). Repository config is limited to these four so a cloned repository can't make `wtc` run an arbitrary program; anything custom goes in the `WTC_COMPOSE_COMMAND` environment variable, which takes precedence. See [Docker, Podman, OrbStack, Colima](#docker-podman-orbstack-colima).

## Docker, Podman, OrbStack, Colima

`wtc` picks the compose command in this order:

1. **`WTC_COMPOSE_COMMAND`** environment variable — any command, split on whitespace: `WTC_COMPOSE_COMMAND="podman compose"`, an absolute path, or global flags such as `WTC_COMPOSE_COMMAND="docker --context colima compose"`.
2. **`composeCommand`** in `.wtcrc.json` / `package.json#wtc` — one of the four standard commands below.
3. **Auto-detection**, in order: `docker compose` (Compose v2) → `podman compose` → `docker-compose` (standalone, including legacy v1) → `podman-compose`. When more than one is installed, the first whose daemon answers wins, so a quit Docker Desktop doesn't shadow a running Podman machine.

| Engine | How |
|--------|-----|
| Docker Desktop / Docker Engine | `docker compose` (auto-detected) |
| OrbStack, Colima | through the `docker` CLI and its current context (auto-detected); for another context, `WTC_COMPOSE_COMMAND="docker --context <name> compose"` |
| Podman | `podman compose` or `podman-compose` (auto-detected); on macOS and Windows, start its VM with `podman machine start` |
| Anything else (e.g. `nerdctl compose`) | `WTC_COMPOSE_COMMAND` |

Status checks, teardown, and cleanup use the same CLI and global flags as compose, so they always talk to the same daemon. `wtc doctor` shows which engine was picked and its version, and whether its daemon is reachable. `wtc promote` doesn't need an engine at all.

## MCP Server

Built-in [MCP](https://modelcontextprotocol.io/) server, so AI agents can manage their stacks themselves. It works on the git repository of the directory it starts in — your agent's project. The setups below use the global install.

### Setup

**Claude Code** — for every project:

```bash
claude mcp add --scope user wtc -- wtc mcp
```

(Without `--scope user`, Claude Code registers it for the current project only.) Or share it with your team through a project `.mcp.json`:

```json
{
  "mcpServers": {
    "wtc": { "command": "wtc", "args": ["mcp"] }
  }
}
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.wtc]
command = "wtc"
args = ["mcp"]
```

**Cursor** — `.cursor/mcp.json`, with the same JSON as `.mcp.json` above.

**Without a global install**, use `npx` with the package name (never `npx wtc`):

```json
{ "command": "npx", "args": ["-y", "worktree-compose", "mcp"] }
```

After upgrading `wtc`, restart your MCP client so it runs the new version.

### Tools

| Tool | Parameters | What it does | Safety |
|------|-----------|--------------|--------|
| `wtc_start` | `indices?: (number \| string)[]`, `envFile?: string`, `workspaces?: string[]`, `build?: boolean` (default `true`) | Same as `wtc start` | not destructive |
| `wtc_stop` | `indices?: (number \| string)[]` | Same as `wtc stop` (`compose stop`) | not destructive: containers and volumes are kept |
| `wtc_restart` | same as `wtc_start` | Same as `wtc restart` | not destructive |
| `wtc_list` | — | First content item is the JSON array of `wtc list --json`; warnings follow as separate items | read-only: never writes the registry |
| `wtc_promote` | `index: number \| string`, `force?: boolean` | Same as `wtc promote`, into the checkout the server runs in | **destructive**: overwrites and deletes files there |
| `wtc_clean` | `force?`, `keepWorktrees?`, `dryRun?`, `sweep?` (all `boolean`) | Same as `wtc clean` | **destructive**: deletes volumes, removes worktrees |
| `wtc_prune` | `dryRun?: boolean` | Same as `wtc prune` | **destructive**: deletes removed worktrees' volumes |
| `wtc_doctor` | — | Same checks as `wtc doctor`, as JSON | read-only |

`indices` / `index` take [selectors](#selecting-worktrees): a JSON number is always an index; a string can be an index, branch, directory name, path, or `.`. Omit `indices` for all worktrees.

- Tools that change stacks or files (start, stop, restart, promote, clean, prune) run one at a time, so a client retry can't launch a second `compose up` for the same stack.
- Cancelling a request stops the compose command it started; a request cancelled while it waits its turn does not run at all. Requests with a `progressToken` get progress notifications while compose runs.
- Every tool returns its progress lines. Failures come back as `isError: true` with the reason (including the tail of compose's error output) — also when a teardown or removal inside `wtc_stop`, `wtc_clean`, or `wtc_prune` failed.
- Tool annotations mark `wtc_list` and `wtc_doctor` read-only and `wtc_promote`, `wtc_clean`, and `wtc_prune` destructive, so clients can ask before running them.
- stdout carries only JSON-RPC; all logging goes to stderr.

## Agent Skill

`wtc` ships an [agent skill](https://docs.claude.com/en/docs/claude-code/skills) ([`SKILL.md`](https://github.com/mostafasudo/worktree-compose/blob/main/SKILL.md)) that teaches AI coding agents the worktree workflow: commands and selectors, stop vs. clean, ports, env files, config, and the MCP tools. Install the copy that matches your installed version:

```bash
wtc skill --install              # ~/.claude/skills/worktree-compose/SKILL.md
wtc skill --dir ~/my-agent/skills # <dir>/worktree-compose/SKILL.md
wtc skill                        # print it
```

Re-run `wtc skill --install` after upgrading `wtc`.

## Full Example

```bash
cd myapp
npm install -g worktree-compose

git worktree add -b agent-1-auth ../myapp-agent-1
git worktree add -b agent-2-auth ../myapp-agent-2

wtc start
# Worktree 1: BACKEND_PORT=28001 FRONTEND_PORT=25174
# Worktree 2: BACKEND_PORT=28002 FRONTEND_PORT=25175

# Compare side by side
# http://localhost:25174  (agent 1)
# http://localhost:25175  (agent 2)

wtc promote agent-1-auth
git add -A && git commit -m "feat: auth from agent 1"

wtc clean --dry-run   # preview
wtc clean             # worktrees with uncommitted work are kept; --force discards them
```

## Upgrading from 0.2

1.0 changes a few behaviors; the [changelog](https://github.com/mostafasudo/worktree-compose/blob/main/CHANGELOG.md#upgrading-from-02) has the full list.

- **Node.js 20+.**
- **Install globally and type `wtc`** — without an install, `npx wtc` runs an unrelated package. Update MCP configs to `"command": "wtc", "args": ["mcp"]`.
- **Indices are stable.** Your existing stacks keep their names on the first run; after that, removing a worktree never shifts the others. Deleted worktrees show as `(removed)` until `wtc prune`.
- **`wtc stop` keeps containers** (`compose stop` instead of `down`); `start` resumes them. Only `clean` and `prune` remove stacks and volumes.
- **`wtc clean` keeps worktrees that hold work** (uncommitted changes, unreachable commits, unpushed submodule commits, locked) unless you pass `--force`, and only removes Docker resources of stacks it owns. Stale 0.2 stacks that still have containers: `wtc clean --sweep`. 0.2's `wtc stop` kept named volumes, so a worktree deleted after `wtc stop` can leave volumes with no container; `wtc clean` lists those but never removes them. Find them with `docker volume ls --filter label=com.docker.compose.project=<project>` and remove them with `docker volume rm`.
- **Env keys are rewritten in place**, and the root env file now gets `COMPOSE_PROJECT_NAME`.
- **`wtc promote`** also aborts when the target branch changed the same files since the worktree branched (`--force` overrides), and untracked files in the target now count as conflicts.

## Requirements

- **Node.js** >= 20
- **Git** 2.17 or newer, with worktree support (2.31+ recommended)
- **Docker** with Compose v2 (`docker compose`), or **Podman** (`podman compose` / `podman-compose`) — see [engines](#docker-podman-orbstack-colima)
- Docker Compose 2.24.4 or newer to [remap hardcoded host ports and `container_name`](#runtime-remapping); with older engines, write host ports as `${VAR:-default}`

## Troubleshooting

Start with **`wtc doctor`**: it checks the engine, the daemon, ports, isolation settings, missing worktrees, and orphaned stacks, and says what to do.

**`npx wtc` does something unexpected** — when worktree-compose isn't installed, it downloads and runs an unrelated npm package named `wtc`. Install globally (`npm install -g worktree-compose`) and type `wtc`, or use `npx worktree-compose <command>`.

**"No compose file found"** — `wtc` reads the compose file from the root of the main checkout, not the current directory: `compose.yaml`, `compose.yml`, `docker-compose.yaml`, or `docker-compose.yml`.

**"No extra worktrees found"** — Create worktrees first: `git worktree add -b my-branch ../my-feature`

**Ports not changing** — `wtc doctor` lists which ports are isolated, and whether hardcoded ones are remapped at runtime or why not (it needs Docker Compose 2.24.4+). Otherwise write host ports as `${VAR:-default}`, with an upper-case variable. A plain `docker compose up` run from a subdirectory of the worktree ignores `COMPOSE_FILE` in `.env` and publishes the hardcoded ports; run it from the worktree's root, or use `wtc restart .`.

**"Bind for 0.0.0.0:25435 failed: port is already allocated"** — Something else listens on that port. `wtc doctor` reports allocated ports that are already taken; stop the other process, or raise `portStride`. If you run `docker compose` yourself with a custom `envFile`, pass `--env-file <envFile>` (Compose only reads `.env` on its own) or export the port (e.g. `POSTGRES_PORT=25435 docker compose up`).

**A stack shows as `(removed)`** — its worktree was deleted but its stack or record remains. `wtc prune` tears it down (and frees its index); preview with `wtc prune --dry-run`.

**Leftover containers, networks, or volumes** — `wtc clean --dry-run` shows what `wtc clean` would remove. Leftovers of stacks whose worktree directory no longer exists (e.g. from wtc 0.2) are listed, and removed with `wtc clean --sweep` as long as the stack still has a container (that is where the working directory is recorded). Volumes or networks with no container left, and resources merely *named* like this repo's stacks, are listed and never removed by `wtc`. Inspect one project exactly before removing anything yourself: `docker ps -a --filter label=com.docker.compose.project=<project>` shows nothing for volume-only leftovers, so also run `docker volume ls --filter label=com.docker.compose.project=<project>` and `docker network ls --filter label=com.docker.compose.project=<project>`.

**"Refusing to start worktree stacks: cannot locate the main checkout"** (also `restart`, `clean`) — the repository layout doesn't say which checkout is the main one (see [repository layouts](#repository-layouts)). In a bare repository, check the default branch out in your main worktree again (finish the rebase or bisect), or add a worktree for it; with `--separate-git-dir`, run it from the main checkout (after one `wtc start` there, linked worktrees find it too).

**`wtc clean` kept a worktree** — it prints why (uncommitted changes, unreachable commits, unpushed submodule commits, locked, or the worktree you're in). Commit or push the work, or pass `--force` to discard it.

**"Timed out waiting for the wtc state lock"** — another `wtc` command (or MCP call) is updating `.git/wtc/state.json`; retry when it finishes. If no `wtc` process is running at all, delete the lock file the message names.

**"…was written by a newer wtc (state version N); upgrade wtc."** — an older `wtc` (often an MCP server started by a cached install) met a registry written by a newer one. Upgrade it (`npm install -g worktree-compose@latest`) and restart your MCP client. The older version leaves the file untouched.

**Wrong engine, or the daemon is down** — `wtc doctor` shows which engine was picked and whether its daemon answers. Start the daemon, or set `WTC_COMPOSE_COMMAND` (e.g. `"podman compose"`).

## Contributing

Issues and pull requests are welcome. Found a bug or have an idea? [Open an issue](https://github.com/mostafasudo/worktree-compose/issues) — and if `wtc` saves you time, a ⭐ on the [repo](https://github.com/mostafasudo/worktree-compose) helps others find it. Docs and demos live at [worktree-compose.com](https://www.worktree-compose.com).

## License

[MIT](https://github.com/mostafasudo/worktree-compose/blob/main/LICENSE)
