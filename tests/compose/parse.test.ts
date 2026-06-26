import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseComposeFile } from "../../src/compose/parse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.join(__dirname, "..", "fixtures");

describe("parseComposeFile", () => {
  it("parses services with env var port patterns", () => {
    const result = parseComposeFile(
      path.join(FIXTURES, "docker-compose-basic.yml"),
    );
    expect(result.services).toHaveLength(5);

    const postgres = result.services.find((s) => s.name === "postgres")!;
    expect(postgres.ports).toEqual(["${POSTGRES_PORT:-5434}:5432"]);

    const redis = result.services.find((s) => s.name === "redis")!;
    expect(redis.ports).toEqual(["${REDIS_PORT:-6380}:6379"]);

    const backend = result.services.find((s) => s.name === "backend")!;
    expect(backend.ports).toEqual(["${BACKEND_PORT:-8000}:8000"]);
    expect(backend.build).toEqual({
      context: "./backend",
      dockerfile: "Dockerfile.dev",
    });

    const frontend = result.services.find((s) => s.name === "frontend")!;
    expect(frontend.ports).toEqual([
      "${FRONTEND_PORT:-5173}:${FRONTEND_PORT:-5173}",
    ]);
  });

  it("parses services with no ports (worker)", () => {
    const result = parseComposeFile(
      path.join(FIXTURES, "docker-compose-basic.yml"),
    );
    const worker = result.services.find((s) => s.name === "worker")!;
    expect(worker.ports).toEqual([]);
  });

  it("parses services with raw port numbers", () => {
    const result = parseComposeFile(
      path.join(FIXTURES, "docker-compose-raw-ports.yml"),
    );
    expect(result.services).toHaveLength(3);

    const nginx = result.services.find((s) => s.name === "nginx")!;
    expect(nginx.ports).toEqual(["8080:80"]);
  });

  it("parses services with multiple ports", () => {
    const result = parseComposeFile(
      path.join(FIXTURES, "docker-compose-multi-ports.yml"),
    );
    const backend = result.services.find((s) => s.name === "backend")!;
    expect(backend.ports).toHaveLength(2);
    expect(backend.ports).toEqual([
      "${BACKEND_PORT:-8000}:8000",
      "${DEBUG_PORT:-9229}:9229",
    ]);
  });

  it("parses long-form port syntax", () => {
    const result = parseComposeFile(
      path.join(FIXTURES, "docker-compose-long-form.yml"),
    );
    const backend = result.services.find((s) => s.name === "backend")!;
    expect(backend.ports).toEqual(["${BACKEND_PORT:-8000}:8000"]);
  });

  it("extracts build context and dockerfile paths", () => {
    const result = parseComposeFile(
      path.join(FIXTURES, "docker-compose-basic.yml"),
    );
    const backend = result.services.find((s) => s.name === "backend")!;
    expect(backend.build).toEqual({
      context: "./backend",
      dockerfile: "Dockerfile.dev",
    });
  });

  it("handles string-only build context", () => {
    const result = parseComposeFile(
      path.join(FIXTURES, "docker-compose-raw-ports.yml"),
    );
    const api = result.services.find((s) => s.name === "api")!;
    expect(api.build).toEqual({ context: "./api" });
  });

  describe("include:", () => {
    it("flattens services from nested includes", () => {
      const result = parseComposeFile(
        path.join(FIXTURES, "include", "root.yml"),
      );
      const names = result.services.map((s) => s.name).sort();
      expect(names).toEqual(["api", "cache", "postgres", "web"]);
    });

    it("stamps each service with the file that declared it", () => {
      const result = parseComposeFile(
        path.join(FIXTURES, "include", "root.yml"),
      );
      const api = result.services.find((s) => s.name === "api")!;
      expect(api.sourcePath.endsWith("include/api/compose.yml")).toBe(true);

      const cache = result.services.find((s) => s.name === "cache")!;
      expect(cache.sourcePath.endsWith("include/shared/compose.yml")).toBe(true);

      const web = result.services.find((s) => s.name === "web")!;
      expect(web.sourcePath.endsWith("include/root.yml")).toBe(true);
    });

    it("tracks all source files, root first", () => {
      const result = parseComposeFile(
        path.join(FIXTURES, "include", "root.yml"),
      );
      expect(result.sourceFiles[0].endsWith("include/root.yml")).toBe(true);
      expect(
        result.sourceFiles.some((f) => f.endsWith("include/db/compose.yml")),
      ).toBe(true);
      expect(
        result.sourceFiles.some((f) => f.endsWith("include/api/compose.yml")),
      ).toBe(true);
      expect(
        result.sourceFiles.some((f) =>
          f.endsWith("include/shared/compose.yml"),
        ),
      ).toBe(true);
    });

    it("discovers services in an include-only file (no services key)", () => {
      const result = parseComposeFile(
        path.join(FIXTURES, "include", "include-only.yml"),
      );
      expect(result.services.map((s) => s.name)).toEqual(["postgres"]);
    });
  });
});
