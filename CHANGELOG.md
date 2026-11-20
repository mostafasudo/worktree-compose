# Changelog

All notable changes to worktree-compose (`wtc`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Hardcoded host ports and `container_name` no longer have to be edited out of the compose file: `wtc` remaps them for each worktree stack at runtime. Thanks to [@cokeeffe](https://github.com/cokeeffe) for the idea ([#12](https://github.com/mostafasudo/worktree-compose/issues/12)).

### Added

- Runtime remapping of hardcoded host ports (`"8080:80"`) and fixed `container_name`s. Each worktree stack gets a generated compose override in `.git/wtc/compose/<project>.yaml` (`ports: !override` with the worktree's ports, `container_name: !reset null` with the old name kept as a network alias inside the stack), passed through `COMPOSE_FILE` to every compose call on the stack and written into the worktree's root env file, so a plain `docker compose` run from the worktree's root uses it too. The compose file is never edited. Needs Docker Compose 2.24.4 or newer: `wtc` checks the engine (`compose config` on a throwaway file) and otherwise warns as before. Left alone: what the worktree's own `compose.override.yaml` sets for a service, the ports of services that use `extends` or come from an `include:`d file with port variables, host port ranges, ports too high to move or whose new port the stack already publishes, a `container_name` another service joins by name (`network_mode: container:<name>`), and everything when you set `COMPOSE_FILE` (or a different `COMPOSE_PATH_SEPARATOR`) yourself.
- Remapped ports show up in `wtc start`, `wtc list` (and `--json`, MCP `wtc_list`) as `<service>:<default port>`, e.g. `web:8080=28081`; they count in cross-worktree collision checks and `portStride` recommendations, and `wtc doctor` checks whether they are already taken. `wtc doctor` lists what is remapped, or why it can't be.

### Changed

- With an engine that can't remap, `wtc start` and `wtc doctor` add a warning that says why (e.g. Compose older than 2.24.4), which `wtc list` counts among the isolation warnings.
- Raw port warnings suggest a different variable for each port of a service (`WEB_PORT`, `WEB_443_PORT`) instead of the same one, and host port ranges get a warning of their own (they are never remapped). Host port `0` (any free port) is no longer warned about.
- `wtc start` prints a worktree's ports after syncing its files, since the worktree's own compose override may be one of them.

### Fixed

- A `${VAR:-port}` mapping repeated with the same default (e.g. for tcp and udp) gets one port instead of failing with "Port collision".
- Compose files are read the way compose reads them: YAML merge keys (`<<: *anchor`) are resolved, `ports: !reset` clears the list, and `!override` / `!reset` in a later file of an `include:` path list replace the earlier file's `ports` or `container_name` instead of adding to them.
- A host port written as an incomplete range (`"8000-${PORT_END:-8010}:80"`) is no longer read as port 8000.

## [1.0.0] - 2026-10-24

The first stable release: worktree stacks keep a stable identity, cleanup no longer touches what it doesn't own, every command runs without a shell, and Podman is supported.

Thanks to [@DarellYuhu](https://github.com/DarellYuhu) for monorepo env targeting ([#10](https://github.com/mostafasudo/worktree-compose/pull/10)), to [@KennyCandra](https://github.com/KennyCandra) for the original `COMPOSE_PROJECT_NAME` proposal ([#3](https://github.com/mostafasudo/worktree-compose/pull/3)), to [@kevmtt](https://github.com/kevmtt) for reporting [#7](https://github.com/mostafasudo/worktree-compose/issues/7), and to [@geniuskamo](https://github.com/geniuskamo) for reporting [#9](https://github.com/mostafasudo/worktree-compose/issues/9).

### Upgrading from 0.2

- **Node.js 20 or newer** is required (was 18).
- **Install globally and type `wtc`.** An unrelated npm package is named `wtc`, so `npx wtc` without a global install runs that package. Use `npm install -g worktree-compose`, or `npx worktree-compose <command>` for a one-off. Update MCP configs to `{"command": "wtc", "args": ["mcp"]}` (or `{"command": "npx", "args": ["-y", "worktree-compose", "mcp"]}`).
- **Indices are stable.** On the first run, existing worktrees get the same positional indices 0.2 used, and a worktree whose 0.2 stack is running adopts that stack's index and project, so running stacks are picked up, not duplicated. After that an index never changes: removing a worktree no longer renumbers the ones after it, and a new worktree takes the lowest free index. Identities are stored in `.git/wtc/state.json`.
- **Deleted worktrees become orphans.** A worktree removed with `git worktree remove` or `rm -rf` shows in `wtc list` as `(removed)`, and its index stays reserved until `wtc prune` (or `wtc clean`) tears its stack down.
- **`wtc stop` keeps containers.** It runs `compose stop` instead of `compose down`: containers and all volumes are kept, `wtc start` resumes them, and `wtc list` shows them as `exited`. `restart` is now `compose stop` followed by `start` with `--remove-orphans`.
- **`wtc clean` keeps worktrees that hold work.** Worktrees with uncommitted changes (other than files wtc wrote), commits on a detached HEAD that nothing else reaches, unpushed submodule commits, or a lock are kept unless you pass `--force`; the main checkout and the current worktree are never removed. Kept worktrees' stacks are still torn down with `down -v` (their volumes are deleted).
- **`wtc clean` only removes stacks it owns.** It no longer removes every container named `*-wt-*`; leftovers are swept only for stacks this checkout owns, one at a time. Same-named stacks of other checkouts are listed, never removed. Stale 0.2 leftovers whose worktree directory is gone: `wtc clean --sweep` (stacks that still have containers; leftover volumes with no container — e.g. after 0.2's `wtc stop`, which kept named volumes — are listed for you to remove with `docker volume rm`).
- **Env keys are rewritten in place.** A key that already exists in the env file (e.g. `POSTGRES_PORT`) is rewritten where it is instead of being repeated in the wtc block, and the root env file now gets `COMPOSE_PROJECT_NAME`. `${VAR}` placeholders in overrides are replaced everywhere in a value, not just the first time.
- **`wtc promote` is stricter.** It aborts when the target branch committed changes to the same files since the worktree branched (promoting would revert them; `--force` overrides), and untracked files in the target now count as conflicts.
- **MCP `wtc_list` output.** `content[0]` is still a pure JSON array (the same as `wtc list --json`); rows gain `running`, `total`, `url`, `orphan`, and `unavailable`, `status` can be `up`, `partial`, `exited`, `down`, or `?`, orphan rows are included, and warnings come as separate content items.
- **MCP selectors.** `indices` and `wtc_promote`'s `index` accept strings (branch, directory name, path, `.`) as well as numbers.
- **Exit codes.** `stop`, `clean`, and `prune` exit 1 when a stack or removal fails; MCP tools return `isError: true`.
- **Agent skill.** Install it with `wtc skill --install` instead of symlinking `SKILL.md`.

### Added

- Stable worktree identity: each worktree's index and compose project are recorded at first sight in `.git/wtc/state.json` (locked, atomic writes) and survive branch renames and `git worktree move` (an id is kept in the worktree's git admin dir). 0.2 stacks are adopted by position or by the directory compose ran in ([#9](https://github.com/mostafasudo/worktree-compose/issues/9)).
- Orphan tracking: `(removed)` rows in `wtc list`, reserved indices, and `wtc prune [--dry-run]` / MCP `wtc_prune` to tear orphaned stacks down. A worktree git still lists is never an orphan: a locked worktree whose directory is missing (an unmounted drive) keeps its index, record, and stack, shown as `(locked, missing on disk)`.
- Worktree selectors for `start`, `stop`, `restart`, `promote`, and the MCP tools: index, branch, directory name, path, or `.` (the worktree you are in), with ambiguity errors.
- `COMPOSE_PROJECT_NAME` written into each worktree's root env file, so plain `docker compose` in the worktree (with the default `.env`) reaches the same stack; `${COMPOSE_PROJECT_NAME}` interpolation in `envOverrides` and `workspaceEnvOverrides` ([#2](https://github.com/mostafasudo/worktree-compose/issues/2); original proposal by @KennyCandra in [#3](https://github.com/mostafasudo/worktree-compose/pull/3)).
- Podman support and compose engine detection: `docker compose` → `podman compose` → `docker-compose` → `podman-compose`, preferring an engine whose daemon answers. Override with the `WTC_COMPOSE_COMMAND` environment variable or the `composeCommand` config key. OrbStack and Colima work through the `docker` CLI; global flags such as `--context` are honored by status checks and cleanup too ([#1](https://github.com/mostafasudo/worktree-compose/issues/1)).
- Monorepo env targeting: `envFile` / `--env`, `workspaces` / `--workspace`, and `workspaceEnvOverrides`; allocated ports exported into the compose process environment; existing env keys rewritten in place. By @DarellYuhu in [#10](https://github.com/mostafasudo/worktree-compose/pull/10).
- `wtc doctor [--json]` and MCP `wtc_doctor`: git, repository layout, compose file, config, engine and daemon, port isolation, isolation-breaking settings, collisions, missing worktrees, orphans, and allocated ports already in use.
- Isolation warnings for `container_name`, and for volumes and networks with a fixed `name:` or `external: true`.
- `wtc list --json`, with `running`/`total` counts and `partial` and `exited` states.
- `wtc start` / `wtc restart` `--no-build` (MCP `build: false`).
- `wtc clean --dry-run`, `--force`, `--keep-worktrees`, and `--sweep` (MCP `dryRun`, `force`, `keepWorktrees`, `sweep`).
- `wtc promote --force` (MCP `force`).
- `wtc skill [--install] [--dir <path>]`; `SKILL.md` now ships in the package.
- `wtc.schema.json` for `.wtcrc.json` editor completion: `"$schema": "https://unpkg.com/worktree-compose/wtc.schema.json"`.
- MCP: tool annotations (read-only/destructive; `wtc_list` and `wtc_doctor` never write anything), progress notifications, cancellation that stops the running compose command (a request cancelled while it waits its turn never runs), serialized stack-changing tools, and `isError` results with compose's error output.
- Support for bare repositories with worktrees, submodules, and `--separate-git-dir` checkouts. The main checkout is remembered where git can't always name it (a bare repo's default-branch worktree mid-rebase, a `--separate-git-dir` repo seen from a linked worktree); when it is unknown, `start`, `restart`, and `clean` refuse instead of guessing.
- CI on Node.js 20, 22, and 24; releases are published from GitHub Actions with npm trusted publishing.

### Changed

- Every command resolves the main checkout, even when run from a linked worktree (where agents and MCP servers usually run): the repo name, and therefore every project name, stays the same, and compose, config, and env files are always read from main.
- `wtc stop` runs `compose stop` (containers and volumes are kept); `wtc restart` runs `compose stop`, then start with `up -d --remove-orphans`, and checks env options and selectors before stopping anything.
- `wtc clean` tears stacks down with `down -v --remove-orphans` (anonymous volumes included), removes only worktrees without work of their own unless `--force`, sweeps only resources of stacks it owns, one at a time, and keeps the records (and indices) of worktrees that remain.
- `wtc promote` takes a selector, reads changes with `-z` and `--no-renames` (a rename deletes the old path in the target), and checks every path before writing anything.
- MCP tools use `registerTool`; `wtc_list` returns full rows; tool handlers never throw.
- Port collision warnings consider the indices actually in use (live worktrees and orphans).
- Errors name the failing command and include the tail of its error output.
- `stop`, `clean`, and `prune` exit 1 when something failed; MCP tools return `isError: true`.
- Node.js 20 or newer is required (`commander` 14 needs it).
- Docs use `wtc` (global install) instead of `npx wtc`; the homepage is now https://www.worktree-compose.com.

### Fixed

- Removing a worktree renumbered every worktree after it: their stacks were orphaned and `start` created new stacks on new ports ([#9](https://github.com/mostafasudo/worktree-compose/issues/9)).
- `wtc clean`'s unanchored `-wt-` filter matched other repositories' containers, and one failed removal discarded a whole batch ([#9](https://github.com/mostafasudo/worktree-compose/issues/9)).
- `wtc clean` force-removed worktrees with uncommitted work.
- Running `wtc` from a linked worktree used that worktree's directory name as the repo name and synced files from it.
- `wtc mcp` could write log lines to stdout, corrupting the JSON-RPC stream (e.g. from `wtc_clean`).
- Stack status comes from container labels (one `ps -a` call, Docker and Podman output formats) instead of being guessed from the length of `compose ps` output; one-off `compose run` containers don't make a healthy stack look `partial`.
- Worktrees deleted from disk counted as live, and `start` recreated their directories to run compose in.
- `promote` with non-ASCII file names, with renames (the old path is now deleted in the target), and with untracked files in the target (now a conflict instead of being overwritten).
- `envOverrides` replaced only the first `${VAR}` in a value ([#10](https://github.com/mostafasudo/worktree-compose/pull/10)).
- Dockerfile sync with absolute `dockerfile` paths, remote build contexts (`https://…`, `git@…`), and `dockerfile_inline`.

### Security

- No shell anywhere: every git, docker, and compose call passes an argument array, so paths, branch names, and config values can't inject commands ([#7](https://github.com/mostafasudo/worktree-compose/issues/7), reported by @kevmtt).
- Path containment: `sync` entries and Dockerfile paths must stay inside the repository; symlinks under synced paths are recreated as symlinks instead of followed; sync, env injection, and promote never write through a symlink found at the destination; and promote rejects paths that pass through a symlinked directory on either side ([#7](https://github.com/mostafasudo/worktree-compose/issues/7)).
- `composeCommand` in repository config may only be one of `docker compose`, `podman compose`, `docker-compose`, or `podman-compose`, so a cloned repository can't make `wtc` (including the read-only `wtc doctor`) run an arbitrary program. Custom commands go in `WTC_COMPOSE_COMMAND`.
- `wtc clean` decides ownership from compose labels, not names, so it never removes containers, networks, or volumes of another checkout that happens to share the directory name.

## [0.2.0] - 2026-06-26

### Added

- Support for the compose `include:` directive: services in included files get port isolation, and included files are synced into worktrees. By @wms in [#5](https://github.com/mostafasudo/worktree-compose/pull/5).
- `portStride` config with cross-worktree port collision detection and a recommended stride. By @wms in [#6](https://github.com/mostafasudo/worktree-compose/pull/6).

### Fixed

- MCP `wtc_list` always reported status `"up"`. By @samjbobb in [#4](https://github.com/mostafasudo/worktree-compose/pull/4).

## [0.1.4] - 2026-02-23

### Changed

- README: install command and the embedded explainer video.

## [0.1.3] - 2026-02-23

### Added

- MIT license.

### Changed

- README: clarified `sync` for gitignored and generated files; added the explainer video.

## [0.1.2] - 2026-02-23

### Changed

- README restructured (install and usage first, `wtc list` output, npm badge); the npm package links to the GitHub repository.

## [0.1.0] - 2026-02-23

### Added

- Initial release: `wtc start`, `stop`, `restart`, `list`, `promote`, `clean`, and `mcp`; per-worktree port allocation from `${VAR:-default}` host ports; env file injection; infra file sync; `.wtcrc.json` config.

[1.0.0]: https://github.com/mostafasudo/worktree-compose/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/mostafasudo/worktree-compose/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/mostafasudo/worktree-compose/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/mostafasudo/worktree-compose/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/mostafasudo/worktree-compose/compare/7a4ab6f...v0.1.2
[0.1.0]: https://github.com/mostafasudo/worktree-compose/commit/7a4ab6f
