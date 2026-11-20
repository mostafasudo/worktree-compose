import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Document, parseDocument } from "yaml";
import { ENGINE_PROBE_TIMEOUT_MS, runSafe } from "../utils/exec.js";
import { allocatePort } from "../ports/allocate.js";
import { portSegments } from "../ports/extract.js";
import { stateDir } from "../state/registry.js";
import { COMPOSE_FILE_VAR } from "../sync/env.js";
import { COMPOSE_FILENAMES } from "./detect.js";
import { composeArgs, composeBin } from "./engine.js";
import { isProjectScopedName, parseContainerRefs, portEntryString } from "./parse.js";
import type { ComposeEngine } from "./engine.js";
import type { ComposeFile, ComposeService } from "./types.js";
import type { PortAllocation, PortMapping } from "../ports/types.js";

/**
 * Runtime remapping. Two compose settings make every worktree stack collide
 * with the others: a hardcoded host port (`8080:80`) and a fixed
 * `container_name`. Instead of asking for the compose file to be edited, wtc
 * writes a compose override for each worktree stack that replaces the
 * service's `ports` (`!override`, hardcoded host ports swapped for the
 * worktree's allocated ones) and drops `container_name` (`!reset`, keeping
 * the old name as a network alias), and adds it to `COMPOSE_FILE` for every
 * compose call on that stack — and in the worktree's root env file, so plain
 * `docker compose` there agrees. The compose file itself is never changed.
 *
 * A plain override cannot do this: compose merges `ports` lists, so the
 * hardcoded port would still be published. The `!override`/`!reset` tags
 * need Docker Compose 2.24.4+ (and are partial or missing in other
 * engines), so wtc first checks that the engine merges them as expected,
 * and otherwise keeps warning as before.
 */

/** Override files compose loads next to the compose file, in its order of preference. */
export const USER_OVERRIDE_FILENAMES = [
  "compose.override.yml",
  "compose.override.yaml",
  "docker-compose.override.yml",
  "docker-compose.override.yaml",
];

/** What wtc remaps for a stack. */
export interface RemapTargets {
  /** Hardcoded host-port mappings: each gets the worktree's allocated port. */
  ports: PortMapping[];
  /**
   * Fixed container names: dropped, so compose names the containers per
   * project. The old name stays reachable inside the stack as a network
   * alias, unless `noAlias` (the user's own override sets the networks).
   */
  containerNames: { service: string; name: string; noAlias?: boolean }[];
}

export function remapIsEmpty(t: RemapTargets): boolean {
  return t.ports.length === 0 && t.containerNames.length === 0;
}

/** Whether a service's port entries use `${…}` interpolation anywhere. */
function portsUseVariables(svc: ComposeService): boolean {
  return (svc.portEntries ?? svc.ports).some((e) => (JSON.stringify(e) ?? "").includes("$"));
}

/** Whether a hardcoded host port can move at all: allocated ports end at 65535. */
function canMove(port: number): boolean {
  try {
    allocatePort(port, 1, 1);
    return true;
  } catch {
    return false;
  }
}

/**
 * Settings wtc could remap: hardcoded host ports (not ranges) and fixed
 * container names, plus why some are left alone:
 * - a service that uses `extends` may inherit ports wtc cannot see, which
 *   a replaced list would drop;
 * - a service from an included file whose ports use variables: compose
 *   fills those in from that file's own env (its directory's `.env`), but
 *   an override is interpolated with the main project's;
 * - a port too high to move (above 65435);
 * - a container name another service joins by name (`network_mode:
 *   container:<name>`, `volumes_from`, `ipc`, `pid`): an alias cannot stand
 *   in for a container identity.
 */
