import net from "node:net";
import path from "node:path";
import { buildContext, resolveConfig } from "../context.js";
import { loadConfigWithSource } from "../config.js";
import { detectComposeFile } from "../compose/detect.js";
import { parseComposeFile } from "../compose/parse.js";
import { daemonCheckArgs, resolveEngine } from "../compose/engine.js";
import { createStackProbe, stackStatus } from "../compose/status.js";
import {
  composeIsolationWarnings,
  portCollisionWarnings,
  rawPortWarnings,
  remapNotes,
} from "../compose/isolation.js";
import { decideRemap } from "../compose/override.js";
import { extractPortMappings } from "../ports/extract.js";
import { portLabel } from "../ports/allocate.js";
import { stackAllocations, stackRemap } from "./compose.js";
import { DEFAULT_ENV_FILE, findEnvSource } from "../sync/env.js";
import { getRepoInfo } from "../git/repo.js";
import { ENGINE_PROBE_TIMEOUT_MS, runSafe } from "../utils/exec.js";
import type { ComposeEngine } from "../compose/engine.js";
import type { ComposeFile } from "../compose/types.js";
import type { WtcConfig } from "../config.js";
import type { CoreIo } from "./types.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  status: CheckStatus;
  title: string;
  detail?: string;
  hint?: string;
}

export interface DoctorResult {
  /** False when any check failed. */
  ok: boolean;
  checks: DoctorCheck[];
}

/** True when binding `port` on `host` fails with EADDRINUSE. */
function bindFails(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE");
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen({ port, host, exclusive: true });
  });
}

/**
 * True when something already listens on `port`. Docker publishes on all
 * interfaces, but local dev servers and Homebrew databases usually bind
 * 127.0.0.1 or ::1 only — and on macOS (BSD sockets, libuv's SO_REUSEADDR)
 * a wildcard bind succeeds next to them, so each address is probed. Only
 * EADDRINUSE counts as busy (no IPv6 → not busy).
 */
export async function isPortBusy(port: number): Promise<boolean> {
  for (const host of ["0.0.0.0", "127.0.0.1", "::1"]) {
    if (await bindFails(port, host)) return true;
  }
  return false;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function versionLine(output: string | null): string | undefined {
  if (!output) return undefined;
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /version/i.test(l)) ?? lines[0];
}

/**
 * Diagnose the setup: git, repo layout, compose file, config, compose
 * engine and daemon, port isolation (including what is remapped at
 * runtime), isolation-breaking compose settings, worktree/registry health,
 * and host ports already taken for stopped stacks. Each check is
 * independent so one failure never hides the others.
 */
