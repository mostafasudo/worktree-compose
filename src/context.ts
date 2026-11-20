import path from "node:path";
import { detectComposeFile } from "./compose/detect.js";
import { parseComposeFile } from "./compose/parse.js";
import { resolveEngine } from "./compose/engine.js";
import { createStackProbe } from "./compose/status.js";
import {
  composeIsolationWarnings,
  portCollisionWarnings,
  rawPortWarnings,
  remapNotes,
} from "./compose/isolation.js";
import { decideRemap } from "./compose/override.js";
import { extractPortMappings } from "./ports/extract.js";
import { loadConfig } from "./config.js";
import { assertMainCheckout, getRepoInfo, listRepoWorktrees } from "./git/repo.js";
import { isCandidate, samePath } from "./git/worktree.js";
import { hasRecord, peekState, reconcileWorktrees } from "./state/registry.js";
import { escapeRegExp, sanitize } from "./utils/sanitize.js";
import { resolveWorkspaces } from "./workspaces/resolve.js";
import { resolveSyncEntries } from "./sync/files.js";
import { DEFAULT_ENV_FILE, findEnvSource } from "./sync/env.js";
import type { ComposeEngine } from "./compose/engine.js";
import type { RemapDecision, RemapTargets } from "./compose/override.js";
import type { PsContainer, StackProbe } from "./compose/status.js";
import type { ComposeFile } from "./compose/types.js";
import type { PortMapping } from "./ports/types.js";
import type { WtcConfig } from "./config.js";
import type { RepoInfo } from "./git/repo.js";
import type { WorktreeInfo } from "./git/worktree.js";
import type {
  AdoptableStack,
  ResolvedWorktree,
  UnavailableRecord,
  WorktreeRecord,
} from "./state/registry.js";
import type { EnvTarget } from "./sync/env.js";
import type { WorkspaceInfo } from "./workspaces/resolve.js";

/** One-run CLI overrides for env handling. Values fall back to `.wtcrc.json`. */
export interface EnvCliOptions {
  /** Env filename to copy and inject (`--env`). */
  envFile?: string;
  /** Workspaces to also inject env into (`--workspace`, repeatable). */
  workspaces?: string[];
}

export interface BuildContextOptions {
  /** Directory wtc runs from (defaults to `process.cwd()`). */
  cwd?: string;
  /**
   * Resolve the compose engine and probe stack states (status display). A
   * worktree seen for the first time may then adopt the identity of a
   * stack already running from it, and an empty registry is persisted —
   * without a probe it is only computed (see ReconcileOptions.adoptable).
   */
  probeStacks?: boolean;
  /**
   * Compute identities without side effects (`--dry-run`): never write the
   * registry, create worktree ids, or move a corrupt registry aside.
   */
  readOnly?: boolean;
  /** Tolerate a main checkout without a compose file (promote, clean). */
  allowMissingCompose?: boolean;
  /**
   * The command syncs files into, starts, or removes other checkouts: refuse
   * (naming this action) when the main checkout cannot be located, instead
   * of treating the current checkout as the main one.
   */
  requireMainFor?: string;
  /**
   * Decide runtime remapping of hardcoded ports and container_name (see
   * compose/override.ts), which may probe the engine. Implied by
   * `probeStacks`; set it for other commands that run compose on stacks.
   */
  resolveRemap?: boolean;
}

