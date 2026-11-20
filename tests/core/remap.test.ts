import fs from "node:fs";
import path from "node:path";
import { startWorktrees } from "../../src/core/start.js";
import { stopWorktrees } from "../../src/core/stop.js";
import { prune } from "../../src/core/prune.js";
import { clean } from "../../src/core/clean.js";
import { listWorktrees } from "../../src/core/list.js";
import { doctor } from "../../src/core/doctor.js";
import { overridePath, resetRemapProbeCache } from "../../src/compose/override.js";
import { CollectingReporter, silentReporter } from "../../src/utils/log.js";
import { addWorktree, commitAll, git, makeRepo, write } from "../helpers/git.js";
import { installFakeEngine } from "../helpers/fake-engine.js";

const COMPOSE = [
  "services:",
  "  web:",
  "    image: nginx",
  "    container_name: web",
  "    ports:",
  '      - "8080:80"',
  "  api:",
  "    image: node",
  "    ports:",
  '      - "${API_PORT:-3000}:3000"',
  "",
].join("\n");

/**
 * Compose hook for the fake engine: answers the remap probe like an engine
 * that applies `!override` / `!reset`, and records the COMPOSE_FILE every
 * other compose call ran with.
 */
function remapHook(base: string): string {
  return `
const fs = require("fs");
module.exports = (args) => {
  if (args.includes("config")) {
    process.stdout.write('services:\\n  probe:\\n    image: x\\n    ports:\\n    - "2:1"\\n');
    return;
  }
  fs.appendFileSync(${JSON.stringify(path.join(base, "calls.log"))},
    JSON.stringify({ args: args.join(" "), composeFile: process.env.COMPOSE_FILE || null }) + "\\n");
};
`;
}

