/**
 * Backend общего набора коннектора на настоящем изолированном Relay v1.
 * Каждый `project()` поднимает свой сервер с новым временным проектом
 * (scripts/acceptance/relay-v1-server.mjs, ~1–2 с). Действия «другого
 * участника» — независимый REST-клиент с другим actor (`relay-fixture`),
 * не адаптер. `dropping` — управляемый HTTP proxy для D02: поле `relay`
 * конфигурации (им пользуются процессы-worker) указывает на proxy, а
 * `transport()` для проверок — прямо на сервер.
 */
import type { SuiteBackend, SuiteProject } from '../../src/integrations/connector/testing.ts';
import type { TaskColumn } from '../../src/integrations/connector/transport.ts';
import { createTransport } from '../../src/integrations/relay-v1/index.ts';

type Json = Record<string, unknown>;

export interface RelayFixture {
  url: string;
  projectId: string;
  tmp: string;
  stop(): Promise<void>;
  get(path: string): Promise<Json>;
  createTask(i: Json): Promise<{ id: string; key: string; revision: number }>;
  criteria(ref: string): Promise<{ items: { id: string }[] }>;
  createDocument(i: {
    name: string;
    body: string;
    taskId: string;
  }): Promise<{ ref: { id: string } }>;
  updateTask(ref: string, patch: Json): Promise<unknown>;
  updateCriterion(ref: string, criterionId: string, title: string): Promise<unknown>;
  completeCriterion(ref: string, criterionId: string, completed?: boolean): Promise<unknown>;
  updateDocument(id: string, body: string): Promise<unknown>;
  addDependency(ref: string, dependsOn: string): Promise<unknown>;
  moveTask(ref: string, column: string): Promise<unknown>;
  comment(ref: string, body: string): Promise<unknown>;
  takeover(sessionRef: string): Promise<unknown>;
  comments(ref: string): Promise<{ items: { id: string }[] }>;
}

export interface DroppingProxy {
  url: string;
  dropped: {
    method: string;
    path: string;
    status: number;
    response: string;
    mode: 'destroy' | 'hang';
  }[];
  close(): Promise<void>;
}

export interface ServerModule {
  startRelayServer(o?: Json): Promise<RelayFixture>;
  startDroppingProxy(
    url: string,
    drop: (method: string, path: string) => boolean | 'destroy' | 'hang',
  ): Promise<DroppingProxy>;
  isBuilt(): boolean;
  buildInfo(): Record<string, string>;
  relayV1Paths(): { buildDir: string };
}

const serverModulePath = new URL('../../scripts/acceptance/relay-v1-server.mjs', import.meta.url)
  .href;

export async function relayServerModule(): Promise<ServerModule> {
  const mod = (await import(serverModulePath)) as ServerModule;
  if (!mod.isBuilt())
    throw new Error(
      `BLOCKED: Relay v1 build missing at ${mod.relayV1Paths().buildDir}; run node scripts/acceptance/relay-v1-server.mjs prepare`,
    );
  return mod;
}

export interface RelayV1Project extends SuiteProject {
  server: RelayFixture;
  proxy?: DroppingProxy;
}

export interface RelayV1BackendOptions {
  /** Обрывать ответ после commit для запросов worker-процессов (через proxy). */
  dropping?: (method: string, path: string) => boolean | 'destroy' | 'hang';
  /** Сюда backend кладёт каждый созданный проект (для проверок теста). */
  onProject?: (p: RelayV1Project) => void;
}

const ACTOR = 'harness-controller';

export function relayV1Backend(options: RelayV1BackendOptions = {}): SuiteBackend {
  return {
    name: 'relay-v1',
    async project(): Promise<RelayV1Project> {
      const mod = await relayServerModule();
      const srv = await mod.startRelayServer();
      const proxy = options.dropping
        ? await mod.startDroppingProxy(srv.url, options.dropping)
        : undefined;
      const settings = {
        endpoint: srv.url,
        projectId: srv.projectId,
        actor: ACTOR,
        timeoutMs: 30_000,
      };
      const relay = { endpoint: proxy?.url ?? srv.url, timeoutMs: 30_000 };
      const project: RelayV1Project = {
        provider: 'relay-v1-http',
        projectId: srv.projectId,
        actor: ACTOR,
        relay,
        server: srv,
        ...(proxy ? { proxy } : {}),
        transport: () => createTransport(settings),
        worker: { kind: 'config' },
        admin: {
          async createTask(input) {
            const t = await srv.createTask({
              title: input.title,
              description: input.description,
              column: input.column ?? 'ready',
              criteria: (input.criteria ?? []).map((c) => ({
                title: c.title,
                summary: c.summary ?? '',
              })),
              dependencies: input.dependencies ?? [],
              ...(input.parentId ? { parentId: input.parentId } : {}),
            });
            const criteria = (await srv.criteria(t.id)).items.map((c) => c.id);
            return { id: t.id, key: t.key, criteria };
          },
          async updateTask(id, patch) {
            await srv.updateTask(id, patch);
          },
          async updateCriterion(id, criterionId, title) {
            await srv.updateCriterion(id, criterionId, title);
          },
          async completeCriterion(id, criterionId, completed = true) {
            await srv.completeCriterion(id, criterionId, completed);
          },
          async addDocument(taskId, doc) {
            const saved = await srv.createDocument({ ...doc, taskId });
            return { id: saved.ref.id };
          },
          async updateDocument(id, body) {
            await srv.updateDocument(id, body);
          },
          async addDependency(id, dependsOn) {
            await srv.addDependency(id, dependsOn);
          },
          async move(id, column: TaskColumn) {
            await srv.moveTask(id, column);
          },
          async comment(id, body) {
            await srv.comment(id, body);
          },
          async takeover(sessionId) {
            await srv.takeover(sessionId);
          },
        },
        async cleanup() {
          try {
            await proxy?.close();
          } finally {
            await srv.stop();
          }
        },
      };
      options.onProject?.(project);
      return project;
    },
  };
}
