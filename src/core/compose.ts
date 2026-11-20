import fs from "node:fs";
import path from "node:path";
import { CommandError, runAsync } from "../utils/exec.js";
import { composeArgs, composeBin } from "../compose/engine.js";
import {
  composeFileValue,
  envFileComposeFile,
  findUserOverride,
  isUserComposeFile,
  isWtcComposeFile,
  overridePath,
  remapIsEmpty,
  renderOverride,
  withoutUserOverride,
  writeOverride,
} from "../compose/override.js";
import { allocateWorktreePorts, allocationEnv } from "../ports/allocate.js";
import { COMPOSE_FILE_VAR, PROJECT_NAME_VAR } from "../sync/env.js";
import type { RunResult } from "../utils/exec.js";
import type { ComposeEngine } from "../compose/engine.js";
import type { PortAllocation, PortMapping } from "../ports/types.js";
import type { Reporter } from "../utils/log.js";
import type { WtcContext } from "../context.js";
import type { CoreIo } from "./types.js";

/** Variables for a compose call, over the process environment; `undefined` removes one. */
export type ComposeCallEnv = Record<string, string | undefined>;

/**
 * Process environment for a compose call on a worktree stack: the project
 * name plus every allocated port, so `${VAR}` interpolation resolves to the
 * worktree's ports no matter which env filename is configured — and the
 * stack's `COMPOSE_FILE` when wtc remaps hardcoded settings at runtime.
 * Without one, an inherited `COMPOSE_FILE` that wtc wrote (a worktree's
 * `.env` exported by direnv or similar) is removed: it names another
 * stack's files, or an override that is gone.
 */
export function composeEnv(
  project: string,
  allocations: PortAllocation[],
  composeFile: string | null = null,
  commonDir?: string,
): ComposeCallEnv {
  const inherited = process.env[COMPOSE_FILE_VAR];
  const files = composeFile
    ? { [COMPOSE_FILE_VAR]: composeFile }
    : commonDir && inherited && isWtcComposeFile(inherited, commonDir)
      ? { [COMPOSE_FILE_VAR]: undefined }
      : {};
  return { [PROJECT_NAME_VAR]: project, ...allocationEnv(allocations), ...files };
}

export interface StackTarget {
  project: string;
  index: number;
  /** Directory compose runs in: the worktree, or the main checkout for an orphan. */
  dir: string;
}

export interface PreparedStack {
  /** The stack's ports, remapped hardcoded ones included. */
  allocations: PortAllocation[];
  /** `COMPOSE_FILE` for the stack's compose calls when wtc's override applies, else null. */
  composeFile: string | null;
  /** Hardcoded settings left as they are in this directory, and why. */
  warnings: string[];
}

/**
 * Ports and compose files for one stack: the `COMPOSE_FILE` list compose
 * would otherwise pick by itself — the compose file, the directory's own
 * compose override if any — followed by wtc's override (see
 * compose/override.ts), or null without one.
 *
 * `start` (`write`) writes the override, after syncing the worktree's
 * compose file from main. `stop` and teardown use the override the stack
 * was started with as it is: rewriting it from main's current compose file
 * could name services the worktree's (older) compose file does not have,
 * which the `COMPOSE_FILE` in the worktree's env file also loads.
 */
export function prepareStack(ctx: WtcContext, target: StackTarget, opts: { write: boolean }): PreparedStack {
  const file = overridePath(ctx.repo.commonDir, target.project);
  const plain = (warnings: string[]): PreparedStack => ({
    allocations: allocateWorktreePorts(ctx.portMappings, target.index, ctx.portStride),
    composeFile: null,
    warnings,
  });
  const filesWith = (override: string): string | null => {
    const userOverride = findUserOverride(target.dir);
    return composeFileValue([
      path.join(target.dir, path.basename(ctx.composeFile.composePath)),
      ...(userOverride ? [userOverride] : []),
      override,
    ]);
  };

  if (!opts.write && fs.existsSync(file)) {
    const composeFile = filesWith(file);
    if (composeFile !== null) {
      return {
        allocations: allocateWorktreePorts(ctx.portMappings, target.index, ctx.portStride, ctx.remap?.ports),
        composeFile,
        warnings: [],
      };
    }
  }
  if (!ctx.remap) return plain([]);

  // The repository's own COMPOSE_FILE settings were checked with the
  // context; a worktree's unmanaged `.env` (custom envFile) may have one.
  if (isUserComposeFile(envFileComposeFile(path.join(target.dir, ".env")), ctx.repo.commonDir)) {
    return plain([
      `${target.project}: its .env sets COMPOSE_FILE, so wtc does not remap hardcoded ports or container_name for it.`,
    ]);
  }
  const { targets, warnings } = withoutUserOverride(ctx.remap, target.dir);
  if (remapIsEmpty(targets)) return plain(warnings);

  const composeFile = filesWith(file);
  if (composeFile === null) {
    return plain([
      ...warnings,
      `A path of ${target.project}'s compose files contains the COMPOSE_FILE separator, so wtc does not remap hardcoded ports or container_name for it.`,
    ]);
  }
  const allocations = allocateWorktreePorts(ctx.portMappings, target.index, ctx.portStride, targets.ports);
  const stuck = new Map<number, PortMapping>();
  for (const m of targets.ports) {
    if (!allocations.some((a) => a.defaultPort === m.defaultPort)) stuck.set(m.defaultPort, m);
  }
  for (const m of stuck.values()) {
    warnings.push(
      `Service "${m.serviceName}": hardcoded host port ${m.defaultPort} has no free port to move to in worktree ${target.index} (ports end at 65535), so it stays ${m.defaultPort}.`,
    );
  }
  if (opts.write) {
    writeOverride(file, renderOverride(target.project, ctx.composeFile, targets, allocations));
  } else if (!fs.existsSync(file)) {
    // Started before wtc remapped (or the file was deleted): recreate it.
    writeOverride(file, renderOverride(target.project, ctx.composeFile, targets, allocations));
  }
  return { allocations, composeFile, warnings };
}

export interface ComposeCallOptions {
  cwd: string;
  env?: ComposeCallEnv;
  live: boolean;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

/** Run `<compose> -p <project> <args…>` without blocking the event loop. */
export function composeRun(
  engine: ComposeEngine,
  project: string,
  args: string[],
  opts: ComposeCallOptions,
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return runAsync(composeBin(engine), composeArgs(engine, project, ...args), {
    cwd: opts.cwd,
    env,
    live: opts.live,
    signal: opts.signal,
    onLine: opts.onLine,
  });
}

/** Prefix an error with what was being done, keeping CommandError details. */
export function withContext(prefix: string, err: unknown): Error {
  if (err instanceof CommandError) {
    err.message = `${prefix}: ${err.message}`;
    return err;
  }
  return new Error(`${prefix}: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Report a context's general warnings (and, when asked, its isolation
 * warnings plus what runtime remapping does).
 */
export function reportContextWarnings(
  ctx: WtcContext,
  reporter: Reporter,
  opts: { isolation: boolean },
): void {
  for (const w of ctx.warnings) reporter.warn(w);
  if (opts.isolation) {
    for (const w of ctx.isolationWarnings) reporter.warn(w);
    for (const n of ctx.remapNotes) reporter.info(n);
  }
}

/** Throw if the operation was cancelled (checked between worktrees). */
export function throwIfAborted(io: CoreIo): void {
  if (io.signal?.aborted) throw new Error("Cancelled.");
}

export const NO_WORKTREES_HINT =
  "No extra worktrees found. Create one with:\n  git worktree add ../my-branch my-branch";
