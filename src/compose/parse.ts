import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import type { ComposeFile, ComposeService, SharedResource } from "./types.js";

/** The `host:container` string wtc reads a `ports:` entry as, or null (no published port). */
export function portEntryString(p: unknown): string | null {
  if (typeof p === "string") return p;
  if (typeof p === "number") return String(p);
  if (typeof p === "object" && p !== null) {
    const obj = p as Record<string, unknown>;
    if (obj.published != null && obj.target != null) {
      return `${obj.published}:${obj.target}`;
    }
  }
  return null;
}

function parseServicePorts(ports: unknown): string[] {
  if (!Array.isArray(ports)) return [];
  return ports.flatMap((p) => {
    const s = portEntryString(p);
    return s === null ? [] : [s];
  });
}

/** Key for deduplicating `ports:` entries across files (same written value). */
function entryKey(entry: unknown): string {
  return JSON.stringify(entry) ?? String(entry);
}

function uniqueEntries(entries: unknown[]): unknown[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = entryKey(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseServiceBuild(
  build: unknown,
): ComposeService["build"] | undefined {
  if (typeof build === "string") {
    return { context: build };
  }
  if (typeof build === "object" && build !== null) {
    const obj = build as Record<string, unknown>;
    return {
      context: typeof obj.context === "string" ? obj.context : undefined,
      dockerfile:
        typeof obj.dockerfile === "string" ? obj.dockerfile : undefined,
      ...(typeof obj.dockerfile_inline === "string" ? { inline: true } : {}),
    };
  }
  return undefined;
}

function parseEnvFile(envFile: unknown): string[] | undefined {
  if (typeof envFile === "string") return [envFile];
  if (Array.isArray(envFile)) {
    return envFile.filter((e) => typeof e === "string");
  }
  return undefined;
}

/** Network names a service joins: the keys of the map form, or the list form. */
function parseServiceNetworks(networks: unknown): string[] | undefined {
  if (Array.isArray(networks)) return networks.filter((n): n is string => typeof n === "string");
  if (networks && typeof networks === "object") return Object.keys(networks);
  return undefined;
}

/** `extends: base` or `extends: { service, file }`. */
function parseExtends(ext: unknown): ComposeService["extendsFrom"] {
  if (typeof ext === "string" && ext) return { service: ext };
  if (ext && typeof ext === "object") {
    const o = ext as Record<string, unknown>;
    if (typeof o.service === "string" && o.service) {
      return { service: o.service, ...(typeof o.file === "string" && o.file ? { file: o.file } : {}) };
    }
  }
  return undefined;
}

/**
 * Container names a service joins by name: `network_mode`, `ipc` or `pid`
 * set to `container:<name>`, and `volumes_from: [container:<name>[:ro]]`.
 */
export function parseContainerRefs(s: Record<string, unknown>): string[] {
  const refs: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.startsWith("container:")) {
      const name = v.slice("container:".length).split(":")[0];
      if (name) refs.push(name);
    }
  };
  add(s.network_mode);
  add(s.ipc);
  add(s.pid);
  if (Array.isArray(s.volumes_from)) s.volumes_from.forEach(add);
  return refs;
}

/** Compose's `!reset` / `!override` tag on a service key, when there is one. */
type KeyTag = (service: string, key: string) => string | undefined;

function parseServicesObject(
  doc: Record<string, unknown>,
  sourcePath: string,
  tagOf: KeyTag = () => undefined,
): ComposeService[] {
  if (!("services" in doc) || !doc.services || typeof doc.services !== "object") {
    return [];
  }

  const servicesObj = doc.services as Record<
    string,
    Record<string, unknown> | null
  >;
  return Object.entries(servicesObj).map(([name, svc]) => {
    // An empty service definition (`foo:` with no body) parses to null.
    const s = svc ?? {};
    const portsTag = tagOf(name, "ports");
    // `!reset` clears the attribute whatever its payload says.
    const portsReset = portsTag === "!reset";
    const nameReset = tagOf(name, "container_name") === "!reset";
    const networks = parseServiceNetworks(s.networks);
    const extendsFrom = parseExtends(s.extends);
    const containerRefs = parseContainerRefs(s);
    return {
      name,
      ports: portsReset ? [] : parseServicePorts(s.ports),
      portEntries: portsReset ? [] : Array.isArray(s.ports) ? uniqueEntries(s.ports) : [],
      ...(portsTag === "!override" || portsReset ? { portsReplace: true } : {}),
      ...(s.extends != null ? { extends: true } : {}),
      ...(extendsFrom ? { extendsFrom } : {}),
      ...(containerRefs.length > 0 ? { containerRefs } : {}),
      ...(networks ? { networks } : {}),
      ...(s.network_mode != null ? { networkMode: true } : {}),
      build: parseServiceBuild(s.build),
      envFile: parseEnvFile(s.env_file),
      ...(nameReset ? { containerNameReset: true } : {}),
      ...(!nameReset && typeof s.container_name === "string" && s.container_name
        ? { containerName: s.container_name }
        : {}),
      sourcePath,
    };
  });
}

