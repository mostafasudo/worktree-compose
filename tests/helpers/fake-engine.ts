import fs from "node:fs";
import path from "node:path";
import { resetEngineCache } from "../../src/compose/engine.js";
import { resetRemapProbeCache } from "../../src/compose/override.js";

/**
 * A fake `podman` on PATH: `ps -a --format json` prints the JSON array
 * stored in `<dir>/ps.json` (other `ps` forms print nothing), `compose …`
 * appends its argv to `<dir>/compose.log` (and fails while
 * `<dir>/compose.fail` exists), `network`/`volume ls` print `[]`,
 * `info`/`version` succeed. Lets list/doctor/clean run without a container
 * engine — and guarantees tests never touch a real one. A compose hook
 * (`setComposeHook`) runs inside each compose call, after it is logged.
 */
export function installFakeEngine(dir: string): {
  setContainers: (containers: unknown[]) => void;
  composeLog: () => string[];
  /** Make every compose call fail (true) or succeed again (false). */
  failCompose: (fail: boolean) => void;
  /**
   * CommonJS module source exporting `(args: string[]) => void`, run inside
   * every compose call (args after `compose`); `null` removes it.
   */
  setComposeHook: (source: string | null) => void;
  restore: () => void;
} {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(bin, "podman");
  fs.writeFileSync(
    script,
    `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
if (args[0] === "ps") {
  if (args.includes("-q")) process.exit(0);
  const file = path.join(dir, "ps.json");
  process.stdout.write(fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "[]");
} else if (args[0] === "compose") {
  if (args[1] === "version") { console.log("podman-compose version 1.0.0-fake"); process.exit(0); }
  fs.appendFileSync(path.join(dir, "compose.log"), args.slice(1).join(" ") + "\\n");
  const hook = path.join(dir, "compose-hook.cjs");
  if (fs.existsSync(hook)) require(hook)(args.slice(1));
  if (fs.existsSync(path.join(dir, "compose.fail"))) {
    console.error("Error: fake compose failure");
    process.exit(1);
  }
} else if ((args[0] === "network" || args[0] === "volume") && args[1] === "ls") {
  process.stdout.write("[]");
} else if (args[0] === "info" || args[0] === "version") {
  console.log("fake");
}
`,
  );
  fs.chmodSync(script, 0o755);

  const saved = { PATH: process.env.PATH, CMD: process.env.WTC_COMPOSE_COMMAND };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.WTC_COMPOSE_COMMAND = "podman compose";
  resetEngineCache();
  // Every test probes its fake engine afresh (no answer cached by another test).
  resetRemapProbeCache();

  return {
    setContainers: (containers) =>
      fs.writeFileSync(path.join(dir, "ps.json"), JSON.stringify(containers)),
    // The remap engine probe (`-p wtc-remap-probe config`) is setup, not an operation.
    composeLog: () => {
      const file = path.join(dir, "compose.log");
      return fs.existsSync(file)
        ? fs.readFileSync(file, "utf-8").trim().split("\n").filter((l) => !l.includes("wtc-remap-probe"))
        : [];
    },
    failCompose: (fail) => {
      const file = path.join(dir, "compose.fail");
      if (fail) fs.writeFileSync(file, "");
      else fs.rmSync(file, { force: true });
    },
    setComposeHook: (source) => {
      const file = path.join(dir, "compose-hook.cjs");
      if (source === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, source);
    },
    restore: () => {
      process.env.PATH = saved.PATH;
      if (saved.CMD === undefined) delete process.env.WTC_COMPOSE_COMMAND;
      else process.env.WTC_COMPOSE_COMMAND = saved.CMD;
      resetEngineCache();
      resetRemapProbeCache();
    },
  };
}

export function podmanContainer(project: string, state: string, workingDir?: string): unknown {
  return {
    Id: Math.random().toString(16).slice(2),
    Names: [`${project}_svc_1`],
    State: state,
    Labels: {
      "io.podman.compose.project": project,
      "com.docker.compose.project": project,
      ...(workingDir ? { "com.docker.compose.project.working_dir": workingDir } : {}),
    },
  };
}
