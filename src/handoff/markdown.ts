import { HANDOFF_LIMITS, type HandoffPack } from '../contracts/handoff.ts';

/** Ячейка таблицы Markdown: одна строка, без разделителей колонок. */
const cell = (s: string | number | undefined | null) =>
  String(s ?? '—')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|');
const secs = (ms: number | undefined) => (ms === undefined ? '—' : `${Math.round(ms / 1000)} с`);
const who = (actor: string | null | undefined) => actor ?? '—';
const more = (n: number, what: string) =>
  n > 0 ? [`… и ещё ${n} ${what} (не вошли в пакет)`] : [];
const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `$${n.toFixed(2)}`;
type Budget = NonNullable<HandoffPack['budgets']>['entries'][number];
/** Расход: точный или нижняя граница с причинами неполноты. */
function spent(b: Budget) {
  const total = usd(b.reportedUsd + b.estimatedUsd);
  const split =
    b.estimatedUsd > 0 ? ` (сообщено ${usd(b.reportedUsd)}, оценено ${usd(b.estimatedUsd)})` : '';
  if (b.complete) return total + split;
  const gaps = [
    ...(b.unknownCalls ? [`${b.unknownCalls} вызовов без стоимости`] : []),
    ...(b.unfinishedCalls ? [`${b.unfinishedCalls} незавершённых`] : []),
    ...(b.abandonedCalls ? [`${b.abandonedCalls} брошенных`] : []),
    ...(b.uncoveredRuns ? [`${b.uncoveredRuns} попыток без учёта`] : []),
  ];
  return `≥ ${total}${split} (неполно: ${gaps.join(', ')})`;
}

/**
 * Текст пакета передачи для новой сессии ведущего агента. Те же данные, что
 * JSON-ответ; раздел «Намерения» — единственный, который пишет агент.
 */
