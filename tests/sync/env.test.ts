import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stripOverrideBlock,
  buildOverrideBlock,
  injectPortOverrides,
  prepareEnvFile,
  findEnvSource,
} from "../../src/sync/env.js";
import type { EnvTarget } from "../../src/sync/env.js";
import type { PortAllocation } from "../../src/ports/types.js";

const allocations: PortAllocation[] = [
  {
    serviceName: "backend",
    envVar: "BACKEND_PORT",
    port: 28001,
    containerPort: 8000,
  },
  {
    serviceName: "frontend",
    envVar: "FRONTEND_PORT",
    port: 25174,
    containerPort: 5173,
  },
];

describe("buildOverrideBlock", () => {
  it("creates a delimited block with port assignments", () => {
    const block = buildOverrideBlock(allocations);
    expect(block).toContain("# --- wtc port overrides ---");
    expect(block).toContain("BACKEND_PORT=28001");
    expect(block).toContain("FRONTEND_PORT=25174");
    expect(block).toContain("# --- end wtc ---");
  });

  it("interpolates envOverrides with port values", () => {
    const block = buildOverrideBlock(allocations, {
      VITE_API_URL: "http://localhost:${BACKEND_PORT}",
    });
    expect(block).toContain("VITE_API_URL=http://localhost:28001");
  });

  it("handles multiple envOverrides", () => {
    const block = buildOverrideBlock(allocations, {
      VITE_API_URL: "http://localhost:${BACKEND_PORT}",
      VITE_APP_URL: "http://localhost:${FRONTEND_PORT}",
    });
    expect(block).toContain("VITE_API_URL=http://localhost:28001");
    expect(block).toContain("VITE_APP_URL=http://localhost:25174");
  });
});

describe("stripOverrideBlock", () => {
  it("removes the override block from content", () => {
    const content = [
      "FOO=bar",
      "",
      "# --- wtc port overrides ---",
      "BACKEND_PORT=28001",
      "# --- end wtc ---",
      "",
    ].join("\n");

    const result = stripOverrideBlock(content);
    expect(result).toContain("FOO=bar");
    expect(result).not.toContain("BACKEND_PORT");
    expect(result).not.toContain("wtc port overrides");
  });

  it("returns content unchanged when no block exists", () => {
    const content = "FOO=bar\nBAZ=qux\n";
    expect(stripOverrideBlock(content)).toBe(content);
  });

  it("handles content with only the block", () => {
    const content = [
      "# --- wtc port overrides ---",
      "X=1",
      "# --- end wtc ---",
    ].join("\n");

    const result = stripOverrideBlock(content);
    expect(result.trim()).toBe("");
  });
});

