import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINE_PROBE_TIMEOUT_MS, run, runSafe } from "../utils/exec.js";
import { isWithin } from "../utils/paths.js";
import { sanitize, worktreeResourcePattern } from "../utils/sanitize.js";
import { cliCall, isComposePlugin } from "../compose/engine.js";
import { COMPOSE_FILE_VAR } from "../sync/env.js";
import {
  field,
  labelsOf,
  parseJsonListing,
  parsePsContainers,
  PROJECT_LABELS,
} from "../compose/status.js";
import { samePath } from "../git/worktree.js";
import { listRepoWorktrees } from "../git/repo.js";
import { recordIsLive } from "../state/registry.js";
import { composeEnv, composeRun, prepareStack } from "./compose.js";
import type { ComposeCallEnv } from "./compose.js";
import type { ComposeEngine } from "../compose/engine.js";
import type { Reporter } from "../utils/log.js";
import type { WtcContext } from "../context.js";
import type { WorktreeRecord } from "../state/registry.js";
import type { CoreIo } from "./types.js";

export interface TeardownTarget {
  project: string;
  index: number;
  /** Worktree directory (may no longer exist for orphans). */
  path: string;
}

/** Anonymous volumes are named by a 64-hex id; named volumes never are. */
const ANONYMOUS_VOLUME = /^[0-9a-f]{64}$/;

/**
 * Anonymous volumes (image-declared `VOLUME`s with no named volume in the
 * compose file) mounted by a project's containers. A container recreated
 * by `up` carries its anonymous volume over, and such a carried-over volume
 * survives `down -v`; collecting them first lets teardown remove them too.
 * Best effort: any failure yields an empty list.
 */
