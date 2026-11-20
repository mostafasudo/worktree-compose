import Table from "cli-table3";
import chalk from "chalk";
import { listWorktrees } from "../core/list.js";
import type { ListRow } from "../core/list.js";
import { print, warn } from "../utils/log.js";

function renderStatus(row: ListRow): string {
  switch (row.status) {
    case "up":
      return chalk.green("up");
    case "partial":
      return chalk.yellow(`partial ${row.running}/${row.total}`);
    case "exited":
      return chalk.yellow("exited");
    case "down":
      return chalk.red("down");
    default:
      return chalk.dim("?");
  }
}

export async function listCommand(
  options: { json?: boolean; quiet?: boolean } = {},
): Promise<void> {
  const result = listWorktrees({ live: true });

  if (options.json) {
    // Keep stdout machine-readable: warnings go to stderr.
    for (const w of result.warnings) console.error(`⚠ ${w}`);
    console.log(JSON.stringify(result.rows, null, 2));
    return;
  }

  // After start/restart (`quiet`), the warnings were already printed.
  for (const w of options.quiet ? [] : result.warnings) warn(w);
  if (!options.quiet && result.isolationWarnings.length > 0) {
    warn(
      `${result.isolationWarnings.length} isolation warning(s) — run 'wtc doctor'`,
    );
  }

  if (result.rows.length === 0) {
    print(
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

  table.push([
    chalk.dim("-"),
    chalk.dim("main"),
    chalk.dim("-"),
    chalk.dim("-"),
    chalk.dim(result.mainPorts.map((p) => `${p.service}:${p.port}`).join(" ")),
  ]);

  for (const row of result.rows) {
    const ports = Object.entries(row.ports)
      .map(([label, port]) => `${label}=${port}`)
      .join(" ");
    if (row.orphan || row.unavailable) {
      const note = row.orphan
        ? "removed"
        : row.unavailable === "missing"
          ? "locked, missing on disk"
          : "now the main checkout";
      table.push([
        chalk.dim(String(row.index)),
        chalk.dim(`${row.branch} (${note})`),
        renderStatus(row),
        chalk.dim("-"),
        chalk.dim(ports),
      ]);
      continue;
    }
    const url = row.url ?? "-";
    table.push([
      String(row.index),
      row.branch,
      renderStatus(row),
      row.status === "up" || row.status === "partial" ? chalk.underline(url) : chalk.dim(url),
      ports,
    ]);
  }

  print(table.toString());

  if (result.rows.some((r) => r.orphan)) {
    print(
      chalk.dim(
        "(removed) = the worktree is gone but its stack/record remains. Run 'wtc prune' to tear it down.",
      ),
    );
  }
  if (result.rows.some((r) => r.unavailable === "missing")) {
    print(
      chalk.dim(
        "(locked, missing on disk) = remount it (e.g. an unmounted drive) to use it; wtc keeps its stack and index meanwhile.",
      ),
    );
  }
}
