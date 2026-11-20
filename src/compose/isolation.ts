import { suggestEnvVars } from "../ports/extract.js";
import {
  detectCrossWorktreeCollisions,
  recommendPortStride,
} from "../ports/allocate.js";
import { isProjectScopedName } from "./parse.js";
import type { PortCollision } from "../ports/allocate.js";
import type { PortMapping } from "../ports/types.js";
import type { RemapTargets } from "./override.js";
import type { ComposeFile } from "./types.js";

/**
 * Compose settings that defeat per-worktree isolation: a fixed
 * `container_name` (the second stack cannot start), and volumes/networks with
 * a fixed `name:` or `external` (every stack shares them). Services in
 * `reset` have their container_name dropped at runtime, so they are fine.
 */
export function composeIsolationWarnings(
  composeFile: ComposeFile,
  reset: ReadonlySet<string> = new Set(),
): string[] {
  const warnings: string[] = [];
  for (const svc of composeFile.services) {
    if (svc.containerName && !isProjectScopedName(svc.containerName) && !reset.has(svc.name)) {
      warnings.push(
        `Service "${svc.name}" sets container_name "${svc.containerName}" — every worktree stack would use the same name and the second one fails to start. Remove container_name.`,
      );
    }
  }
  for (const v of composeFile.sharedVolumes) {
    warnings.push(
      `Volume "${v.key}" has a fixed name/external — it is shared by every worktree stack (not isolated).`,
    );
  }
  for (const n of composeFile.sharedNetworks) {
    warnings.push(
      `Network "${n.key}" has a fixed name/external — it is shared by every worktree stack (not isolated).`,
    );
  }
  return warnings;
}

/**
 * Hardcoded `host:container` port mappings that stay the same in every
 * worktree: those not in `remapped` (remapped at runtime).
 */
export function rawPortWarnings(
  portMappings: PortMapping[],
  remapped: PortMapping[] = [],
): string[] {
  const suggestions = suggestEnvVars(portMappings);
  const done = new Set(remapped);
  return portMappings
    .filter((m) => m.envVar === null && !done.has(m))
    .map((p) =>
      p.range
        ? `Service "${p.serviceName}" publishes a host port range (${p.raw}) — every worktree stack binds the same ports. ` +
          `wtc cannot remap ranges; publish single ports, or leave the range out of worktree stacks.`
        : `Service "${p.serviceName}" uses a raw port mapping (${p.raw}). ` +
          `To enable port isolation, change it to: "\${${suggestions.get(p)}:-${p.defaultPort}}:${p.containerPort}"`,
    );
}

/**
 * What runtime remapping does, for `wtc start` (info, not warnings: the
 * stacks no longer collide). Remapped ports have no variable, so env values
 * cannot follow them; the hint says how to give one a name.
 */
export function remapNotes(targets: RemapTargets, portMappings: PortMapping[]): string[] {
  const notes: string[] = [];
  if (targets.ports.length > 0) {
    const suggestions = suggestEnvVars(portMappings);
    const first = targets.ports[0];
    notes.push(
      `Remapping hardcoded host ports per worktree at runtime (your compose file is unchanged): ` +
        `${targets.ports.map((m) => `${m.serviceName} ${m.raw}`).join(", ")}. ` +
        `To use one in env values, give it a variable, e.g. "\${${suggestions.get(first)}:-${first.defaultPort}}:${first.containerPort}".`,
    );
  }
  if (targets.containerNames.length > 0) {
    notes.push(
      `Dropping fixed container names per worktree at runtime (your compose file is unchanged): ` +
        `${targets.containerNames.map((c) => `${c.service} ("${c.name}")`).join(", ")}.`,
    );
  }
  return notes;
}

/**
 * Advisory cross-worktree collision warning over the indices actually in use
 * (live worktrees plus orphans that still reserve theirs).
 */
export function portCollisionWarnings(
  portMappings: PortMapping[],
  portStride: number,
  indices: number[],
  remapped: PortMapping[] = [],
): string[] {
  const inUse = [...new Set(indices)];
  if (inUse.length < 2) return [];

  // Collision detection is advisory; an allocation failure here must never
  // abort the command that triggered the warning.
  let collisions: PortCollision[];
  try {
    collisions = detectCrossWorktreeCollisions(portMappings, portStride, inUse, remapped);
  } catch {
    return [];
  }
  if (collisions.length === 0) return [];

  const examples = collisions
    .slice(0, 3)
    .map(
      (c) =>
        `${c.port} (wt${c.a.worktreeIndex}/${c.a.serviceName} ↔ wt${c.b.worktreeIndex}/${c.b.serviceName})`,
    )
    .join(", ");
  const recommended = recommendPortStride(portMappings, Math.max(...inUse), remapped);
  const fix =
    recommended > 0
      ? `Set "portStride": ${recommended} in .wtcrc.json (or package.json#wtc) to resolve.`
      : `No single portStride resolves this — check for services sharing the same default port.`;

  return [
    `Cross-worktree port collisions detected with portStride=${portStride} ` +
      `across worktrees ${inUse.sort((a, b) => a - b).join(", ")}: ${collisions.length} collision(s), e.g. ${examples}. ${fix}`,
  ];
}
