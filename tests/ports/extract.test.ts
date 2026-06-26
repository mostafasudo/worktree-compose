import {
  extractPortMappings,
  suggestEnvVar,
} from "../../src/ports/extract.js";
import type { ComposeService } from "../../src/compose/types.js";

function svc(name: string, ports: string[]): ComposeService {
  return { name, ports, sourcePath: `/repo/${name}/compose.yml` };
}

describe("extractPortMappings", () => {
  it("extracts env var name and default from ${VAR:-default}:container", () => {
    const result = extractPortMappings([
      svc("backend", ["${BACKEND_PORT:-8000}:8000"]),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      serviceName: "backend",
      envVar: "BACKEND_PORT",
      defaultPort: 8000,
      containerPort: 8000,
      raw: "${BACKEND_PORT:-8000}:8000",
    });
  });

  it("handles same-var host-and-container pattern", () => {
    const result = extractPortMappings([
      svc("frontend", ["${FRONTEND_PORT:-5173}:${FRONTEND_PORT:-5173}"]),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].envVar).toBe("FRONTEND_PORT");
    expect(result[0].defaultPort).toBe(5173);
    expect(result[0].containerPort).toBe(5173);
  });

  it("returns null envVar for raw port numbers", () => {
    const result = extractPortMappings([svc("nginx", ["8080:80"])]);

    expect(result).toHaveLength(1);
    expect(result[0].envVar).toBeNull();
    expect(result[0].defaultPort).toBe(8080);
    expect(result[0].containerPort).toBe(80);
  });

  it("handles IP-bound ports", () => {
    const result = extractPortMappings([
      svc("api", ["127.0.0.1:${API_PORT:-3000}:3000"]),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].envVar).toBe("API_PORT");
    expect(result[0].defaultPort).toBe(3000);
    expect(result[0].containerPort).toBe(3000);
  });

  it("strips protocol suffix", () => {
    const result = extractPortMappings([
      svc("backend", ["${BACKEND_PORT:-8000}:8000/tcp"]),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].envVar).toBe("BACKEND_PORT");
    expect(result[0].containerPort).toBe(8000);
  });

  it("handles multiple ports per service", () => {
    const result = extractPortMappings([
      svc("backend", [
        "${BACKEND_PORT:-8000}:8000",
        "${DEBUG_PORT:-9229}:9229",
      ]),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].envVar).toBe("BACKEND_PORT");
    expect(result[1].envVar).toBe("DEBUG_PORT");
  });

  it("skips container-only ports (no host mapping)", () => {
    const result = extractPortMappings([svc("app", ["8080"])]);
    expect(result).toHaveLength(0);
  });

  it("handles mixed env var and raw ports across services", () => {
    const result = extractPortMappings([
      svc("postgres", ["${POSTGRES_PORT:-5434}:5432"]),
      svc("nginx", ["8080:80"]),
      svc("worker", []),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].envVar).toBe("POSTGRES_PORT");
    expect(result[1].envVar).toBeNull();
  });
});

describe("suggestEnvVar", () => {
  it("creates uppercase env var from service name", () => {
    expect(suggestEnvVar("nginx")).toBe("NGINX_PORT");
    expect(suggestEnvVar("my-api")).toBe("MY_API_PORT");
    expect(suggestEnvVar("frontend_app")).toBe("FRONTEND_APP_PORT");
  });
});
