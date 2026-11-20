import { jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parseComposeFile } from "../../src/compose/parse.js";
import { engineFromArgv } from "../../src/compose/engine.js";
import {
  composeFileValue,
  decideRemap,
  engineSupportsRemap,
  envFileComposeFile,
  findUserOverride,
  isWtcComposeFile,
  overridePath,
  probeApplied,
  remapCandidates,
  renderOverride,
  resetRemapProbeCache,
  withoutUserOverride,
} from "../../src/compose/override.js";
import { extractPortMappings } from "../../src/ports/extract.js";
import { allocateWorktreePorts } from "../../src/ports/allocate.js";
import { runSafe } from "../../src/utils/exec.js";
import { literalEnvValue } from "../../src/sync/env.js";
import type { ComposeEngine } from "../../src/compose/engine.js";
import type { RemapInputs } from "../../src/compose/override.js";

function write(dir: string, rel: string, contents: string): string {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

const COMPOSE = [
  "services:",
  "  web:",
  "    image: nginx",
  "    container_name: web",
  "    ports:",
  '      - "8080:80"',
  '      - "${WEB_TLS_PORT:-8443}:443"',
  '      - "127.0.0.1:2222:22"',
  '      - "53:53/udp"',
  '      - "9229"',
  "      - target: 9000",
  "        published: 9000",
  "        host_ip: 127.0.0.1",
  "        protocol: tcp",
  "      - target: 9100",
  "  db:",
  "    image: postgres",
  "    container_name: ${COMPOSE_PROJECT_NAME:-app}-db",
  "    ports:",
  '      - "5432:5432"',
  "  ftp:",
  "    image: ftp",
  "    ports:",
  '      - "21000-21010:21000-21010"',
  "",
].join("\n");

/** A fake compose executable: `config` prints `<dir>/out` (or `output`); every call appends to `<dir>/calls`. */
function fakeCompose(dir: string, output: string): ComposeEngine {
  write(dir, "out", output);
  const script = write(
    dir,
    "bin/fake-compose",
    `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const dir = ${JSON.stringify(dir)};
fs.appendFileSync(path.join(dir, "calls"), JSON.stringify({
  args: process.argv.slice(2),
  files: (process.env.COMPOSE_FILE || "").split(${JSON.stringify(path.delimiter)}).filter(Boolean).length,
}) + "\\n");
if (process.argv.includes("config")) process.stdout.write(fs.readFileSync(path.join(dir, "out"), "utf-8"));
`,
  );
  fs.chmodSync(script, 0o755);
  return engineFromArgv([script]);
}

const DOCKER_STYLE_APPLIED = [
  "name: wtc-remap-probe",
  "services:",
  "  probe:",
  "    image: wtc-probe",
  "    ports:",
  "      - mode: ingress",
  "        target: 1",
  '        published: "2"',
  "        protocol: tcp",
  "",
].join("\n");

type OverrideDoc = {
  services: Record<string, { ports?: unknown[]; container_name?: unknown; networks?: Record<string, { aliases: string[] }> }>;
};

describe("runtime remapping of hardcoded ports and container_name", () => {
  let tmp: string;
  let savedComposeFile: string | undefined;

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-override-")));
    savedComposeFile = process.env.COMPOSE_FILE;
    delete process.env.COMPOSE_FILE;
    resetRemapProbeCache();
  });

  afterEach(() => {
    if (savedComposeFile === undefined) delete process.env.COMPOSE_FILE;
    else process.env.COMPOSE_FILE = savedComposeFile;
    jest.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function model(text = COMPOSE) {
    const composeFile = parseComposeFile(write(tmp, "compose.yaml", text));
    const mappings = extractPortMappings(composeFile.services);
    return { composeFile, mappings };
  }

  function render(text = COMPOSE): OverrideDoc {
    const { composeFile, mappings } = model(text);
    const { targets } = remapCandidates(composeFile, mappings);
    const allocations = allocateWorktreePorts(mappings, 1, 1, targets.ports);
    return parseYaml(renderOverride("app-wt-1", composeFile, targets, allocations), { logLevel: "silent" }) as OverrideDoc;
  }

  it("picks hardcoded host ports (not ranges) and fixed container names (not project-scoped)", () => {
    const { composeFile, mappings } = model();
    const { targets, skipped } = remapCandidates(composeFile, mappings);
    expect(targets.ports.map((m) => `${m.serviceName} ${m.raw}`)).toEqual([
      "web 8080:80",
      "web 127.0.0.1:2222:22",
      "web 53:53/udp",
      "web 9000:9000",
      "db 5432:5432",
    ]);
    expect(targets.containerNames).toEqual([{ service: "web", name: "web" }]);
    expect(skipped).toEqual([]);
  });

  it("leaves the ports of a service that uses extends alone, and says why", () => {
    const { composeFile, mappings } = model(
      'services:\n  api:\n    extends:\n      file: base.yaml\n      service: api\n    ports:\n      - "3000:3000"\n',
    );
    const { targets, skipped } = remapCandidates(composeFile, mappings);
    expect(targets.ports).toEqual([]);
    expect(skipped).toEqual([
      'Service "api" uses extends, which may bring in ports wtc cannot see, so wtc does not remap its hardcoded ports.',
    ]);
  });

  it("leaves an included service alone when its ports use variables (compose fills them from that file's env)", () => {
    write(tmp, "db/compose.yaml", 'services:\n  db:\n    image: postgres\n    ports:\n      - "5432:5432"\n      - "6432:${PGBOUNCER_PORT}"\n');
    write(tmp, "cache/compose.yaml", 'services:\n  cache:\n    image: redis\n    ports:\n      - "6379:6379"\n');
    const { composeFile, mappings } = model("include:\n  - ./db/compose.yaml\n  - ./cache/compose.yaml\nservices: {}\n");
    const { targets, skipped } = remapCandidates(composeFile, mappings);
    expect(targets.ports.map((m) => m.serviceName)).toEqual(["cache"]);
    expect(skipped).toEqual([
      'Service "db" comes from an included file (compose.yaml) whose port variables compose fills in from that file\'s own env, so wtc does not remap its hardcoded ports.',
    ]);
  });

  it("leaves a port too high to move, and a container name another service joins by name", () => {
    const { composeFile, mappings } = model(
      [
        "services:",
        "  edge:",
        "    image: x",
        '    ports: ["65500:65500"]',
        "  db:",
        "    image: postgres",
        "    container_name: mydb",
        "  vpn:",
        "    image: x",
        "    network_mode: container:mydb",
        "",
      ].join("\n"),
    );
    const { targets, skipped } = remapCandidates(composeFile, mappings);
    expect(targets).toEqual({ ports: [], containerNames: [] });
    expect(skipped).toEqual([
      'Service "edge": hardcoded host port 65500 is too high to move (ports end at 65535), so wtc leaves it.',
      'Service "db": service "vpn" joins container:mydb by name, so wtc does not drop its container_name.',
    ]);
  });

  it("renders the whole ports list with !override, remapping only hardcoded host ports, and !reset for container_name", () => {
    const { composeFile, mappings } = model();
    const { targets } = remapCandidates(composeFile, mappings);
    const allocations = allocateWorktreePorts(mappings, 1, 1, targets.ports);
    const yaml = renderOverride("app-wt-1-feat", composeFile, targets, allocations);

    expect(yaml).toMatch(/^# Generated by wtc for app-wt-1-feat/);
    expect(yaml).toContain("ports: !override");
    expect(yaml).toContain("container_name: !reset null");
    // Quoted, so a YAML 1.1 parser never reads "22223:22" as a base-60 number.
    expect(yaml).toContain('- "127.0.0.1:22223:22"');

    const doc = parseYaml(yaml, { logLevel: "silent" }) as OverrideDoc;
    expect(Object.keys(doc.services)).toEqual(["web", "db"]);
    expect(doc.services.web.ports).toEqual([
      "28081:80",
      "${WEB_TLS_PORT:-8443}:443",
      "127.0.0.1:22223:22",
      "20054:53/udp",
      "9229",
      { target: 9000, published: "29001", host_ip: "127.0.0.1", protocol: "tcp" },
      { target: 9100 },
    ]);
    expect("container_name" in doc.services.web).toBe(true);
    expect(doc.services.db).toEqual({ ports: ["25433:5432"] });
  });

  it("keeps a dropped container_name as an alias on the service's own networks", () => {
    const doc = render(
      [
        "services:",
        "  db:",
        "    image: postgres",
        "    container_name: mydb",
        "  api:",
        "    image: node",
        "    container_name: myapi",
        "    networks: [backend, proxy]",
        "  host:",
        "    image: x",
        "    container_name: myhost",
        "    network_mode: host",
        "  templated:",
        "    image: x",
        "    container_name: ${APP}-x",
        "networks:",
        "  backend:",
        "  proxy:",
        "    external: true",
        "",
      ].join("\n"),
    );
    expect(doc.services.db.networks).toEqual({ default: { aliases: ["mydb"] } });
    // Never on a network every stack shares: the alias would answer for all of them.
    expect(doc.services.api.networks).toEqual({ backend: { aliases: ["myapi"] } });
    expect(doc.services.host.networks).toBeUndefined();
    expect(doc.services.templated.networks).toBeUndefined();
  });

  it("follows extends in the same file before giving the old name an alias", () => {
    const doc = render(
      [
        "services:",
        "  hostnet:",
        "    image: x",
        "    network_mode: host",
        "  backend-base:",
        "    image: x",
        "    networks: [backend]",
        "  a:",
        "    extends: hostnet",
        "    container_name: aname",
        "  b:",
        "    extends: backend-base",
        "    container_name: bname",
        "  c:",
        "    extends:",
        "      file: other.yaml",
        "      service: web",
        "    container_name: cname",
        "networks:",
        "  backend:",
        "",
      ].join("\n"),
    );
    // Inherited network_mode: compose rejects networks next to it.
    expect(doc.services.a.networks).toBeUndefined();
    // Inherited networks: the alias goes there, not onto default.
    expect(doc.services.b.networks).toEqual({ backend: { aliases: ["bname"] } });
    // Another file: wtc cannot see what it brings.
    expect(doc.services.c.networks).toBeUndefined();
    expect("container_name" in doc.services.c).toBe(true);
  });

  it("finds the compose override compose would load, in compose's order", () => {
    expect(findUserOverride(tmp)).toBeNull();
    write(tmp, "docker-compose.override.yml", "services: {}\n");
    write(tmp, "compose.override.yaml", "services: {}\n");
    expect(path.basename(findUserOverride(tmp)!)).toBe("compose.override.yaml");
    write(tmp, "compose.override.yml", "services: {}\n");
    expect(path.basename(findUserOverride(tmp)!)).toBe("compose.override.yml");
  });

  it("leaves alone what the user's own compose override sets for a service", () => {
    const { composeFile, mappings } = model();
    const { targets } = remapCandidates(composeFile, mappings);
    write(tmp, "compose.override.yaml", 'services:\n  web:\n    ports: !reset []\n    container_name: web-dev\n');

    const result = withoutUserOverride(targets, tmp);
    expect(result.targets.ports.map((m) => m.serviceName)).toEqual(["db"]);
    expect(result.targets.containerNames).toEqual([]);
    expect(result.warnings).toEqual([
      'Service "web": compose.override.yaml also sets its ports, so wtc does not remap its hardcoded ports.',
      'Service "web": compose.override.yaml also sets container_name, so wtc does not drop it.',
    ]);
  });

  it("sees ports the user's compose override sets through a YAML merge key", () => {
    const { composeFile, mappings } = model();
    const { targets } = remapCandidates(composeFile, mappings);
    write(tmp, "compose.override.yaml", 'x-debug: &debug\n  ports: ["9229:9229"]\nservices:\n  web:\n    <<: *debug\n');
    expect(withoutUserOverride(targets, tmp).targets.ports.map((m) => m.serviceName)).toEqual(["db"]);
  });

  it("keeps a container name a service in the user's compose override joins by name", () => {
    const { composeFile, mappings } = model();
    const { targets } = remapCandidates(composeFile, mappings);
    write(tmp, "compose.override.yaml", "services:\n  sidecar:\n    image: x\n    network_mode: container:web\n");
    const result = withoutUserOverride(targets, tmp);
    expect(result.targets.containerNames).toEqual([]);
    expect(result.warnings).toEqual([
      'Service "web": service "sidecar" in compose.override.yaml joins container:web by name, so wtc does not drop its container_name.',
    ]);
  });

  it("gives no alias where the user's compose override sets the service's networks", () => {
    const { composeFile, mappings } = model();
    const { targets } = remapCandidates(composeFile, mappings);
    write(tmp, "compose.override.yaml", "services:\n  web:\n    network_mode: host\n");
    expect(withoutUserOverride(targets, tmp).targets.containerNames).toEqual([{ service: "web", name: "web", noAlias: true }]);
  });

  it("remaps nothing when the user's compose override cannot be read", () => {
    const { composeFile, mappings } = model();
    write(tmp, "compose.override.yaml", "services: [\n");
    const result = withoutUserOverride(remapCandidates(composeFile, mappings).targets, tmp);
    expect(result.targets).toEqual({ ports: [], containerNames: [] });
    expect(result.warnings[0]).toMatch(/Could not read compose\.override\.yaml/);
  });

  it("joins COMPOSE_FILE with the platform separator, and refuses a path that contains it", () => {
    expect(composeFileValue(["/a/compose.yaml", "/b/o.yaml"])).toBe(`/a/compose.yaml${path.delimiter}/b/o.yaml`);
    expect(composeFileValue([`/a${path.delimiter}b/compose.yaml`])).toBeNull();
  });

  it("reads the COMPOSE_FILE an env file sets", () => {
    expect(envFileComposeFile(write(tmp, "a.env", "X=1\nCOMPOSE_FILE=compose.yaml:dev.yaml\n"))).toBe("compose.yaml:dev.yaml");
    expect(envFileComposeFile(write(tmp, "b.env", 'export COMPOSE_FILE="compose.yaml"\n'))).toBe("compose.yaml");
    // compose's dotenv parser also takes `KEY: value`.
    expect(envFileComposeFile(write(tmp, "d.env", "COMPOSE_FILE: compose.yaml:dev.yaml\n"))).toBe("compose.yaml:dev.yaml");
    expect(envFileComposeFile(write(tmp, "c.env", "# COMPOSE_FILE=x\nMY_COMPOSE_FILE=y\n"))).toBeNull();
    expect(envFileComposeFile(path.join(tmp, "missing.env"))).toBeNull();
    expect(envFileComposeFile(null)).toBeNull();
  });

  it("writes COMPOSE_FILE so compose reads it literally, $ and ' included", () => {
    expect(literalEnvValue("/w/app/compose.yaml:/g/x.yaml")).toBe("'/w/app/compose.yaml:/g/x.yaml'");
    expect(literalEnvValue("/w/$APP/compose.yaml")).toBe("'/w/$APP/compose.yaml'");
    expect(literalEnvValue("/w/o'brien/$APP/c.yaml")).toBe('"/w/o\'brien/\\$APP/c.yaml"');
  });

  it("reads the probe's config output from docker compose and from podman-compose", () => {
    expect(probeApplied(DOCKER_STYLE_APPLIED)).toBe(true);
    expect(probeApplied('services:\n  probe:\n    image: x\n    ports:\n    - "2:1"\n')).toBe(true);
    // Tags ignored: the hardcoded port is still there, or the name survived.
    expect(probeApplied('services:\n  probe:\n    ports:\n    - "1:1"\n    - "2:1"\n')).toBe(false);
    expect(probeApplied('services:\n  probe:\n    container_name: wtc-probe\n    ports:\n    - "2:1"\n')).toBe(false);
    expect(probeApplied("not: [yaml")).toBe(false);
    expect(probeApplied("")).toBe(false);
  });

  it("probes the engine once, through COMPOSE_FILE, and caches the answer", () => {
    const engine = fakeCompose(tmp, DOCKER_STYLE_APPLIED);
    expect(engineSupportsRemap(engine)).toBe(true);
    expect(engineSupportsRemap(engine)).toBe(true);
    const calls = fs.readFileSync(path.join(tmp, "calls"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(calls).toEqual([{ args: ["-p", "wtc-remap-probe", "config"], files: 2 }]);
  });

  it("reports an engine that ignores the tags as unsupported, and probes again after a minute", () => {
    const engine = fakeCompose(tmp, 'services:\n  probe:\n    container_name: wtc-probe\n    ports:\n    - "1:1"\n    - "2:1"\n');
    const now = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(now);
    expect(engineSupportsRemap(engine)).toBe(false);

    write(tmp, "out", DOCKER_STYLE_APPLIED);
    expect(engineSupportsRemap(engine)).toBe(false);
    clock.mockReturnValue(now + 61_000);
    expect(engineSupportsRemap(engine)).toBe(true);
  });

  describe("decideRemap", () => {
    function inputs(engine: () => ComposeEngine, extra: Partial<RemapInputs> = {}): RemapInputs {
      const { composeFile, mappings } = model();
      return { composeFile, mappings, mainRoot: tmp, commonDir: path.join(tmp, ".git"), envFiles: [], engine, ...extra };
    }

    it("remaps the candidates when the engine applies the tags", () => {
      const engine = fakeCompose(path.join(tmp, "ok"), DOCKER_STYLE_APPLIED);
      const decision = decideRemap(inputs(() => engine));
      expect(decision.problem).toBeNull();
      expect(decision.targets?.ports).toHaveLength(5);
      expect(decision.targets?.containerNames).toHaveLength(1);
    });

    it("explains why it cannot: unsupported engine, or a COMPOSE_FILE of the user's anywhere wtc would replace it", () => {
      const old = fakeCompose(path.join(tmp, "old"), "services: {}\n");
      expect(decideRemap(inputs(() => old)).problem).toMatch(/does not apply compose's !override \/ !reset tags \(Docker Compose 2\.24\.4 or newer does\)/);

      const ok = fakeCompose(path.join(tmp, "ok"), DOCKER_STYLE_APPLIED);
      // The main checkout's .env, which compose reads even with a custom envFile.
      const dotenv = write(tmp, ".env", "COMPOSE_FILE=compose.yaml:compose.dev.yaml\n");
      const local = write(tmp, ".env.local", "X=1\n");
      expect(decideRemap(inputs(() => ok, { envFiles: [local, dotenv] })).problem).toMatch(/\.env sets COMPOSE_FILE/);
      expect(decideRemap(inputs(() => ok, { envOverrides: { COMPOSE_FILE: "a.yaml" } })).problem).toMatch(
        /envOverrides sets COMPOSE_FILE/,
      );
      // Another separator would split wtc's list into one missing file.
      const sep = write(tmp, "sep.env", "COMPOSE_PATH_SEPARATOR=|\n");
      expect(decideRemap(inputs(() => ok, { envFiles: [sep] })).problem).toMatch(/sep\.env sets COMPOSE_PATH_SEPARATOR/);
      expect(decideRemap(inputs(() => ok, { envOverrides: { COMPOSE_PATH_SEPARATOR: "|" } })).problem).toMatch(
        /envOverrides sets COMPOSE_PATH_SEPARATOR/,
      );

      process.env.COMPOSE_FILE = "compose.yaml";
      const decision = decideRemap(inputs(() => ok));
      expect(decision.targets).toBeNull();
      expect(decision.problem).toMatch(/COMPOSE_FILE is set in the environment/);
    });

    it("ignores a COMPOSE_FILE that lists wtc's own override (a worktree's .env exported by direnv)", () => {
      const ok = fakeCompose(path.join(tmp, "ok"), DOCKER_STYLE_APPLIED);
      process.env.COMPOSE_FILE = composeFileValue([
        path.join(tmp, "wt", "compose.yaml"),
        overridePath(path.join(tmp, ".git"), "app-wt-1-feat"),
      ])!;
      const commonDir = path.join(tmp, ".git");
      const wtcFile = overridePath(commonDir, "app-wt-1-feat");
      expect(isWtcComposeFile(process.env.COMPOSE_FILE, commonDir)).toBe(true);
      expect(
        isWtcComposeFile(composeFileValue([path.join(tmp, "wt", "compose.yaml"), path.join(tmp, "wt", "compose.override.yaml"), wtcFile])!, commonDir),
      ).toBe(true);
      // Anything else in the list makes it the user's.
      expect(isWtcComposeFile(`${process.env.COMPOSE_FILE}${path.delimiter}${path.join(tmp, "wt", "compose.debug.yaml")}`, commonDir)).toBe(false);
      expect(isWtcComposeFile(composeFileValue([path.join(tmp, "wt", "compose.debug.yaml"), wtcFile])!, commonDir)).toBe(false);
      // A compose override from another directory is not the one wtc lists.
      expect(
        isWtcComposeFile(composeFileValue([path.join(tmp, "wt", "compose.yaml"), path.join(tmp, "other", "compose.override.yaml"), wtcFile])!, commonDir),
      ).toBe(false);
      expect(isWtcComposeFile(path.join(tmp, "compose.dev.yaml"), commonDir)).toBe(false);
      const decision = decideRemap(inputs(() => ok));
      expect(decision.problem).toBeNull();
      expect(decision.targets).not.toBeNull();
    });

    it("stays silent without an engine, and never probes when there is nothing to remap", () => {
      expect(decideRemap(inputs(() => { throw new Error("no engine"); }))).toEqual({ targets: null, problem: null, warnings: [] });

      let probed = false;
      const decision = decideRemap(
        inputs(
          () => {
            probed = true;
            throw new Error("unused");
          },
          model('services:\n  web:\n    image: x\n    ports:\n      - "${WEB_PORT:-80}:80"\n'),
        ),
      );
      expect(decision).toEqual({ targets: null, problem: null, warnings: [] });
      expect(probed).toBe(false);
    });
  });
});

// Real `docker compose config` (read-only: no daemon, no containers) checks
// that compose merges the rendered override the way wtc relies on.
const dockerCompose = runSafe("docker", ["compose", "version", "--short"], { timeoutMs: 20_000 });
const [major, minor, patch] = (dockerCompose ?? "").replace(/^v/, "").split(/[.-]/).map(Number);
const supportsTags = major > 2 || (major === 2 && (minor > 24 || (minor === 24 && patch >= 4)));
const describeDocker = dockerCompose && supportsTags ? describe : describe.skip;

describeDocker("the rendered override under real docker compose", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-override-docker-")));
    resetRemapProbeCache();
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  type ConfigService = {
    container_name?: string;
    networks?: Record<string, { aliases?: string[] } | null>;
    ports?: { target: number; published?: string; host_ip?: string; protocol?: string }[];
  };

  function config(text: string): Record<string, ConfigService> {
    const base = write(tmp, "app/compose.yaml", text);
    const composeFile = parseComposeFile(base);
    const mappings = extractPortMappings(composeFile.services);
    const { targets } = remapCandidates(composeFile, mappings);
    const allocations = allocateWorktreePorts(mappings, 1, 1, targets.ports);
    const override = write(tmp, "state/app-wt-1.yaml", renderOverride("app-wt-1", composeFile, targets, allocations));
    const out = runSafe("docker", ["compose", "-p", "app-wt-1", "config", "--format", "json"], {
      cwd: path.dirname(base),
      env: { ...process.env, COMPOSE_FILE: composeFileValue([base, override])! },
      timeoutMs: 20_000,
    });
    expect(out).not.toBeNull();
    return (JSON.parse(out!) as { services: Record<string, ConfigService> }).services;
  }

  it("passes the engine probe", () => {
    expect(engineSupportsRemap(engineFromArgv(["docker", "compose"]))).toBe(true);
  });

  it("replaces hardcoded host ports, keeps every other entry, and drops container_name", () => {
    const services = config(COMPOSE);
    const published = (svc: string) =>
      services[svc].ports!.map((p) => `${p.host_ip ? `${p.host_ip}:` : ""}${p.published ?? ""}->${p.target}/${p.protocol}`).sort();
    expect(published("web")).toEqual(
      [
        "28081->80/tcp",
        "8443->443/tcp",
        "127.0.0.1:22223->22/tcp",
        "20054->53/udp",
        "->9229/tcp",
        "127.0.0.1:29001->9000/tcp",
        "->9100/tcp",
      ].sort(),
    );
    expect(services.web.container_name).toBeUndefined();
    expect(published("db")).toEqual(["25433->5432/tcp"]);
    // A project-scoped name is already per stack: compose fills in the project.
    expect(services.db.container_name).toBe("app-wt-1-db");
    // A range is left as it is.
    expect(published("ftp")).toHaveLength(11);
  });

  it("keeps the old container name as an alias on the default network and on list-form networks", () => {
    const services = config(
      [
        "services:",
        "  db:",
        "    image: postgres",
        "    container_name: mydb",
        "  api:",
        "    image: node",
        "    container_name: myapi",
        "    networks: [backend]",
        "networks:",
        "  backend:",
        "",
      ].join("\n"),
    );
    expect(services.db.container_name).toBeUndefined();
    expect(services.db.networks?.default?.aliases).toEqual(["mydb"]);
    expect(Object.keys(services.api.networks ?? {})).toEqual(["backend"]);
    expect(services.api.networks?.backend?.aliases).toEqual(["myapi"]);
  });
});