export function remapCandidates(
  composeFile: ComposeFile,
  mappings: PortMapping[],
): { targets: RemapTargets; skipped: string[] } {
  const root = composeFile.sourceFiles[0];
  const skipped: string[] = [];
  const keep = new Set<string>();
  for (const svc of composeFile.services) {
    if (!mappings.some((m) => m.serviceName === svc.name && m.envVar === null && !m.range)) continue;
    if (svc.extends) {
      keep.add(svc.name);
      skipped.push(
        `Service "${svc.name}" uses extends, which may bring in ports wtc cannot see, so wtc does not remap its hardcoded ports.`,
      );
    } else if (root !== undefined && svc.sourcePath !== root && portsUseVariables(svc)) {
      keep.add(svc.name);
      skipped.push(
        `Service "${svc.name}" comes from an included file (${path.basename(svc.sourcePath)}) whose port variables compose fills in from that file's own env, so wtc does not remap its hardcoded ports.`,
      );
    }
  }
  const stuck = new Set<number>();
  const ports = mappings.filter((m) => {
    if (m.envVar !== null || m.range || keep.has(m.serviceName)) return false;
    if (canMove(m.defaultPort)) return true;
    if (!stuck.has(m.defaultPort)) {
      stuck.add(m.defaultPort);
      skipped.push(
        `Service "${m.serviceName}": hardcoded host port ${m.defaultPort} is too high to move (ports end at 65535), so wtc leaves it.`,
      );
    }
    return false;
  });

  const joinedBy = new Map<string, string>();
  for (const s of composeFile.services) {
    for (const ref of s.containerRefs ?? []) if (!joinedBy.has(ref)) joinedBy.set(ref, s.name);
  }
  const containerNames = composeFile.services.flatMap((s) => {
    if (!s.containerName || isProjectScopedName(s.containerName)) return [];
    const by = joinedBy.get(s.containerName);
    if (by) {
      skipped.push(
        `Service "${s.name}": service "${by}" joins container:${s.containerName} by name, so wtc does not drop its container_name.`,
      );
      return [];
    }
    return [{ service: s.name, name: s.containerName }];
  });
  return { targets: { ports, containerNames }, skipped };
}

