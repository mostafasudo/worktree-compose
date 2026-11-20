import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { startWorktrees } from "../core/start.js";
import { restartWorktrees } from "../core/restart.js";
import { stopWorktrees } from "../core/stop.js";
import { listWorktrees } from "../core/list.js";
import { promoteWorktree } from "../core/promote.js";
import { clean } from "../core/clean.js";
import { prune } from "../core/prune.js";
import { doctor } from "../core/doctor.js";
import { throwIfAborted } from "../core/compose.js";
import { CollectingReporter } from "../utils/log.js";
import { VERSION } from "../version.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { CoreIo } from "../core/types.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** What an operation hands back besides its progress lines. */
interface ToolOutcome {
  /** Extra content items, each its own text block (e.g. pure JSON first). */
  extra?: string[];
  /** The operation ran but something failed (a stack could not be stopped…). */
  isError?: boolean;
}

function text(...parts: (string | undefined)[]): ToolResult {
  return {
    content: parts
      .filter((p): p is string => p !== undefined && p !== "")
      .map((p) => ({ type: "text" as const, text: p })),
  };
}

const PROGRESS_INTERVAL_MS = 5_000;

/**
 * Progress notifications for a request that asked for them (progressToken):
 * one per reported line, throttled, plus a heartbeat carrying the latest
 * compose output line while a long `up --build` runs.
 */
function progressSender(extra: Extra | undefined): {
  note: (message: string) => void;
  stop: () => void;
} {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra) return { note: () => {}, stop: () => {} };
  let count = 0;
  let last = "";
  let lastSent = 0;
  const send = (message: string) => {
    lastSent = Date.now();
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: ++count, message },
      })
      .catch(() => {});
  };
  const timer = setInterval(() => {
    if (Date.now() - lastSent >= PROGRESS_INTERVAL_MS && last) send(last);
  }, PROGRESS_INTERVAL_MS);
  timer.unref?.();
  return {
    note: (message: string) => {
      last = message;
      if (Date.now() - lastSent >= 1_000) send(message);
    },
    stop: () => clearInterval(timer),
  };
}

/**
 * Serializes the tools that change stacks or files (start, stop, restart,
 * clean, prune, promote). A client that times out and retries `wtc_start`
 * must not launch a second `compose up` for the same project while the
 * first is still building, and a promote must not copy files while a clean
 * removes the worktree: each call waits its turn. A request cancelled while
 * it waits never runs.
 */
let mutating: Promise<unknown> = Promise.resolve();
function exclusive<T>(io: CoreIo, fn: () => Promise<T>): Promise<T> {
  const run = () => {
    throwIfAborted(io);
    return fn();
  };
  const next = mutating.then(run, run);
  mutating = next.catch(() => {});
  return next;
}

/**
 * Run an operation with a collecting reporter. Handlers never throw: errors
 * come back as `isError: true` with the progress so far plus the message
 * (which includes compose's stderr tail on compose failures). The request's
 * abort signal cancels running compose commands.
 */
async function runTool(
  extra: Extra | undefined,
  fn: (reporter: CollectingReporter, io: CoreIo) => Promise<ToolOutcome | void>,
): Promise<ToolResult> {
  const progress = progressSender(extra);
  const reporter = new CollectingReporter((line) => progress.note(line));
  // Compose output is captured, never streamed: stdout is the JSON-RPC channel.
  const io: CoreIo = { live: false, signal: extra?.signal, onOutput: (line) => progress.note(line) };
  try {
    const outcome = (await fn(reporter, io)) ?? {};
    const result = text(reporter.text(), ...(outcome.extra ?? []));
    if (result.content.length === 0) result.content.push({ type: "text", text: "Done." });
    return outcome.isError ? { ...result, isError: true } : result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...text(reporter.text(), `Error: ${msg}`), isError: true };
  } finally {
    progress.stop();
  }
}

const worktreesSchema = z
  .array(z.union([z.number().int(), z.string()]))
  .optional()
  .describe(
    "Worktrees to act on: indices, branch names, or directory names (as shown by wtc_list). Omit for all.",
  );

const envFileSchema = z
  .string()
  .optional()
  .describe(
    'Env filename to copy and inject, e.g. ".env.development". Omit to use the configured "envFile" (.wtcrc.json / package.json#wtc), else ".env".',
  );

const workspacesSchema = z
  .array(z.string())
  .optional()
  .describe("Monorepo workspaces (by package name, directory, or path) that also get env injected.");