describe("injectPortOverrides", () => {
  let tmpDir: string;

  function read(name: string): string {
    return fs.readFileSync(path.join(tmpDir, name), "utf-8");
  }

  function write(name: string, content: string): string {
    const full = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  }

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "wtc-env-")),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("rewrites existing keys in place and preserves comments/ordering", () => {
    const file = write(
      ".env.development",
      [
        "# Database",
        "DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres",
        "NODE_ENV=local",
        "PORT=8080",
        "",
      ].join("\n"),
    );

    const result = injectPortOverrides(file, allocations, {
      DATABASE_URL:
        "postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/postgres",
      PORT: "${BACKEND_PORT}",
    });

    expect(result.rewritten).toEqual(["DATABASE_URL", "PORT"]);
    expect(result.appended).toEqual(["BACKEND_PORT", "FRONTEND_PORT"]);

    const content = read(".env.development");
    expect(content).toContain("# Database");
    expect(content).toContain("NODE_ENV=local");
    expect(content).not.toContain(":5433");
    expect(content).toContain("BACKEND_PORT=28001");
    // Unprovided ${POSTGRES_PORT} stays unresolved rather than being dropped.
    expect(content).toContain(
      "DATABASE_URL=postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/postgres",
    );
  });

  it("resolves interpolated values into existing keys", () => {
    const file = write(
      "apps/server/.env.development",
      "DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres\n",
    );

    const result = injectPortOverrides(file, allocations, {
      DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5432/postgres",
    });

    expect(result.rewritten).toEqual(["DATABASE_URL"]);
    expect(read("apps/server/.env.development")).toContain(
      "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres",
    );
  });

  it("appends missing keys in an idempotent block", () => {
    const file = write("dirty/.env", "NODE_ENV=local\n");

    injectPortOverrides(file, allocations, {
      VITE_API_URL: "http://localhost:${FRONTEND_PORT}",
    });
    const first = read("dirty/.env");

    injectPortOverrides(file, allocations, {
      VITE_API_URL: "http://localhost:${FRONTEND_PORT}",
    });
    const second = read("dirty/.env");

    expect(first).toBe(second);
    expect(second.match(/# --- wtc port overrides ---/g)).toHaveLength(1);
    expect(second).toContain("NODE_ENV=local");
    expect(second).toContain("VITE_API_URL=http://localhost:25174");
  });

  it("rewrites allocation keys already present in the file", () => {
    const file = write(".env", "BACKEND_PORT=8000\n");

    const result = injectPortOverrides(file, allocations);

    expect(result.rewritten).toEqual(["BACKEND_PORT"]);
    expect(read(".env")).toContain("BACKEND_PORT=28001");
    expect(read(".env")).not.toContain("BACKEND_PORT=8000");
  });

  it("keeps values containing $ intact", () => {
    const file = write(".env", "SECRET=old\n");

    injectPortOverrides(file, allocations, {
      SECRET: "pa$$&word$1",
    });

    expect(read(".env")).toContain("SECRET=pa$$&word$1");
  });

  it("does not let a previous run's block mask in-place rewriting", () => {
    const file = write(".env", "PORT=8080\n");
    injectPortOverrides(file, allocations, { PORT: "${BACKEND_PORT}" });

    injectPortOverrides(file, allocations, { PORT: "9999" });

    const content = read(".env");
    expect(content).toContain("PORT=9999");
    expect(content).not.toMatch(/^PORT=28001$/m);
  });

  it("writes no block when every entry is rewritten in place", () => {
    const file = write(".env", "BACKEND_PORT=8000\nFRONTEND_PORT=5173\n");

    injectPortOverrides(file, allocations);

    const content = read(".env");
    expect(content).not.toContain("wtc port overrides");
    expect(content).toBe("BACKEND_PORT=28001\nFRONTEND_PORT=25174\n");
  });
});

describe("prepareEnvFile", () => {
  let repoRoot: string;
  let wtPath: string;

  function writeRepo(rel: string, content: string): void {
    const full = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  function target(dir: string, envFileName = ".env.development"): EnvTarget {
    return { dir, label: dir || "root", envFileName };
  }

  beforeEach(() => {
    const base = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "wtc-prepare-")),
    );
    repoRoot = path.join(base, "main");
    wtPath = path.join(base, "wt");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(wtPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(repoRoot), { recursive: true });
  });

  it("copies a workspace env file to the same relative path", () => {
    writeRepo("apps/server/.env.development", "DATABASE_URL=main\n");

    const dest = prepareEnvFile(repoRoot, wtPath, target("apps/server"));

    expect(dest).toBe(path.join(wtPath, "apps/server/.env.development"));
    expect(fs.readFileSync(dest!, "utf-8")).toBe("DATABASE_URL=main\n");
  });

  it("falls back to .env.example per directory", () => {
    writeRepo("apps/server/.env.example", "DATABASE_URL=example\n");

    const dest = prepareEnvFile(repoRoot, wtPath, target("apps/server"));

    expect(dest).toBe(path.join(wtPath, "apps/server/.env.development"));
    expect(fs.readFileSync(dest!, "utf-8")).toBe("DATABASE_URL=example\n");
  });

  it("skips a workspace with no env file and no example", () => {
    expect(prepareEnvFile(repoRoot, wtPath, target("apps/empty"))).toBeNull();
    expect(fs.existsSync(path.join(wtPath, "apps/empty"))).toBe(false);
  });

  it("creates an empty root env file when nothing exists", () => {
    const dest = prepareEnvFile(repoRoot, wtPath, target(""));

    expect(dest).toBe(path.join(wtPath, ".env.development"));
    expect(fs.readFileSync(dest!, "utf-8")).toBe("");
  });

  it("prefers the configured filename over .env.example", () => {
    writeRepo("apps/server/.env.development", "real\n");
    writeRepo("apps/server/.env.example", "example\n");

    expect(findEnvSource(repoRoot, target("apps/server"))).toBe(
      path.join(repoRoot, "apps/server/.env.development"),
    );
  });
});