export function anonymousVolumes(engine: ComposeEngine, project: string): string[] {
  const opts = { timeoutMs: ENGINE_PROBE_TIMEOUT_MS };
  const [psFile, psArgs] = cliCall(
    engine,
    "ps",
    "-a",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  );
  const ids = (runSafe(psFile, psArgs, opts) ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((id) => /^[0-9a-f]{6,64}$/i.test(id));
  if (ids.length === 0) return [];

  const [inspectFile, inspectArgs] = cliCall(engine, "inspect", "--format", "{{json .Mounts}}", ...ids);
  const names = new Set<string>();
  for (const line of (runSafe(inspectFile, inspectArgs, opts) ?? "").split("\n")) {
    try {
      const mounts: unknown = JSON.parse(line);
      if (!Array.isArray(mounts)) continue;
      for (const m of mounts) {
        const mount = m as Record<string, unknown>;
        const name = String(field(mount, "Name") ?? "");
        if (String(field(mount, "Type") ?? "") === "volume" && ANONYMOUS_VOLUME.test(name)) {
          names.add(name);
        }
      }
    } catch {
      // Not JSON (empty line, unexpected output): ignore.
    }
  }
  return [...names];
}

/**
 * `compose -p P down -v --remove-orphans`. Runs from the worktree when it
 * still exists (so declared volumes/networks are resolved from its compose
 * file), otherwise from the main checkout — with the compose files the
 * stack was started with (its runtime override, which is deleted when its
 * record is forgotten). Fallbacks, in order:
 * - plain `down -v` from the same directory (podman-compose < 1.0.6 rejects
 *   `--remove-orphans`, which would make every teardown fail);
 * - for the Compose v2 plugin only, `down -v --remove-orphans` from an
 *   empty directory: it tears a project down by its labels alone when the
 *   compose file no longer parses. Standalone docker-compose v1 and
 *   podman-compose always need a compose file, so that retry cannot help.
 * Anonymous volumes the containers mounted are removed afterwards.
 */
export async function teardownStack(
  ctx: WtcContext,
  engine: ComposeEngine,
  target: TeardownTarget,
  io: CoreIo,
): Promise<{ ok: boolean; error?: string }> {
  const cwd = fs.existsSync(target.path) ? target.path : ctx.repoRoot;
  let env: ComposeCallEnv | undefined;
  try {
    // The compose files the stack was started with (runtime override included).
    const stack = prepareStack(ctx, { project: target.project, index: target.index, dir: cwd }, { write: false });
    env = composeEnv(target.project, stack.allocations, stack.composeFile, ctx.repo.commonDir);
  } catch {
    env = undefined;
  }
  // The label-only retry must not load any compose file, wtc's or an inherited list.
  const labelsOnlyEnv: ComposeCallEnv = { ...env, [COMPOSE_FILE_VAR]: undefined };
  const anonymous = anonymousVolumes(engine, target.project);
  const call = { live: io.live, signal: io.signal, onLine: io.onOutput };

  const attempts: { args: string[]; dir: () => string; env: ComposeCallEnv | undefined }[] = [
    { args: ["down", "-v", "--remove-orphans"], dir: () => cwd, env },
    { args: ["down", "-v"], dir: () => cwd, env },
  ];
  if (isComposePlugin(engine)) {
    attempts.push({
      args: ["down", "-v", "--remove-orphans"],
      dir: () => fs.mkdtempSync(path.join(os.tmpdir(), "wtc-down-")),
      env: labelsOnlyEnv,
    });
  }

  let firstError: unknown = null;
  for (const attempt of attempts) {
    if (io.signal?.aborted) break;
    const dir = attempt.dir();
    try {
      await composeRun(engine, target.project, attempt.args, { ...call, env: attempt.env, cwd: dir });
      for (const volume of anonymous) {
        const [file, args] = cliCall(engine, "volume", "rm", volume);
        runSafe(file, args, { timeoutMs: ENGINE_PROBE_TIMEOUT_MS });
      }
      return { ok: true };
    } catch (err) {
      firstError ??= err;
    } finally {
      if (dir !== cwd) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return {
    ok: false,
    error: firstError instanceof Error ? firstError.message : String(firstError ?? "cancelled"),
  };
}

/**
 * Re-check an orphan right before tearing it down, with a fresh `git
 * worktree list`: another wtc process (or `git worktree repair` / a moved
 * directory coming back) may have made its worktree live again since the
 * context was built, and `down -v` would then destroy a live stack's data.
 * Same identity rules as reconcile: a record is live when a worktree holds
 * its id, or sits at its path without a conflicting id (a new worktree at a
 * reused path is not the old one, so the orphan can still be pruned).
 * Returns null when the orphan is still gone, else why it must be skipped.
 */
export function orphanSkipReason(ctx: WtcContext, record: WorktreeRecord): string | null {
  let listed;
  try {
    listed = listRepoWorktrees(ctx.repo);
  } catch (err) {
    return `could not re-check its worktree (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`;
  }
  return recordIsLive(record, listed) ? `its worktree (${record.path}) exists again; run 'wtc list' to see it` : null;
}

/** Runs a container CLI command; throws on failure. Injectable for tests. */
export type SweepRunner = (file: string, args: string[]) => string;

export interface SweepBucket {
  removed: string[];
  failed: string[];
}

export interface SweepResult {
  /** Removed (or, in a dry run, to be removed) resources, and failed removals. */
  containers: SweepBucket;
  networks: SweepBucket;
  volumes: SweepBucket;
  /**
   * Resources of `<repo>-wt-<n>-` stacks whose working directory no longer
   * exists (typically left by wtc ≤0.2). Removed only with `sweep`; kept
   * and listed otherwise.
   */
  stale: string[];
  /**
   * Resources named like this repo's worktree stacks that this checkout
   * cannot prove it owns: another checkout's stack (same directory name),
   * or nothing left to attribute them by (no labels, no containers). Never
   * removed.
   */
  notOwned: string[];
  /** Set when a listing failed (engine unreachable). */
  error?: string;
}

const defaultRunner: SweepRunner = (file, args) =>
  run(file, args, { timeoutMs: ENGINE_PROBE_TIMEOUT_MS });

export interface SweepOptions {
  dryRun?: boolean;
  runner?: SweepRunner;
  reporter?: Reporter;
  /** Projects of this repository's registry records (live and orphaned): owned outright. */
  registryProjects?: string[];
  /**
   * Projects to leave alone this run: in a dry run those step 1 would tear
   * down (`down -v` removes them first), and orphans whose worktree came
   * back while cleaning.
   */
  skipProjects?: string[];
  /** The main checkout: a stack that ran from it (or below it) is this repository's. */
  mainRoot?: string;
  /**
   * Current worktree paths plus every registry path: a stack whose
   * `working_dir` is exactly one of them is this repository's.
   */
  checkouts?: string[];
  /**
   * `clean --sweep`: also remove `<repo>-wt-<n>-` stacks whose working
   * directory no longer exists on disk (stale ≤0.2 leftovers). A stack
   * whose directory exists is never removed this way — it may be another
   * checkout's.
   */
  sweep?: boolean;
  /** Whether a directory exists (tests). */
  dirExists?: (dir: string) => boolean;
}

interface Resource {
  id: string;
  name: string;
  /** Compose project label, or null. */
  project: string | null;
}

interface ResourceKind {
  key: "containers" | "networks" | "volumes";
  label: string;
  list: string[];
  remove: (id: string) => string[];
}

const KINDS: ResourceKind[] = [
  {
    key: "containers",
    label: "container",
    list: ["ps", "-a", "--format", "json"],
    remove: (id) => ["rm", "-f", id],
  },
  {
    key: "networks",
    label: "network",
    list: ["network", "ls", "--format", "json"],
    remove: (id) => ["network", "rm", id],
  },
  {
    key: "volumes",
    label: "volume",
    list: ["volume", "ls", "--format", "json"],
    remove: (id) => ["volume", "rm", id],
  },
];

function parseResources(kind: ResourceKind, output: string): Resource[] {
  if (kind.key === "containers") {
    return parsePsContainers(output).map((c) => ({
      id: c.id || c.name,
      name: c.name,
      project: c.project,
    }));
  }
  return parseJsonListing(output).map((entry) => {
    const labels = labelsOf(entry);
    const name = String(field(entry, "Name") ?? "");
    // Volumes are removed by name; networks by id when there is one.
    const id = kind.key === "networks" ? String(field(entry, "ID") ?? "") || name : name;
    return { id, name, project: PROJECT_LABELS.map((l) => labels[l]).find(Boolean) ?? null };
  });
}

type Group = "owned" | "stale" | "notOwned";

/**
 * Remove leftover containers, networks and volumes of this repository's
 * worktree stacks — never another checkout's.
 *
 * A name like `<repo>-wt-<n>-…` proves nothing: the prefix is the checkout
 * directory's basename, which a second clone (or an unrelated repo also
 * called `api`) shares. Ownership comes from compose's labels instead. A
 * project is *owned* when it is in this repository's registry, or when it
 * is a `<repo>-wt-<n>-` project one of whose containers ran
 * (`project.working_dir`) from the main checkout (or below it), a current
 * worktree, or a registry path. Only resources whose project label is owned
 * are removed, one at a time (a volume still in use cannot discard the rest).
 *
 * Name-matching projects that are not owned are kept and listed, in two
 * groups: *stale* ones, whose working directory no longer exists (removed
 * with `sweep`), and the rest — whose directory exists (another checkout),
 * or which have nothing to attribute them by — which are never removed.
 */
export function sweepStaleResources(
  cliArgv: string[],
  repoName: string,
  opts: SweepOptions = {},
): SweepResult {
  const runner = opts.runner ?? defaultRunner;
  const dirExists = opts.dirExists ?? ((dir: string) => fs.existsSync(dir));
  // An empty prefix (a repo name with no ASCII letters/digits) would match
  // every repository's `wt-<n>-` stacks: no name-based matching at all then.
  const namePattern = sanitize(repoName) ? worktreeResourcePattern(repoName) : null;
  const nameMatches = (name: string | null) => !!name && !!namePattern && namePattern.test(name);
  const skip = new Set(opts.skipProjects ?? []);
  const result: SweepResult = {
    containers: { removed: [], failed: [] },
    networks: { removed: [], failed: [] },
    volumes: { removed: [], failed: [] },
    stale: [],
    notOwned: [],
  };

  const listings = new Map<ResourceKind["key"], Resource[]>();
  const containerDirs = new Map<string, Set<string>>();
  for (const kind of KINDS) {
    try {
      const output = runner(cliArgv[0], [...cliArgv.slice(1), ...kind.list]);
      listings.set(kind.key, parseResources(kind, output));
      if (kind.key === "containers") {
        for (const c of parsePsContainers(output)) {
          if (!c.project || !c.workingDir) continue;
          const dirs = containerDirs.get(c.project) ?? new Set<string>();
          dirs.add(c.workingDir);
          containerDirs.set(c.project, dirs);
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      opts.reporter?.warn(`Could not list ${kind.label}s: ${result.error.split("\n")[0]}`);
    }
  }

  // Attribute `<repo>-wt-<n>-` projects by where their containers ran.
  const owned = new Set(opts.registryProjects ?? []);
  const stale = new Set<string>();
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const mainRoot = opts.mainRoot;
  const ours = (dir: string) =>
    (mainRoot !== undefined && (isWithin(mainRoot, dir) || isWithin(real(mainRoot), real(dir)))) ||
    (opts.checkouts ?? []).some((c) => samePath(c, dir));
  for (const [project, dirs] of containerDirs) {
    if (owned.has(project) || !nameMatches(project)) continue;
    if ([...dirs].some(ours)) owned.add(project);
    else if (![...dirs].some(dirExists)) stale.add(project);
  }

  const groupOf = (r: Resource): Group | null => {
    if (r.project !== null && owned.has(r.project)) return "owned";
    if (!nameMatches(r.name) && !nameMatches(r.project)) return null;
    return r.project !== null && stale.has(r.project) ? "stale" : "notOwned";
  };

  for (const kind of KINDS) {
    for (const r of listings.get(kind.key) ?? []) {
      if (r.project !== null && skip.has(r.project)) continue;
      const group = groupOf(r);
      if (group === null) continue;
      const label = `${kind.label} ${r.name}`;
      if (group === "notOwned") {
        result.notOwned.push(label);
        continue;
      }
      if (group === "stale") {
        result.stale.push(label);
        if (!opts.sweep) continue;
      }
      const why = group === "stale" ? " (its worktree directory is gone)" : "";
      if (opts.dryRun) {
        opts.reporter?.info(`Would remove leftover ${label}${why}`);
        result[kind.key].removed.push(r.name);
        continue;
      }
      try {
        runner(cliArgv[0], [...cliArgv.slice(1), ...kind.remove(r.id)]);
        result[kind.key].removed.push(r.name);
        opts.reporter?.info(`Removed leftover ${label}${why}`);
      } catch (err) {
        result[kind.key].failed.push(r.name);
        const reason = err instanceof Error ? err.message.split("\n").slice(-1)[0] : String(err);
        opts.reporter?.warn(`Could not remove ${label}: ${reason}`);
      }
    }
  }

  if (result.stale.length > 0 && !opts.sweep) {
    opts.reporter?.warn(
      `Kept ${result.stale.length} leftover resource(s) of worktree stacks whose directory no longer exists ` +
        `(e.g. left by wtc ≤0.2): ${result.stale.join(", ")}. ` +
        `Remove them with 'wtc clean --sweep' (preview with --dry-run).`,
    );
  }
  if (result.notOwned.length > 0) {
    opts.reporter?.warn(
      `Kept ${result.notOwned.length} resource(s) named like this repo's worktree stacks that this checkout ` +
        `does not own (another checkout with the same directory name, or nothing to attribute them by): ` +
        `${result.notOwned.join(", ")}. wtc never removes these; remove them yourself if they are yours.`,
    );
  }
  return result;
}
