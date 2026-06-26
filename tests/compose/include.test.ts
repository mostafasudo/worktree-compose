import { jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseComposeFile } from "../../src/compose/parse.js";
import { getDockerfiles, syncWorktreeFiles } from "../../src/sync/files.js";

function write(dir: string, rel: string, contents: string): string {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

describe("parseComposeFile with include:", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "wtc-include-")),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("terminates on include cycles and lists each service once", () => {
    write(tmpDir, "a.yml", "include:\n  - ./b.yml\nservices:\n  a:\n    image: a\n");
    write(tmpDir, "b.yml", "include:\n  - ./a.yml\nservices:\n  b:\n    image: b\n");

    const result = parseComposeFile(path.join(tmpDir, "a.yml"));
    expect(result.services.map((s) => s.name).sort()).toEqual(["a", "b"]);
    expect(result.sourceFiles).toHaveLength(2);
  });

  it("warns and continues when an included file is missing", () => {
    write(
      tmpDir,
      "root.yml",
      "include:\n  - ./nope.yml\nservices:\n  web:\n    image: web\n",
    );
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = parseComposeFile(path.join(tmpDir, "root.yml"));
    expect(result.services.map((s) => s.name)).toEqual(["web"]);
    expect(result.sourceFiles.some((f) => f.endsWith("nope.yml"))).toBe(false);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it("lets the including file override an included service by name", () => {
    write(tmpDir, "base.yml", "services:\n  db:\n    image: included-db\n");
    write(
      tmpDir,
      "root.yml",
      "include:\n  - ./base.yml\nservices:\n  db:\n    image: local-db\n",
    );

    const result = parseComposeFile(path.join(tmpDir, "root.yml"));
    const db = result.services.filter((s) => s.name === "db");
    expect(db).toHaveLength(1);
    expect(db[0].sourcePath.endsWith("root.yml")).toBe(true);
  });

  it("resolves build context relative to the included file's directory", () => {
    write(
      tmpDir,
      "root.yml",
      "include:\n  - ./svc/compose.yml\n",
    );
    write(
      tmpDir,
      "svc/compose.yml",
      "services:\n  app:\n    build:\n      context: .\n      dockerfile: Dockerfile\n",
    );
    write(tmpDir, "svc/Dockerfile", "FROM scratch\n");

    const result = parseComposeFile(path.join(tmpDir, "root.yml"));
    const dockerfiles = getDockerfiles(result, tmpDir);
    expect(dockerfiles).toEqual(["svc/Dockerfile"]);
  });

  it("does not copy included files that escape the repo root", () => {
    const repoRoot = path.join(tmpDir, "repo");
    const outside = path.join(tmpDir, "outside");
    write(
      repoRoot,
      "compose.yml",
      "include:\n  - ../outside/compose.yml\nservices:\n  web:\n    image: web\n",
    );
    write(outside, "compose.yml", "services:\n  ext:\n    image: ext\n");

    const result = parseComposeFile(path.join(repoRoot, "compose.yml"));
    // The external service is still discovered for remapping...
    expect(result.services.map((s) => s.name).sort()).toEqual(["ext", "web"]);

    // Worktree lives under repoRoot so an escaping write would land in a
    // sibling we can detect, rather than silently overwriting the original.
    const wtPath = path.join(repoRoot, ".wt");
    syncWorktreeFiles(repoRoot, wtPath, result);

    // ...but its file is not copied anywhere (and nothing escapes the worktree).
    expect(fs.existsSync(path.join(wtPath, "compose.yml"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "outside", "compose.yml"))).toBe(
      false,
    );
    expect(fs.readdirSync(wtPath)).toEqual(["compose.yml"]);
  });

  it("parses include entries whose path is a list", () => {
    write(tmpDir, "a.yml", "services:\n  a:\n    image: a\n");
    write(tmpDir, "b.yml", "services:\n  b:\n    image: b\n");
    write(
      tmpDir,
      "root.yml",
      "include:\n  - path:\n      - ./a.yml\n      - ./b.yml\n",
    );

    const result = parseComposeFile(path.join(tmpDir, "root.yml"));
    expect(result.services.map((s) => s.name).sort()).toEqual(["a", "b"]);
    expect(result.sourceFiles).toHaveLength(3);
  });

  it("keeps base ports when a local service overrides without repeating them", () => {
    write(
      tmpDir,
      "base.yml",
      'services:\n  web:\n    ports:\n      - "${WEB_PORT:-8080}:80"\n',
    );
    write(
      tmpDir,
      "root.yml",
      "include:\n  - ./base.yml\nservices:\n  web:\n    environment:\n      FOO: bar\n",
    );

    const result = parseComposeFile(path.join(tmpDir, "root.yml"));
    const web = result.services.find((s) => s.name === "web")!;
    // Without deep-merge the override would wipe the port and break isolation.
    expect(web.ports).toEqual(["${WEB_PORT:-8080}:80"]);
  });

  it("keeps base ports across a path: list base+overlay", () => {
    write(
      tmpDir,
      "base.yml",
      'services:\n  web:\n    ports:\n      - "${WEB_PORT:-8080}:80"\n',
    );
    write(
      tmpDir,
      "overlay.yml",
      "services:\n  web:\n    environment:\n      FOO: bar\n",
    );
    write(
      tmpDir,
      "root.yml",
      "include:\n  - path:\n      - ./base.yml\n      - ./overlay.yml\n",
    );

    const result = parseComposeFile(path.join(tmpDir, "root.yml"));
    const web = result.services.find((s) => s.name === "web")!;
    expect(web.ports).toEqual(["${WEB_PORT:-8080}:80"]);
  });

  it("unions distinct ports from base and overlay of the same service", () => {
    write(
      tmpDir,
      "base.yml",
      'services:\n  web:\n    ports:\n      - "${WEB_PORT:-8080}:80"\n',
    );
    write(
      tmpDir,
      "overlay.yml",
      'services:\n  web:\n    ports:\n      - "${ADMIN_PORT:-9090}:9090"\n',
    );
    write(
      tmpDir,
      "root.yml",
      "include:\n  - path:\n      - ./base.yml\n      - ./overlay.yml\n",
    );

    const result = parseComposeFile(path.join(tmpDir, "root.yml"));
    const web = result.services.find((s) => s.name === "web")!;
    expect(web.ports).toEqual([
      "${WEB_PORT:-8080}:80",
      "${ADMIN_PORT:-9090}:9090",
    ]);
  });

  it("tolerates empty (null) service definitions", () => {
    write(
      tmpDir,
      "root.yml",
      "services:\n  web:\n    image: web\n  worker:\n",
    );

    const result = parseComposeFile(path.join(tmpDir, "root.yml"));
    const worker = result.services.find((s) => s.name === "worker")!;
    expect(worker.ports).toEqual([]);
    expect(worker.build).toBeUndefined();
  });
});