export async function doctor(io: CoreIo): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);
  const finish = (): DoctorResult => ({ ok: !checks.some((c) => c.status === "fail"), checks });
  const cwd = path.resolve(io.cwd ?? process.cwd());

  // git + repository layout
  const gitVersion = runSafe("git", ["--version"]);
  if (!gitVersion) {
    add({ status: "fail", title: "git not found", hint: "Install git (2.31+ recommended)." });
    return finish();
  }
  add({ status: "ok", title: gitVersion });

  let repo;
  try {
    repo = getRepoInfo(cwd);
  } catch (err) {
    add({ status: "fail", title: "Not inside a git repository", detail: message(err), hint: "Run wtc from your project." });
    return finish();
  }
  add({
    status: "ok",
    title: repo.mainRootIsFallback
      ? `Repository "${repo.repoName}"${repo.bare ? " (bare)" : ""}: main checkout unknown, reading files from ${repo.currentRoot}`
      : repo.bare
        ? `Repository "${repo.repoName}" (bare; main checkout ${repo.mainRoot})`
        : `Repository "${repo.repoName}" (main worktree ${repo.mainRoot})`,
    detail:
      repo.currentRoot !== repo.mainRoot && !repo.mainRootIsFallback
        ? `Running from linked worktree ${repo.currentRoot}; compose, config and env files are read from ${repo.mainRoot}.`
        : undefined,
  });
  for (const w of repo.warnings) add({ status: "warn", title: w });

  // compose file
  let composeFile: ComposeFile | null = null;
  const composePath = detectComposeFile(repo.mainRoot);
  if (!composePath) {
    add({
      status: "fail",
      title: "No compose file found",
      detail: `Looked in ${repo.mainRoot}`,
      hint: "Add compose.yaml (or docker-compose.yml) to the main worktree.",
    });
  } else {
    try {
      composeFile = parseComposeFile(composePath);
      const includes = composeFile.sourceFiles.length - 1;
      add({
        status: "ok",
        title: `${path.basename(composePath)}: ${composeFile.services.length} service(s)` +
          (includes > 0 ? `, ${includes} included file(s)` : ""),
        detail: includes > 0
          ? composeFile.sourceFiles.slice(1).map((f) => path.relative(repo.mainRoot, f)).join(", ")
          : undefined,
      });
    } catch (err) {
      add({ status: "fail", title: `Could not parse ${path.basename(composePath)}`, detail: message(err) });
    }
  }

  // config
  let config: WtcConfig | null = null;
  try {
    const loaded = loadConfigWithSource(repo.mainRoot);
    config = resolveConfig(loaded.config, {});
    add({
      status: "ok",
      title: loaded.source ? `Config: ${path.relative(repo.mainRoot, loaded.source) || loaded.source}` : "No config (zero-config defaults)",
    });
  } catch (err) {
    add({ status: "fail", title: "Invalid wtc config", detail: message(err), hint: "Fix .wtcrc.json (or package.json#wtc)." });
  }

  // compose engine + daemon
  let engine: ComposeEngine | null = null;
  let composeWorks = false;
  try {
    engine = resolveEngine(config ?? {});
    const output = runSafe(engine.compose[0], [...engine.compose.slice(1), "version"], {
      timeoutMs: ENGINE_PROBE_TIMEOUT_MS,
    });
    composeWorks = output !== null;
    const source = process.env.WTC_COMPOSE_COMMAND?.trim()
      ? "WTC_COMPOSE_COMMAND"
      : config?.composeCommand !== undefined
        ? `"composeCommand" config`
        : null;
    add(
      composeWorks
        ? { status: "ok", title: `Compose engine: ${engine.label}`, detail: versionLine(output) }
        : {
            status: "fail",
            title: `Compose engine not working: ${engine.label}`,
            detail: `'${engine.label} version' failed (${source ? `set by ${source}` : "auto-detected"}).`,
            hint: source
              ? `Check ${source}: the command must exist and support 'version'.`
              : "Install Docker with Compose v2, or Podman — or set WTC_COMPOSE_COMMAND.",
          },
    );
  } catch (err) {
    add({ status: "fail", title: "No compose engine", detail: message(err) });
  }
  let daemonUp = false;
  if (engine) {
    const [file, args] = daemonCheckArgs(engine);
    daemonUp = runSafe(file, args, { timeoutMs: ENGINE_PROBE_TIMEOUT_MS }) !== null;
    const start =
      engine.cli === "podman" ? "Start it with 'podman machine start'" : "Start Docker Desktop (or the docker service)";
    add(
      daemonUp
        ? { status: "ok", title: `${engine.cli} daemon reachable` }
        : {
            status: "fail",
            title: `${engine.cli} daemon not reachable`,
            hint: `${start}, or set WTC_COMPOSE_COMMAND to use another engine (e.g. "podman compose").`,
          },
    );
  }

  if (!composeFile) return finish();

  // ports and isolation
  const mappings = extractPortMappings(composeFile.services);
  const remap = decideRemap({
    composeFile,
    mappings,
    mainRoot: repo.mainRoot,
    commonDir: repo.commonDir,
    envFiles: [
      findEnvSource(repo.mainRoot, { dir: "", label: "root", envFileName: config?.envFile ?? DEFAULT_ENV_FILE }),
      path.join(repo.mainRoot, DEFAULT_ENV_FILE),
    ],
    envOverrides: config?.envOverrides,
    engine: () => {
      if (!engine || !composeWorks) throw new Error("no working compose engine");
      return engine;
    },
  });
  const remapped = remap.targets?.ports ?? [];
  const isolatable = [
    ...mappings.filter((m) => m.envVar !== null).map((m) => `${m.serviceName}:${m.envVar}`),
    ...remapped.map((m) => `${m.serviceName}:${m.defaultPort} (remapped at runtime)`),
  ];
  if (mappings.length === 0) {
    add({ status: "ok", title: "No published ports" });
  } else {
    add({
      status: "ok",
      title: `${isolatable.length} isolatable port(s)`,
      detail: isolatable.join(", ") || undefined,
    });
  }
  if (remap.targets) {
    add({
      status: "ok",
      title: "Hardcoded settings remapped at runtime (compose file unchanged)",
      detail: remapNotes(remap.targets, mappings).join(" "),
    });
  }
  if (remap.problem) {
    add({
      status: "warn",
      title: "Runtime remapping unavailable",
      detail: remap.problem,
      hint: "Or change the compose file as the warnings below suggest.",
    });
  }
  for (const w of remap.warnings) {
    add({ status: "warn", title: "Not remapped", detail: w });
  }
  for (const w of rawPortWarnings(mappings, remapped)) {
    add({ status: "warn", title: "Raw port mapping (not isolated)", detail: w });
  }
  const isolation = composeIsolationWarnings(
    composeFile,
    new Set(remap.targets?.containerNames.map((c) => c.service)),
  );
  if (isolation.length === 0) {
    add({
      status: "ok",
      title: remap.targets?.containerNames.length
        ? "No shared volumes/networks (container_name is dropped at runtime)"
        : "No container_name or shared volumes/networks",
    });
  }
  for (const w of isolation) {
    add({ status: "warn", title: "Isolation", detail: w });
  }

  if (!config) return finish();

  // worktrees, registry, collisions, busy ports. Read-only: a diagnosis
  // (and the readOnlyHint wtc_doctor) must not assign identities, create
  // worktree ids, or move a corrupt registry aside — it only reports.
  let ctx;
  try {
    ctx = buildContext({}, { cwd, readOnly: true });
  } catch (err) {
    add({ status: "fail", title: "Could not load worktrees", detail: message(err) });
    return finish();
  }

  const indices = [
    ...ctx.worktrees.map((w) => w.index),
    ...ctx.orphans.map((o) => o.index),
    ...ctx.unavailable.map((u) => u.index),
  ];
  const collisions = portCollisionWarnings(ctx.portMappings, ctx.portStride, indices, remapped);
  if (collisions.length === 0) {
    add({ status: "ok", title: "No cross-worktree port collisions" });
  }
  for (const w of collisions) {
    add({ status: "warn", title: "Port collisions", detail: w });
  }

  // Missing worktrees, registry problems, skipped sync entries.
  for (const w of ctx.warnings) {
    add({ status: "warn", title: w });
  }
  if (ctx.orphans.length > 0) {
    add({
      status: "warn",
      title: `${ctx.orphans.length} orphaned stack record(s)`,
      detail: ctx.orphans.map((o) => `${o.index}:${o.branch} (${o.project})`).join(", "),
      hint: "Their worktrees were removed. Run 'wtc prune' to stop the stacks and free the indices.",
    });
  }

  const probe = createStackProbe(daemonUp && composeWorks ? engine : null, null, ctx.repoRoot);
  const byIndex = [...ctx.worktrees].sort((a, b) => a.index - b.index);
  const summary = byIndex.map((w) => `${w.index}:${w.branch} (${stackStatus(probe.state(w.project))})`);
  add({
    status: "ok",
    title: `${ctx.worktrees.length} worktree(s)`,
    detail: summary.join(", ") || undefined,
  });

  const busy: string[] = [];
  let probed = 0;
  for (const wt of byIndex) {
    // Stacks with nothing running (down, or stopped containers) hold no
    // ports themselves, so whatever listens there is something else.
    const state = probe.state(wt.project);
    if (!state || state.running > 0) continue;
    probed++;
    let allocations;
    try {
      // As start allocates them: this worktree's own compose override counts.
      const withRemap = { ...ctx, remap: remap.targets };
      allocations = stackAllocations(withRemap, wt.index, stackRemap(withRemap, wt.path, wt.project).targets).allocations;
    } catch (err) {
      add({ status: "fail", title: `Worktree ${wt.index}: cannot allocate ports`, detail: message(err) });
      continue;
    }
    for (const a of allocations) {
      if (await isPortBusy(a.port)) {
        busy.push(`worktree ${wt.index} (${wt.branch}) ${portLabel(a)}=${a.port}`);
      }
    }
  }
  if (busy.length > 0) {
    add({
      status: "warn",
      title: `${busy.length} allocated port(s) already in use`,
      detail: busy.join(", "),
      hint: "Something else is listening there: starting that worktree would fail, or its localhost URL would reach the other process. Stop it, or change portStride.",
    });
  } else if (probed > 0) {
    add({ status: "ok", title: `Allocated ports are free for ${probed} stopped worktree(s)` });
  }

  return finish();
}
