import path from "node:path";
import { getRepoRoot, getRepoName, detectComposeFile } from "./compose/detect.js";
import { parseComposeFile } from "./compose/parse.js";
import { extractPortMappings } from "./ports/extract.js";
import {
  detectCrossWorktreeCollisions,
  recommendPortStride,
} from "./ports/allocate.js";
import type { PortCollision } from "./ports/allocate.js";
import { loadConfig } from "./config.js";
import { getNonMainWorktrees } from "./git/worktree.js";
import { resolveWorkspaces } from "./workspaces/resolve.js";
import { DEFAULT_ENV_FILE } from "./sync/env.js";
import * as log from "./utils/log.js";
import type { ComposeFile } from "./compose/types.js";
import type { PortMapping } from "./ports/types.js";
import type { WtcConfig } from "./config.js";
import type { WorktreeInfo } from "./git/worktree.js";
import type { EnvTarget } from "./sync/env.js";
import type { WorkspaceInfo } from "./workspaces/resolve.js";

/** One-run CLI overrides for env handling. Values fall back to `.wtcrc.json`. */
export interface EnvCliOptions {
  /** Env filename to copy and inject (`--env`). */
  envFile?: string;
  /** Workspaces to also inject env into (`--workspace`, repeatable). */
  workspaces?: string[];
}

export interface WtcContext {
  repoRoot: string;
  repoName: string;
  composeFile: ComposeFile;
  portMappings: PortMapping[];
  config: WtcConfig;
  portStride: number;
  worktrees: WorktreeInfo[];
}

export function buildContext(cli: EnvCliOptions = {}): WtcContext {
  const repoRoot = getRepoRoot();
  const repoName = getRepoName(repoRoot);

  const composePath = detectComposeFile(repoRoot);
  if (!composePath) {
    throw new Error(
      `No compose file found in ${repoRoot}. Expected one of: compose.yaml, compose.yml, docker-compose.yaml, docker-compose.yml`,
    );
  }

  const composeFile = parseComposeFile(composePath);
  const portMappings = extractPortMappings(composeFile.services);
  const config = resolveConfig(loadConfig(repoRoot), cli);
  const portStride = config.portStride ?? 1;
  if (!Number.isInteger(portStride) || portStride < 1) {
    throw new Error(
      `Invalid "portStride": ${String(portStride)}. Expected a positive integer.`,
    );
  }
  const worktrees = getNonMainWorktrees(repoRoot);

  warnOnPortCollisions(portMappings, portStride, worktrees.length);

  return {
    repoRoot,
    repoName,
    composeFile,
    portMappings,
    config,
    portStride,
    worktrees,
  };
}

/** Merge CLI overrides over the loaded config and validate the env settings. */
function resolveConfig(config: WtcConfig, cli: EnvCliOptions): WtcConfig {
  const envFile = cli.envFile ?? config.envFile ?? DEFAULT_ENV_FILE;
  validateEnvFileName(envFile);

  const workspaces =
    cli.workspaces && cli.workspaces.length > 0
      ? cli.workspaces
      : (config.workspaces ?? []);
  if (
    !Array.isArray(workspaces) ||
    workspaces.some((w) => typeof w !== "string" || w.trim() === "")
  ) {
    throw new Error(
      `Invalid "workspaces" config: expected an array of workspace names.`,
    );
  }

  validateOverrides("envOverrides", config.envOverrides);
  if (config.workspaceEnvOverrides !== undefined) {
    const map = config.workspaceEnvOverrides;
    if (typeof map !== "object" || map === null || Array.isArray(map)) {
      throw new Error(
        `Invalid "workspaceEnvOverrides" config: expected an object of workspace -> overrides.`,
      );
    }
    for (const [name, overrides] of Object.entries(map)) {
      validateOverrides(`workspaceEnvOverrides.${name}`, overrides);
    }
  }

  return { ...config, envFile, workspaces };
}

function validateEnvFileName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    path.isAbsolute(name)
  ) {
    throw new Error(
      `Invalid env file name "${name}". Expected a bare filename such as ".env" or ".env.development".`,
    );
  }
}

function validateOverrides(
  label: string,
  overrides: unknown,
): void {
  if (overrides === undefined) return;
  if (
    typeof overrides !== "object" ||
    overrides === null ||
    Array.isArray(overrides)
  ) {
    throw new Error(
      `Invalid "${label}" config: expected an object of VAR -> value.`,
    );
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string") {
      throw new Error(
        `Invalid "${label}.${key}": expected a string value (got ${typeof value}).`,
      );
    }
  }
}

/**
 * Env targets for a run: the repo root always, plus every selected workspace.
 * Workspace targets are additive — the root env file is what docker compose
 * interpolates port values from, so it must never be skipped.
 */
export function getEnvTargets(ctx: WtcContext): EnvTarget[] {
  const envFileName = ctx.config.envFile ?? DEFAULT_ENV_FILE;

  const targets: EnvTarget[] = [
    {
      dir: "",
      label: "root",
      envFileName,
      overrides: ctx.config.envOverrides,
    },
  ];

  const workspaces = resolveWorkspaces(
    ctx.repoRoot,
    ctx.config.workspaces ?? [],
  );
  for (const ws of workspaces) {
    targets.push({
      dir: ws.dir,
      label: `workspace ${ws.name} (${ws.dir})`,
      envFileName,
      overrides: findWorkspaceOverrides(ctx.config.workspaceEnvOverrides, ws),
    });
  }

  return targets;
}

/**
 * Look up a workspace's overrides by package name, then directory basename,
 * then repo-relative path.
 */
function findWorkspaceOverrides(
  map: Record<string, Record<string, string>> | undefined,
  ws: WorkspaceInfo,
): Record<string, string> | undefined {
  if (!map) return undefined;

  for (const key of [
    ws.name,
    path.posix.basename(ws.dir),
    ws.dir,
    `./${ws.dir}`,
  ]) {
    const overrides = map[key];
    if (overrides && typeof overrides === "object") return overrides;
  }

  return undefined;
}

function warnOnPortCollisions(
  portMappings: PortMapping[],
  portStride: number,
  worktreeCount: number,
): void {
  if (worktreeCount < 2) return;

  // Collision detection is advisory; an allocation failure here must never
  // abort the command that triggered the warning.
  let collisions: PortCollision[];
  try {
    collisions = detectCrossWorktreeCollisions(
      portMappings,
      portStride,
      worktreeCount,
    );
  } catch {
    return;
  }
  if (collisions.length === 0) return;

  const examples = collisions
    .slice(0, 3)
    .map(
      (c) =>
        `${c.port} (wt${c.a.worktreeIndex}/${c.a.serviceName} ↔ wt${c.b.worktreeIndex}/${c.b.serviceName})`,
    )
    .join(", ");
  const recommended = recommendPortStride(portMappings, worktreeCount);
  const fix =
    recommended > 0
      ? `Set "portStride": ${recommended} in .wtcrc.json (or package.json#wtc) to resolve.`
      : `No single portStride resolves this — check for services sharing the same default port.`;

  log.warn(
    `Cross-worktree port collisions detected with portStride=${portStride} ` +
      `across ${worktreeCount} worktrees: ${collisions.length} collision(s), e.g. ${examples}. ${fix}`,
  );
}

export function filterWorktrees(
  worktrees: WorktreeInfo[],
  indices: number[],
): WorktreeInfo[] {
  if (indices.length === 0) return worktrees;
  return indices
    .map((i) => {
      const wt = worktrees[i - 1];
      if (!wt) throw new Error(`Worktree index ${i} not found. Run 'wtc list' to see available worktrees.`);
      return wt;
    });
}
