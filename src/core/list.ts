import { buildContext } from "../context.js";
import { allocatableMappings, allocateWorktreePorts, portsByLabel } from "../ports/allocate.js";
import { stackStatus } from "../compose/status.js";
import type { StackStatus } from "../compose/status.js";
import type { PortAllocation } from "../ports/types.js";
import type { CoreIo } from "./types.js";

export interface ListRow {
  index: number;
  branch: string;
  path: string;
  project: string;
  /** up · partial · exited · down · ? (engine unavailable) */
  status: StackStatus;
  running: number | null;
  total: number | null;
  url: string | null;
  /**
   * Allocated host ports by variable — or by `<service>:<default port>` for
   * hardcoded ports remapped at runtime.
   */
  ports: Record<string, number>;
  /** The worktree was removed but its registry record (and maybe its stack) remains. */
  orphan: boolean;
  /**
   * The worktree still exists but cannot be started: `missing` (locked, its
   * checkout missing on disk — an unmounted drive) or `main` (it became the
   * main checkout). Its record and stack are kept; prune never touches it.
   */
  unavailable: "missing" | "main" | null;
}

export interface ListResult {
  rows: ListRow[];
  /** Default (main checkout) ports of isolated services, remapped hardcoded ones included. */
  mainPorts: { service: string; port: number }[];
  warnings: string[];
  isolationWarnings: string[];
}

function safeAllocate(
  ctx: ReturnType<typeof buildContext>,
  index: number,
): PortAllocation[] {
  try {
    return allocateWorktreePorts(ctx.portMappings, index, ctx.portStride, ctx.remap?.ports);
  } catch {
    return [];
  }
}

/** Guess the URL a human wants: a frontend-ish service, else the last port. */
export function pickUrl(allocations: PortAllocation[]): string | null {
  const frontend = allocations.find(
    (a) =>
      a.serviceName.includes("frontend") ||
      a.serviceName.includes("web") ||
      a.serviceName.includes("app") ||
      a.serviceName.includes("ui"),
  );
  const chosen = frontend ?? allocations[allocations.length - 1];
  return chosen ? `http://localhost:${chosen.port}` : null;
}

/**
 * Worktrees (and orphaned stacks) with status, ports, and URL. Read-only
 * (wtc_list carries readOnlyHint): identities of worktrees seen for the
 * first time are computed, adopting running stacks, but never recorded —
 * no registry write, no `wtc-id`, a corrupt registry left in place.
 */
export function listWorktrees(io: CoreIo): ListResult {
  const ctx = buildContext({}, { cwd: io.cwd, probeStacks: true, readOnly: true });
  const warnings = [...ctx.warnings];
  const stacks = ctx.stacks!;

  const rows: ListRow[] = [];
  for (const wt of ctx.worktrees) {
    const allocations = safeAllocate(ctx, wt.index);
    const state = stacks.state(wt.project);
    rows.push({
      index: wt.index,
      branch: wt.branch,
      path: wt.path,
      project: wt.project,
      status: stackStatus(state),
      running: state?.running ?? null,
      total: state?.total ?? null,
      url: pickUrl(allocations),
      ports: portsByLabel(allocations),
      orphan: false,
      unavailable: null,
    });
  }
  for (const u of ctx.unavailable) {
    const allocations = safeAllocate(ctx, u.index);
    const state = stacks.state(u.project);
    rows.push({
      index: u.index,
      branch: u.branch,
      path: u.path,
      project: u.project,
      status: stackStatus(state),
      running: state?.running ?? null,
      total: state?.total ?? null,
      url: null,
      ports: portsByLabel(allocations),
      orphan: false,
      unavailable: u.reason,
    });
  }
  for (const o of ctx.orphans) {
    const allocations = safeAllocate(ctx, o.index);
    const state = stacks.state(o.project);
    rows.push({
      index: o.index,
      branch: o.branch,
      path: o.path,
      project: o.project,
      status: stackStatus(state),
      running: state?.running ?? null,
      total: state?.total ?? null,
      url: null,
      ports: portsByLabel(allocations),
      orphan: true,
      unavailable: null,
    });
  }
  rows.sort((a, b) => a.index - b.index);

  if (rows.length > 0 && stacks.problem) warnings.push(stacks.problem);

  return {
    rows,
    mainPorts: allocatableMappings(ctx.portMappings, ctx.remap?.ports).map((m) => ({
      service: m.serviceName,
      port: m.defaultPort,
    })),
    warnings,
    isolationWarnings: ctx.isolationWarnings,
  };
}
