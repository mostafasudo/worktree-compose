import type { ComposeService } from "../compose/types.js";
import type { PortMapping } from "./types.js";

const ENV_VAR_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*):-(\d+)\}$/;

function stripProtocol(port: string): string {
  return port.replace(/\/(tcp|udp|sctp)$/i, "");
}

/**
 * Split a `ports:` string into its `:`-separated segments, keeping `${…}`
 * interpolations whole. The protocol suffix (`/tcp`) is stripped first.
 */
export function portSegments(raw: string): string[] {
  const cleaned = stripProtocol(raw);

  const segments: string[] = [];
  let current = "";
  let depth = 0;

  for (const ch of cleaned) {
    if (ch === "$" || (depth > 0 && ch !== "}")) {
      current += ch;
      if (ch === "{") depth++;
      continue;
    }
    if (ch === "{" && current.endsWith("$")) {
      current += ch;
      depth++;
      continue;
    }
    if (ch === "}") {
      current += ch;
      depth--;
      continue;
    }
    if (ch === ":" && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

function splitPortString(raw: string): {
  host: string;
  container: string;
} | null {
  const segments = portSegments(raw);
  if (segments.length === 1) return null;
  if (segments.length === 2)
    return { host: segments[0], container: segments[1] };
  if (segments.length === 3)
    return { host: segments[1], container: segments[2] };

  return null;
}

function resolveEnvVar(segment: string): {
  envVar: string;
  defaultPort: number;
} | null {
  const match = segment.match(ENV_VAR_PATTERN);
  if (!match) return null;
  return { envVar: match[1], defaultPort: parseInt(match[2], 10) };
}

function resolvePort(segment: string): number | null {
  const n = parseInt(segment, 10);
  return isNaN(n) ? null : n;
}

/** `8000-8010`: a port range, which no single allocated port can replace. */
function isRange(segment: string): boolean {
  return /^\s*\d+\s*-\s*\d+\s*$/.test(segment);
}

export function extractPortMappings(
  services: ComposeService[],
): PortMapping[] {
  const mappings: PortMapping[] = [];

  for (const svc of services) {
    for (const raw of svc.ports) {
      const split = splitPortString(raw);
      if (!split) continue;

      const envResult = resolveEnvVar(split.host);
      const containerEnv = resolveEnvVar(split.container);
      const containerPort =
        containerEnv?.defaultPort ?? resolvePort(split.container);

      if (containerPort === null) continue;

      if (envResult) {
        mappings.push({
          serviceName: svc.name,
          envVar: envResult.envVar,
          defaultPort: envResult.defaultPort,
          containerPort,
          raw,
        });
      } else {
        const hostPort = resolvePort(split.host);
        // Host port 0 asks the engine for any free port: it never collides.
        if (hostPort !== null && hostPort !== 0) {
          mappings.push({
            serviceName: svc.name,
            envVar: null,
            defaultPort: hostPort,
            containerPort,
            raw,
            ...(isRange(split.host) || isRange(split.container) ? { range: true } : {}),
          });
        }
      }
    }
  }

  return mappings;
}

export function suggestEnvVar(serviceName: string): string {
  return `${serviceName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PORT`;
}

/**
 * A variable name to suggest for each hardcoded mapping: `<SERVICE>_PORT`,
 * or `<SERVICE>_<CONTAINER>_PORT` for a service's further ports, never one
 * the compose file already uses (two ports sharing a name would get the
 * same value).
 */
export function suggestEnvVars(mappings: PortMapping[]): Map<PortMapping, string> {
  const taken = new Set(mappings.flatMap((m) => (m.envVar ? [m.envVar] : [])));
  const out = new Map<PortMapping, string>();
  for (const m of mappings) {
    if (m.envVar !== null) continue;
    const base = suggestEnvVar(m.serviceName);
    let name = taken.has(base) ? base.replace(/_PORT$/, `_${m.containerPort}_PORT`) : base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    taken.add(name);
    out.set(m, name);
  }
  return out;
}
