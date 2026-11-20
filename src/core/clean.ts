import fs from "node:fs";
import path from "node:path";
import { buildContext, getEnvTargets } from "../context.js";
import { runSafe, run } from "../utils/exec.js";
import { isWithin } from "../utils/paths.js";
import { getDockerfiles, resolveSyncEntries } from "../sync/files.js";
import { getStatusPaths } from "../git/status.js";
import { samePath } from "../git/worktree.js";
import { forgetRecords } from "../state/registry.js";
import { overridePath, removeOverride } from "../compose/override.js";
import { reportContextWarnings, throwIfAborted } from "./compose.js";
import { orphanSkipReason, sweepStaleResources, teardownStack } from "./teardown.js";
import type { SweepResult, SweepRunner } from "./teardown.js";
import type { ComposeEngine } from "../compose/engine.js";
import type { WtcContext } from "../context.js";
import type { ResolvedWorktree } from "../state/registry.js";
import type { Reporter } from "../utils/log.js";
import type { CoreIo } from "./types.js";

export interface CleanOptions {
  /**
   * Also remove worktrees with uncommitted changes, commits on no branch,
   * or unpushed submodule commits — and locked ones.
   */
  force?: boolean;
  /** Tear down stacks (deleting their volumes) but keep every worktree. */
  keepWorktrees?: boolean;
  /**
   * Report what would happen; change nothing — not even the registry (the
   * context is built read-only).
   */
  dryRun?: boolean;
  /**
   * Also remove stacks named after this repo's worktree stacks
   * (`<repo>-wt-<n>-…`) whose working directory no longer exists — stale
   * leftovers, e.g. of wtc ≤0.2. Never a stack whose directory exists.
   */
  sweep?: boolean;
  /** Container CLI runner for the stale sweep (tests). */
  sweepRunner?: SweepRunner;
}

export interface CleanResult {
  dryRun: boolean;
  stacks: { project: string; orphan: boolean; ok: boolean; error?: string }[];
  removed: string[];
  /** Worktrees deliberately kept: dirty, locked, current, main checkout. Not failures. */
  skipped: { path: string; reason: string }[];
  /** Worktrees whose `git worktree remove` failed. */
  removeFailed: { path: string; reason: string }[];
  sweep: SweepResult | null;
  forgotten: string[];
  /**
   * Real failures (non-zero → exit 1 / MCP isError): stacks that could not
   * be torn down, worktree removals and sweep removals/listings that
   * failed. Always 0 for a dry run.
   */
  failures: number;
}

/** Count a clean run's failures (see CleanResult.failures). */
function countFailures(result: CleanResult): number {
  if (result.dryRun) return 0;
  const sweep = result.sweep;
  return (
    result.stacks.filter((s) => !s.ok).length +
    result.removeFailed.length +
    (sweep
      ? sweep.containers.failed.length +
        sweep.networks.failed.length +
        sweep.volumes.failed.length +
        (sweep.error ? 1 : 0)
      : 0)
  );
}

/** True when `rel` is byte-identical (or the same symlink) in the worktree and in main. */
function mirrorsMain(repoRoot: string, wtPath: string, rel: string): boolean {
  const ours = path.join(wtPath, rel);
  const theirs = path.join(repoRoot, rel);
  try {
    const a = fs.lstatSync(ours);
    const b = fs.lstatSync(theirs);
    if (a.isSymbolicLink() && b.isSymbolicLink()) {
      return fs.readlinkSync(ours) === fs.readlinkSync(theirs);
    }
    if (!a.isFile() || !b.isFile() || a.size !== b.size) return false;
    return fs.readFileSync(ours).equals(fs.readFileSync(theirs));
  } catch {
    return false;
  }
}

/**
 * Which uncommitted paths in a worktree are wtc's own artifacts rather than
 * the user's work:
 * - the env files wtc writes: `<dir>/<envFile>` for the root and each
 *   configured workspace, plus whatever the worktree's last `start` wrote
 *   (`--env`/`--workspace` may name others) — not every `.env.*` file, so an
 *   edited `.env.test` or `apps/x/.env.production` is the user's work;
 * - compose sources (incl. includes), synced Dockerfiles and files under
 *   `sync` entries, but only while they are byte-identical to the main
 *   checkout's copy, i.e. exactly what start's sync wrote. An edit made in
 *   the worktree (or a file only the worktree has) is the user's work. If
 *   main changed since the last start this errs towards "dirty", which
 *   --force overrides.
 */