export interface WtcContext {
  repo: RepoInfo;
  /** The MAIN worktree — source of compose, config and env files. */
  repoRoot: string;
  repoName: string;
  cwd: string;
  composeFile: ComposeFile;
  /** False only with `allowMissingCompose` when no compose file exists. */
  hasComposeFile: boolean;
  portMappings: PortMapping[];
  config: WtcConfig;
  portStride: number;
  /** Live linked worktrees with their persistent index/project, in git order. */
  worktrees: ResolvedWorktree[];
  /** Registry records whose worktree is gone (stack may still exist). */
  orphans: WorktreeRecord[];
  /**
   * Records of worktrees git still lists but wtc cannot start (locked and
   * missing on disk, or now the main checkout): their stacks are left alone.
   */
  unavailable: UnavailableRecord[];
  /** Worktrees git still lists but whose directory is missing. */
  prunable: WorktreeInfo[];
  /** General warnings (missing worktrees, registry problems, skipped sync entries). */
  warnings: string[];
  /** Settings that break isolation between worktree stacks. */
  isolationWarnings: string[];
  /**
   * Hardcoded host ports and fixed container names wtc remaps at runtime
   * (only with `probeStacks` / `resolveRemap`); null when there are none or
   * the engine cannot (the reason is among the isolation warnings).
   */
  remap: RemapTargets | null;
  /** What runtime remapping does, for `wtc start` (informational). */
  remapNotes: string[];
  /** Stack states (only with `probeStacks`). */
  stacks: StackProbe | null;
  /** Resolve the compose engine (lazily; throws when none is available). */
  getEngine(): ComposeEngine;
}

function emptyComposeFile(composePath: string): ComposeFile {
  return {
    services: [],
    composePath,
    sourceFiles: [],
    sharedVolumes: [],
    sharedNetworks: [],
  };
}

/** Characters compose allows in a project name. */
const COMPOSE_PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Identities of running stacks that worktrees may adopt, keyed by worktree
 * path: compose projects named like this repository's worktree stacks
 * (`<repo>-wt-<n>-…`) whose `working_dir` label is one of `worktrees`.
 * Compose records the directory it ran in, so a registry that was lost,
 * corrupted, or never written (0.2) is rebuilt from the stacks themselves
 * instead of renumbering them. One-off `compose run` containers are
 * ignored; when several projects ran from one worktree, the one with the
 * most running (then total) containers, then the lowest index, wins.
 */
export function adoptableStacks(
  containers: PsContainer[],
  repoName: string,
  worktrees: WorktreeInfo[],
): Map<string, AdoptableStack> {
  const prefix = sanitize(repoName);
  const pattern = new RegExp(`^${prefix ? `${escapeRegExp(prefix)}-` : ""}wt-(\\d+)-`);
  const stacks = new Map<string, AdoptableStack & { path: string; running: number; total: number }>();
  for (const c of containers) {
    if (!c.project || !c.workingDir || c.oneoff) continue;
    // Only a name compose accepts may become a record's project: a label
    // that could not be parsed cleanly must never be persisted.
    if (!COMPOSE_PROJECT_NAME.test(c.project)) continue;
    const m = pattern.exec(c.project);
    if (!m) continue;
    const wt = worktrees.find((w) => samePath(w.path, c.workingDir!));
    if (!wt) continue;
    const stack = stacks.get(c.project) ?? {
      index: Number(m[1]),
      project: c.project,
      path: path.resolve(wt.path),
      running: 0,
      total: 0,
    };
    stack.total++;
    if (c.running) stack.running++;
    stacks.set(c.project, stack);
  }

  const best = new Map<string, AdoptableStack>();
  const ranked = [...stacks.values()].sort(
    (a, b) => b.running - a.running || b.total - a.total || a.index - b.index,
  );
  for (const s of ranked) {
    if (s.index > 0 && !best.has(s.path)) best.set(s.path, { index: s.index, project: s.project });
  }
  return best;
}

/**
 * What worktrees seen for the first time may adopt — computed before the
 * registry lock is taken: a slow engine must never hold the lock other wtc
 * processes wait on. `undefined` when the engine is unavailable (no probe).
 */
function stacksToAdopt(
  stacks: StackProbe,
  repo: RepoInfo,
  listWorktrees: () => WorktreeInfo[],
): Map<string, AdoptableStack> | undefined {
  const recorded = peekState(repo.commonDir);
  const unrecorded = listWorktrees().filter((wt) => isCandidate(wt) && !hasRecord(recorded, wt));
  // Every live worktree has a record: nothing to adopt, no `ps` needed.
  if (unrecorded.length === 0) return new Map();
  if (stacks.problem !== null) return undefined;
  const containers = stacks.containers();
  // Unparseable `ps` (per-project fallback): the engine answers, but no labels to adopt from.
  return containers ? adoptableStacks(containers, repo.repoName, unrecorded) : new Map();
}

