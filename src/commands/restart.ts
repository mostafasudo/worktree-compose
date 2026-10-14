import { stopCommand } from "./stop.js";
import { startCommand } from "./start.js";
import type { EnvCliOptions } from "../context.js";

export function restartCommand(
  indices: number[],
  cli: EnvCliOptions = {},
): void {
  stopCommand(indices);
  startCommand(indices, cli);
}
