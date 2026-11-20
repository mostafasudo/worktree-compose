import fs from "node:fs";
import path from "node:path";
import { CommandError, runAsync } from "../utils/exec.js";
import { composeArgs, composeBin } from "../compose/engine.js";
import {
  composeFileValue,
  composePathSeparator,
  envFileComposeFile,
  envFileValue,
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
import type { RemapTargets } from "../compose/override.js";
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
 * stack's `COMPOSE_FILE` when wtc remaps hardcoded settings at runtime,
 * with the separator it was joined with (both beat a `.env` that says
 * otherwise). Without one, an inherited `COMPOSE_FILE` that wtc wrote (a
 * worktree's `.env` exported by direnv or similar) is removed: it names
 * another stack's files, or an override that is gone.
 */
export function composeEnv(
  project: string,
  allocations: PortAllocation[],
  composeFile: string | null = null,
  commonDir?: string,
): ComposeCallEnv {
  const inherited = process.env[COMPOSE_FILE_VAR];
  const files = composeFile
    ? { [COMPOSE_FILE_VAR]: composeFile, COMPOSE_PATH_SEPARATOR: composePathSeparator() }
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
 * What wtc remaps for a stack run from `dir`, without writing anything: the
 * repository's targets minus what the directory's own compose override sets
 * for a service — or nothing when its `.env` sets `COMPOSE_FILE` or
 * `COMPOSE_PATH_SEPARATOR` (a worktree's unmanaged `.env`, with a custom
 * envFile; the repository's own settings were checked with the context).
 */
export function stackRemap(
  ctx: WtcContext,
  dir: string,
  project: string,
): { targets: RemapTargets | null; warnings: string[] } {
  if (!ctx.remap) return { targets: null, warnings: [] };
  const separator = separatorConflicts(dir);
  if (separator || isUserComposeFile(envFileComposeFile(path.join(dir, ".env")), ctx.repo.commonDir)) {
    return {
      targets: null,
      warnings: [
        `${project}: its .env sets ${separator ? "COMPOSE_PATH_SEPARATOR" : "COMPOSE_FILE"}, so wtc does not remap hardcoded ports or container_name for it.`,
      ],
    };
  }
  const { targets, warnings } = withoutUserOverride(ctx.remap, dir);
  return { targets: remapIsEmpty(targets) ? null : targets, warnings };
}

/** Whether `dir`'s `.env` sets a `COMPOSE_PATH_SEPARATOR` that would split wtc's list differently. */
function separatorConflicts(dir: string): boolean {
  const separator = envFileValue(path.join(dir, ".env"), "COMPOSE_PATH_SEPARATOR");
  return !!separator && separator !== composePathSeparator();
}

/** Host ports a stack keeps as written: hardcoded ones wtc does not move, ranges whole. */
function keptHostPorts(mappings: PortMapping[], moving: PortMapping[]): [number, number][] {
  const moved = new Set(moving);
  return mappings
    .filter((m) => m.envVar === null && !moved.has(m))
    .map((m): [number, number] => [m.defaultPort, m.rangeEnd ?? m.defaultPort]);
}

/**
 * The stack's ports: every variable, plus each hardcoded port in `targets`
 * that can move in this worktree to a port the stack does not already
 * publish (a hardcoded port it keeps, or one inside a range). Returns the
 * targets actually remapped and a warning for each port left as it is.
 */
export function stackAllocations(
  ctx: WtcContext,
  index: number,
  targets: RemapTargets | null,
): { allocations: PortAllocation[]; targets: RemapTargets | null; warnings: string[] } {
  if (!targets) {
    return { allocations: allocateWorktreePorts(ctx.portMappings, index, ctx.portStride), targets: null, warnings: [] };
  }
  const allocations = allocateWorktreePorts(ctx.portMappings, index, ctx.portStride, targets.ports);
  const stays = new Map<number, string>();
  // A port that stays is one the stack keeps, which can block another
  // port's move in turn: repeat until nothing more has to stay.
  for (let moving = targets.ports, changed = true; changed; moving = moving.filter((m) => !stays.has(m.defaultPort))) {
    changed = false;
    const kept = keptHostPorts(ctx.portMappings, moving);
    for (const m of moving) {
      if (stays.has(m.defaultPort)) continue;
      const a = allocations.find((x) => x.defaultPort === m.defaultPort);
      if (!a) {
        stays.set(
          m.defaultPort,
          `Service "${m.serviceName}": hardcoded host port ${m.defaultPort} has no free port to move to in worktree ${index} (ports end at 65535), so it stays ${m.defaultPort}.`,
        );
        changed = true;
      } else if (kept.some(([from, to]) => a.port >= from && a.port <= to)) {
        // Also when the port is a variable's (same default port, e.g. tcp
        // and udp): the hardcoded entry would publish it a second time.
        stays.set(
          m.defaultPort,
          `Service "${m.serviceName}": hardcoded host port ${m.defaultPort} would move to ${a.port}, which this stack already publishes, so it stays ${m.defaultPort}.`,
        );
        changed = true;
      }
    }
  }
  if (stays.size === 0) return { allocations, targets, warnings: [] };
  const remaining = { ...targets, ports: targets.ports.filter((m) => !stays.has(m.defaultPort)) };
  return {
    allocations: allocations.filter((a) => a.envVar !== null || !stays.has(a.defaultPort)),
    targets: remapIsEmpty(remaining) ? null : remaining,
    warnings: [...stays.values()],
  };
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
  const filesWith = (override: string): string | null => {
    const userOverride = findUserOverride(target.dir);
    return composeFileValue([
      path.join(target.dir, path.basename(ctx.composeFile.composePath)),
      ...(userOverride ? [userOverride] : []),
      override,
    ]);
  };
  const remap = stackRemap(ctx, target.dir, target.project);
  const stack = stackAllocations(ctx, target.index, remap.targets);
  const warnings = [...remap.warnings, ...stack.warnings];

  if (!opts.write && fs.existsSync(file)) {
    const composeFile = filesWith(file);
    if (composeFile !== null) return { allocations: stack.allocations, composeFile, warnings: [] };
  }
  if (!stack.targets) return { allocations: stack.allocations, composeFile: null, warnings };

  const composeFile = filesWith(file);
  if (composeFile === null) {
    return {
      allocations: allocateWorktreePorts(ctx.portMappings, target.index, ctx.portStride),
      composeFile: null,
      warnings: [
        ...warnings,
        `A path of ${target.project}'s compose files contains the COMPOSE_FILE separator, so wtc does not remap hardcoded ports or container_name for it.`,
      ],
    };
  }
  // `stop`/teardown of a stack started before wtc remapped (or whose file
  // was deleted) recreate it.
  if (opts.write || !fs.existsSync(file)) {
    writeOverride(file, renderOverride(target.project, ctx.composeFile, stack.targets, stack.allocations));
  }
  return { allocations: stack.allocations, composeFile, warnings };
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