export function buildContext(
  cli: EnvCliOptions = {},
  opts: BuildContextOptions = {},
): WtcContext {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const repo = getRepoInfo(cwd);
  if (opts.requireMainFor) assertMainCheckout(repo, opts.requireMainFor);
  const repoRoot = repo.mainRoot;
  const warnings: string[] = [...repo.warnings];

  const composePath = detectComposeFile(repoRoot);
  if (!composePath && !opts.allowMissingCompose) {
    throw new Error(
      `No compose file found in ${repoRoot}. Expected one of: compose.yaml, compose.yml, docker-compose.yaml, docker-compose.yml`,
    );
  }
  const composeFile = composePath
    ? parseComposeFile(composePath)
    : emptyComposeFile(path.join(repoRoot, "compose.yaml"));
  const portMappings = extractPortMappings(composeFile.services);
  const config = resolveConfig(loadConfig(repoRoot), cli);
  const portStride = config.portStride ?? 1;
  if (!Number.isInteger(portStride) || portStride < 1) {
    throw new Error(
      `Invalid "portStride": ${String(portStride)}. Expected a positive integer.`,
    );
  }
  warnings.push(...resolveSyncEntries(repoRoot, config.sync).warnings);

  let engine: ComposeEngine | null = null;
  const getEngine = (): ComposeEngine => {
    engine ??= resolveEngine(config);
    return engine;
  };

  let stacks: StackProbe | null = null;
  if (opts.probeStacks) {
    let problem: string | null = null;
    try {
      getEngine();
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    stacks = createStackProbe(engine, problem, repoRoot);
  }

  const listWorktrees = () => listRepoWorktrees(repo);
  const reconciled = reconcileWorktrees({
    commonDir: repo.commonDir,
    repoName: repo.repoName,
    listWorktrees,
    adoptable: stacks ? stacksToAdopt(stacks, repo, listWorktrees) : undefined,
    // Without the main checkout identities are only computed: a stand-in
    // main (and the repo name derived from it) must never be persisted.
    readOnly: opts.readOnly || repo.mainRootIsFallback,
    mainCheckout: repo.recordMain ? repo.mainRoot : undefined,
  });
  warnings.push(...reconciled.warnings);

  const all = reconciled.listed;
  const prunable = all.filter((wt) => !wt.isMain && wt.prunable);
  for (const wt of prunable) {
    warnings.push(
      `Worktree ${wt.path} is missing on disk — run 'git worktree prune'.`,
    );
  }
  for (const wt of all.filter((w) => !w.isMain && w.missing)) {
    const held = reconciled.unavailable.find((u) => u.reason === "missing" && samePath(u.path, wt.path));
    warnings.push(
      `Worktree ${wt.path} is locked but missing on disk (unmounted drive?) — skipped` +
        (held ? `; its index ${held.index} and stack ${held.project} are kept until it is back.` : "."),
    );
  }
  for (const u of reconciled.unavailable.filter((r) => r.reason === "main")) {
    warnings.push(
      `The main checkout ${u.path} was worktree ${u.index} (${u.project}) before it became the main checkout; ` +
        `wtc leaves that stack alone (stop or remove it yourself if you no longer need it).`,
    );
  }

  const decision: RemapDecision =
    opts.probeStacks || opts.resolveRemap
      ? decideRemap({
          composeFile,
          mappings: portMappings,
          mainRoot: repoRoot,
          commonDir: repo.commonDir,
          envFiles: [
            findEnvSource(repoRoot, { dir: "", label: "root", envFileName: config.envFile ?? DEFAULT_ENV_FILE }),
            path.join(repoRoot, DEFAULT_ENV_FILE),
          ],
          envOverrides: config.envOverrides,
          engine: getEngine,
        })
      : { targets: null, problem: null, warnings: [] };
  const remap = decision.targets;
  const remapped = remap?.ports ?? [];

  const isolationWarnings = [
    ...(decision.problem ? [decision.problem] : []),
    ...decision.warnings,
    ...rawPortWarnings(portMappings, remapped),
    ...composeIsolationWarnings(composeFile, new Set(remap?.containerNames.map((c) => c.service))),
    ...portCollisionWarnings(
      portMappings,
      portStride,
      [
        ...reconciled.worktrees.map((w) => w.index),
        ...reconciled.orphans.map((o) => o.index),
        ...reconciled.unavailable.map((u) => u.index),
      ],
      remapped,
    ),
  ];

  return {
    repo,
    repoRoot,
    repoName: repo.repoName,
    cwd,
    composeFile,
    hasComposeFile: composePath !== null,
    portMappings,
    config,
    portStride,
    worktrees: reconciled.worktrees,
    orphans: reconciled.orphans,
    unavailable: reconciled.unavailable,
    prunable,
    warnings,
    isolationWarnings,
    remap,
    remapNotes: remap ? remapNotes(remap, portMappings) : [],
    stacks,
    getEngine,
  };
}

/** Merge CLI overrides over the loaded config and validate it. */
export function resolveConfig(config: WtcConfig, cli: EnvCliOptions): WtcConfig {
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

  if (
    config.sync !== undefined &&
    (!Array.isArray(config.sync) ||
      config.sync.some((s) => typeof s !== "string" || s.trim() === ""))
  ) {
    throw new Error(
      `Invalid "sync" config: expected an array of repo-relative paths.`,
    );
  }

  const cmd = config.composeCommand;
  if (
    cmd !== undefined &&
    !(typeof cmd === "string" && cmd.trim() !== "") &&
    !(
      Array.isArray(cmd) &&
      cmd.length > 0 &&
      cmd.every((c) => typeof c === "string" && c.trim() !== "")
    )
  ) {
    throw new Error(
      `Invalid "composeCommand" config: expected a command string such as "podman compose" or an array such as ["docker-compose"].`,
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
      overrides: findWorkspaceOverrides(
        ctx.config.workspaceEnvOverrides,
        ws,
        workspaces,
      ),
    });
  }

  return targets;
}