describe("runtime remapping of hardcoded ports and container_name (fake engine)", () => {
  let base: string;
  let root: string;
  let wt: string;
  let engine: ReturnType<typeof installFakeEngine>;
  let savedComposeFile: string | undefined;
  const project = "remaprepo-wt-1-feat";

  beforeEach(() => {
    savedComposeFile = process.env.COMPOSE_FILE;
    delete process.env.COMPOSE_FILE;
    resetRemapProbeCache();
    ({ base, root } = makeRepo("remaprepo"));
    write(root, "compose.yaml", COMPOSE);
    write(root, ".gitignore", ".env\n");
    commitAll(root, "compose");
    write(root, ".env", "SECRET=main-secret\n");
    wt = addWorktree(root, base, "remaprepo-feat", "feat");
    engine = installFakeEngine(base);
  });

  afterEach(() => {
    engine.restore();
    resetRemapProbeCache();
    if (savedComposeFile === undefined) delete process.env.COMPOSE_FILE;
    else process.env.COMPOSE_FILE = savedComposeFile;
    fs.rmSync(base, { recursive: true, force: true });
  });

  function calls(): { args: string; composeFile: string | null }[] {
    const file = path.join(base, "calls.log");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  }

  const override = () => overridePath(path.join(root, ".git"), project);
  const files = (...paths: string[]) => paths.join(path.delimiter);

  it("start remaps through a generated override and COMPOSE_FILE, leaving the compose file untouched", async () => {
    engine.setComposeHook(remapHook(base));
    const reporter = new CollectingReporter();

    const result = await startWorktrees({ worktrees: ["feat"], build: false }, reporter, { live: false, cwd: root });

    expect(result.started[0].ports).toEqual({ "web:8080": 28081, API_PORT: 23001 });
    expect(engine.composeLog()).toEqual(["-p wtc-remap-probe config", `-p ${project} up -d`]);
    const composeFile = files(path.join(wt, "compose.yaml"), override());
    expect(calls()).toEqual([{ args: `-p ${project} up -d`, composeFile }]);

    const yaml = fs.readFileSync(override(), "utf-8");
    expect(yaml).toContain("ports: !override");
    expect(yaml).toContain('- "28081:80"');
    expect(yaml).toContain("container_name: !reset null");
    expect(yaml).not.toContain("api:");

    // Plain `docker compose` in the worktree loads the same files.
    const env = fs.readFileSync(path.join(wt, ".env"), "utf-8");
    expect(env).toContain(`COMPOSE_FILE=${composeFile}\n`);
    expect(env).toContain(`COMPOSE_PROJECT_NAME=${project}\n`);
    expect(env).toContain("API_PORT=23001\n");
    expect(env).not.toMatch(/WEB/);

    expect(fs.readFileSync(path.join(root, "compose.yaml"), "utf-8")).toBe(COMPOSE);
    expect(fs.readFileSync(path.join(wt, "compose.yaml"), "utf-8")).toBe(COMPOSE);
    expect(git(wt, "status", "--porcelain")).toBe("");

    const lines = reporter.lines.join("\n");
    expect(lines).toContain(
      "Remapping hardcoded host ports per worktree at runtime (your compose file is unchanged): web 8080:80.",
    );
    expect(lines).toContain('Dropping fixed container names per worktree at runtime (your compose file is unchanged): web ("web").');
    expect(lines).toContain("Ports:   API_PORT=23001 web:8080=28081");
    expect(lines).not.toMatch(/⚠/);
  });

  it("stop and prune use the same compose files; prune deletes the override with the stack", async () => {
    engine.setComposeHook(remapHook(base));
    await startWorktrees({ worktrees: ["feat"], build: false }, silentReporter, { live: false, cwd: root });
    await stopWorktrees({ worktrees: ["feat"] }, silentReporter, { live: false, cwd: root });
    expect(calls()[1]).toEqual({
      args: `-p ${project} stop`,
      composeFile: files(path.join(wt, "compose.yaml"), override()),
    });

    git(root, "worktree", "remove", "--force", wt);
    const result = await prune({}, silentReporter, { live: false, cwd: root });
    expect(result.failures).toBe(0);
    // The worktree is gone: torn down from the main checkout, with the override.
    expect(calls()[2]).toEqual({
      args: `-p ${project} down -v --remove-orphans`,
      composeFile: files(path.join(root, "compose.yaml"), override()),
    });
    expect(fs.existsSync(override())).toBe(false);
  });

  it("keeps the worktree's own compose override in the list and leaves alone what it sets", async () => {
    engine.setComposeHook(remapHook(base));
    const userOverride = write(wt, "compose.override.yaml", 'services:\n  web:\n    ports:\n      - "9090:80"\n');
    const reporter = new CollectingReporter();

    const result = await startWorktrees({ worktrees: ["feat"], build: false }, reporter, { live: false, cwd: root });

    expect(calls()[0].composeFile).toBe(files(path.join(wt, "compose.yaml"), userOverride, override()));
    expect(result.started[0].ports).toEqual({ API_PORT: 23001 });
    const yaml = fs.readFileSync(override(), "utf-8");
    expect(yaml).not.toContain("ports:");
    expect(yaml).toContain("container_name: !reset null");
    expect(reporter.lines).toContain(
      '⚠ Service "web": compose.override.yaml also sets its ports, so wtc does not remap its hardcoded ports.',
    );
  });

  it("keeps remapping when the shell exported the worktree's COMPOSE_FILE (direnv)", async () => {
    engine.setComposeHook(remapHook(base));
    await startWorktrees({ worktrees: ["feat"], build: false }, silentReporter, { live: false, cwd: root });
    const exported = /^COMPOSE_FILE=(.*)$/m.exec(fs.readFileSync(path.join(wt, ".env"), "utf-8"))![1];
    process.env.COMPOSE_FILE = exported;

    const reporter = new CollectingReporter();
    const result = await startWorktrees({ worktrees: ["."], build: false }, reporter, { live: false, cwd: wt });

    expect(result.started[0].ports).toEqual({ "web:8080": 28081, API_PORT: 23001 });
    expect(calls()[1].composeFile).toBe(exported);
    expect(reporter.lines.join("\n")).not.toMatch(/COMPOSE_FILE is set/);
  });

  it("falls back to warnings when the engine does not apply the tags", async () => {
    const reporter = new CollectingReporter();

    const result = await startWorktrees({ worktrees: ["feat"], build: false }, reporter, { live: false, cwd: root });

    expect(result.started[0].ports).toEqual({ API_PORT: 23001 });
    expect(fs.existsSync(override())).toBe(false);
    expect(fs.readFileSync(path.join(wt, ".env"), "utf-8")).not.toContain("COMPOSE_FILE");
    const lines = reporter.lines.join("\n");
    expect(lines).toContain(
      "⚠ wtc cannot remap hardcoded ports or container_name at runtime: podman compose does not apply compose's !override / !reset tags (Docker Compose 2.24.4 or newer does).",
    );
    expect(lines).toContain('⚠ Service "web" uses a raw port mapping (8080:80).');
    expect(lines).toContain('⚠ Service "web" sets container_name "web"');
  });

  it("removes a stale override when a start no longer needs one", async () => {
    engine.setComposeHook(remapHook(base));
    await startWorktrees({ worktrees: ["feat"], build: false }, silentReporter, { live: false, cwd: root });
    expect(fs.existsSync(override())).toBe(true);

    write(root, "compose.yaml", 'services:\n  web:\n    image: nginx\n    ports:\n      - "${WEB_PORT:-8080}:80"\n');
    await startWorktrees({ worktrees: ["feat"], build: false }, silentReporter, { live: false, cwd: root });

    expect(fs.existsSync(override())).toBe(false);
    expect(calls()[1].composeFile).toBeNull();
    expect(fs.readFileSync(path.join(wt, ".env"), "utf-8")).not.toContain("COMPOSE_FILE");
  });

  it("list and doctor show the remapped ports", async () => {
    engine.setComposeHook(remapHook(base));

    const list = listWorktrees({ live: false, cwd: root });
    expect(list.rows[0].ports).toEqual({ "web:8080": 28081, API_PORT: 23001 });
    expect(list.rows[0].url).toBe("http://localhost:28081");
    expect(list.mainPorts).toEqual([
      { service: "api", port: 3000 },
      { service: "web", port: 8080 },
    ]);
    expect(list.isolationWarnings).toEqual([]);

    const report = await doctor({ live: false, cwd: root });
    const titles = report.checks.map((c) => `${c.status} ${c.title}`);
    expect(titles).toContain("ok 2 isolatable port(s)");
    expect(titles).toContain("ok Hardcoded settings remapped at runtime (compose file unchanged)");
    expect(titles).toContain("ok No shared volumes/networks (container_name is dropped at runtime)");
    expect(titles.some((t) => t.startsWith("warn"))).toBe(false);
  });

  it("doctor says why it cannot remap", async () => {
    const report = await doctor({ live: false, cwd: root });
    const unavailable = report.checks.find((c) => c.title === "Runtime remapping unavailable");
    expect(unavailable?.status).toBe("warn");
    expect(unavailable?.detail).toMatch(/podman compose does not apply/);
    expect(report.checks.some((c) => c.title === "Raw port mapping (not isolated)")).toBe(true);
  });

  it("drops an inherited COMPOSE_FILE that wtc wrote when a stack does not use one", async () => {
    engine.setComposeHook(remapHook(base));
    await startWorktrees({ worktrees: ["feat"], build: false }, silentReporter, { live: false, cwd: root });
    // direnv exported the worktree's .env; then the hardcoded settings were fixed.
    process.env.COMPOSE_FILE = /^COMPOSE_FILE=(.*)$/m.exec(fs.readFileSync(path.join(wt, ".env"), "utf-8"))![1];
    write(root, "compose.yaml", 'services:\n  web:\n    image: nginx\n    ports:\n      - "${WEB_PORT:-8080}:80"\n');

    await startWorktrees({ worktrees: ["feat"], build: false }, silentReporter, { live: false, cwd: wt });

    expect(calls()[1]).toEqual({ args: `-p ${project} up -d`, composeFile: null });
  });

  it("leaves a stack alone whose worktree .env sets its own COMPOSE_FILE (custom envFile)", async () => {
    engine.setComposeHook(remapHook(base));
    write(root, ".wtcrc.json", JSON.stringify({ envFile: ".env.local" }));
    write(wt, ".env", "COMPOSE_FILE=compose.yaml:compose.dev.yaml\n");
    const reporter = new CollectingReporter();

    const result = await startWorktrees({ worktrees: ["feat"], build: false }, reporter, { live: false, cwd: root });

    expect(result.started[0].ports).toEqual({ API_PORT: 23001 });
    expect(calls()[0].composeFile).toBeNull();
    expect(reporter.lines).toContain(
      `⚠ ${project}: its .env sets COMPOSE_FILE, so wtc does not remap hardcoded ports or container_name for it.`,
    );
  });

  it("stop uses the override the stack started with, even after main's compose file changed", async () => {
    engine.setComposeHook(remapHook(base));
    await startWorktrees({ worktrees: ["feat"], build: false }, silentReporter, { live: false, cwd: root });
    const started = fs.readFileSync(override(), "utf-8");
    write(root, "compose.yaml", COMPOSE + '  mail:\n    image: mailhog\n    ports:\n      - "8025:8025"\n');

    await stopWorktrees({ worktrees: ["feat"] }, silentReporter, { live: false, cwd: root });

    expect(fs.readFileSync(override(), "utf-8")).toBe(started);
    expect(calls()[1].composeFile).toBe(files(path.join(wt, "compose.yaml"), override()));
  });

  it("clean keeps the override of a worktree it keeps (its .env still lists it)", async () => {
    engine.setComposeHook(remapHook(base));
    await startWorktrees({ worktrees: ["feat"], build: false }, silentReporter, { live: false, cwd: root });

    const result = await clean({ keepWorktrees: true }, silentReporter, { live: false, cwd: root });

    expect(result.failures).toBe(0);
    expect(calls()[1]).toEqual({
      args: `-p ${project} down -v --remove-orphans`,
      composeFile: files(path.join(wt, "compose.yaml"), override()),
    });
    expect(fs.existsSync(override())).toBe(true);
    expect(fs.readFileSync(path.join(wt, ".env"), "utf-8")).toContain(`COMPOSE_FILE=${files(path.join(wt, "compose.yaml"), override())}`);
  });

  it("starts with a hardcoded port that has nowhere to move, leaving it as it is", async () => {
    engine.setComposeHook(remapHook(base));
    write(root, "compose.yaml", COMPOSE + '  edge:\n    image: x\n    ports:\n      - "65500:65500"\n');
    const reporter = new CollectingReporter();

    const result = await startWorktrees({ worktrees: ["feat"], build: false }, reporter, { live: false, cwd: root });

    expect(result.started[0].ports).toEqual({ "web:8080": 28081, API_PORT: 23001 });
    expect(fs.readFileSync(override(), "utf-8")).not.toContain("edge");
    expect(reporter.lines).toContain(
      '⚠ Service "edge": hardcoded host port 65500 has no free port to move to in worktree 1 (ports end at 65535), so it stays 65500.',
    );
  });
});
