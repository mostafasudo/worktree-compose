import fs from "node:fs";
import path from "node:path";
import type { ComposeFile } from "../compose/types.js";

function copyFile(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  }
}

function copyDir(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

/** True if a repo-relative path escapes the repo root (or is absolute). */
function escapesRepo(rel: string): boolean {
  return path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`);
}

export function getDockerfiles(
  composeFile: ComposeFile,
  repoRoot: string,
): string[] {
  const files: string[] = [];

  for (const svc of composeFile.services) {
    if (!svc.build) continue;
    const context = svc.build.context ?? ".";
    const dockerfile = svc.build.dockerfile ?? "Dockerfile";
    // Build contexts are relative to the file that declared the service, which
    // may be an included file rather than the root compose file.
    const resolvedDir = path.resolve(path.dirname(svc.sourcePath), context);
    const fullPath = path.join(resolvedDir, dockerfile);
    const rel = path.relative(repoRoot, fullPath);
    if (escapesRepo(rel)) continue;
    files.push(rel);
  }

  return [...new Set(files)];
}

export function syncWorktreeFiles(
  repoRoot: string,
  wtPath: string,
  composeFile: ComposeFile,
  extraSync?: string[],
): void {
  for (const src of composeFile.sourceFiles) {
    const rel = path.relative(repoRoot, src);
    if (escapesRepo(rel)) continue;
    copyFile(path.join(repoRoot, rel), path.join(wtPath, rel));
  }

  for (const df of getDockerfiles(composeFile, repoRoot)) {
    copyFile(path.join(repoRoot, df), path.join(wtPath, df));
  }

  if (extraSync) {
    for (const p of extraSync) {
      const src = path.join(repoRoot, p);
      const dst = path.join(wtPath, p);
      if (fs.existsSync(src)) {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          copyDir(src, dst);
        } else {
          copyFile(src, dst);
        }
      }
    }
  }
}