/**
 * Validate env-related CLI options up front: build the context and resolve
 * its env targets, which throws for invalid env file names, malformed
 * config, and unknown workspace selectors. Restart paths call this before
 * stopping any worktree, so bad options never leave things stopped.
 */
export function preflightEnvOptions(
  cli: EnvCliOptions = {},
  cwd?: string,
  opts: { requireMainFor?: string } = {},
): void {
  getEnvTargets(buildContext(cli, { cwd, readOnly: true, requireMainFor: opts.requireMainFor }));
}

/**
 * Look up a workspace's overrides by package name, then directory basename,
 * then repo-relative path — the key order resolveWorkspaces matches
 * selectors in. A bare basename applies only when it identifies exactly one
 * workspace, mirroring selector resolution's ambiguity rule: workspaces
 * sharing a directory name must be reached by full path.
 */
function findWorkspaceOverrides(
  map: Record<string, Record<string, string>> | undefined,
  ws: WorkspaceInfo,
  workspaces: WorkspaceInfo[],
): Record<string, string> | undefined {
  if (!map) return undefined;

  const basename = path.posix.basename(ws.dir);
  const basenameUnique =
    workspaces.filter((w) => path.posix.basename(w.dir) === basename)
      .length === 1;

  for (const key of [
    ws.name,
    ...(basenameUnique ? [basename] : []),
    ws.dir,
    `./${ws.dir}`,
  ]) {
    const overrides = map[key];
    if (overrides && typeof overrides === "object") return overrides;
  }

  return undefined;
}
