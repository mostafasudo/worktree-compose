import { buildContext, filterWorktrees } from "../context.js";
import { allocateWorktreePorts } from "../ports/allocate.js";
import { composeProjectName } from "../utils/sanitize.js";
import { execLive } from "../utils/exec.js";
import { syncWorktreeFiles } from "../sync/files.js";
import { copyBaseEnv, injectPortOverrides } from "../sync/env.js";
import * as log from "../utils/log.js";
import { listCommand } from "./list.js";

export function startCommand(indices: number[]): void {
  const ctx = buildContext();

  if (ctx.worktrees.length === 0) {
    log.warn(
      "No extra worktrees found. Create one with:\n  git worktree add ../my-branch my-branch",
    );
    return;
  }

  const targets = filterWorktrees(ctx.worktrees, indices);

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

    copyBaseEnv(ctx.repoRoot, wt.path);
    injectPortOverrides(
      `${wt.path}/.env`,
      allocations,
      ctx.config.envOverrides,
    );
    log.success("Injected port overrides into .env");

    execLive(`docker compose -p "${project}" up -d --build`, {
      cwd: wt.path,
      env: { ...process.env, COMPOSE_PROJECT_NAME: project },
    });

    log.success(`Worktree ${idx} started`);
  }

  console.log("");
  listCommand();
}
