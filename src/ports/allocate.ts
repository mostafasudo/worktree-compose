import type { PortMapping, PortAllocation } from "./types.js";

const BASE_OFFSET = 20000;

export function allocatePort(
  defaultPort: number,
  worktreeIndex: number,
  portStride: number = 1,
): number {
  let port = BASE_OFFSET + defaultPort + worktreeIndex * portStride;

  if (port > 65535) {
    port = defaultPort + 100 * worktreeIndex;
  }

  if (port > 65535 || port < 1024) {
    throw new Error(
      `Cannot allocate port for default ${defaultPort} at worktree index ${worktreeIndex}. ` +
        `Computed port ${port} is out of valid range (1024-65535).`,
    );
  }

  return port;
}

/**
 * The mappings that get a host port of their own: each `${VAR:-port}`
 * mapping (an exact repeat, e.g. the same variable for tcp and udp, only
 * once), then each hardcoded mapping in `remapped` (remapped at runtime,
 * see compose/override.ts) whose default port is not already covered — the
 * allocated port depends only on the default port, so `53:53/tcp` and
 * `53:53/udp` share one.
 */
export function allocatableMappings(
  mappings: PortMapping[],
  remapped: PortMapping[] = [],
): PortMapping[] {
  const out: PortMapping[] = [];
  const declared = new Set<string>();
  const defaults = new Set<number>();
  for (const m of mappings) {
    const key = `${m.envVar}\0${m.defaultPort}`;
    if (m.envVar === null || declared.has(key)) continue;
    declared.add(key);
    defaults.add(m.defaultPort);
    out.push(m);
  }
  for (const m of remapped) {
    if (m.envVar !== null || m.range || defaults.has(m.defaultPort)) continue;
    defaults.add(m.defaultPort);
    out.push(m);
  }
  return out;
}

/** `allocatePort`, or null for a hardcoded mapping whose port has nowhere to move (it stays as it is). */
function allocateOrKeep(m: PortMapping, worktreeIndex: number, portStride: number): number | null {
  if (m.envVar !== null) return allocatePort(m.defaultPort, worktreeIndex, portStride);
  try {
    return allocatePort(m.defaultPort, worktreeIndex, portStride);
  } catch {
    return null;
  }
}

/**
 * Ports for one worktree: every `${VAR:-port}` mapping, plus the hardcoded
 * mappings in `remapped` (envVar null). A hardcoded port that cannot be
 * moved within range (e.g. 65500) gets no allocation and stays as it is;
 * a variable's port that cannot throws, as before.
 */
export function allocateWorktreePorts(
  mappings: PortMapping[],
  worktreeIndex: number,
  portStride: number = 1,
  remapped: PortMapping[] = [],
): PortAllocation[] {
  const allocations: PortAllocation[] = allocatableMappings(mappings, remapped).flatMap((m) => {
    const port = allocateOrKeep(m, worktreeIndex, portStride);
    return port === null
      ? []
      : [{
          serviceName: m.serviceName,
          envVar: m.envVar,
          port,
          containerPort: m.containerPort,
          defaultPort: m.defaultPort,
        }];
  });

  const seen = new Set<number>();
  for (const a of allocations) {
    if (seen.has(a.port)) {
      throw new Error(
        `Port collision: ${a.port} is assigned to multiple services in worktree ${worktreeIndex}.`,
      );
    }
    seen.add(a.port);
  }

  return allocations;
}

/**
 * Environment variables for a `docker compose` invocation so `${VAR}`
 * interpolation resolves to the allocated ports. Shell environment values take
 * precedence over `.env` files, which makes this independent of the configured
 * env filename — Compose never reads `.env.development` (or any custom name)
 * for interpolation, only the project `.env`, `--env-file`, and the process
 * environment.
 */
export function allocationEnv(
  allocations: PortAllocation[],
): Record<string, string> {
  return Object.fromEntries(
    allocations.flatMap((a) => (a.envVar === null ? [] : [[a.envVar, String(a.port)]])),
  );
}

/**
 * How a port is named in output (`wtc list`, `ports` in JSON and MCP): its
 * variable, or `<service>:<default port>` for a hardcoded port remapped at
 * runtime — no variable holds that one.
 */
export function portLabel(a: PortAllocation): string {
  return a.envVar ?? `${a.serviceName}:${a.defaultPort}`;
}

/** `{ label: port }` for output. */
export function portsByLabel(allocations: PortAllocation[]): Record<string, number> {
  return Object.fromEntries(allocations.map((a) => [portLabel(a), a.port]));
}

export interface PortCollisionParty {
  worktreeIndex: number;
  serviceName: string;
}

export interface PortCollision {
  port: number;
  a: PortCollisionParty;
  b: PortCollisionParty;
}

/**
 * Detect cross-worktree port collisions for a given stride. `worktrees` is
 * either a count (indices 1..n) or the exact indices in use — persistent
 * indices can have gaps (e.g. 2, 3, 7), and only the ones actually assigned
 * can collide. Returns one entry per colliding allocation.
 */
export function detectCrossWorktreeCollisions(
  mappings: PortMapping[],
  portStride: number,
  worktrees: number | number[],
  remapped: PortMapping[] = [],
): PortCollision[] {
  const overridable = allocatableMappings(mappings, remapped);
  const seen = new Map<number, PortCollisionParty>();
  const collisions: PortCollision[] = [];
  const indices = Array.isArray(worktrees)
    ? [...new Set(worktrees)].sort((a, b) => a - b)
    : Array.from({ length: worktrees }, (_, i) => i + 1);

  for (const w of indices) {
    for (const m of overridable) {
      const port = allocateOrKeep(m, w, portStride);
      if (port === null) continue;
      const prev = seen.get(port);
      if (prev) {
        collisions.push({
          port,
          a: prev,
          b: { worktreeIndex: w, serviceName: m.serviceName },
        });
      } else {
        seen.set(port, { worktreeIndex: w, serviceName: m.serviceName });
      }
    }
  }

  return collisions;
}

const STRIDE_SEARCH_CAP = 4096;

/**
 * Smallest portStride that is collision-free across a generous worktree
 * horizon (so the suggestion survives adding more worktrees). Returns -1 if
 * no stride within the search cap works — which signals duplicate default
 * ports within a worktree, a case the per-worktree dedup guard already rejects.
 */
export function recommendPortStride(
  mappings: PortMapping[],
  worktreeCount: number,
  remapped: PortMapping[] = [],
): number {
  const horizon = Math.max(worktreeCount, 100);
  for (let s = 1; s <= STRIDE_SEARCH_CAP; s++) {
    try {
      if (detectCrossWorktreeCollisions(mappings, s, horizon, remapped).length === 0) {
        return s;
      }
    } catch {
      // This stride overflows the valid range at the chosen horizon; it could
      // not be used safely anyway, so skip it and try the next one.
      continue;
    }
  }
  return -1;
}
