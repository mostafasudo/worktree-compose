import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface WorkspaceInfo {
  /** Workspace directory relative to the repo root, POSIX-style ("apps/server"). */
  dir: string;
  /** Absolute workspace directory. */
  absDir: string;
  /** `package.json#name` when present, otherwise the directory basename. */
  name: string;
}

/** Directories that never contain workspaces and are expensive to walk. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  ".cache",
  "out",
  "vendor",
  "target",
  ".venv",
]);

const MAX_WALK_DEPTH = 8;

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Workspace globs declared by the repo: `package.json#workspaces` (npm/bun/yarn
 * style, array or `{ "packages": [...] }`) plus `pnpm-workspace.yaml#packages`.
 */
export function getWorkspacePatterns(repoRoot: string): string[] {
  const patterns: string[] = [];

  const pkg = readJson(path.join(repoRoot, "package.json"));
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) {
    patterns.push(...ws.filter((p): p is string => typeof p === "string"));
  } else if (ws && typeof ws === "object") {
    const packages = (ws as Record<string, unknown>).packages;
    if (Array.isArray(packages)) {
      patterns.push(
        ...packages.filter((p): p is string => typeof p === "string"),
      );
    }
  }

  const pnpmFile = path.join(repoRoot, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmFile)) {
    try {
      const doc = parseYaml(fs.readFileSync(pnpmFile, "utf-8")) as {
        packages?: unknown;
      } | null;
      if (doc && Array.isArray(doc.packages)) {
        patterns.push(
          ...doc.packages.filter((p): p is string => typeof p === "string"),
        );
      }
    } catch {
      // A malformed pnpm-workspace.yaml is ignored; package.json still applies.
    }
  }

  return [...new Set(patterns.map((p) => p.trim()).filter(Boolean))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Convert a workspace glob (`*`, `**`, `?`) into an anchored regexp. */
function globToRegExp(pattern: string): RegExp {
  const normalized = pattern
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");

  let re = "";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        i++;
        if (normalized[i + 1] === "/") {
          i++;
          re += "(?:[^/]+/)*";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${re}$`);
}

/** Directory to start walking for a glob: its first static path segment. */
function scanRootForPattern(pattern: string, repoRoot: string): string {
  const first = pattern.split("/")[0];
  if (first && !first.includes("*") && !first.includes("?")) {
    return path.join(repoRoot, first);
  }
  return repoRoot;
}

function* walkDirs(
  root: string,
  depth: number,
  maxDepth: number,
): Generator<string> {
  yield root;
  if (depth >= maxDepth) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Symlinked directories are skipped to avoid cycles.
    if (!entry.isDirectory()) continue;
    if (IGNORED_DIRS.has(entry.name)) continue;
    yield* walkDirs(path.join(root, entry.name), depth + 1, maxDepth);
  }
}

/** Every directory matched by the declared workspace globs that has a package.json. */
export function listWorkspaces(repoRoot: string): WorkspaceInfo[] {
  const patterns = getWorkspacePatterns(repoRoot);
  if (patterns.length === 0) return [];

  const includes = patterns.filter((p) => !p.startsWith("!"));
  const excludes = patterns
    .filter((p) => p.startsWith("!"))
    .map((p) => globToRegExp(p.slice(1)));

  const found = new Map<string, WorkspaceInfo>();

  for (const pattern of includes) {
    const scanRoot = scanRootForPattern(pattern, repoRoot);
    if (!fs.existsSync(scanRoot)) continue;
    const matcher = globToRegExp(pattern);

    for (const abs of walkDirs(scanRoot, 0, MAX_WALK_DEPTH)) {
      const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
      // The root package is not a workspace, even when a broad glob matches it.
      if (rel === "") continue;
      if (!matcher.test(rel)) continue;
      if (excludes.some((re) => re.test(rel))) continue;
      if (found.has(rel)) continue;

      const pkg = readJson(path.join(abs, "package.json"));
      if (!pkg) continue;

      const name =
        typeof pkg.name === "string" && pkg.name
          ? pkg.name
          : path.basename(abs);
      found.set(rel, { dir: rel, absDir: abs, name });
    }
  }

  return [...found.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Resolve user-supplied workspace selectors (`--workspace server`, `apps/server`,
 * `@acme/ui`) into workspace directories, preserving request order and
 * deduplicating. Throws with available options when a selector matches nothing.
 */
export function resolveWorkspaces(
  repoRoot: string,
  names: string[],
): WorkspaceInfo[] {
  const requested = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (requested.length === 0) return [];

  const all = listWorkspaces(repoRoot);
  const resolved: WorkspaceInfo[] = [];
  const used = new Set<string>();

  for (const raw of requested) {
    const name = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    const match = findWorkspace(repoRoot, all, name);
    if (!match) {
      const available = all.map((w) => w.name).join(", ");
      throw new Error(
        `Workspace "${raw}" not found in ${repoRoot}.` +
          (available
            ? ` Available workspaces: ${available}.`
            : " No workspaces declared in package.json#workspaces or pnpm-workspace.yaml."),
      );
    }
    if (!used.has(match.dir)) {
      used.add(match.dir);
      resolved.push(match);
    }
  }

  return resolved;
}

function findWorkspace(
  repoRoot: string,
  all: WorkspaceInfo[],
  name: string,
): WorkspaceInfo | null {
  const byName = all.find((w) => w.name === name);
  if (byName) return byName;

  const byDir = all.find((w) => w.dir === name);
  if (byDir) return byDir;

  const byBasename = all.filter((w) => path.posix.basename(w.dir) === name);
  if (byBasename.length > 1) {
    throw new Error(
      `Workspace "${name}" is ambiguous: ${byBasename.map((w) => w.dir).join(", ")}. ` +
        `Pass the full directory path instead.`,
    );
  }
  if (byBasename.length === 1) return byBasename[0];

  // Repos without a workspace declaration: probe common layouts so
  // `--workspace server` still finds `apps/server`.
  if (all.length === 0) {
    for (const candidate of [
      name,
      `apps/${name}`,
      `packages/${name}`,
      `libs/${name}`,
    ]) {
      const abs = path.join(repoRoot, candidate);
      const pkg = readJson(path.join(abs, "package.json"));
      if (!pkg) continue;
      return {
        dir: candidate,
        absDir: abs,
        name:
          typeof pkg.name === "string" && pkg.name
            ? pkg.name
            : path.basename(candidate),
      };
    }
  }

  return null;
}
