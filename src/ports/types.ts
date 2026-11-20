export interface PortMapping {
  serviceName: string;
  /** `VAR` of a `${VAR:-port}` host port; null for a hardcoded host port. */
  envVar: string | null;
  defaultPort: number;
  containerPort: number;
  raw: string;
  /** A host port range (`8000-8010:8000-8010`): never remapped. */
  range?: boolean;
  /** Last host port of a range (`defaultPort` is the first). */
  rangeEnd?: number;
}

export interface PortAllocation {
  serviceName: string;
  /**
   * The variable the compose file reads this host port from, or null for a
   * hardcoded host port that wtc remaps at runtime (no variable exists).
   */
  envVar: string | null;
  port: number;
  containerPort: number;
  /** The host port the compose file publishes in the main checkout. */
  defaultPort: number;
}
