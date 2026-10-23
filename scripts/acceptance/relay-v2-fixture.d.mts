/** Типы для `relay-v2-fixture.mjs` (используется из TypeScript-тестов). */
export declare const RELAY_V2_COMMIT: string;
export declare const RELAY_V2_BUILD_DIR: string;

export declare function relayV2Binary(explicit?: string): string | undefined;
export declare function relayV2SqliteLib(): string | undefined;
export declare function relayV2Env(home: string): Record<string, string>;
export declare function sha256File(path: string): string;

export interface RelayV2Info {
  available: boolean;
  binary?: string;
  sha256?: string;
  commit?: string;
  expectedCommit?: string;
  bun?: string;
  cliVersion?: string;
  platform?: string;
  node?: string;
  sqliteLib?: string;
}
export declare function relayV2Info(bin?: string): RelayV2Info;

export interface RelayV2CliError extends Error {
  code?: string;
  status?: number | null;
}

export interface RelayV2Project {
  bin: string;
  root: string;
  home: string;
  config: string;
  projectId: string;
  env: Record<string, string>;
  /** Независимый вызов CLI → `data` (или полный envelope при `full`). */
  cli(args: string[], options?: { actor?: string; full?: boolean }): any;
  exec(
    args: string[],
    input?: string,
  ): { status: number | null; json: any; stdout: string; stderr: string };
  generation(): number;
  settings(extra?: Record<string, unknown>): {
    binary: string;
    config: string;
    projectId: string;
    actor: string;
    env: Record<string, string>;
    [key: string]: unknown;
  };
  cleanup: () => void;
}

export interface RelayV2Seed {
  main: { id: string; key: string };
  dependency: { id: string; key: string };
  subtask: { id: string; key: string };
  document: { id: string; key: string; body: string };
  criteria: { id: string; title: string }[];
}

export declare function createRelayV2Project(options?: {
  bin?: string;
  name?: string;
  slug?: string;
  root?: string;
}): RelayV2Project;

export declare function seedRelayV2Task(
  project: RelayV2Project,
  options?: { actor?: string; title?: string; docBody?: string },
): RelayV2Seed;

export declare function createRelayV2Fixture(options?: { bin?: string; second?: boolean }): {
  a: RelayV2Project & { seed: RelayV2Seed };
  b?: RelayV2Project & { seed: RelayV2Seed };
  cleanup: () => void;
};

export declare function createLossyRelayV2Wrapper(options: {
  bin?: string;
  dir: string;
  match: string[];
  mode?: 'drop' | 'hang' | 'kill-parent';
  times?: number;
}): { path: string; hits(): number };

export interface RelayV2Admin {
  createTask(input: {
    title: string;
    description: string;
    column?: string;
    criteria?: { title: string; summary?: string }[];
    dependencies?: string[];
    parentId?: string;
  }): Promise<{ id: string; key: string; criteria: string[] }>;
  updateTask(id: string, patch: { title?: string; description?: string }): Promise<void>;
  updateCriterion(id: string, criterionId: string, title: string): Promise<void>;
  completeCriterion(id: string, criterionId: string, completed?: boolean): Promise<void>;
  addDocument(taskId: string, doc: { name: string; body: string }): Promise<{ id: string }>;
  updateDocument(id: string, body: string): Promise<void>;
  addDependency(id: string, dependsOn: string): Promise<void>;
  move(id: string, column: string): Promise<void>;
  comment(id: string, body: string): Promise<void>;
  takeover(sessionId: string): Promise<void>;
}
export declare function relayV2Admin(project: RelayV2Project, actor?: string): RelayV2Admin;
