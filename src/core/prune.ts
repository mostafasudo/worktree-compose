import { buildContext } from "../context.js";
import { runSafe } from "../utils/exec.js";
import { forgetRecords } from "../state/registry.js";
import { overridePath, removeOverride } from "../compose/override.js";
import { reportContextWarnings, throwIfAborted } from "./compose.js";
import { orphanSkipReason, teardownStack } from "./teardown.js";
import type { Reporter } from "../utils/log.js";
import type { CoreIo } from "./types.js";

export interface PruneOptions {
  /** Report what would be pruned; change nothing — not even the registry. */
  dryRun?: boolean;
}

export interface PruneResult {
  dryRun: boolean;
  orphans: { index: number; branch: string; path: string; project: string; ok: boolean; error?: string }[];
  /** Orphans left alone because their worktree is live again. */
  skipped: { project: string; path: string; reason: string }[];
  /** Missing-on-disk worktrees whose git metadata was pruned. */
  gitPruned: string[];
  /** Orphaned stacks that could not be torn down (non-zero → exit 1 / MCP isError). */
  failures: number;
}

/**
 * Tear down and forget orphans only: stacks of worktrees deleted with plain
 * `git worktree remove` / `rm -rf`. Live worktrees are not touched.
 */
export async function prune(
  options: PruneOptions,
  reporter: Reporter,
  io: CoreIo,
): Promise<PruneResult> {
  const dryRun = options.dryRun === true;
  // resolveRemap: tear stacks down with the compose files they were started with.
  const ctx = buildContext({}, { cwd: io.cwd, allowMissingCompose: true, readOnly: dryRun, resolveRemap: !dryRun });
  reportContextWarnings(ctx, reporter, { isolation: false });
  const result: PruneResult = { dryRun, orphans: [], skipped: [], gitPruned: [], failures: 0 };

  if (ctx.orphans.length === 0 && ctx.prunable.length === 0) {
    reporter.info("Nothing to prune: every recorded worktree still exists.");
    return result;
  }

  const engine = ctx.orphans.length > 0 ? ctx.getEngine() : null;
  const forget: string[] = [];
  for (const o of ctx.orphans) {
    throwIfAborted(io);
    const entry = { index: o.index, branch: o.branch, path: o.path, project: o.project };
    // Never `down -v` a stack whose worktree is live again (re-checked now,
    // not from the snapshot: the previous teardown may have taken a while).
    const why = orphanSkipReason(ctx, o);
    if (why) {
      result.skipped.push({ project: o.project, path: o.path, reason: why });
      reporter.warn(`Skipping ${o.project}: ${why}.`);
      continue;
    }
    if (dryRun) {
      reporter.info(`Would stop ${o.project} and forget worktree ${o.index} (${o.path})`);
      result.orphans.push({ ...entry, ok: true });
      continue;
    }
    reporter.info(`Stopping ${o.project} (worktree ${o.index} was removed)...`);
    const outcome = await teardownStack(ctx, engine!, o, io);
    result.orphans.push({ ...entry, ...outcome });
    if (outcome.ok) {
      forget.push(o.project);
      reporter.success(`Pruned worktree ${o.index} (${o.branch})`);
    } else {
      reporter.warn(`Could not stop ${o.project}: ${outcome.error}`);
    }
  }

  for (const wt of ctx.prunable) {
    if (dryRun) {
      reporter.info(`Would prune git metadata for missing worktree ${wt.path}`);
    }
    result.gitPruned.push(wt.path);
  }

  if (!dryRun) {
    if (ctx.prunable.length > 0) {
      runSafe("git", ["-C", ctx.repoRoot, "worktree", "prune"]);
    }
    forgetRecords(ctx.repo.commonDir, forget);
    for (const project of forget) removeOverride(overridePath(ctx.repo.commonDir, project));
  }

  const failed = result.orphans.filter((o) => !o.ok).length;
  result.failures = dryRun ? 0 : failed;
  const summary =
    `${dryRun ? "Dry run complete" : failed > 0 ? "Prune finished with failures" : "Prune complete"}: ` +
    `${result.orphans.length - failed} orphaned stack(s) ${dryRun ? "to remove" : "removed"}` +
    (failed > 0 ? `, ${failed} failed` : "") +
    (result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : "") +
    (result.gitPruned.length > 0
      ? `, ${result.gitPruned.length} missing worktree(s) ${dryRun ? "to prune" : "pruned"} from git`
      : "") +
    ".";
  if (failed > 0) reporter.warn(summary);
  else reporter.success(summary);
  return result;
}