const buildSchema = z
  .boolean()
  .optional()
  .describe("Rebuild images (docker compose up --build). Default: true.");

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "worktree-compose",
    version: VERSION,
  });

  server.registerTool(
    "wtc_start",
    {
      title: "Start worktree stacks",
      description:
        "Start Docker Compose stacks for worktrees. Syncs compose/infra files from the main checkout, injects isolated ports and COMPOSE_PROJECT_NAME into env files, remaps hardcoded host ports and container_name through a generated compose override (the compose file is never edited), runs compose up -d. Sends progress notifications when the request carries a progressToken; cancelling the request stops compose.",
      inputSchema: {
        indices: worktreesSchema,
        envFile: envFileSchema,
        workspaces: workspacesSchema,
        build: buildSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ indices, envFile, workspaces, build }, extra) =>
      runTool(extra, (reporter, io) =>
        exclusive(io, async () => {
          await startWorktrees({ worktrees: indices, envFile, workspaces, build }, reporter, io);
        }),
      ),
  );

  server.registerTool(
    "wtc_stop",
    {
      title: "Stop worktree stacks",
      description:
        "Stop the containers of worktree stacks (compose stop). Containers, networks and volumes are kept; wtc_start resumes them. To remove a stack and its volumes, use wtc_clean / wtc_prune.",
      inputSchema: { indices: worktreesSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ indices }, extra) =>
      runTool(extra, (reporter, io) =>
        exclusive(io, async () => {
          const result = await stopWorktrees({ worktrees: indices }, reporter, io);
          return { isError: result.failures > 0 };
        }),
      ),
  );

  server.registerTool(
    "wtc_restart",
    {
      title: "Restart worktree stacks",
      description:
        "Restart Docker Compose stacks for worktrees (compose stop, then re-sync files and env and compose up -d, which recreates changed services). Use after DB migrations, Dockerfile changes, or config updates.",
      inputSchema: {
        indices: worktreesSchema,
        envFile: envFileSchema,
        workspaces: workspacesSchema,
        build: buildSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ indices, envFile, workspaces, build }, extra) =>
      runTool(extra, (reporter, io) =>
        exclusive(io, async () => {
          await restartWorktrees({ worktrees: indices, envFile, workspaces, build }, reporter, io);
        }),
      ),
  );

  server.registerTool(
    "wtc_list",
    {
      title: "List worktrees",
      description:
        "List worktrees with index, branch, path, compose project, status (up/partial/exited/down/?), running/total containers, URL, and ports. The first content item is the JSON array (same as `wtc list --json`); warnings follow as separate items. Rows with orphan=true are removed worktrees whose stack or record remains (clean up with wtc_prune); rows with unavailable set (\"missing\": a locked worktree whose directory is missing, e.g. an unmounted drive; \"main\": it became the main checkout) still exist and are left alone by wtc_prune and wtc_clean. Read-only: never writes wtc's registry.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) =>
      runTool(extra, async () => {
        const result = listWorktrees({ live: false });
        return {
          extra: [
            JSON.stringify(result.rows, null, 2),
            ...result.warnings.map((w) => `⚠ ${w}`),
            ...(result.isolationWarnings.length > 0
              ? [`⚠ ${result.isolationWarnings.length} isolation warning(s) — run wtc_doctor`]
              : []),
          ],
        };
      }),
  );

  server.registerTool(
    "wtc_promote",
    {
      title: "Promote worktree changes",
      description:
        "Copy changed files (committed, staged, unstaged, untracked) from a worktree into the checkout the server runs in, as uncommitted changes; files the worktree deleted are deleted there. Aborts if any of those files has local changes there, or was also changed (committed) on that branch since the worktree branched — unless force is set.",
      inputSchema: {
        index: z
          .union([z.number().int(), z.string()])
          .describe("Worktree to promote: index, branch name, or directory name."),
        force: z
          .boolean()
          .optional()
          .describe(
            "Also overwrite files the target branch changed since the worktree branched (reverting those commits). Default: false.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ index, force }, extra) =>
      runTool(extra, (reporter, io) =>
        exclusive(io, async () => {
          await promoteWorktree({ worktree: index, force }, reporter, io);
        }),
      ),
  );

  server.registerTool(
    "wtc_clean",
    {
      title: "Clean up all worktree stacks",
      description:
        "Tear down every worktree stack (down -v: deletes their volumes), remove worktrees that hold no work of their own (no uncommitted changes, no commits on a detached HEAD, no unpushed submodule commits; never the current one or the main checkout), remove leftover containers/networks/volumes of stacks this checkout owns, and prune. Stacks merely named like this repo's (e.g. another clone with the same directory name) are listed, never removed. Returns isError when a teardown or removal failed. Use dryRun first to preview.",
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe("Also remove worktrees with uncommitted or unreachable work, and locked ones. Default: false."),
        keepWorktrees: z
          .boolean()
          .optional()
          .describe("Tear down stacks (deleting their volumes) but keep every worktree. Default: false."),
        dryRun: z
          .boolean()
          .optional()
          .describe("Only report what would happen; changes nothing (not even wtc's registry). Default: false."),
        sweep: z
          .boolean()
          .optional()
          .describe(
            "Also remove <repo>-wt-N-* stacks whose worktree directory no longer exists (e.g. left by wtc 0.2), judged from their containers: volumes or networks with no container left are listed, never removed. Never a stack whose directory exists. Default: false.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ force, keepWorktrees, dryRun, sweep }, extra) =>
      runTool(extra, (reporter, io) =>
        exclusive(io, async () => {
          const result = await clean({ force, keepWorktrees, dryRun, sweep }, reporter, io);
          return { isError: result.failures > 0 };
        }),
      ),
  );

  server.registerTool(
    "wtc_prune",
    {
      title: "Prune removed worktrees",
      description:
        "Tear down (down -v) and forget the stacks of worktrees that were deleted with git worktree remove or rm -rf. Live worktrees are not touched. Returns isError when a teardown failed.",
      inputSchema: {
        dryRun: z
          .boolean()
          .optional()
          .describe("Only report what would happen; changes nothing (not even wtc's registry). Default: false."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ dryRun }, extra) =>
      runTool(extra, (reporter, io) =>
        exclusive(io, async () => {
          const result = await prune({ dryRun }, reporter, io);
          return { isError: result.failures > 0 };
        }),
      ),
  );

  server.registerTool(
    "wtc_doctor",
    {
      title: "Diagnose setup",
      description:
        "Check git, compose file, config, compose engine and daemon, port isolation, isolation-breaking settings (container_name, shared volumes/networks), port collisions, missing worktrees, orphaned stacks, and busy ports. Returns JSON.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) =>
      runTool(extra, async () => {
        const result = await doctor({ live: false });
        return { extra: [JSON.stringify(result, null, 2)] };
      }),
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
