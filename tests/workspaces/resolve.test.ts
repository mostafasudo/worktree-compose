import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getWorkspacePatterns,
  listWorkspaces,
  resolveWorkspaces,
} from "../../src/workspaces/resolve.js";

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

describe("workspace resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "wtc-workspaces-")),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  function scaffold(): void {
    writeJson(path.join(tmpDir, "package.json"), {
      name: "ruker",
      private: true,
      workspaces: ["apps/*", "packages/*", "scripts/*"],
    });
    writeJson(path.join(tmpDir, "apps/server/package.json"), {
      name: "server",
    });
    writeJson(path.join(tmpDir, "apps/homepage/package.json"), {
      name: "homepage",
    });
    writeJson(path.join(tmpDir, "packages/ui/package.json"), {
      name: "@ruker/ui",
    });
    // Not a workspace: no package.json.
    fs.mkdirSync(path.join(tmpDir, "apps/notes"), { recursive: true });
    // Excluded by the negation pattern below when present.
    writeJson(path.join(tmpDir, "apps/legacy/package.json"), {
      name: "legacy",
    });
  }

  it("reads workspace patterns from package.json", () => {
    scaffold();
    expect(getWorkspacePatterns(tmpDir)).toEqual([
      "apps/*",
      "packages/*",
      "scripts/*",
    ]);
  });

  it("lists only directories matched by the globs that have a package.json", () => {
    scaffold();
    expect(listWorkspaces(tmpDir).map((w) => w.dir)).toEqual([
      "apps/homepage",
      "apps/legacy",
      "apps/server",
      "packages/ui",
    ]);
  });

  it("applies negated patterns", () => {
    scaffold();
    writeJson(path.join(tmpDir, "package.json"), {
      name: "ruker",
      private: true,
      workspaces: ["apps/*", "!apps/legacy"],
    });
    expect(listWorkspaces(tmpDir).map((w) => w.dir)).toEqual([
      "apps/homepage",
      "apps/server",
    ]);
  });

  it("resolves by package name, directory name, and repo-relative path", () => {
    scaffold();
    expect(
      resolveWorkspaces(tmpDir, ["server", "packages/ui", "@ruker/ui"]).map(
        (w) => w.dir,
      ),
    ).toEqual(["apps/server", "packages/ui"]);
  });

  it("deduplicates repeated selectors and preserves request order", () => {
    scaffold();
    expect(
      resolveWorkspaces(tmpDir, ["homepage", "server", "homepage"]).map(
        (w) => w.dir,
      ),
    ).toEqual(["apps/homepage", "apps/server"]);
  });

  it("throws with available workspaces when a selector does not match", () => {
    scaffold();
    expect(() => resolveWorkspaces(tmpDir, ["nope"])).toThrow(
      /Workspace "nope" not found.*Available workspaces: homepage, legacy, server, @ruker\/ui/s,
    );
  });

  it("throws when a bare directory name is ambiguous", () => {
    writeJson(path.join(tmpDir, "package.json"), {
      name: "root",
      workspaces: ["apps/*", "libs/*"],
    });
    writeJson(path.join(tmpDir, "apps/utils/package.json"), {
      name: "@acme/utils-app",
    });
    writeJson(path.join(tmpDir, "libs/utils/package.json"), {
      name: "@acme/utils-lib",
    });

    expect(() => resolveWorkspaces(tmpDir, ["utils"])).toThrow(
      /ambiguous: apps\/utils, libs\/utils/,
    );
  });

  it("reads pnpm-workspace.yaml when present", () => {
    writeJson(path.join(tmpDir, "package.json"), { name: "root" });
    fs.writeFileSync(
      path.join(tmpDir, "pnpm-workspace.yaml"),
      'packages:\n  - "apps/*"\n',
    );
    writeJson(path.join(tmpDir, "apps/web/package.json"), { name: "web" });

    expect(getWorkspacePatterns(tmpDir)).toEqual(["apps/*"]);
    expect(resolveWorkspaces(tmpDir, ["web"])[0].dir).toBe("apps/web");
  });

  it("reads object-form workspaces and **/ globs", () => {
    writeJson(path.join(tmpDir, "package.json"), {
      name: "root",
      workspaces: { packages: ["**/apps"] },
    });
    writeJson(path.join(tmpDir, "apps/package.json"), { name: "apps-root" });
    writeJson(path.join(tmpDir, "nested/apps/package.json"), { name: "one" });

    expect(getWorkspacePatterns(tmpDir)).toEqual(["**/apps"]);
    expect(listWorkspaces(tmpDir).map((w) => w.dir)).toEqual([
      "apps",
      "nested/apps",
    ]);
  });

  it("falls back to common layouts when no workspaces are declared", () => {
    writeJson(path.join(tmpDir, "package.json"), { name: "root" });
    writeJson(path.join(tmpDir, "apps/server/package.json"), {
      name: "server",
    });

    expect(resolveWorkspaces(tmpDir, ["server"])[0].dir).toBe("apps/server");
  });

  it("does not readdir node_modules while expanding globs", () => {
    writeJson(path.join(tmpDir, "package.json"), {
      name: "root",
      workspaces: ["**"],
    });
    writeJson(path.join(tmpDir, "node_modules/pkg/package.json"), {
      name: "pkg",
    });
    writeJson(path.join(tmpDir, "apps/real/package.json"), { name: "real" });

    expect(listWorkspaces(tmpDir).map((w) => w.dir)).toEqual(["apps/real"]);
  });
});
