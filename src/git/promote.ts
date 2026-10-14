import fs from "node:fs";
import path from "node:path";
import { exec, execSafe } from "../utils/exec.js";

const PROMOTE_EXCLUDES = new Set([
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
]);

/**
 * Local env files are excluded from promote (`.env.example` is committed and
 * therefore promotable): `.env`, `.env.development`, `.env.local`, …
 */
function isEnvFile(file: string): boolean {
  const base = path.posix.basename(file);
  if (base === ".env.example") return false;
  return base === ".env" || base.startsWith(".env.");
}

function resolveRef(repoRoot: string, ref: string): string {
  return exec(`git -C "${repoRoot}" rev-parse "${ref}"`);
}

export function getChangedFiles(
  repoRoot: string,
  wtPath: string,
  currentBranch: string,
  wtBranch: string,
): string[] {
  const currentRef = resolveRef(repoRoot, currentBranch === "HEAD" ? "HEAD" : currentBranch);
  const wtRef = resolveRef(wtPath, "HEAD");
  const mergeBase = exec(
    `git -C "${repoRoot}" merge-base "${currentRef}" "${wtRef}"`,
  );

  const committed =
    execSafe(`git -C "${wtPath}" diff --name-only "${mergeBase}" HEAD`) ?? "";

  let uncommitted = "";
  const hasStagedOrUnstaged =
    execSafe(`git -C "${wtPath}" diff --quiet`) === null ||
    execSafe(`git -C "${wtPath}" diff --cached --quiet`) === null;
  if (hasStagedOrUnstaged) {
    uncommitted = execSafe(`git -C "${wtPath}" diff --name-only HEAD`) ?? "";
  }

  const untracked =
    execSafe(
      `git -C "${wtPath}" ls-files --others --exclude-standard`,
    ) ?? "";

  const allFiles = [committed, uncommitted, untracked]
    .join("\n")
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  const unique = [...new Set(allFiles)];
  return unique.filter(
    (f) => !PROMOTE_EXCLUDES.has(f) && !isEnvFile(f),
  );
}

export function getLocalDirtyFiles(repoRoot: string): string[] {
  const unstaged = execSafe(`git -C "${repoRoot}" diff --name-only HEAD`) ?? "";
  const staged =
    execSafe(`git -C "${repoRoot}" diff --cached --name-only HEAD`) ?? "";

  return [...new Set([unstaged, staged].join("\n").split("\n"))]
    .map((f) => f.trim())
    .filter(Boolean);
}

export function findConflicts(
  files: string[],
  dirtyFiles: string[],
): string[] {
  const dirtySet = new Set(dirtyFiles);
  return files.filter((f) => dirtySet.has(f));
}

export function promoteFiles(
  repoRoot: string,
  wtPath: string,
  files: string[],
): void {
  for (const f of files) {
    const src = path.join(wtPath, f);
    const dst = path.join(repoRoot, f);

    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } else {
      if (fs.existsSync(dst)) fs.unlinkSync(dst);
    }
  }
}
