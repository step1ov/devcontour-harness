/* eslint-disable @typescript-eslint/require-await -- заглушка L0; снимается рабочим пакетом */
import type { z } from 'zod';
import type {
  ExecutionPolicy,
  initDataSchema,
  ProfilePin,
  ProjectManifest,
} from '../contracts/index.ts';
import type { ToolchainReport } from '../toolchains/inspect.ts';
import type { ToolProbe } from '../toolchains/probe.ts';
import type { FileIntent, FilePlan } from '../setup/files.ts';
import { notImplemented } from '../projections/stub.ts';

export type InitData = z.infer<typeof initDataSchema>;

/** `p-` + первые 16 hex sha256 от realpath корня: тот же проект — тот же id. */
export function projectIdOf(root: string): string {
  void root;
  return notImplemented('projectIdOf');
}
/** Каталог состояния по умолчанию — вне репозитория. */
export function defaultStateDir(projectId: string, env?: NodeJS.ProcessEnv): string {
  void projectId;
  void env;
  return notImplemented('defaultStateDir');
}
/** Manifest проекта; отсутствует — undefined, невалиден — INVALID_INPUT. */
export async function readProjectManifest(
  repository: string,
): Promise<ProjectManifest | undefined> {
  void repository;
  return notImplemented('readProjectManifest');
}

export interface InitOptions {
  repository: string;
  profile?: string;
  writer?: 'claude' | 'codex';
  state?: string;
  plan?: boolean;
  env?: NodeJS.ProcessEnv;
  probe?: ToolProbe;
}
export interface InitPlanned {
  root: string;
  status: 'new' | 'partial' | 'complete';
  manifest: ProjectManifest;
  intents: FileIntent[];
  plan: FilePlan;
  policy: ExecutionPolicy;
  profile: ProfilePin;
  shadowed: string[];
  toolchain: ToolchainReport[];
}
export async function planProject(options: InitOptions): Promise<InitPlanned> {
  void options;
  return notImplemented('planProject');
}
/** `harness init`: план или create-only запись `.harness/`, manifest последним. */
export async function initProject(options: InitOptions): Promise<InitData> {
  void options;
  return notImplemented('initProject');
}
export function initText(data: InitData): string {
  void data;
  return notImplemented('initText');
}
