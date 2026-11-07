import {
  API_VERSION,
  INPUT_SOURCE_KIND,
  blocksWork,
  inputManifestSchema,
  inputSourceId,
  pinnedBytes,
  sha256,
  sourceDigest,
  type ContextSnapshot,
  type ContextSourceEntry,
  type ExecutionView,
  type InputAnswer,
  type InputManifest,
  type InputRequest,
  type PinnedFile,
  type WorkState,
} from '../contracts/index.ts';

/**
 * Чтение запросов исполнителя (`input-requests`). Запрос хранится у
 * владельца — репозитория поручения; поиск по поручению идёт у его
 * владельца, без владельца — по всем.
 */
export function requestsOf(
  view: ExecutionView,
  work?: Pick<WorkState, 'id' | 'order'>,
): InputRequest[] {
  return view
    .locals('input-requests', work?.order.repositoryId)
    .map((r) => r.value)
    .filter((r) => !work || r.workId === work.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Вопрос, держащий поручение: блокирующий запрос в `pending` или
 * `answered`. Это канонический блокер claim, retry (в том числе со сбросом),
 * repair и finish: `WorkState.hold` для него не занимается, и снятие чужого
 * удержания ожидания ответа не обходит.
 */
export function blockingRequest(
  view: ExecutionView,
  work: Pick<WorkState, 'id' | 'order'>,
): InputRequest | undefined {
  return requestsOf(view, work).find(blocksWork);
}

/** Запрос по ID у любого владельца. */
export function requestById(
  view: ExecutionView,
  id: string,
): { owner: string; request: InputRequest } | undefined {
  const found = view.locals('input-requests').find((r) => r.key === id);
  return found ? { owner: found.owner, request: found.value } : undefined;
}

/* ------------------------------------------------------------------ */
/* Ответ как источник контекста                                         */
/* ------------------------------------------------------------------ */

const pin = (path: string, text: string): PinnedFile => ({
  path,
  digest: sha256(Buffer.from(text, 'utf8')),
  bytes: Buffer.byteLength(text, 'utf8'),
  content: { encoding: 'utf8', data: text },
});

/** Сообщение обсуждения хоста, включённое в источник ответа: ID, версия и digest. */
export type InputMessageRef = InputManifest['messages'][number];

/**
 * Источник контекста с ответом на вопрос исполнителя (`input-answer`):
 * файл `input/<id>.md` — вопрос, варианты и ответ, их получат writer и оба
 * reviewer; справка `input/<id>.manifest.json` — точные запрос, digest и
 * версия ответа и включённые сообщения хоста. Версия источника — версия
 * ответа (`r<N>`), не ревизия Git. Источник неизменяем: новое сообщение или
 * ответ — новый источник и новый снимок.
 */
export function inputContextSource(
  request: InputRequest,
  answer: InputAnswer,
  messages: InputMessageRef[] = [],
): ContextSourceEntry {
  const manifest: InputManifest = inputManifestSchema.parse({
    requestId: request.id,
    answerDigest: answer.digest,
    revision: answer.revision,
    messages,
  });
  const q = request.question;
  const text = [
    `# Answer to the writer's question ${request.id}`,
    `Work order: ${request.workId}, attempt ${request.attempt}.`,
    '## Question',
    q.question,
    ...(q.options.length
      ? [
          '## Options',
          ...q.options.map(
            (o) => `- ${o.id}: ${o.label}${o.consequence ? ` — ${o.consequence}` : ''}`,
          ),
          q.recommended ? `Recommended by the writer: ${q.recommended}.` : '',
        ]
      : []),
    `## Answer (revision ${answer.revision}, ${answer.kind})`,
    answer.optionId ? `Chosen option: ${answer.optionId}.` : '',
    answer.text,
  ]
    .filter((line) => line !== '')
    .join('\n\n');
  const files = [pin(`input/${request.id}.md`, text + '\n')];
  const references = [
    pin(`input/${request.id}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n'),
  ];
  const entry = {
    id: inputSourceId(request.id),
    kind: INPUT_SOURCE_KIND,
    version: `r${answer.revision}`,
    required: true,
    files,
    references,
  };
  return { ...entry, digest: sourceDigest(entry) };
}

/** Снимок `base` с источником ответа (прежний источник того же запроса заменяется). */
export function withInput(
  base: ContextSnapshot | undefined,
  entry: ContextSourceEntry,
): ContextSnapshot {
  return {
    apiVersion: API_VERSION,
    sources: [...(base?.sources ?? []).filter((s) => s.id !== entry.id), entry],
    missing: (base?.missing ?? []).filter((m) => m.id !== entry.id),
  };
}

/** Manifest источника ответа; источник другого вида или без manifest — `undefined`. */
export function inputManifestOf(source: ContextSourceEntry): InputManifest | undefined {
  if (source.kind !== INPUT_SOURCE_KIND) return undefined;
  const file = source.references.find((f) => f.path.endsWith('.manifest.json'));
  if (!file) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(pinnedBytes(file).toString('utf8'));
  } catch {
    // Не JSON или digest не совпал: manifest не прочитан — причина, а не сбой.
    return undefined;
  }
  const parsed = inputManifestSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Ответ заменённого запроса (`superseded`), перенесённый в контекст
 * преемника: продолжением исходной работы он не является — это сведения для
 * новой редакции. Запрос закрыт, блокировки нет; снимок называет ровно один
 * из записанных ответов.
 */
export const carried = (
  request: InputRequest,
  manifest: InputManifest,
  mayCarry: (request: InputRequest) => boolean,
) => {
  const last = request.answers.at(-1);
  return (
    request.lifecycle === 'superseded' &&
    last?.digest === manifest.answerDigest &&
    last.revision === manifest.revision &&
    mayCarry(request)
  );
};

/**
 * Источники ответов снимка, которые ещё не применены `applyInput`: запрос не
 * найден, не применён или применён с другим ответом. Такой снимок не
 * становится действующим согласованием обходным путём (approve, run).
 */
export function unappliedInputs(
  view: ExecutionView,
  snapshot: ContextSnapshot | undefined,
  /**
   * Можно ли перенести ответ заменённого запроса сейчас — правило движка
   * (`(r) => engine.carryAllowed(view, r)`; то же делает
   * `Engine.unappliedInputs`). Обязателен: отметка `closed.carry` — лишь
   * сведение о моменте замены, решать по ней нельзя.
   */
  mayCarry: (request: InputRequest) => boolean,
) {
  // Вызов без правила переноса (прежняя сигнатура, JS) — ошибка, а не тихое
  // решение по устаревшей отметке.
  if (typeof mayCarry !== 'function')
    throw new TypeError('unappliedInputs: нужен mayCarry (Engine.carryAllowed)');
  const out: { source: string; requestId?: string; reason: string }[] = [];
  for (const source of snapshot?.sources ?? []) {
    if (source.kind !== INPUT_SOURCE_KIND) continue;
    const manifest = inputManifestOf(source);
    if (!manifest) {
      out.push({ source: source.id, reason: 'manifest ответа не прочитан' });
      continue;
    }
    const found = requestById(view, manifest.requestId)?.request;
    if (!found)
      out.push({ source: source.id, requestId: manifest.requestId, reason: 'запрос не найден' });
    else if (carried(found, manifest, mayCarry)) continue;
    else if (found.lifecycle !== 'applied' || found.target?.answerDigest !== manifest.answerDigest)
      out.push({
        source: source.id,
        requestId: found.id,
        reason:
          found.lifecycle === 'applied'
            ? 'в снимке другой ответ, чем применённый'
            : `ответ не применён (${found.lifecycle})`,
      });
  }
  return out;
}
