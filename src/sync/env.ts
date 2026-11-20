import fs from "node:fs";
import path from "node:path";
import { isSameFile, prepareWritablePath } from "../utils/paths.js";
import type { PortAllocation } from "../ports/types.js";

export const DEFAULT_ENV_FILE = ".env";
const EXAMPLE_ENV_FILE = ".env.example";

const BLOCK_START = "# --- wtc port overrides ---";
const BLOCK_END = "# --- end wtc ---";

/** An env file target: the repo root, or a workspace directory. */
export interface EnvTarget {
  /** Directory relative to the repo root; `""` means the repo root. */
  dir: string;
  /** Human-readable label used in logs ("root", "workspace server (apps/server)"). */
  label: string;
  /** Env filename to copy and inject (e.g. `.env`, `.env.development`). */
  envFileName: string;
  /** Per-target overrides; `${VAR}` interpolates allocated port values. */
  overrides?: Record<string, string>;
}

export function stripOverrideBlock(content: string): string {
  const startIdx = content.indexOf(BLOCK_START);
  if (startIdx === -1) return content;

  const endIdx = content.indexOf(BLOCK_END, startIdx);
  if (endIdx === -1) return content;

  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + BLOCK_END.length).trimStart();

  return [before, after].filter(Boolean).join("\n") + "\n";
}

/** Name of the compose project variable wtc writes into the root env file. */
export const PROJECT_NAME_VAR = "COMPOSE_PROJECT_NAME";

/** Interpolate `${VAR}` placeholders with allocated port values (and the project name). */
export function resolveOverrideValue(
  value: string,
  values: Map<string, number | string>,
): string {
  let result = value;
  for (const [name, replacement] of values) {
    result = result.replaceAll(`\${${name}}`, String(replacement));
  }
  return result;
}

export interface InjectOptions {
  /** Compose project name; always available to overrides as `${COMPOSE_PROJECT_NAME}`. */
  projectName?: string;
  /**
   * Also write `COMPOSE_PROJECT_NAME=<project>` (root target only), so running
   * `docker compose` by hand inside the worktree addresses the same stack wtc
   * started instead of creating a new one named after the directory.
   */
  writeProjectName?: boolean;
  /**
   * Also write `COMPOSE_FILE=<value>` (root target only, when wtc remaps
   * hardcoded ports or container names at runtime), so `docker compose`
   * run by hand inside the worktree loads the same override wtc used.
   */
  composeFile?: string;
  /**
   * Directory the env file must stay inside (the worktree root). Defaults to
   * the file's own directory, which still protects the final component.
   */
  root?: string;
  /** The pristine env source this file was copied from; never written, even via a hard link. */
  source?: string;
}

/** Name of the compose file list variable (runtime remapping). */
export const COMPOSE_FILE_VAR = "COMPOSE_FILE";

/**
 * A value compose reads back exactly, `$` included: single-quoted dotenv
 * values are literal; one with a `'` in it is double-quoted, with `\`, `"`
 * and `$` escaped (compose reads `\$` as a literal `$`).
 */
