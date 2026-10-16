import {
  STATE_VERSION,
  type AttemptState,
  type ControlState,
  type ControllerLease,
  type ExecutionDocument,
  type GraphState,
  type JointVerificationState,
  type WorkState,
} from '../contracts/index.ts';

/**
 * Пустой документ: очередь ещё не запускалась — пауза без причины. Причина
 * появляется только у решения (оператор, штатная остановка, отказ, операция):
 * так первый запуск отличим от паузы, которую поставил человек.
 */
export const emptyDocument = (): ExecutionDocument => ({
  stateVersion: STATE_VERSION,
  graphs: [],
  works: [],
  attempts: [],
  verifications: [],
  control: { paused: true },
  sequence: 0,
});

/** Чтение и запись записей модели поверх документа — общая часть адаптеров хранилища. */
export class DocumentView {
  constructor(readonly doc: ExecutionDocument) {}
  control(): ControlState {
    return this.doc.control;
  }
  controller(): ControllerLease | undefined {
    return this.doc.controller;
  }
  graph(id: string) {
    return this.doc.graphs.find((g) => g.id === id);
  }
  graphs() {
    return this.doc.graphs;
  }
  work(id: string) {
    return this.doc.works.find((w) => w.id === id);
  }
  works(graphId?: string) {
    return graphId ? this.doc.works.filter((w) => w.graphId === graphId) : this.doc.works;
  }
  attempt(id: string) {
    return this.doc.attempts.find((a) => a.id === id);
  }
  attempts(workId?: string) {
    return workId ? this.doc.attempts.filter((a) => a.workId === workId) : this.doc.attempts;
  }
  verification(id: string) {
    return this.doc.verifications.find((v) => v.id === id);
  }
  verifications() {
    return this.doc.verifications;
  }
  putGraph(graph: GraphState) {
    upsert(this.doc.graphs, graph);
  }
  putWork(work: WorkState) {
    upsert(this.doc.works, work);
  }
  putAttempt(attempt: AttemptState) {
    upsert(this.doc.attempts, attempt);
  }
  putVerification(verification: JointVerificationState) {
    upsert(this.doc.verifications, verification);
  }
  setControl(control: ControlState) {
    this.doc.control = control;
  }
  setController(lease: ControllerLease | undefined) {
    if (lease) this.doc.controller = lease;
    else delete this.doc.controller;
  }
}

function upsert<T extends { id: string }>(list: T[], item: T) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
}