interface ResourceDef {
  name?: string;
  external: boolean;
}

/**
 * Top-level `volumes:` / `networks:` entries. Only `name:` and `external`
 * matter to wtc: either one takes the resource out of the project scope, so
 * every worktree stack would share it.
 */
function parseResources(section: unknown): Map<string, ResourceDef> {
  const out = new Map<string, ResourceDef>();
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return out;
  }
  for (const [key, raw] of Object.entries(section as Record<string, unknown>)) {
    const def = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    // `external: true`, or the legacy `external: { name: x }` form.
    const external =
      def.external === true ||
      (typeof def.external === "object" && def.external !== null);
    const legacyName =
      typeof def.external === "object" && def.external !== null
        ? (def.external as Record<string, unknown>).name
        : undefined;
    const name =
      typeof def.name === "string" && def.name
        ? def.name
        : typeof legacyName === "string" && legacyName
          ? legacyName
          : undefined;
    out.set(key, { ...(name ? { name } : {}), external });
  }
  return out;
}

/** Later definitions override earlier ones field by field, like services. */
function mergeResources(
  into: Map<string, ResourceDef>,
  from: Map<string, ResourceDef>,
): void {
  for (const [key, def] of from) {
    const existing = into.get(key);
    into.set(
      key,
      existing
        ? { name: def.name ?? existing.name, external: def.external || existing.external }
        : def,
    );
  }
}

/**
 * A name built from `${COMPOSE_PROJECT_NAME}` is still per-stack: wtc sets
 * that variable for every worktree (process env and root env file).
 */
