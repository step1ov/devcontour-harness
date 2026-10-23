/**
 * H1-05: типы общих операций из `.d.ts` установленного архива. Проверяется
 * внешним tsc; не исполняется. Импорты — только корень и ./projections.
 */
import {
  applyFileWrites,
  chainRoots as rootChainRoots,
  checkDestination,
  diagnoseState,
  initProject,
  planFileWrites,
  type ExecutionPolicy,
  type FileIntent,
  type FilePlan,
  type InitData,
  type ProjectManifest,
} from 'devcontour-harness';
import {
  actors,
  chainRoots,
  clipDeep,
  clipText,
  CLIP_DIAGNOSTIC,
  explainStop,
  nextAction,
  nextActions,
  queueStop,
  stopCodeOf,
  workProgress,
  type Actor,
  type ChainRoot,
  type ChainWork,
  type EvidenceLink,
  type NextAction,
  type NextView,
  type ProgressView,
  type QueueStopView,
  type StopDiagnosis,
  type StopInput,
} from 'devcontour-harness/projections';

// Одна реализация: тип функции корня совпадает с ./projections.
const same: typeof chainRoots = rootChainRoots;
void same;

const works: ChainWork[] = [
  { id: 'root', status: 'failed', dependsOn: [], attempt: 3, failureKind: 'gate' },
  { id: 'a', status: 'ready', dependsOn: ['root'], attempt: 0 },
  { id: 'h', status: 'ready', dependsOn: [], attempt: 0, hold: { operation: 'op', reason: 'r' } },
];
const roots: ChainRoot[] = chainRoots(works, 3);
const first: ChainRoot | undefined = roots[0];
const actor: Actor = first ? first.actor : null;
const action: NextAction | undefined = first?.action;
void actor;
void action;
const allActors: readonly ('controller' | 'lead' | 'user')[] = actors;
const allActions: readonly NextAction[] = nextActions;
void allActors;
void allActions;

const stop: QueueStopView = queueStop({
  paused: true,
  pauseReason: 'runtime',
  errors: [{ seq: 1, message: 'Error: x' }, { seq: 2 }],
});
const detail: string | undefined = stop.detail;
void detail;

const next: NextView = nextAction({ status: 'failed', attempt: 1, maxAttempts: 3 });
void next.step;
const progress: ProgressView = workProgress({
  work: { status: 'ready', attempt: 0, dependsOn: [] },
  statusOf: () => 'done',
  maxAttempts: 3,
  paused: false,
  activeRuns: 0,
  concurrency: 1,
});
void progress.eligible;

const input: StopInput = {
  kind: 'work',
  work: { id: 'w', status: 'failed', attempt: 1, failureKind: 'environment' },
  maxAttempts: 3,
  repair: { sameFailureRepairs: 0, groupRepairsUsed: 0, groupRepairBudget: 2 },
  control: { paused: false },
  phase: 'implementation',
};
const diagnosis: StopDiagnosis = explainStop(input);
const evidence: EvidenceLink[] = diagnosis.evidence;
const retry: boolean = diagnosis.retryPlanned;
void evidence;
void retry;
explainStop({ kind: 'runtime', runtime: { runtime: 'codex', available: false } });
explainStop({ kind: 'error', error: { code: 'CONTROLLER_BUSY', message: 'busy' } });
const code: string = stopCodeOf('gate');
void code;
const clipped: string | undefined = clipText('x'.repeat(5000), CLIP_DIAGNOSTIC - 1);
const deep: { token: string; a: string } = clipDeep({ token: 't', a: 'b' });
void clipped;
void deep;

export async function setup(files: FileIntent[]): Promise<string[]> {
  await checkDestination(files[0]?.path ?? '/', { root: '/' });
  const plan: FilePlan = await planFileWrites({ files, root: '/' });
  if (plan.conflicts > 0) return plan.entries.map((e) => e.conflictPath ?? e.path);
  const { created }: { created: string[]; preserved: string[] } = await applyFileWrites(
    plan,
    files,
  );
  return created;
}

export async function standalone(
  repository: string,
  policy: ExecutionPolicy,
): Promise<ProjectManifest> {
  const data: InitData = await initProject({ repository, plan: true });
  const state: string = data.manifest.paths.state;
  void state;
  const { diagnoses } = await diagnoseState({
    stateDir: data.manifest.paths.state,
    policy,
    baseDir: repository,
  });
  const d: StopDiagnosis[] = diagnoses;
  void d;
  return data.manifest;
}