export function handoffMarkdown(pack: HandoffPack): string {
  const out: string[] = [];
  const s = pack.summary;
  out.push(
    `# Передача контекста${pack.graphId ? ` — граф ${pack.graphId}` : ''}`,
    '',
    `Снимок хранилища на ${pack.at}. Факты ниже — из состояния harness, не из памяти агента.`,
    '',
    `Поручений: ${s.works} (открыто ${s.open}, принято ${s.done}, отменено ${s.cancelled}); ` +
      `статусы: ${s.byStatus.map((b) => `${b.status} ${b.count}`).join(', ') || '—'}. ` +
      `Пределы: попыток ${pack.limits.maxAttempts}, восстановлений группы ${pack.limits.repairBudget}.` +
      (pack.truncated.bySize
        ? ' Пакет урезан по пределу размера: часть записей отброшена (см. «не вошли»).'
        : ''),
    '',
    '## Следующий шаг',
    '',
    `- **${who(pack.next.actor)}: ${pack.next.action}**` +
      (pack.next.workId ? ` — ${pack.next.workId}` : '') +
      (pack.next.code ? ` (${pack.next.code})` : '') +
      (pack.next.detail ? `: ${cell(pack.next.detail)}` : '') +
      (pack.next.command ? `. Команда: \`${pack.next.command}\`` : ''),
    '',
    '## Очередь',
    '',
  );
  const q = pack.queue;
  out.push(
    q.paused
      ? `- Пауза${q.reason ? ` (${q.reason})` : ''}${q.since ? ` с ${q.since}` : ''}` +
          `${q.liftedByRun ? '; её снимет следующий run' : ''}` +
          `${q.actor !== undefined || q.action ? ` → ${who(q.actor)}: ${q.action ?? '—'}` : ''}` +
          `${q.detail ? `: ${cell(q.detail)}` : ''}`
      : '- Выдача идёт.',
  );
  if (q.operation)
    out.push(`- Паузу держит операция ${cell(q.operation)}: её применяют или отменяют.`);
  if (q.failures?.length) out.push(`- Классы отказа паузы runtime: ${q.failures.join(', ')}.`);
  if (pack.controller)
    out.push(
      `- Controller: ${pack.controller.owner} до ${pack.controller.until}` +
        (pack.controller.live ? '' : ' (срок истёк)'),
    );
  out.push('', '## Активная работа', '');
  if (!pack.active.length) out.push('Нет идущих попыток.');
  else {
    out.push(
      '| Поручение | Попытка | Фаза | Стадия | Идёт | Heartbeat | Gates |',
      '|---|---|---|---|---|---|---|',
    );
    for (const a of pack.active)
      out.push(
        `| ${cell(a.workId)} — ${cell(a.title)} | ${a.attempt} (${cell(a.runId)}) | ${a.phase} | ` +
          `${cell(a.stage ? `${a.stage.name}, ${secs(a.stage.elapsedMs)}` : undefined)} | ${secs(a.elapsedMs)} | ` +
          `${a.stale ? 'истёк' : secs(a.sinceHeartbeatMs) + ' назад'} | ` +
          `${a.gates.phase}: ${a.gates.passed}/${a.gates.required}, не прошли ${a.gates.failed} |`,
      );
  }
  if (pack.unfinished.length || pack.truncated.unfinished) {
    out.push('', '### Незавершённые попытки', '');
    for (const u of pack.unfinished)
      out.push(
        `- ${u.workId} #${u.attempt} (${u.runId}), ${u.phase}, с ${u.startedAt}: ` +
          [
            u.stale ? 'владение истекло' : 'владение действует',
            u.current ? 'текущая попытка поручения' : 'поручение её не ведёт',
            ...(u.interrupted ? ['прервана остановкой'] : []),
          ].join(', '),
      );
    out.push(...more(pack.truncated.unfinished, 'попыток'));
  }
  out.push('', '## Решения и остановки', '');
  if (!pack.stops.length) out.push('Остановок нет.');
  for (const d of pack.stops)
    out.push(
      `- ${(d.actor === 'user' || d.actor === 'lead') && d.action !== 'wait' ? '**решение** ' : ''}` +
        `${d.queue ? 'очередь' : (d.workId ?? '—')} ${d.code} [${d.cause}/${d.phase}] → ${who(d.actor)}: ${d.action}` +
        `${d.retryPlanned ? ' (повтор запланирован)' : ''} — ${cell(d.message)}` +
        (d.worksCount
          ? ` Поручений: ${d.worksCount} (${d.works!.join(', ')}${d.worksCount > d.works!.length ? ', …' : ''}).`
          : ''),
    );
  out.push(...more(pack.truncated.stops, 'остановок'));
  out.push('', '## Открытые поручения', '');
  if (!pack.works.length) out.push('Открытых поручений нет.');
  else {
    out.push('| Поручение | Статус | Попытка | Следующий шаг | Причина |', '|---|---|---|---|---|');
    for (const w of pack.works) {
      const why = [
        ...(w.failureKind ? [`${w.failureKind}: ${w.failure ?? ''}`] : []),
        ...(w.hold ? [`удержано ${w.hold.operation}: ${w.hold.reason}`] : []),
        ...(w.recovery
          ? [
              `восстановление ${w.recovery.property} ${w.recovery.status}` +
                (w.recovery.reason ? `: ${w.recovery.reason}` : '') +
                (w.recovery.proposal ? `; предложение: ${w.recovery.proposal}` : ''),
            ]
          : []),
        ...w.blockers.map((b) => `${b.code}: ${b.message}`),
        ...(w.blockersTruncated ? [`ещё блокировок: ${w.blockersTruncated}`] : []),
      ];
      out.push(
        `| ${cell(w.id)} — ${cell(w.title)} | ${w.status} | ${w.attempt}/${pack.limits.maxAttempts} | ` +
          `${who(w.next.actor)}: ${w.next.action} (${w.next.step ?? '—'}) | ${cell(why.join('; ') || undefined)} |`,
      );
    }
  }
  out.push(...more(pack.truncated.works, 'поручений'));
  if (
    pack.queue.paused &&
    pack.works.some((w) => w.next.actor === 'controller' && w.next.action === 'retry')
  )
    out.push('', 'Повтор ждёт снятия паузы очереди.');
  out.push('', '## Последние провалы', '');
  if (!pack.failures.length) out.push('Провалов нет.');
  for (const f of pack.failures)
    out.push(
      `- ${f.finishedAt ?? '—'} ${f.workId}${f.workStatus ? ` (сейчас ${f.workStatus})` : ''} #${f.attempt} (${f.runId}) ${f.status} на ${f.phase}: ` +
        `${f.failureKind ?? 'unknown'} / ${f.code}${f.error ? ` — ${cell(f.error)}` : ''}`,
    );
  out.push(...more(pack.truncated.failures, 'провалов'));
  out.push('', '## Бюджеты', '');
  if (!pack.budgets) out.push('Бюджеты не заданы.');
  else {
    out.push(
      `Неизвестная стоимость: ${pack.budgets.onUnknown}.`,
      '',
      '| Область | Состояние | Потрачено | Предел | Осталось | Время | Неизвестных вызовов |',
      '|---|---|---|---|---|---|---|',
    );
    for (const b of pack.budgets.entries)
      out.push(
        `| ${b.scope}${b.id ? ' ' + cell(b.id) : ''} | ${b.state}${b.reason ? ': ' + cell(b.reason) : ''} | ` +
          `${spent(b)} | ${b.limitUsd !== undefined ? usd(b.limitUsd) : '—'}` +
          `${b.limitMs !== undefined ? ` / ${secs(b.limitMs)}` : ''} | ` +
          `${usd(b.remainingUsd)}${b.remainingMs !== null && b.limitMs !== undefined ? ` / ${secs(b.remainingMs)}` : ''} | ` +
          `${secs(b.durationMs)} | ${b.unknownCalls} |`,
      );
    out.push(...more(pack.truncated.budgets, 'бюджетов'));
    if (pack.truncated.budgetsWithin)
      out.push(
        `Бюджеты поручений в пределах и без расхода не показаны: ${pack.truncated.budgetsWithin}.`,
      );
    if (pack.truncated.budgetsShared)
      out.push(
        `Бюджеты поручений, весь расход которых — вызовы о их группе (ревью и проверка плана), не показаны: ${pack.truncated.budgetsShared}; этот расход учтён один раз — в строках группы и total.`,
      );
  }
  if (pack.repairs.length) {
    out.push('', 'Восстановления заданий:');
    for (const r of pack.repairs)
      out.push(`- ${r.graphId} (${r.status}): потрачено ${r.used} из ${r.budget}`);
    out.push(...more(pack.truncated.repairs, 'заданий'));
  }
  out.push('', '## Намерения', '');
  if (!pack.intentions.length)
    out.push('<!-- Дописывает агент: что собирается сделать дальше и почему. -->');
  for (const i of pack.intentions) out.push(`- ${cell(i)}`);
  if (pack.truncated.intentions)
    out.push(
      `(Усечено намерений: ${pack.truncated.intentions}, предел — ${HANDOFF_LIMITS.intentionChars} знаков.)`,
    );
  if (pack.truncated.intentionsDropped)
    out.push(`(Отброшено намерений ради предела размера: ${pack.truncated.intentionsDropped}.)`);
  return out.join('\n') + '\n';
}