/** The compose override file compose would load from `dir` by itself, or null. */
export function findUserOverride(dir: string): string | null {
  for (const name of USER_OVERRIDE_FILENAMES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Parse YAML that may use compose's custom tags (`!reset`, `!override`):
 * unknown tags are fine (no warning printed), merge keys (`<<: *anchor`)
 * are resolved as compose resolves them, syntax errors throw.
 */
function parseComposeYaml(text: string): unknown {
  const doc = parseDocument(text, { uniqueKeys: false, merge: true });
  if (doc.errors.length > 0) throw doc.errors[0];
  return doc.toJS();
}

/** Each service's definition in a compose file, or null when it cannot be read. */
function serviceDefs(file: string): Map<string, Record<string, unknown>> | null {
  let doc: unknown;
  try {
    doc = parseComposeYaml(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  const out = new Map<string, Record<string, unknown>>();
  const services = doc && typeof doc === "object" ? (doc as Record<string, unknown>).services : null;
  if (services && typeof services === "object") {
    for (const [name, svc] of Object.entries(services as Record<string, unknown>)) {
      if (svc && typeof svc === "object") out.set(name, svc as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * Leave alone what the user's own compose override in `dir` also sets for
 * a service (`ports` or `extends`, `container_name`): replacing it would
 * discard theirs. A container name one of its services joins by name
 * (`network_mode: container:<name>`, …) is kept too. Where it sets the
 * service's networks, the old container name gets no alias (theirs could
 * be `network_mode`). Returns what remains, with a warning for each
 * setting left alone.
 */
export function withoutUserOverride(
  targets: RemapTargets,
  dir: string,
): { targets: RemapTargets; warnings: string[] } {
  const file = findUserOverride(dir);
  if (!file || remapIsEmpty(targets)) return { targets, warnings: [] };
  const name = path.basename(file);
  const defs = serviceDefs(file);
  if (!defs) {
    return {
      targets: { ports: [], containerNames: [] },
      warnings: [`Could not read ${name}, so wtc does not remap hardcoded ports or container_name at runtime.`],
    };
  }
  const sets = (service: string, key: string) => defs.get(service)?.[key] !== undefined;
  const joinedBy = new Map<string, string>();
  for (const [service, def] of defs) {
    for (const ref of parseContainerRefs(def)) if (!joinedBy.has(ref)) joinedBy.set(ref, service);
  }
  const warnings: string[] = [];
  const skippedPorts = new Set(
    targets.ports
      .filter((m) => sets(m.serviceName, "ports") || sets(m.serviceName, "extends"))
      .map((m) => m.serviceName),
  );
  for (const service of skippedPorts) {
    warnings.push(`Service "${service}": ${name} also sets its ports, so wtc does not remap its hardcoded ports.`);
  }
  const containerNames = targets.containerNames.flatMap((c) => {
    if (sets(c.service, "container_name")) {
      warnings.push(`Service "${c.service}": ${name} also sets container_name, so wtc does not drop it.`);
      return [];
    }
    const by = joinedBy.get(c.name);
    if (by) {
      warnings.push(
        `Service "${c.service}": service "${by}" in ${name} joins container:${c.name} by name, so wtc does not drop its container_name.`,
      );
      return [];
    }
    return sets(c.service, "networks") || sets(c.service, "network_mode") || sets(c.service, "extends")
      ? [{ ...c, noAlias: true }]
      : [c];
  });
  return {
    targets: { ports: targets.ports.filter((m) => !skippedPorts.has(m.serviceName)), containerNames },
    warnings,
  };
}

/** The separator compose splits `COMPOSE_FILE` on (wtc's calls and the env files it writes). */
export function composePathSeparator(): string {
  return process.env.COMPOSE_PATH_SEPARATOR || path.delimiter;
}

/** A `COMPOSE_FILE` value for `files`, or null when a path contains the separator. */
export function composeFileValue(files: string[]): string | null {
  const sep = composePathSeparator();
  return files.some((f) => f.includes(sep)) ? null : files.join(sep);
}

/**
 * The value an env file assigns to `key`: its last assignment, in either
 * form compose's dotenv parser accepts (`KEY=value`, `KEY: value`),
 * unquoted. Null when the file or the key is missing.
 */
export function envFileValue(file: string | null, key: string): string | null {
  if (!file) return null;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  let value: string | null = null;
  for (const m of text.matchAll(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*[=:](.*)$`, "gm"))) {
    value = m[1].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return value;
}

/** The `COMPOSE_FILE` an env file sets, or null. */
export function envFileComposeFile(file: string | null): string | null {
  return envFileValue(file, COMPOSE_FILE_VAR);
}

/** Why an env file's `COMPOSE_PATH_SEPARATOR` would split wtc's list differently, or null. */
function separatorConflict(file: string | null): string | null {
  const sep = envFileValue(file, "COMPOSE_PATH_SEPARATOR");
  return sep && sep !== composePathSeparator()
    ? `${path.basename(file!)} sets COMPOSE_PATH_SEPARATOR, which would split wtc's COMPOSE_FILE differently`
    : null;
}

/** Where wtc keeps a stack's override: inside the git directory, never committed. */
export function overridePath(commonDir: string, project: string): string {
  return path.join(stateDir(commonDir), "compose", `${project}.yaml`);
}

/**
 * True when a `COMPOSE_FILE` value is exactly a list wtc writes — the
 * compose file, the directory's own compose override if any, then one of
 * wtc's overrides: the line wtc wrote into a worktree's env file, exported
 * into the shell by a tool that loads `.env` (direnv's `dotenv`, mise,
 * autoenv). That is not a file list of the user's, so it must not switch
 * remapping off. A list with anything else in it (the user appended a
 * file) is the user's.
 */
export function isWtcComposeFile(value: string, commonDir: string): boolean {
  const dir = path.dirname(overridePath(commonDir, "_"));
  const files = value.split(composePathSeparator()).map((f) => f.trim()).filter(Boolean);
  if (files.length < 2 || files.length > 3) return false;
  if (path.dirname(path.resolve(files[files.length - 1])) !== dir) return false;
  if (!COMPOSE_FILENAMES.includes(path.basename(files[0]))) return false;
  if (files.length === 2) return true;
  // The compose override wtc lists is the one next to the compose file.
  return (
    USER_OVERRIDE_FILENAMES.includes(path.basename(files[1])) &&
    path.dirname(path.resolve(files[1])) === path.dirname(path.resolve(files[0]))
  );
}

/**
 * Whether the inherited `COMPOSE_FILE` names `file`: a list the shell still
 * holds (direnv, or one the user extended) would break if it were deleted.
 */
export function inheritedComposeFileNames(file: string): boolean {
  const value = process.env[COMPOSE_FILE_VAR];
  return !!value && value.split(composePathSeparator()).some((f) => f.trim() && path.resolve(f.trim()) === file);
}

/** A `COMPOSE_FILE` the user set (not one wtc wrote), from a value. */
export function isUserComposeFile(value: string | null | undefined, commonDir: string): boolean {
  return !!value?.trim() && !isWtcComposeFile(value, commonDir);
}

export function writeOverride(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, file);
}

export function removeOverride(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best effort: a leftover file is only read through COMPOSE_FILE.
  }
}

/** `entry` with its hardcoded host port replaced by `port` (same IP, protocol, and fields). */
function withHostPort(entry: unknown, port: number): unknown {
  if (typeof entry === "object" && entry !== null) {
    return { ...(entry as Record<string, unknown>), published: String(port) };
  }
  const s = String(entry);
  const protocol = /\/(tcp|udp|sctp)$/i.exec(s)?.[0] ?? "";
  const segments = portSegments(s);
  if (segments.length === 2) return `${port}:${segments[1]}${protocol}`;
  if (segments.length === 3) return `${segments[0]}:${port}:${segments[2]}${protocol}`;
  return entry;
}

/**
 * Networks on which a service whose container_name is dropped keeps the old
 * name as an alias, so containers that reach it by that name still do. Only
 * the stack's own networks: on one shared by every stack (fixed `name:`,
 * `external`) the alias would answer for several stacks at once. What a
 * service inherits through `extends` counts: a `network_mode` there leaves
 * no networks (compose rejects `networks` next to it), and its `networks`
 * add to the service's. When `extends` points into another file, wtc
 * cannot see what it brings, so no alias.
 */
function aliasNetworks(composeFile: ComposeFile, svc: ComposeService, name: string): string[] {
  // A `${…}` name would be interpolated with the main project's env, not the name's own.
  if (name.includes("$")) return [];
  const byName = new Map(composeFile.services.map((s) => [s.name, s]));
  const networks = new Set<string>();
  const seen = new Set<string>();
  for (let s: ComposeService | undefined = svc; s; ) {
    if (seen.has(s.name) || s.networkMode) return [];
    seen.add(s.name);
    for (const n of s.networks ?? []) networks.add(n);
    if (!s.extendsFrom) {
      if (s.extends) return []; // an `extends` form wtc does not read
      break;
    }
    if (s.extendsFrom.file) return [];
    s = byName.get(s.extendsFrom.service);
    if (!s) return [];
  }
  const shared = new Set(composeFile.sharedNetworks.map((n) => n.key));
  return (networks.size > 0 ? [...networks] : ["default"]).filter((n) => !shared.has(n));
}

/**
 * The override YAML for one stack. A service whose hardcoded ports are
 * remapped gets its whole `ports` list (`!override` replaces it): every
 * entry as written, except the remapped host ports. A service whose
 * container_name is dropped (`!reset`) keeps the old name as an alias on
 * its own networks. Strings are quoted, so YAML 1.1 parsers never read
 * `2222:22` as a base-60 number.
 */
export function renderOverride(
  project: string,
  composeFile: ComposeFile,
  targets: RemapTargets,
  allocations: PortAllocation[],
): string {
  const byDefault = new Map(allocations.map((a) => [a.defaultPort, a.port]));
  const remapped = new Map<string, Map<string, number>>();
  for (const m of targets.ports) {
    const port = byDefault.get(m.defaultPort);
    if (port === undefined) continue;
    const forService = remapped.get(m.serviceName) ?? new Map<string, number>();
    forService.set(m.raw, port);
    remapped.set(m.serviceName, forService);
  }
  const reset = new Map(targets.containerNames.map((c) => [c.service, c]));

  const out: Record<string, Record<string, unknown>> = {};
  for (const svc of composeFile.services) {
    const ports = remapped.get(svc.name);
    const name = reset.get(svc.name);
    if (!ports && !name) continue;
    const entry: Record<string, unknown> = {};
    if (ports) {
      entry.ports = (svc.portEntries ?? svc.ports).map((e) => {
        const raw = portEntryString(e);
        const port = raw === null ? undefined : ports.get(raw);
        return port === undefined ? e : withHostPort(e, port);
      });
    }
    if (name) {
      entry.container_name = null;
      const networks = name.noAlias ? [] : aliasNetworks(composeFile, svc, name.name);
      if (networks.length > 0) {
        entry.networks = Object.fromEntries(networks.map((n) => [n, { aliases: [name.name] }]));
      }
    }
    out[svc.name] = entry;
  }

  const doc = new Document({ services: out });
  for (const [name, entry] of Object.entries(out)) {
    if ("ports" in entry) {
      const node = doc.getIn(["services", name, "ports"], true) as { tag?: string } | undefined;
      if (node) node.tag = "!override";
    }
    if ("container_name" in entry) {
      const node = doc.getIn(["services", name, "container_name"], true) as { tag?: string } | undefined;
      if (node) node.tag = "!reset";
    }
  }
  doc.commentBefore =
    ` Generated by wtc for ${project}; rewritten on every start, do not edit.\n` +
    ` Remaps hardcoded host ports and drops fixed container names so this stack\n` +
    ` runs next to the others. The compose file itself is not changed.`;
  return doc.toString({ defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN", lineWidth: 0 });
}

const PROBE_COMPOSE = [
  "services:",
  "  probe:",
  "    image: wtc-probe",
  "    container_name: wtc-probe",
  "    ports:",
  '      - "1:1"',
  "",
].join("\n");

const PROBE_OVERRIDE = [
  "services:",
  "  probe:",
  "    container_name: !reset null",
  "    ports: !override",
  '      - "2:1"',
  "",
].join("\n");

/** True when `config` output shows the probe override applied: one port, published on 2, no container_name. */
export function probeApplied(stdout: string): boolean {
  let doc: unknown;
  try {
    doc = parseComposeYaml(stdout);
  } catch {
    return false;
  }
  const services = doc && typeof doc === "object" ? (doc as Record<string, unknown>).services : null;
  const svc = services && typeof services === "object" ? (services as Record<string, unknown>).probe : null;
  if (!svc || typeof svc !== "object" || "container_name" in svc) return false;
  const ports = (svc as Record<string, unknown>).ports;
  if (!Array.isArray(ports) || ports.length !== 1) return false;
  const p = ports[0];
  const published =
    typeof p === "object" && p !== null
      ? (p as Record<string, unknown>).published
      : portSegments(String(p)).at(-2);
  return String(published) === "2";
}

/** A failed probe is retried after this long (a long-lived MCP server must not stay off for good). */
const PROBE_RETRY_MS = 60_000;
const probeCache = new Map<string, { supported: boolean; at: number }>();

/** Forget cached probe results (tests). */
export function resetRemapProbeCache(): void {
  probeCache.clear();
}

/**
 * Whether the engine merges `!override` and `!reset` the way runtime
 * remapping needs: `config` on a throwaway project in a temp directory,
 * passed through `COMPOSE_FILE` exactly like the real override. It needs
 * no daemon and touches no containers. Cached per process and engine (a
 * failure for a minute).
 */
export function engineSupportsRemap(engine: ComposeEngine): boolean {
  const key = engine.compose.join("\0");
  const cached = probeCache.get(key);
  if (cached && (cached.supported || Date.now() - cached.at < PROBE_RETRY_MS)) return cached.supported;

  let supported = false;
  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-remap-probe-"));
    const base = path.join(dir, "compose.yaml");
    const override = path.join(dir, "override.yaml");
    fs.writeFileSync(base, PROBE_COMPOSE);
    fs.writeFileSync(override, PROBE_OVERRIDE);
    const files = composeFileValue([base, override]);
    if (files !== null) {
      const out = runSafe(composeBin(engine), composeArgs(engine, "wtc-remap-probe", "config"), {
        cwd: dir,
        env: { ...process.env, [COMPOSE_FILE_VAR]: files },
        timeoutMs: ENGINE_PROBE_TIMEOUT_MS,
      });
      supported = out !== null && probeApplied(out);
    }
  } catch {
    supported = false;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  probeCache.set(key, { supported, at: Date.now() });
  return supported;
}

export interface RemapDecision {
  /** What wtc remaps at runtime; null when there is nothing to remap or it cannot. */
  targets: RemapTargets | null;
  /** Why the candidates are not remapped, or null. */
  problem: string | null;
  /** Hardcoded settings left alone, and why. */
  warnings: string[];
}

export interface RemapInputs {
  composeFile: ComposeFile;
  mappings: PortMapping[];
  /** The main checkout (where its own compose override would be). */
  mainRoot: string;
  /** The git common dir (where wtc keeps the overrides). */
  commonDir: string;
  /**
   * Env files that could carry a `COMPOSE_FILE` of the user's: the root
   * env file wtc copies into worktrees, and the main checkout's `.env`
   * (which compose reads by itself).
   */
  envFiles: (string | null)[];
  /** The root `envOverrides`, which wtc writes into the worktree's env file. */
  envOverrides?: Record<string, string>;
  /** Resolves the engine; throwing means "no engine" (nothing to remap with). */
  engine: () => ComposeEngine;
}

/** Decide what to remap for this repository (see the module comment). */
export function decideRemap(inputs: RemapInputs): RemapDecision {
  const none: RemapDecision = { targets: null, problem: null, warnings: [] };
  const { targets: candidates, skipped } = remapCandidates(inputs.composeFile, inputs.mappings);
  if (remapIsEmpty(candidates)) return { ...none, warnings: skipped };

  // A COMPOSE_FILE of the user's lists the files compose loads; wtc's
  // would replace it, dropping theirs.
  const cannot = (why: string): RemapDecision => ({
    ...none,
    problem: `wtc cannot remap hardcoded ports or container_name at runtime: ${why}.`,
  });
  if (isUserComposeFile(process.env[COMPOSE_FILE_VAR], inputs.commonDir)) {
    return cannot("COMPOSE_FILE is set in the environment, and wtc would replace it");
  }
  for (const file of new Set(inputs.envFiles)) {
    if (isUserComposeFile(envFileComposeFile(file), inputs.commonDir)) {
      return cannot(`${path.basename(file!)} sets COMPOSE_FILE, and wtc would replace it`);
    }
    const conflict = separatorConflict(file);
    if (conflict) return cannot(conflict);
  }
  if (inputs.envOverrides && COMPOSE_FILE_VAR in inputs.envOverrides) {
    return cannot("envOverrides sets COMPOSE_FILE, and wtc would replace it");
  }
  const separator = inputs.envOverrides?.COMPOSE_PATH_SEPARATOR;
  if (separator !== undefined && separator !== composePathSeparator()) {
    return cannot("envOverrides sets COMPOSE_PATH_SEPARATOR, which would split wtc's COMPOSE_FILE differently");
  }
  let engine: ComposeEngine;
  try {
    engine = inputs.engine();
  } catch {
    // No engine: nothing runs, and the engine problem is reported elsewhere.
    return none;
  }
  if (!engineSupportsRemap(engine)) {
    return cannot(
      `${engine.label} does not apply compose's !override / !reset tags (Docker Compose 2.24.4 or newer does)`,
    );
  }
  const { targets, warnings } = withoutUserOverride(candidates, inputs.mainRoot);
  return { targets: remapIsEmpty(targets) ? null : targets, problem: null, warnings: [...skipped, ...warnings] };
}
