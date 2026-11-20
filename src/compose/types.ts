export interface ComposeService {
  name: string;
  ports: string[];
  /**
   * Every `ports:` entry as written (string, number, or long-form object),
   * merged across files like `ports`. A runtime override that replaces the
   * list must reproduce the entries it does not remap exactly.
   */
  portEntries?: unknown[];
  /** `ports: !override` / `!reset`: the list replaces earlier files' lists instead of adding to them. */
  portsReplace?: boolean;
  /** The service uses `extends:`, so it may inherit ports wtc cannot see. */
  extends?: boolean;
  /** What `extends:` names: a service, in another file when `file` is set. */
  extendsFrom?: { service: string; file?: string };
  /** Container names the service joins by name (`network_mode: container:<name>`, `volumes_from`, …). */
  containerRefs?: string[];
  /** Networks the service joins (absent: only the project's `default`). */
  networks?: string[];
  /** The service sets `network_mode` (host, none, another container…): no networks of its own. */
  networkMode?: boolean;
  /** `container_name: !reset` in a later file dropped any earlier name. */
  containerNameReset?: boolean;
  build?: {
    context?: string;
    dockerfile?: string;
    /** `dockerfile_inline` is set: there is no Dockerfile on disk to sync. */
    inline?: boolean;
  };
  envFile?: string[];
  /** Fixed `container_name` — breaks running the same stack twice. */
  containerName?: string;
  /** Absolute path of the compose file that declared this service. */
  sourcePath: string;
}

/**
 * A top-level volume or network that is NOT scoped to the compose project:
 * it sets an explicit `name:` or is `external`. Every worktree stack would
 * share it.
 */
export interface SharedResource {
  /** Key under `volumes:` / `networks:`. */
  key: string;
  /** Explicit `name:` when set. */
  name?: string;
  external: boolean;
}

export interface ComposeFile {
  services: ComposeService[];
  /** Resolved absolute path of the root compose file. */
  composePath: string;
  /** Absolute paths of the root file plus all transitively-included files, root first. */
  sourceFiles: string[];
  /** Top-level volumes with a fixed name or `external`. */
  sharedVolumes: SharedResource[];
  /** Top-level networks with a fixed name or `external`. */
  sharedNetworks: SharedResource[];
}
