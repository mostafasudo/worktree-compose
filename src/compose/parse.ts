import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ComposeFile, ComposeService } from "./types.js";

function parseServicePorts(ports: unknown): string[] {
  if (!Array.isArray(ports)) return [];

  return ports.flatMap((p) => {
    if (typeof p === "string") return [p];
    if (typeof p === "number") return [String(p)];
    if (typeof p === "object" && p !== null) {
      const obj = p as Record<string, unknown>;
      if (obj.published != null && obj.target != null) {
        return [`${obj.published}:${obj.target}`];
      }
    }
    return [];
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

function parseServicesObject(
  doc: Record<string, unknown>,
  sourcePath: string,
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
    return {
      name,
      ports: parseServicePorts(s.ports),
      build: parseServiceBuild(s.build),
      envFile: parseEnvFile(s.env_file),
      sourcePath,
    };
  });
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
  const ports = [...base.ports];
  for (const p of override.ports) {
    if (!ports.includes(p)) ports.push(p);
  }
  const sourcePath =
    override.build !== undefined
      ? override.sourcePath
      : base.build !== undefined
        ? base.sourcePath
        : override.sourcePath;
  return {
    name: override.name,
    ports,
    build: override.build ?? base.build,
    envFile: override.envFile ?? base.envFile,
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

function parseRecursive(
  filePath: string,
  seen: Set<string>,
  sourceFiles: string[],
): ComposeService[] {
  if (!fs.existsSync(filePath)) {
    console.warn(`wtc: included compose file not found, skipping: ${filePath}`);
    return [];
  }

  // Key on the realpath so symlinked duplicates and cycles are caught.
  const key = fs.realpathSync.native(filePath);
  if (seen.has(key)) return [];
  seen.add(key);

  const raw = fs.readFileSync(filePath, "utf-8");
  const doc = parseYaml(raw, { uniqueKeys: false });
  if (!doc || typeof doc !== "object") return [];

  sourceFiles.push(key);

  // Recurse into includes first so local services can override included ones.
  let included: ComposeService[] = [];
  if ("include" in doc) {
    for (const inc of normalizeIncludes(
      (doc as Record<string, unknown>).include,
      filePath,
    )) {
      included = included.concat(parseRecursive(inc, seen, sourceFiles));
    }
  }

  const local = parseServicesObject(doc as Record<string, unknown>, key);
  return foldServices([...included, ...local]);
}

export function parseComposeFile(composePath: string): ComposeFile {
  const abs = path.resolve(composePath);
  const seen = new Set<string>();
  const sourceFiles: string[] = [];
  const services = parseRecursive(abs, seen, sourceFiles);
  return { services, composePath: abs, sourceFiles };
}