export function managedPathMatcher(
  ctx: WtcContext,
  wtPath: string,
  envFiles: string[] = [],
): (rel: string) => boolean {
  const toPosix = (p: string) => p.split(path.sep).join("/");
  const mirrored = new Set<string>();
  for (const src of ctx.composeFile.sourceFiles) {
    mirrored.add(toPosix(path.relative(ctx.repoRoot, src)));
  }
  for (const df of getDockerfiles(ctx.composeFile, ctx.repoRoot)) {
    mirrored.add(toPosix(df));
  }
  const prefixes = resolveSyncEntries(ctx.repoRoot, ctx.config.sync).entries.map(toPosix);

  const envPaths = new Set(envFiles.map(toPosix));
  try {
    for (const t of getEnvTargets(ctx)) envPaths.add(path.posix.join(toPosix(t.dir), t.envFileName));
  } catch {
    envPaths.add(ctx.config.envFile ?? ".env");
  }

  return (rel: string) => {
    const p = rel.replace(/\/+$/, "");
    if (envPaths.has(p)) return true;
    const synced = mirrored.has(p) || prefixes.some((pre) => p === pre || p.startsWith(`${pre}/`));
    return synced && mirrorsMain(ctx.repoRoot, wtPath, p);
  };
}

/** Uncommitted paths in a worktree that wtc did not put there. */
export function unmanagedChanges(statusPaths: string[], isManaged: (rel: string) => boolean): string[] {
  return statusPaths.filter((p) => !isManaged(p));
}

/**
 * Commits that removing the worktree would make unreachable, beyond what
 * `git status` shows:
 * - a detached HEAD with commits no branch, tag or remote reaches (the
 *   worktree's HEAD reflog goes with it);
 * - submodule commits not on any remote: the submodules' repositories live
 *   in the worktree's admin dir, which `git worktree remove --force`
 *   deletes (plain `remove` refuses worktrees with submodules for this
 *   reason; wtc needs --force for its own artifacts).
 * Returns a reason, or `null` when nothing would be lost.
 */
export function unreachableWork(wt: ResolvedWorktree): string | null {
  if (wt.detached) {
    try {
      const sha = run("git", [
        "-C",
        wt.path,
        "rev-list",
        "--max-count=1",
        "HEAD",
        "--not",
        "--branches",
        "--tags",
        "--remotes",
      ]);
      if (sha) {
        return `detached HEAD has commits no branch or tag reaches (HEAD ${sha.slice(0, 12)}); save them with 'git -C ${wt.path} branch <name>'`;
      }
    } catch (err) {
      return `could not check its detached HEAD (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`;
    }
  }

  const hasSubmodules =
    (wt.adminDir !== undefined && fs.existsSync(path.join(wt.adminDir, "modules"))) ||
    fs.existsSync(path.join(wt.path, ".gitmodules"));
  if (hasSubmodules) {
    try {
      const out = run("git", [
        "-C",
        wt.path,
        "submodule",
        "foreach",
        "--quiet",
        "--recursive",
        "git rev-list -n1 --all --not --remotes",
      ]);
      if (out.trim()) return "a submodule has commits not on any remote; push them first";
    } catch (err) {
      return `could not check its submodules (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`;
    }
  }
  return null;
}

/**
 * Tear down every worktree stack (live and orphaned), remove worktrees that
 * hold no work of their own, sweep leftovers this checkout owns, and forget
 * what was removed. Never removes the main checkout or the worktree it runs
 * from.
 */
