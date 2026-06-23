import {
  allocatePort,
  allocateWorktreePorts,
  detectCrossWorktreeCollisions,
  recommendPortStride,
} from "../../src/ports/allocate.js";
import type { PortMapping } from "../../src/ports/types.js";

describe("allocatePort", () => {
  it("computes 20000 + default + index", () => {
    expect(allocatePort(8000, 1)).toBe(28001);
    expect(allocatePort(5173, 2)).toBe(25175);
    expect(allocatePort(5434, 1)).toBe(25435);
    expect(allocatePort(6380, 3)).toBe(26383);
  });

  it("falls back for high default ports", () => {
    expect(allocatePort(50000, 1)).toBe(50100);
  });

  it("throws for impossible ports", () => {
    expect(() => allocatePort(60000, 100)).toThrow(/out of valid range/);
  });

  it("honours a custom portStride", () => {
    expect(allocatePort(8000, 2, 100)).toBe(28200);
    expect(allocatePort(8081, 1, 100)).toBe(28181);
    expect(allocatePort(8081, 2, 100)).toBe(28281);
    // stride defaults to 1 (current behaviour)
    expect(allocatePort(8000, 2)).toBe(28002);
  });
});

describe("allocateWorktreePorts", () => {
  const mappings: PortMapping[] = [
    {
      serviceName: "postgres",
      envVar: "POSTGRES_PORT",
      defaultPort: 5434,
      containerPort: 5432,
      raw: "${POSTGRES_PORT:-5434}:5432",
    },
    {
      serviceName: "backend",
      envVar: "BACKEND_PORT",
      defaultPort: 8000,
      containerPort: 8000,
      raw: "${BACKEND_PORT:-8000}:8000",
    },
    {
      serviceName: "nginx",
      envVar: null,
      defaultPort: 8080,
      containerPort: 80,
      raw: "8080:80",
    },
  ];

  it("allocates ports for overridable services only", () => {
    const result = allocateWorktreePorts(mappings, 1);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      serviceName: "postgres",
      envVar: "POSTGRES_PORT",
      port: 25435,
      containerPort: 5432,
    });
    expect(result[1]).toEqual({
      serviceName: "backend",
      envVar: "BACKEND_PORT",
      port: 28001,
      containerPort: 8000,
    });
  });

  it("skips raw port mappings (no envVar)", () => {
    const result = allocateWorktreePorts(mappings, 1);
    const names = result.map((a) => a.serviceName);
    expect(names).not.toContain("nginx");
  });

  it("produces different ports for different worktree indices", () => {
    const r1 = allocateWorktreePorts(mappings, 1);
    const r2 = allocateWorktreePorts(mappings, 2);

    expect(r1[0].port).not.toBe(r2[0].port);
    expect(r1[1].port).not.toBe(r2[1].port);
  });

  it("applies the portStride to each worktree index", () => {
    const r1 = allocateWorktreePorts(mappings, 1, 100);
    const r2 = allocateWorktreePorts(mappings, 2, 100);

    // postgres default 5434, backend default 8000
    expect(r1.map((a) => a.port)).toEqual([25534, 28100]);
    expect(r2.map((a) => a.port)).toEqual([25634, 28200]);
  });
});

describe("cross-worktree collision detection", () => {
  // Clustered defaults: six mock ports (8081-8086) bunched together, plus
  // spread-out api/web/temporal/mtls. Adjacent worktrees collide at stride 1.
  const clustered: PortMapping[] = [
    { serviceName: "api", defaultPort: 3000 },
    { serviceName: "web", defaultPort: 5173 },
    { serviceName: "temporal", defaultPort: 8233 },
    { serviceName: "mtls", defaultPort: 8444 },
    { serviceName: "mock-api", defaultPort: 8081 },
    { serviceName: "mock-oauth2-auth", defaultPort: 8082 },
    { serviceName: "mock-oauth2-res", defaultPort: 8083 },
    { serviceName: "mock-jwt", defaultPort: 8085 },
    { serviceName: "mock-sentinel", defaultPort: 8086 },
  ].map((s) => ({
    ...s,
    envVar: s.serviceName.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_PORT",
    containerPort: s.defaultPort,
    raw: `\${X:-${s.defaultPort}}:${s.defaultPort}`,
  }));

  it("finds the three known collisions for indices 1 & 2 at stride 1", () => {
    const collisions = detectCrossWorktreeCollisions(clustered, 1, 2);
    const ports = collisions.map((c) => c.port).sort((a, b) => a - b);
    expect(ports).toEqual([28083, 28084, 28087]);
  });

  it("is collision-free at stride 100", () => {
    expect(detectCrossWorktreeCollisions(clustered, 100, 2)).toEqual([]);
    expect(detectCrossWorktreeCollisions(clustered, 100, 10)).toEqual([]);
  });

  it("recommends a stride that is collision-free over the horizon", () => {
    const stride = recommendPortStride(clustered, 2);
    expect(stride).toBeGreaterThan(1);
    expect(detectCrossWorktreeCollisions(clustered, stride, 100)).toEqual([]);
  });

  it("does not throw when allocations overflow during the search", () => {
    // A very high default port forces allocatePort out of range deep in the
    // horizon; recommendPortStride must stay non-fatal and report -1.
    const highPort: PortMapping[] = [
      {
        serviceName: "huge",
        envVar: "HUGE_PORT",
        defaultPort: 60000,
        containerPort: 60000,
        raw: "${HUGE_PORT:-60000}:60000",
      },
    ];
    expect(() => recommendPortStride(highPort, 2)).not.toThrow();
    expect(recommendPortStride(highPort, 2)).toBe(-1);
  });
});