export function literalEnvValue(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/[\\"$]/g, (c) => `\\${c}`)}"`;
}

/**
 * All keys that should be written for a target: the project name and
 * compose file list (root target), allocated port variables, then the
 * target's overrides (already interpolated). Overrides win on key
 * conflicts. A remapped hardcoded port has no variable, so nothing is
 * written for it.
 */
export function buildOverrideEntries(
  allocations: PortAllocation[],
  overrides?: Record<string, string>,
  opts: InjectOptions = {},
): Record<string, string> {
  const entries: Record<string, string> = {};
  const values = new Map<string, number | string>();

  if (opts.projectName !== undefined) {
    if (opts.writeProjectName) entries[PROJECT_NAME_VAR] = opts.projectName;
    values.set(PROJECT_NAME_VAR, opts.projectName);
  }
  if (opts.composeFile) entries[COMPOSE_FILE_VAR] = literalEnvValue(opts.composeFile);

  for (const a of allocations) {
    if (a.envVar === null) continue;
    entries[a.envVar] = String(a.port);
    values.set(a.envVar, a.port);
  }

  if (overrides) {
    for (const [key, template] of Object.entries(overrides)) {
      entries[key] = resolveOverrideValue(template, values);
    }
  }

  return entries;
}

function formatOverrideBlock(entries: Record<string, string>): string {
  return [
    BLOCK_START,
    ...Object.entries(entries).map(([key, value]) => `${key}=${value}`),
    BLOCK_END,
  ].join("\n");
}

export function buildOverrideBlock(
  allocations: PortAllocation[],
  envOverrides?: Record<string, string>,
): string {
  return formatOverrideBlock(buildOverrideEntries(allocations, envOverrides));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace the value of an existing `KEY=...` line in place, preserving
 * comments, ordering, and every other line. Returns `null` when the key is
 * not present in the file.
 */
function rewriteExistingKey(
  content: string,
  key: string,
  value: string,
): string | null {
  const probe = new RegExp(`^${escapeRegExp(key)}=`, "m");
  if (!probe.test(content)) return null;

  const line = new RegExp(`^${escapeRegExp(key)}=.*$`, "gm");
  // A function replacer avoids `$&`-style substitution in user values.
  return content.replace(line, () => `${key}=${value}`);
}

export interface InjectionResult {
  /** Keys whose existing line was rewritten in place. */
  rewritten: string[];
  /** Keys that were not present and were appended in the override block. */
  appended: string[];
  /** A symlink or special file at the path was replaced instead of written through. */
  warnings: string[];
}

/**
 * Inject port allocations and overrides into an env file. Existing keys are
 * rewritten in place; missing keys are appended in an idempotent block. The
 * block is stripped before writing, so repeated runs never accumulate.
 */
export function injectPortOverrides(
  envPath: string,
  allocations: PortAllocation[],
  overrides?: Record<string, string>,
  opts: InjectOptions = {},
): InjectionResult {
  // Reading and writing follow symlinks: never inject through one (it could
  // point at the main checkout's real .env, or anywhere else on disk). A
  // symlink here is replaced; a directory resolving outside the root refused.
  const root = opts.root ?? path.dirname(envPath);
  const warnings: string[] = [];
  const dest = prepareWritablePath(root, path.relative(root, envPath), warnings);
  if (!dest) throw new Error(`Refusing to write ${envPath}: ${warnings.join(" ")}`);
  if (opts.source && isSameFile(opts.source, dest)) {
    throw new Error(`Refusing to write ${envPath}: it is the env source file ${opts.source} itself.`);
  }
  let content = "";
  if (fs.existsSync(dest)) {
    content = fs.readFileSync(dest, "utf-8");
  }

  content = stripOverrideBlock(content);

  const entries = buildOverrideEntries(allocations, overrides, opts);
  const rewritten: string[] = [];
  const appended: Record<string, string> = {};

  for (const [key, value] of Object.entries(entries)) {
    const replaced = rewriteExistingKey(content, key, value);
    if (replaced === null) {
      appended[key] = value;
    } else {
      content = replaced;
      rewritten.push(key);
    }
  }

  let result = content.trimEnd();
  if (Object.keys(appended).length > 0) {
    result += (result ? "\n\n" : "") + formatOverrideBlock(appended) + "\n";
  } else if (result) {
    result += "\n";
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, result, "utf-8");

  return { rewritten, appended: Object.keys(appended), warnings };
}

/**
 * Pristine source for a target's env file: `<dir>/<envFileName>` first, then
 * `<dir>/.env.example`. Returns `null` when neither exists.
 */
export function findEnvSource(
  repoRoot: string,
  target: EnvTarget,
): string | null {
  const dir = target.dir ? path.join(repoRoot, target.dir) : repoRoot;

  const primary = path.join(dir, target.envFileName);
  if (fs.existsSync(primary)) return primary;

  const example = path.join(dir, EXAMPLE_ENV_FILE);
  if (fs.existsSync(example)) return example;

  return null;
}

/**
 * Copy the pristine env file from the main checkout into the worktree at the
 * same relative path. Returns the destination path, or `null` when the target
 * is skipped: a workspace with no env file (and no `.env.example`), or a
 * destination wtc refuses to write (reasons pushed onto `warnings`). The
 * repo root otherwise always yields a path — an empty file is created when
 * nothing exists, matching the previous zero-config behavior.
 *
 * The worktree's branch is not trusted: a committed symlink at the env path
 * (`.env -> ../somewhere`) or a symlinked workspace directory would make the
 * copy write the main checkout's secrets — plus the override block — to
 * wherever it points. A symlink at the env path is replaced by a regular
 * copy (symlinking `.env` from main is also a common setup, and writing
 * through it would rewrite main's own `.env`); a directory that resolves
 * outside the worktree is refused. The env source itself is never written:
 * when the destination *is* the source (same realpath or inode — the
 * worktree is the main checkout, or a hard link), the target is skipped.
 */
export function prepareEnvFile(
  repoRoot: string,
  wtPath: string,
  target: EnvTarget,
  warnings: string[] = [],
): string | null {
  const relDest = path.join(target.dir, target.envFileName);
  const source = findEnvSource(repoRoot, target);
  if (!source && target.dir !== "") return null;

  const label = `${target.label} env file ${relDest}`;
  const dest = prepareWritablePath(wtPath, relDest, warnings, { label });
  if (!dest) return null;
  if (source && isSameFile(source, dest)) {
    warnings.push(
      `Skipped ${label}: it is the main checkout's own env file (the worktree is the env source); wtc never rewrites it.`,
    );
    return null;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!source) {
    fs.writeFileSync(dest, "", "utf-8");
    return dest;
  }
  fs.copyFileSync(source, dest);
  return dest;
}
