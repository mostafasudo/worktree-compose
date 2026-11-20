import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { addWorktree, commitAll, makeRepo, write } from "../helpers/git.js";
import { installFakeEngine } from "../helpers/fake-engine.js";

type Content = { text: string }[];

async function connect(): Promise<Client> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("MCP server", () => {
  let client: Client;
  let outside: string;
  const cwd = process.cwd();

  beforeAll(async () => {
    outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-mcp-")));
    process.chdir(outside);
    client = await connect();
  });

  afterAll(async () => {
    await client.close();
    process.chdir(cwd);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("registers every tool with annotations", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      "wtc_clean",
      "wtc_doctor",
      "wtc_list",
      "wtc_promote",
      "wtc_prune",
      "wtc_restart",
      "wtc_start",
      "wtc_stop",
    ]);
    expect(byName.wtc_list.annotations?.readOnlyHint).toBe(true);
    expect(byName.wtc_doctor.annotations?.readOnlyHint).toBe(true);
    expect(byName.wtc_clean.annotations?.destructiveHint).toBe(true);
    expect(byName.wtc_prune.annotations?.destructiveHint).toBe(true);
    // Promote overwrites and deletes files in the target checkout.
    expect(byName.wtc_promote.annotations?.destructiveHint).toBe(true);
    expect(byName.wtc_stop.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(byName.wtc_stop.description).toMatch(/compose stop/);

    const indices = (byName.wtc_start.inputSchema.properties as Record<string, { description?: string }>).indices;
    expect(indices.description).toMatch(/branch names, or directory names/);
    expect(Object.keys(byName.wtc_clean.inputSchema.properties ?? {}).sort()).toEqual([
      "dryRun",
      "force",
      "keepWorktrees",
      "sweep",
    ]);
  });

  it("returns isError with a readable message instead of throwing", async () => {
    const result = await client.callTool({ name: "wtc_list", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Content).map((c) => c.text).join("\n");
    expect(text).toContain("Not inside a git repository");
  });
});

describe("MCP tools wired to core operations (fake engine)", () => {
  let base: string;
  let root: string;
  let engine: ReturnType<typeof installFakeEngine>;
  let client: Client;
  const cwd = process.cwd();

  beforeEach(async () => {
    ({ base, root } = makeRepo("mcprepo"));
    write(
      root,
      "compose.yaml",
      'services:\n  web:\n    image: nginx\n    ports:\n      - "${WEB_PORT:-8080}:80"\n  cache:\n    image: redis\n    ports:\n      - "6379:6379"\n',
    );
    commitAll(root, "compose");
    engine = installFakeEngine(base);
    process.chdir(root);
    client = await connect();
  });

  afterEach(async () => {
    await client.close();
    process.chdir(cwd);
    engine.restore();
    fs.rmSync(base, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, content: result.content as Content };
  }

  it("wtc_list: the first item is pure JSON, warnings follow separately", async () => {
    addWorktree(root, base, "mcprepo-a", "feat-a");
    const result = await call("wtc_list");
    expect(result.isError).toBe(false);
    const rows = JSON.parse(result.content[0].text) as { branch: string; index: number }[];
    expect(rows).toMatchObject([{ index: 1, branch: "feat-a" }]);
    // The raw port, and why it is not remapped at runtime (the fake engine
    // does not apply compose's !override / !reset tags).
    expect(result.content.slice(1).map((c) => c.text)).toContain("⚠ 2 isolation warning(s) — run wtc_doctor");
  });

  it("wtc_list is read-only: no registry, no wtc-id, a corrupt registry left in place", async () => {
    const wt = addWorktree(root, base, "mcprepo-a", "feat-a");
    const rows = JSON.parse((await call("wtc_list")).content[0].text) as { index: number }[];
    expect(rows).toMatchObject([{ index: 1 }]);
    expect(fs.existsSync(path.join(root, ".git", "wtc"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".git", "worktrees", path.basename(wt), "wtc-id"))).toBe(false);

    const state = path.join(root, ".git", "wtc", "state.json");
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, "{not json");
    const listed = await call("wtc_list");
    expect(listed.isError).toBe(false);
    expect(listed.content.map((c) => c.text).join("\n")).toMatch(/Left in place/);
    expect(fs.readFileSync(state, "utf-8")).toBe("{not json");
    expect(fs.readdirSync(path.dirname(state)).filter((f) => f.includes(".bak-"))).toEqual([]);
  });

  it("wtc_promote accepts a branch name", async () => {
    const wt = addWorktree(root, base, "mcprepo-a", "feat-a");
    write(wt, "feature.txt", "from the worktree\n");
    commitAll(wt, "feature");
    const result = await call("wtc_promote", { index: "feat-a" });
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(root, "feature.txt"), "utf-8")).toBe("from the worktree\n");
  });

  it("wtc_clean: dryRun changes nothing, keepWorktrees keeps, force removes dirty worktrees", async () => {
    const wt = addWorktree(root, base, "mcprepo-a", "feat-a");
    write(wt, "unsaved.txt", "work\n");

    expect((await call("wtc_clean", { dryRun: true, force: true })).isError).toBe(false);
    expect(fs.existsSync(wt)).toBe(true);
    expect(engine.composeLog()).toEqual([]);

    await call("wtc_clean", { keepWorktrees: true, force: true });
    expect(fs.existsSync(wt)).toBe(true);
    expect(engine.composeLog()).toEqual(["-p mcprepo-wt-1-feat-a down -v --remove-orphans"]);

    const kept = await call("wtc_clean", {});
    expect(fs.existsSync(wt)).toBe(true);
    expect(kept.content.map((c) => c.text).join("\n")).toMatch(/uncommitted changes \(unsaved\.txt\)/);

    await call("wtc_clean", { force: true });
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("wtc_prune: dryRun makes no compose calls, a real run tears the orphan down", async () => {
    const wt = addWorktree(root, base, "mcprepo-a", "feat-a");
    await call("wtc_stop"); // records the worktree (wtc_list never writes)
    const before = engine.composeLog().length;
    fs.rmSync(wt, { recursive: true, force: true });

    await call("wtc_prune", { dryRun: true });
    expect(engine.composeLog().slice(before)).toEqual([]);
    expect((await call("wtc_prune")).isError).toBe(false);
    expect(engine.composeLog().slice(before)).toEqual(["-p mcprepo-wt-1-feat-a down -v --remove-orphans"]);
  });

  it("wtc_start honours build:false and reports progress when asked", async () => {
    addWorktree(root, base, "mcprepo-a", "feat-a");
    const messages: string[] = [];
    const result = await client.callTool(
      { name: "wtc_start", arguments: { build: false } },
      undefined,
      { onprogress: (p) => messages.push(String(p.message)) },
    );
    expect(result.isError).toBeFalsy();
    expect(engine.composeLog()).toEqual(["-p mcprepo-wt-1-feat-a up -d"]);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("wtc_stop / wtc_clean return isError when compose fails", async () => {
    addWorktree(root, base, "mcprepo-a", "feat-a");
    engine.failCompose(true);
    const stop = await call("wtc_stop");
    expect(stop.isError).toBe(true);
    expect(stop.content.map((c) => c.text).join("\n")).toMatch(/Could not stop mcprepo-wt-1-feat-a/);
    expect((await call("wtc_clean", { keepWorktrees: true })).isError).toBe(true);
    expect((await call("wtc_clean", { keepWorktrees: true, dryRun: true })).isError).toBe(false);
  });
});

/** Polls until `check` passes (or fails after `ms`). */
async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("MCP concurrency and cancellation (fake engine)", () => {
  let base: string;
  let root: string;
  let engine: ReturnType<typeof installFakeEngine>;
  let client: Client;
  const cwd = process.cwd();

  beforeEach(async () => {
    ({ base, root } = makeRepo("mcpslow"));
    write(root, "compose.yaml", "services:\n  web:\n    image: nginx\n");
    commitAll(root, "compose");
    engine = installFakeEngine(base);
    process.chdir(root);
    client = await connect();
  });

  afterEach(async () => {
    await client.close();
    process.chdir(cwd);
    engine.restore();
    fs.rmSync(base, { recursive: true, force: true });
  });

  /** `compose up` takes `ms`, then appends `<label>` to <base>/events (sleeping synchronously). */
  function slowUp(ms: number, label: string): string {
    const events = path.join(base, "events");
    engine.setComposeHook(
      `const fs = require("fs");
module.exports = (args) => {
  if (!args.includes("up")) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});
  fs.appendFileSync(${JSON.stringify(events)}, ${label} + "\\n");
};`,
    );
    return events;
  }

  it("serializes mutating tools: a promote waits for a running start", async () => {
    const wt = addWorktree(root, base, "mcpslow-a", "feat-a");
    write(wt, "feature.txt", "from the worktree\n");
    commitAll(wt, "feature");
    const promoted = path.join(root, "feature.txt");
    // Records, when compose up ends, whether the promote already ran.
    const events = slowUp(800, `"up done; promoted=" + fs.existsSync(${JSON.stringify(promoted)})`);

    const start = client.callTool({ name: "wtc_start", arguments: { build: false } });
    await waitFor(() => engine.composeLog().some((l) => l.endsWith(" up -d")));
    const promote = client.callTool({ name: "wtc_promote", arguments: { index: "feat-a" } });
    const [started, promotedResult] = await Promise.all([start, promote]);

    expect(started.isError).toBeFalsy();
    expect(promotedResult.isError).toBeFalsy();
    expect(fs.readFileSync(events, "utf-8").trim()).toBe("up done; promoted=false");
    expect(fs.existsSync(promoted)).toBe(true);
  }, 20_000);

  it("a request cancelled while it waits its turn never runs", async () => {
    const wt = addWorktree(root, base, "mcpslow-a", "feat-a");
    write(wt, "feature.txt", "from the worktree\n");
    commitAll(wt, "feature");
    const promoted = path.join(root, "feature.txt");
    slowUp(1_000, `"up done"`);

    const start = client.callTool({ name: "wtc_start", arguments: { build: false } });
    await waitFor(() => engine.composeLog().some((l) => l.endsWith(" up -d")));
    const controller = new AbortController();
    const promote = client
      .callTool({ name: "wtc_promote", arguments: { index: "feat-a" } }, undefined, { signal: controller.signal })
      .then(
        () => "resolved",
        () => "rejected",
      );
    controller.abort();
    expect(await promote).toBe("rejected");
    expect((await start).isError).toBeFalsy();
    // The queue is serial: once a later call has run, the cancelled promote had its turn.
    engine.setComposeHook(null);
    expect((await client.callTool({ name: "wtc_stop", arguments: {} })).isError).toBeFalsy();
    expect(fs.existsSync(promoted)).toBe(false);
  }, 20_000);

  it("cancelling a request kills the running compose command", async () => {
    addWorktree(root, base, "mcpslow-a", "feat-a");
    const events = slowUp(1_500, `"up finished"`);
    const controller = new AbortController();
    const call = client
      .callTool({ name: "wtc_start", arguments: { build: false } }, undefined, { signal: controller.signal })
      .then(
        () => "resolved",
        () => "rejected",
      );
    await waitFor(() => engine.composeLog().length > 0);
    controller.abort();
    expect(await call).toBe("rejected");

    // The fake compose would have written its event after 1.5 s had it not been killed.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(fs.existsSync(events)).toBe(false);

    // The server is free again: the next mutating call is not stuck behind the cancelled one.
    engine.setComposeHook(null);
    const again = await client.callTool({ name: "wtc_stop", arguments: {} });
    expect(again.isError).toBeFalsy();
  }, 20_000);
});

describe("wtc mcp over stdio", () => {
  it("writes nothing but JSON-RPC to stdout", async () => {
    const { base, root } = makeRepo("stdiorepo");
    const engine = installFakeEngine(base);
    try {
      write(root, "compose.yaml", 'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n');
      commitAll(root, "compose");
      addWorktree(root, base, "stdiorepo-a", "feat-a");
      const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
      const cli = path.join(process.cwd(), "src", "cli.ts");
      const child = spawn(tsx, [cli, "mcp"], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });

      let stdout = "";
      child.stdout.setEncoding("utf-8");
      const answered = new Promise<void>((resolve) => {
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes('"id":3')) resolve();
        });
      });
      const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + "\n");
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "wtc_list", arguments: {} } });
      await answered;
      child.kill();

      const lines = stdout.split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) {
        expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
      }
    } finally {
      engine.restore();
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);
});