export async function clean(
  options: CleanOptions,
  reporter: Reporter,
  io: CoreIo,
): Promise<CleanResult> {
  const dryRun = options.dryRun === true;
  // probeStacks: with no registry yet (an upgrade from ≤0.2, or a lost
  // state file) identities are adopted from the running stacks, so teardown
  // targets their real project names instead of positional guesses.
  const ctx = buildContext(
    {},
    {
      cwd: io.cwd,
      allowMissingCompose: true,
      probeStacks: true,
      readOnly: dryRun,
      requireMainFor: "clean up worktrees",
    },
  );
  reportContextWarnings(ctx, reporter, { isolation: false });
  const result: CleanResult = {
    dryRun,
    stacks: [],
    removed: [],
    skipped: [],
    removeFailed: [],
    sweep: null,
    forgotten: [],
    failures: 0,
  };
  if (dryRun) reporter.info("Dry run: nothing will be changed.");

  let engine: ComposeEngine | null = null;
  try {
    engine = ctx.getEngine();
  } catch (err) {
    reporter.warn(
      `${err instanceof Error ? err.message : String(err)} Skipping container teardown; registry records are kept so 'wtc prune' can finish later.`,
    );
  }

  // Worktrees git still lists but wtc cannot manage (locked and missing on
  // disk, or now the main checkout): their stacks and records stay.
  for (const u of ctx.unavailable) {
    const why =
      u.reason === "missing"
        ? "its worktree is locked and missing on disk (unmounted drive?)"
        : "its worktree is now the main checkout";
    result.skipped.push({ path: u.path, reason: why });
    reporter.warn(`Skipping ${u.project}: ${why}.`);
  }

  // 1. Tear down every stack wtc knows about.
  const targets = [
    ...ctx.worktrees.map((w) => ({ project: w.project, index: w.index, path: w.path, orphan: null })),
    ...ctx.orphans.map((o) => ({ project: o.project, index: o.index, path: o.path, orphan: o })),
  ];
  const tornDown = new Set<string>();
  // Orphans whose worktree came back while cleaning (or could not be
  // re-checked): never touched.
  const leftAlone = new Set<string>();
  for (const t of targets) {
    throwIfAborted(io);
    if (!engine) {
      result.stacks.push({ project: t.project, orphan: t.orphan !== null, ok: false, error: "no compose engine" });
      continue;
    }
    if (t.orphan) {
      const why = orphanSkipReason(ctx, t.orphan);
      if (why) {
        leftAlone.add(t.project);
        reporter.warn(`Skipping ${t.project}: ${why}.`);
        continue;
      }
    }
    if (dryRun) {
      reporter.info(`Would stop ${t.project} (down -v --remove-orphans)${t.orphan ? " [removed worktree]" : ""}`);
      result.stacks.push({ project: t.project, orphan: t.orphan !== null, ok: true });
      continue;
    }
    reporter.info(`Stopping ${t.project}...`);
    const outcome = await teardownStack(ctx, engine, t, io);
    result.stacks.push({ project: t.project, orphan: t.orphan !== null, ...outcome });
    if (outcome.ok) {
      tornDown.add(t.project);
    } else {
      reporter.warn(`Could not stop ${t.project}: ${outcome.error}`);
    }
  }

  // 2. Remove worktrees that hold no work of their own.
  if (!options.keepWorktrees) {
    for (const wt of ctx.worktrees) {
      throwIfAborted(io);
      // In a bare-repo layout the main checkout is a linked worktree: it is
      // the env/config source and the user's primary checkout.
      if (samePath(wt.path, ctx.repo.mainRoot)) {
        result.skipped.push({ path: wt.path, reason: "main checkout" });
        reporter.warn(`Skipping removal of the main checkout: ${wt.path}`);
        continue;
      }
      if (isWithin(wt.path, ctx.cwd) || samePath(wt.path, ctx.repo.currentRoot)) {
        result.skipped.push({ path: wt.path, reason: "current worktree" });
        reporter.warn(`Skipping removal of current worktree: ${wt.path}`);
        continue;
      }
      if (wt.locked && !options.force) {
        result.skipped.push({ path: wt.path, reason: "locked" });
        reporter.warn(`Skipping locked worktree ${wt.path} (unlock it, or use --force).`);
        continue;
      }
      let dirty: string[];
      try {
        dirty = unmanagedChanges(getStatusPaths(wt.path), managedPathMatcher(ctx, wt.path, wt.envFiles));
      } catch (err) {
        dirty = [`(git status failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)})`];
      }
      if (dirty.length > 0 && !options.force) {
        const shown = dirty.slice(0, 5).join(", ") + (dirty.length > 5 ? `, … (${dirty.length} total)` : "");
        result.skipped.push({ path: wt.path, reason: `uncommitted changes: ${shown}` });
        reporter.warn(
          `Skipping ${wt.path}: uncommitted changes (${shown}). Commit them, or use --force to discard.`,
        );
        continue;
      }
      const unreachable = unreachableWork(wt);
      if (unreachable && !options.force) {
        result.skipped.push({ path: wt.path, reason: unreachable });
        reporter.warn(`Skipping ${wt.path}: ${unreachable} (or use --force to discard).`);
        continue;
      }
      if (dryRun) {
        reporter.info(`Would remove worktree ${wt.path}`);
        result.removed.push(wt.path);
        continue;
      }
      // --force is needed only because of wtc's own artifacts; a second
      // --force is git's way of removing a locked worktree.
      const force = wt.locked ? ["--force", "--force"] : ["--force"];
      try {
        run("git", ["-C", ctx.repoRoot, "worktree", "remove", ...force, "--", wt.path]);
        result.removed.push(wt.path);
        reporter.success(`Removed worktree ${wt.path}`);
        if (unreachable) reporter.warn(`Discarded with --force: ${unreachable}.`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        result.removeFailed.push({ path: wt.path, reason });
        reporter.warn(`Could not remove ${wt.path}: ${reason}`);
      }
    }
  }

  // 3. Sweep leftovers this checkout owns (and, with --sweep, stale ones
  //    whose worktree directory is gone). A request cancelled during the
  //    last teardown stops here.
  throwIfAborted(io);
  if (engine) {
    result.sweep = sweepStaleResources(engine.cliArgv, ctx.repoName, {
      dryRun,
      reporter,
      runner: options.sweepRunner,
      registryProjects: targets.map((t) => t.project),
      // A dry run's `down -v` above would remove these first.
      skipProjects: [
        ...leftAlone,
        ...ctx.unavailable.map((u) => u.project),
        ...(dryRun ? targets.map((t) => t.project) : []),
      ],
      mainRoot: ctx.repo.mainRoot,
      checkouts: targets.map((t) => t.path),
      sweep: options.sweep === true,
    });
  }

  // 4. Prune git metadata and forget what is gone.
  if (!dryRun) {
    runSafe("git", ["-C", ctx.repoRoot, "worktree", "prune"]);
    const removed = new Set(result.removed);
    const forget = targets.filter(
      (t) => tornDown.has(t.project) && (t.orphan !== null || removed.has(t.path)),
    );
    forgetRecords(ctx.repo.commonDir, forget.map((t) => t.project));
    // A kept worktree keeps its runtime override: its env file still lists it.
    for (const t of forget) removeOverride(overridePath(ctx.repo.commonDir, t.project));
    result.forgotten = forget.map((t) => t.path);
  }

  result.failures = countFailures(result);
  const sweep = result.sweep;
  const swept = sweep
    ? `${sweep.containers.removed.length} container(s), ${sweep.networks.removed.length} network(s), ${sweep.volumes.removed.length} volume(s)`
    : "nothing (no compose engine)";
  const sweepFailed = sweep
    ? sweep.containers.failed.length + sweep.networks.failed.length + sweep.volumes.failed.length
    : 0;
  const kept = sweep ? (options.sweep ? 0 : sweep.stale.length) + sweep.notOwned.length : 0;
  const stopped = result.stacks.filter((s) => s.ok).length;
  const summary =
    `${dryRun ? "Dry run complete" : result.failures > 0 ? "Cleanup finished with failures" : "Cleanup complete"}: ` +
    `${stopped}/${result.stacks.length} stack(s) ${dryRun ? "to stop" : "stopped"}, ` +
    `${result.removed.length} worktree(s) ${dryRun ? "to remove" : "removed"}` +
    (result.skipped.length > 0 ? ` (${result.skipped.length} skipped)` : "") +
    (result.removeFailed.length > 0 ? ` (${result.removeFailed.length} failed)` : "") +
    `, ${dryRun ? "would sweep" : "swept"} ${swept}` +
    (sweepFailed > 0 ? ` (${sweepFailed} failed)` : "") +
    (kept > 0 ? `, ${kept} leftover(s) kept` : "") +
    ".";
  if (result.failures > 0) reporter.warn(summary);
  else reporter.success(summary);

  return result;
}
