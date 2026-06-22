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

  const servicesObj = doc.services as Record<string, Record<string, unknown>>;
  return Object.entries(servicesObj).map(([name, svc]) => ({
    name,
    ports: parseServicePorts(svc.ports),
    build: parseServiceBuild(svc.build),
    envFile: parseEnvFile(svc.env_file),
    sourcePath,
  }));
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

/** Merge included and local services by name; local services win. */
function mergeServices(
  included: ComposeService[],
  local: ComposeService[],
): ComposeService[] {
  const byName = new Map<string, ComposeService>();
  for (const svc of included) byName.set(svc.name, svc);
  for (const svc of local) byName.set(svc.name, svc);
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
  return mergeServices(included, local);
}

export function parseComposeFile(composePath: string): ComposeFile {
  const abs = path.resolve(composePath);
  const seen = new Set<string>();
  const sourceFiles: string[] = [];
  const services = parseRecursive(abs, seen, sourceFiles);
  return { services, composePath: abs, sourceFiles };
}
