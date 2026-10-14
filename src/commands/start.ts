import path from "node:path";
import { buildContext, filterWorktrees, getEnvTargets } from "../context.js";
import type { EnvCliOptions } from "../context.js";
import { allocateWorktreePorts } from "../ports/allocate.js";
import { composeProjectName } from "../utils/sanitize.js";
import { execLive } from "../utils/exec.js";
import { syncWorktreeFiles } from "../sync/files.js";
import { injectPortOverrides, prepareEnvFile } from "../sync/env.js";
import * as log from "../utils/log.js";
import { listCommand } from "./list.js";

export function startCommand(
  indices: number[],
  cli: EnvCliOptions = {},
): void {
  const ctx = buildContext(cli);

  if (ctx.worktrees.length === 0) {
    log.warn(
      "No extra worktrees found. Create one with:\n  git worktree add ../my-branch my-branch",
    );
    return;
  }

  const targets = filterWorktrees(ctx.worktrees, indices);
  const envTargets = getEnvTargets(ctx);

  for (const wt of targets) {
    const idx = ctx.worktrees.indexOf(wt) + 1;
    const project = composeProjectName(ctx.repoName, idx, wt.branch);
    const allocations = allocateWorktreePorts(
      ctx.portMappings,
      idx,
      ctx.portStride,
    );

    log.header(`Worktree ${idx}: ${wt.branch}`);
    log.info(`Path:    ${wt.path}`);
    log.info(`Project: ${project}`);
    log.info(
      `Ports:   ${allocations.map((a) => `${a.envVar}=${a.port}`).join(" ")}`,
    );

    syncWorktreeFiles(
      ctx.repoRoot,
      wt.path,
      ctx.composeFile,
      ctx.config.sync,
    );
    log.success("Synced infrastructure files");

    const injected: string[] = [];
    for (const target of envTargets) {
      const envPath = prepareEnvFile(ctx.repoRoot, wt.path, target);
      if (!envPath) {
        log.warn(
          `No ${target.envFileName} (or .env.example) found for ${target.label}; skipped`,
        );
        continue;
      }
      injectPortOverrides(envPath, allocations, target.overrides);
      injected.push(path.relative(wt.path, envPath));
    }
    if (injected.length > 0) {
      log.success(`Injected port overrides into ${injected.join(", ")}`);
    }

    execLive(`docker compose -p "${project}" up -d --build`, {
      cwd: wt.path,
      env: { ...process.env, COMPOSE_PROJECT_NAME: project },
    });

    log.success(`Worktree ${idx} started`);
  }

  console.log("");
  listCommand();
}
