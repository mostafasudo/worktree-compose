export interface ComposeService {
  name: string;
  ports: string[];
  build?: {
    context?: string;
    dockerfile?: string;
  };
  envFile?: string[];
  /** Absolute path of the compose file that declared this service. */
  sourcePath: string;
}

export interface ComposeFile {
  services: ComposeService[];
  /** Resolved absolute path of the root compose file. */
  composePath: string;
  /** Absolute paths of the root file plus all transitively-included files, root first. */
  sourceFiles: string[];
}