export function isProjectScopedName(name: string): boolean {
  return /\$\{?COMPOSE_PROJECT_NAME\b/.test(name);
}

function sharedOnly(defs: Map<string, ResourceDef>): SharedResource[] {
  const out: SharedResource[] = [];
  for (const [key, def] of defs) {
    if (!def.external && (!def.name || isProjectScopedName(def.name))) continue;
    out.push({ key, ...(def.name ? { name: def.name } : {}), external: def.external });
  }
  return out;
}

interface ParseState {
  seen: Set<string>;
  sourceFiles: string[];
  volumes: Map<string, ResourceDef>;
  networks: Map<string, ResourceDef>;
}

/**
 * Normalize a top-level `include:` value into a list of resolved absolute
 * paths. Each entry is a string path or a long-form object whose `path` is a
 * string or list of strings. Paths resolve relative to the directory of the
 * file currently being parsed.
 */
function normalizeIncludes(include: unknown, parentPath: string): string[] {
  if (!Array.isArray(include)) return [];

  const dir = path.dirname(parentPath);
  const out: string[] = [];
  for (const entry of include) {
    let paths: string[] = [];
    if (typeof entry === "string") {
      paths = [entry];
    } else if (entry && typeof entry === "object" && "path" in entry) {
      const p = (entry as Record<string, unknown>).path;
      if (typeof p === "string") {
        paths = [p];
      } else if (Array.isArray(p)) {
        paths = p.filter((s): s is string => typeof s === "string");
      }
    }
    for (const p of paths) out.push(path.resolve(dir, p));
  }
  return out;
}

/**
 * Combine two definitions of the same service. Docker Compose deep-merges
 * same-named services across included/overriding files rather than replacing
 * them wholesale, so a later definition that omits `ports` must NOT discard the
 * earlier one's ports — otherwise that service silently loses its per-worktree
 * port isolation. We merge the fields wtc relies on: ports are unioned (deduped
 * by raw mapping so the allocator never sees a duplicate), while build/envFile
 * fall back to the base when the override doesn't set them. sourcePath stays
 * aligned with whichever file actually declared `build`, so getDockerfiles
 * resolves the context relative to the right directory.
 */
function mergeService(
  base: ComposeService,
  override: ComposeService,
): ComposeService {
  // `ports: !override` / `!reset` in the later file replaces the list.
  const ports = override.portsReplace ? [...override.ports] : [...base.ports];
  if (!override.portsReplace) {
    for (const p of override.ports) {
      if (!ports.includes(p)) ports.push(p);
    }
  }
  const sourcePath =
    override.build !== undefined
      ? override.sourcePath
      : base.build !== undefined
        ? base.sourcePath
        : override.sourcePath;
  const containerName = override.containerNameReset
    ? override.containerName
    : (override.containerName ?? base.containerName);
  const networks = [...new Set([...(base.networks ?? []), ...(override.networks ?? [])])];
  return {
    name: override.name,
    ports,
    portEntries: override.portsReplace
      ? (override.portEntries ?? [])
      : uniqueEntries([...(base.portEntries ?? []), ...(override.portEntries ?? [])]),
    ...(base.portsReplace || override.portsReplace ? { portsReplace: true } : {}),
    ...(base.extends || override.extends ? { extends: true } : {}),
    ...((override.extendsFrom ?? base.extendsFrom) ? { extendsFrom: override.extendsFrom ?? base.extendsFrom } : {}),
    ...(base.containerRefs || override.containerRefs
      ? { containerRefs: [...new Set([...(base.containerRefs ?? []), ...(override.containerRefs ?? [])])] }
      : {}),
    ...(base.networks || override.networks ? { networks } : {}),
    ...(base.networkMode || override.networkMode ? { networkMode: true } : {}),
    build: override.build ?? base.build,
    envFile: override.envFile ?? base.envFile,
    ...(containerName ? { containerName } : {}),
    ...(override.containerNameReset ? { containerNameReset: true } : {}),
    sourcePath,
  };
}

/**
 * Fold services in declaration order (included first, in include order, then
 * local), deep-merging any later definition of an already-seen service name
 * onto the earlier one. Replaces a previous wholesale last-writer-wins merge,
 * which silently dropped the base's ports when an override redefined a service
 * without repeating them.
 */
function foldServices(services: ComposeService[]): ComposeService[] {
  const byName = new Map<string, ComposeService>();
  for (const svc of services) {
    const existing = byName.get(svc.name);
    byName.set(svc.name, existing ? mergeService(existing, svc) : svc);
  }
  return [...byName.values()];
}

function parseRecursive(filePath: string, st: ParseState): ComposeService[] {
  if (!fs.existsSync(filePath)) {
    console.warn(`wtc: included compose file not found, skipping: ${filePath}`);
    return [];
  }

  // Key on the realpath so symlinked duplicates and cycles are caught.
  const key = fs.realpathSync.native(filePath);
  if (st.seen.has(key)) return [];
  st.seen.add(key);

  const raw = fs.readFileSync(filePath, "utf-8");
  // Merge keys (`<<: *anchor`) resolved as compose resolves them; compose's
  // own tags (`!reset`, `!override`) kept on the nodes, without warnings.
  const document = parseDocument(raw, { uniqueKeys: false, merge: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid YAML in ${filePath}: ${document.errors[0].message}`);
  }
  const doc: unknown = document.toJS();
  if (!doc || typeof doc !== "object") return [];
  const tagOf: KeyTag = (service, k) =>
    (document.getIn(["services", service, k], true) as { tag?: string } | undefined)?.tag;

  st.sourceFiles.push(key);

  // Recurse into includes first so local services can override included ones.
  let included: ComposeService[] = [];
  if ("include" in doc) {
    for (const inc of normalizeIncludes(
      (doc as Record<string, unknown>).include,
      filePath,
    )) {
      included = included.concat(parseRecursive(inc, st));
    }
  }

  const record = doc as Record<string, unknown>;
  mergeResources(st.volumes, parseResources(record.volumes));
  mergeResources(st.networks, parseResources(record.networks));

  const local = parseServicesObject(record, key, tagOf);
  return foldServices([...included, ...local]);
}

export function parseComposeFile(composePath: string): ComposeFile {
  const abs = path.resolve(composePath);
  const st: ParseState = {
    seen: new Set<string>(),
    sourceFiles: [],
    volumes: new Map(),
    networks: new Map(),
  };
  const services = parseRecursive(abs, st);
  return {
    services,
    composePath: abs,
    sourceFiles: st.sourceFiles,
    sharedVolumes: sharedOnly(st.volumes),
    sharedNetworks: sharedOnly(st.networks),
  };
}
