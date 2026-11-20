import type { ConnectorConfig } from './config.ts';
import type { RelayCompatibility } from './compat.ts';
import type { RelayTransport, SourceQuestionRecord } from './transport.ts';

/**
 * Вопросы владельцу, записанные в backend по соглашению Relay: документ
 * `Вопрос: <суть>` (тип `proposal`, состояние `draft`) с разделами
 * `## Вопрос`, `## Варианты`, `## Рекомендация`, `## Временный ответ`,
 * `## Ответ`. harness их только читает и показывает в представлении
 * оператора; отвечают в Relay.
 */

export interface SourceQuestion {
  id: string;
  key: string;
  title: string;
  revision: number;
  question?: string;
  options: string[];
  recommendation?: string;
  provisional?: string;
  targets: string[];
  updatedAt?: string;
  /** Адрес документа в веб-интерфейсе backend, если он известен. */
  url?: string;
}

/** Последнее наблюдение backend в состоянии коннектора (`observation('relay')`). */
export interface RelayObservation {
  at: string;
  provider: string;
  projectId: string;
  connector: string;
  compatibility?: RelayCompatibility;
  questions?: { items: SourceQuestion[]; total: number; error?: string };
  /**
   * Срез последнего чтения задач (снимок или `run --source`): задачи с
   * названием и причинами неготовности. Запись снимка с той же ревизией не
   * обновляется, а eligibility (колонка, зависимости) меняется без новой
   * ревизии — поэтому срез хранится здесь и пишется при каждом чтении.
   */
  scope?: {
    readAt: string;
    tasks: { id: string; key: string; title?: string; orderId: string }[];
    problems: { taskId: string; code: string; message: string }[];
  };
}

export const RELAY_OBSERVATION = 'relay';
/** Предел времени чтения вопросов владельцу за одно наблюдение. */
export const QUESTIONS_TIMEOUT_MS = 20_000;

const SECTION_MAX = 2000;

/** Разделы `## Заголовок` документа в нижнем регистре заголовка. */
function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (current !== undefined && !out.has(current)) out.set(current, buf.join('\n').trim());
  };
  for (const line of body.split('\n')) {
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1]!.toLowerCase();
      buf = [];
    } else if (current !== undefined) buf.push(line);
  }
  flush();
  return out;
}

const pick = (s: Map<string, string>, ...names: string[]) => {
  for (const n of names) {
    const v = s.get(n);
    if (v) return v.slice(0, SECTION_MAX);
  }
  return undefined;
};

export function parseQuestion(record: SourceQuestionRecord, webBase?: string): SourceQuestion {
  const s = sections(record.body);
  const options = (pick(s, 'варианты', 'options') ?? '')
    .split('\n')
    .map((l) => /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => !!x)
    .slice(0, 10);
  const question = pick(s, 'вопрос', 'question');
  const recommendation = pick(s, 'рекомендация', 'recommendation');
  const provisional = pick(s, 'временный ответ', 'provisional answer');
  return {
    id: record.id,
    key: record.key,
    title: record.title.replace(/^\s*(вопрос|question)\s*:\s*/i, '').trim() || record.title,
    revision: record.revision,
    ...(question ? { question } : {}),
    options,
    ...(recommendation ? { recommendation } : {}),
    ...(provisional ? { provisional } : {}),
    targets: record.targets.slice(0, 20),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    ...(webBase ? { url: `${webBase}/documents/${encodeURIComponent(record.id)}` } : {}),
  };
}

/**
 * Адрес проекта в веб-интерфейсе Relay v1 (`<origin>/projects/<id>`); у
 * Relay-2 его нет. Строится из origin и пути endpoint без `/api/v1`: учётные
 * данные, query и fragment endpoint в ссылку не попадают.
 */
export function webBaseOf(config: ConnectorConfig): string | undefined {
  if (config.provider !== 'relay-v1-http') return undefined;
  const raw = (config.relay as { endpoint?: unknown }).endpoint;
  if (typeof raw !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return `${url.origin}${path}/projects/${encodeURIComponent(config.projectId)}`;
}

/** Открытые вопросы backend; нет метода у транспорта — `undefined`, сбой — с причиной. */
export async function readQuestions(
  config: ConnectorConfig,
  transport: RelayTransport,
  redact: (text: string) => string,
  signal?: AbortSignal,
): Promise<RelayObservation['questions']> {
  if (!config.questions.enabled || !transport.listOpenQuestions) return undefined;
  try {
    // Наблюдение необязательно: общий предел времени, чтобы не задерживать run.
    const bound = AbortSignal.timeout(QUESTIONS_TIMEOUT_MS);
    const { questions, total } = await transport.listOpenQuestions(
      { limit: config.questions.limit },
      signal ? AbortSignal.any([signal, bound]) : bound,
    );
    const base = webBaseOf(config);
    return { items: questions.map((q) => parseQuestion(q, base)), total };
  } catch (error) {
    return {
      items: [],
      total: 0,
      error: redact(error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
  }
}
