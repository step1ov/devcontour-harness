/* eslint-disable @typescript-eslint/no-explicit-any -- политика и граф примера правятся как сырой JSON до разбора схемой. */
/** Типы `starter-fixture.mjs` для потребителей на TypeScript (тесты, W01). */
export declare const ROOT: string;
export declare const EXAMPLE: string;
export declare const CONTROLLER_TEMPLATE: string;
export declare const STARTER: Readonly<{ url: string; commit: string; pnpm: string }>;
export declare const SETUP_VERSION: string;

export interface StarterManifest {
  version: 1;
  setupVersion: string;
  upstream: { source: string; commit: string };
  baselineSha: string;
  baselineMessage: string;
  setup: { path: string; sha256: string }[];
  tools: { node: string; pnpm: string | null };
  repo: string;
}
export interface StarterFixture {
  workDir: string;
  repo: string;
  baselineSha: string;
  upstream: { source: string; commit: string };
  /** Каталоги, которые нужно поставить первыми в PATH процесса harness (pnpm закреплённой версии). */
  pathPrepend: string[];
  env: { PATH: string };
  manifest: StarterManifest;
}
export declare function git(cwd: string, args: string[], env?: Record<string, string>): string;
export declare function prepareStarterFixture(options: {
  workDir: string;
  source?: string;
  commit?: string;
  installPnpm?: boolean;
  warm?: boolean;
  log?: (line: string) => void;
}): StarterFixture;
export declare function starterPolicy(
  fixture: Pick<StarterFixture, 'repo'>,
  options?: {
    template?: 'policy.json' | 'policy.lifecycle.json';
    repoPath?: string;
    targetRef?: string;
    scenario?: string;
    edit?: (policy: any) => void;
  },
): any;
export declare function starterGraph(options?: {
  template?: string;
  edit?: (graph: any) => void;
}): any;
export declare function changeFiles(
  fixture: Pick<StarterFixture, 'repo' | 'baselineSha'>,
  patch: string,
): Record<string, string>;
/** `upstream: null` — обычный репозиторий проекта, не копия starter (skill harness-setup). */
export declare function controllerContext(
  fixture: Pick<StarterFixture, 'repo' | 'baselineSha'> & {
    upstream: StarterFixture['upstream'] | null;
  },
  dir: string,
): { dir: string; provenance: any };
export declare const approve: (summary?: string) => { result: Record<string, unknown> };
export declare const implement: (
  files: Record<string, string>,
  summary?: string,
) => { files: Record<string, string>; result: Record<string, unknown> };
/** Пользовательская раскладка рядом с копией: policy.json, graph.json, context/controller-mode. */
export declare function writeLayout(
  fixture: Pick<StarterFixture, 'repo' | 'baselineSha' | 'upstream' | 'workDir'>,
  options?: { targetRef?: string; scenario?: string; edit?: (policy: any) => void },
): { policy: string; graph: string; context: string };
