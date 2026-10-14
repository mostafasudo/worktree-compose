import fs from "node:fs";
import path from "node:path";

export interface WtcConfig {
  sync?: string[];
  envOverrides?: Record<string, string>;
  /**
   * Env filename to copy from the main checkout into each worktree and inject
   * port overrides into. Workspace targets use the same name. Defaults to `.env`.
   */
  envFile?: string;
  /**
   * Monorepo workspaces (by package name, directory name, or path) that also
   * receive env file copies + port override injection, in addition to the repo
   * root. Empty/omitted means root-only (the zero-config behavior).
   */
  workspaces?: string[];
  /**
   * Per-workspace env overrides, keyed by workspace name (or directory).
   * Values support `${VAR}` interpolation against allocated port values.
   */
  workspaceEnvOverrides?: Record<string, Record<string, string>>;
  /**
   * Per-worktree-index port stride. Allocated port =
   * 20000 + defaultPort + worktreeIndex * portStride. Defaults to 1.
   * Raise it (e.g. 100) when a project exposes clustered default host
   * ports so that adjacent worktrees do not collide across services.
   */
  portStride?: number;
}

export function loadConfig(repoRoot: string): WtcConfig {
  const rcPath = path.join(repoRoot, ".wtcrc.json");
  if (fs.existsSync(rcPath)) {
    return JSON.parse(fs.readFileSync(rcPath, "utf-8")) as WtcConfig;
  }

  const pkgPath = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (pkg.wtc && typeof pkg.wtc === "object") {
      return pkg.wtc as WtcConfig;
    }
  }

  return {};
}
