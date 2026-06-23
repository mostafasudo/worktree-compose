import { getRepoRoot, getRepoName, detectComposeFile } from "./compose/detect.js";
import { parseComposeFile } from "./compose/parse.js";
import { extractPortMappings } from "./ports/extract.js";
import {
  detectCrossWorktreeCollisions,
  recommendPortStride,
} from "./ports/allocate.js";
import { loadConfig } from "./config.js";
import { getNonMainWorktrees } from "./git/worktree.js";
import * as log from "./utils/log.js";
import type { ComposeFile } from "./compose/types.js";
import type { PortMapping } from "./ports/types.js";
import type { WtcConfig } from "./config.js";
import type { WorktreeInfo } from "./git/worktree.js";

export interface WtcContext {
  repoRoot: string;
  repoName: string;
  composeFile: ComposeFile;
  portMappings: PortMapping[];
  config: WtcConfig;
  portStride: number;
  worktrees: WorktreeInfo[];
}

export function buildContext(): WtcContext {
  const repoRoot = getRepoRoot();
  const repoName = getRepoName(repoRoot);

  const composePath = detectComposeFile(repoRoot);
  if (!composePath) {
    throw new Error(
      `No compose file found in ${repoRoot}. Expected one of: compose.yaml, compose.yml, docker-compose.yaml, docker-compose.yml`,
    );
  }

  const composeFile = parseComposeFile(composePath);
  const portMappings = extractPortMappings(composeFile.services);
  const config = loadConfig(repoRoot);
  const portStride = config.portStride ?? 1;
  const worktrees = getNonMainWorktrees(repoRoot);

  warnOnPortCollisions(portMappings, portStride, worktrees.length);

  return {
    repoRoot,
    repoName,
    composeFile,
    portMappings,
    config,
    portStride,
    worktrees,
  };
}

function warnOnPortCollisions(
  portMappings: PortMapping[],
  portStride: number,
  worktreeCount: number,
): void {
  if (worktreeCount < 2) return;

  const collisions = detectCrossWorktreeCollisions(
    portMappings,
    portStride,
    worktreeCount,
  );
  if (collisions.length === 0) return;

  const examples = collisions
    .slice(0, 3)
    .map(
      (c) =>
        `${c.port} (wt${c.a.worktreeIndex}/${c.a.serviceName} ↔ wt${c.b.worktreeIndex}/${c.b.serviceName})`,
    )
    .join(", ");
  const recommended = recommendPortStride(portMappings, worktreeCount);
  const fix =
    recommended > 0
      ? `Set "portStride": ${recommended} in .wtcrc.json (or package.json#wtc) to resolve.`
      : `No single portStride resolves this — check for services sharing the same default port.`;

  log.warn(
    `Cross-worktree port collisions detected with portStride=${portStride} ` +
      `across ${worktreeCount} worktrees: ${collisions.length} collision(s), e.g. ${examples}. ${fix}`,
  );
}

export function filterWorktrees(
  worktrees: WorktreeInfo[],
  indices: number[],
): WorktreeInfo[] {
  if (indices.length === 0) return worktrees;
  return indices
    .map((i) => {
      const wt = worktrees[i - 1];
      if (!wt) throw new Error(`Worktree index ${i} not found. Run 'wtc list' to see available worktrees.`);
      return wt;
    });
}
