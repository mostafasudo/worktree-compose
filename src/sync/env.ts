import fs from "node:fs";
import path from "node:path";
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

/** Interpolate `${VAR}` placeholders with allocated port values. */
export function resolveOverrideValue(
  value: string,
  portValues: Map<string, number>,
): string {
  let result = value;
  for (const [envVar, port] of portValues) {
    result = result.replaceAll(`\${${envVar}}`, String(port));
  }
  return result;
}

/**
 * All keys that should be written for a target: allocated ports plus the
 * target's overrides (already interpolated). Overrides win on key conflicts.
 */
export function buildOverrideEntries(
  allocations: PortAllocation[],
  overrides?: Record<string, string>,
): Record<string, string> {
  const entries: Record<string, string> = {};
  const portValues = new Map<string, number>();

  for (const a of allocations) {
    entries[a.envVar] = String(a.port);
    portValues.set(a.envVar, a.port);
  }

  if (overrides) {
    for (const [key, template] of Object.entries(overrides)) {
      entries[key] = resolveOverrideValue(template, portValues);
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
): InjectionResult {
  let content = "";
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf-8");
  }

  content = stripOverrideBlock(content);

  const entries = buildOverrideEntries(allocations, overrides);
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

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, result, "utf-8");

  return { rewritten, appended: Object.keys(appended) };
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
 * same relative path. Returns the destination path, or `null` when a workspace
 * target has no env file (and no `.env.example`) and should be skipped. The
 * repo root always yields a path — an empty file is created when nothing
 * exists, matching the previous zero-config behavior.
 */
export function prepareEnvFile(
  repoRoot: string,
  wtPath: string,
  target: EnvTarget,
): string | null {
  const dir = target.dir ? path.join(wtPath, target.dir) : wtPath;
  const dest = path.join(dir, target.envFileName);
  const source = findEnvSource(repoRoot, target);

  if (!source) {
    if (target.dir !== "") return null;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, "", "utf-8");
    return dest;
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(source, dest);
  return dest;
}
