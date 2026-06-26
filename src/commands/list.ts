import Table from "cli-table3";
import chalk from "chalk";
import { buildContext } from "../context.js";
import { allocateWorktreePorts } from "../ports/allocate.js";
import { composeProjectName } from "../utils/sanitize.js";
import { execSafe } from "../utils/exec.js";
import { warn } from "../utils/log.js";
import { suggestEnvVar } from "../ports/extract.js";

function isWorktreeUp(projectName: string, wtPath: string): boolean {
  const result = execSafe(
    `docker compose -p "${projectName}" ps --format json`,
    { cwd: wtPath },
  );
  return result !== null && result.length > 2;
}

export function listCommand(): void {
  const ctx = buildContext();

  const rawPorts = ctx.portMappings.filter((m) => m.envVar === null);
  for (const p of rawPorts) {
    warn(
      `Service "${p.serviceName}" uses a raw port mapping (${p.raw}). ` +
        `To enable port isolation, change it to: "\${${suggestEnvVar(p.serviceName)}:-${p.defaultPort}}:${p.containerPort}"`,
    );
  }

  if (ctx.worktrees.length === 0) {
    console.log(
      "\nNo extra worktrees found. Create one with:\n  git worktree add ../my-branch my-branch\n",
    );
    return;
  }

  const table = new Table({
    head: [
      chalk.white("Index"),
      chalk.white("Branch"),
      chalk.white("Status"),
      chalk.white("URL"),
      chalk.white("Ports"),
    ],
  });

  const overridable = ctx.portMappings.filter((m) => m.envVar !== null);
  const defaultPorts = overridable
    .map((m) => `${m.serviceName}:${m.defaultPort}`)
    .join(" ");

  table.push([
    chalk.dim("-"),
    chalk.dim("main"),
    chalk.dim("-"),
    chalk.dim("-"),
    chalk.dim(defaultPorts),
  ]);

  for (let i = 0; i < ctx.worktrees.length; i++) {
    const wt = ctx.worktrees[i];
    const idx = i + 1;
    const project = composeProjectName(ctx.repoName, idx, wt.branch);
    const allocations = allocateWorktreePorts(
      ctx.portMappings,
      idx,
      ctx.portStride,
    );
    const up = isWorktreeUp(project, wt.path);

    const ports = allocations
      .map((a) => `${a.serviceName}:${a.port}`)
      .join(" ");

    const frontendAlloc = allocations.find(
      (a) =>
        a.serviceName.includes("frontend") ||
        a.serviceName.includes("web") ||
        a.serviceName.includes("app") ||
        a.serviceName.includes("ui"),
    );
    const url = frontendAlloc
      ? `http://localhost:${frontendAlloc.port}`
      : allocations.length > 0
        ? `http://localhost:${allocations[allocations.length - 1].port}`
        : "-";

    table.push([
      String(idx),
      wt.branch,
      up ? chalk.green("up") : chalk.red("down"),
      up ? chalk.underline(url) : chalk.dim(url),
      ports,
    ]);
  }

  console.log(table.toString());
}
