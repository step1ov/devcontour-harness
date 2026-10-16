import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { propertyReportSchema, type PropertyReport } from '../contracts/index.ts';
import { redactDeep } from '../environment/redaction.ts';

/**
 * Отчёт генеративной проверки: эталон, генератор, свойства и уменьшение
 * входа живут в проекте, а controller задаёт seed, читает отчёт при любом
 * исходе и сохраняет его как доказательство.
 *
 * Приёмка из отдельных точек проверяла примеры, а не обещание: контрпример
 * находил reviewer после полной попытки, и решение подгонялось под точки.
 * Генеративная проверка находит его сама, а seed controller делает отказ
 * воспроизводимым — даже если проверка зависла и ничего не успела записать.
 */

/** Seed controller: свой у каждой попытки, фазы и gate, но воспроизводимый. */
export function propertySeed(runId: string, phase: string, gateId: string) {
  return createHash('sha256').update(`${runId}:${phase}:${gateId}`).digest().readUInt32BE(0);
}

const brief = (v: unknown) => {
  const text = JSON.stringify(v) ?? String(v);
  return text.length > 400 ? text.slice(0, 400) + '…' : text;
};

/** Строка для итога gate: её видит следующая попытка в истории отказов. */
export function propertyFailure(report: PropertyReport) {
  // Провал случая корпуса — провал свойства, даже если отчёт оставил статус
  // свойства зелёным: отчёт противоречит сам себе, и верится провалу.
  const corpus = (report.corpus?.failed ?? [])
    .filter(
      (c) =>
        !report.properties.some(
          (p) =>
            p.testId === c.property && p.status !== 'passed' && p.counterexample?.case === c.id,
        ),
    )
    .map(
      (c) =>
        `случай корпуса ${c.id} свойства ${c.property} провален: ожидалось ${brief(c.expected)}, получено ${brief(c.actual)}`,
    );
  const own = report.properties
    .filter((p) => p.status !== 'passed')
    .map((p) =>
      p.status === 'running'
        ? `свойство ${p.testId} не завершилось на входе ${brief(p.current)}`
        : p.error && !p.counterexample
          ? `свойство ${p.testId}: ${p.error}`
          : `свойство ${p.testId} нарушено на ${brief(p.counterexample?.reduced ?? p.counterexample?.original)}` +
            (p.counterexample?.case ? ` (случай корпуса ${p.counterexample.case})` : '') +
            (p.counterexample && 'expected' in p.counterexample
              ? `: ожидалось ${brief(p.counterexample.expected)}, получено ${brief(p.counterexample.actual)}`
              : ''),
    );
  return [...own, ...corpus].join('; ');
}

/**
 * Ожидаемая проверка: что обязан подтвердить отчёт, чтобы gate прошёл.
 *
 * Зелёный код выхода и один зелёный testcase не говорят, что проверено
 * заявленное: harness с нулём входов писал `passed`, а пустой список свойств
 * проходил схему. Манифест закреплён вместе с договором проверки — свойства,
 * минимальное число входов по каждому и по семействам, обязательные случаи
 * корпуса — и отчёт сопоставляется с ним в controller, а не в подсказке
 * reviewer.
 */
export interface CheckManifest {
  properties: { id: string; minCases: number; families: { id: string; minCases: number }[] }[];
  corpus?: { digest: string; cases: { id: string; property: string }[] };
}

/** Свидетельство выполнения корпуса: hash отсортированных строк `id:pass|fail`. */
export function corpusWitness(cases: { id: string; passed: boolean }[]) {
  return createHash('sha256')
    .update(
      cases
        .map((c) => `${c.id}:${c.passed ? 'pass' : 'fail'}`)
        .sort()
        .join('\n'),
    )
    .digest('hex');
}

/** Выполненные testcases gate, как их сводит JUnit. */
export interface JunitCases {
  cases: { id: string; status: 'passed' | 'failed' | 'skipped'; opaque?: true }[];
  truncated: boolean;
}

/**
 * Почему отчёт не подтверждает покрытие. Пустой список — подтверждает.
 *
 * Без манифеста (поручение без свойств) проверяется прежний уровень: отчёт
 * не пуст, id не повторяются, `passed` означает хотя бы один проверенный
 * вход, а названные отчётом свойства есть среди testcases. С манифестом
 * обязательны все его свойства, их минимальные выборки и корпус. Id,
 * изменённый redaction или хешем, не совпадает ни с чем: скрытое имя не
 * подтверждает свойство, которое оно могло скрывать.
 */
export function propertyCoverage(
  report: PropertyReport,
  manifest: CheckManifest | undefined,
  junit: JunitCases | undefined,
): string[] {
  const problems: string[] = [];
  if (!report.properties.length) problems.push('отчёт свойств пуст: не проверено ни одно свойство');
  const counts = new Map<string, number>();
  for (const p of report.properties) counts.set(p.testId, (counts.get(p.testId) ?? 0) + 1);
  for (const [id, n] of counts)
    if (n > 1) problems.push(`свойство ${id} указано в отчёте ${n} раза`);
  for (const p of report.properties)
    if (p.status === 'passed' && p.cases < 1)
      problems.push(`свойство ${p.testId}: passed без единого проверенного входа`);
  const entry = (id: string) => report.properties.find((p) => p.testId === id);
  const required = manifest
    ? manifest.properties.map((m) => m.id)
    : [...new Set(report.properties.map((p) => p.testId))];
  if (manifest)
    for (const m of manifest.properties) {
      const p = entry(m.id);
      if (!p) {
        problems.push(`обязательное свойство ${m.id} отсутствует в отчёте`);
        continue;
      }
      // Провал и обрыв уже названы отказом свойства; недобор выборки у них
      // следствие, а не отдельная причина.
      if (p.status !== 'passed') continue;
      if (p.cases < m.minCases)
        problems.push(
          `свойство ${m.id}: проверено ${p.cases} входов из обязательных ${m.minCases}`,
        );
      for (const f of m.families) {
        const seen = p.families?.[f.id] ?? 0;
        if (seen < f.minCases)
          problems.push(
            `свойство ${m.id}, семейство ${f.id}: проверено ${seen} входов из обязательных ${f.minCases}`,
          );
      }
    }
  const corpus = manifest?.corpus;
  if (corpus && corpus.cases.length) {
    const ran = report.corpus;
    if (!ran) problems.push(`обязательный корпус (${corpus.cases.length} случаев) не выполнялся`);
    else if (ran.digest !== corpus.digest)
      problems.push('выполнен корпус другой версии, чем закреплён за поручением');
    else {
      // Полнота проверяется всегда, с провалами и без: иначе один упавший
      // случай выключал сверку, и отчёт с нулём выполненных случаев проходил.
      // Свидетельство пересчитывается по манифесту с исходами, названными
      // отчётом; если упавших больше, чем помещается в отчёт, исход каждого
      // случая не доказать — это тоже отказ.
      const failed = new Set(ran.failed.map((c) => c.id));
      const declared = new Set(corpus.cases.map((c) => c.id));
      const foreign = [...failed].filter((id) => !declared.has(id));
      const complete = ran.failed.length === ran.executed - ran.passed;
      const expected = corpusWitness(
        corpus.cases.map((c) => ({ id: c.id, passed: !failed.has(c.id) })),
      );
      if (
        ran.executed !== corpus.cases.length ||
        !complete ||
        foreign.length ||
        ran.witness !== expected
      )
        problems.push(
          `выполнены не все обязательные случаи корпуса или исходы не доказаны: ${ran.executed} из ${corpus.cases.length}` +
            (foreign.length ? `; в отчёте чужие случаи: ${foreign.slice(0, 5).join(', ')}` : ''),
        );
      if (ran.failed.length || ran.passed < ran.executed)
        problems.push(
          `случаи корпуса провалены: ${ran.executed - ran.passed}` +
            (ran.failed.length
              ? ` (${ran.failed
                  .slice(0, 5)
                  .map((c) => `${c.property}/${c.id}`)
                  .join(', ')})`
              : ''),
        );
    }
  }
  if (junit) {
    if (junit.truncated && required.length)
      problems.push('список testcases обрезан: соответствие свойств и testcases не доказать');
    else
      for (const id of required) {
        const found = junit.cases.filter((c) => !c.opaque && c.id === id);
        const p = entry(id);
        if (!found.length) problems.push(`testcase ${id} отсутствует в JUnit`);
        else if (found.length > 1) problems.push(`testcase ${id} встречается ${found.length} раза`);
        else if (p?.status === 'passed' && found[0]!.status !== 'passed')
          problems.push(`testcase ${id}: ${found[0]!.status}, хотя отчёт свойств сообщает passed`);
      }
  }
  return problems;
}

/** Digest манифеста: под ним evidence называет ту проверку, которую ждало. */
export function manifestDigest(manifest: CheckManifest) {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

const MAX_REPORT = 64 * 1024;

/**
 * Прочитать отчёт. Отсутствие или повреждение — не исключение: исход команды
 * остаётся главным, отчёт его только дополняет. Причина называется.
 *
 * Читается только обычный файл внутри каталога отчёта. Команда проверки
 * могла заменить отчёт или его каталог на symlink наружу, и чужой файл —
 * например, из каталога controller — попал бы в evidence. Каталог сверяется
 * по realpath, файл открывается без следования за ссылкой, и проверка идёт
 * по уже открытому дескриптору: подмена между проверкой и чтением не проходит.
 */
export async function readPropertyReport(
  path: string,
  root: string,
  redact?: (text: string) => string,
): Promise<
  { report: PropertyReport; problem?: undefined } | { problem: string; report?: undefined }
> {
  let base: string, dir: string;
  try {
    base = await realpath(root);
    dir = await realpath(dirname(path));
  } catch {
    return { problem: 'отчёт свойств не записан' };
  }
  if (dir !== base && !dir.startsWith(base + sep))
    return { problem: 'отчёт свойств вне каталога отчёта' };
  let text: string;
  try {
    // O_NONBLOCK: FIFO на месте отчёта без писателя иначе держал бы open
    // бесконечно, и evidence не записывалось бы вовсе.
    const handle = await open(
      join(dir, basename(path)),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { problem: 'отчёт свойств — не обычный файл' };
      if (stat.size > MAX_REPORT) return { problem: `отчёт свойств больше ${MAX_REPORT} байт` };
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ELOOP'
      ? { problem: 'отчёт свойств — symlink' }
      : { problem: 'отчёт свойств не записан' };
  }
  if (text.length > MAX_REPORT) return { problem: `отчёт свойств больше ${MAX_REPORT} байт` };
  if (redact) text = redact(text);
  try {
    const parsed = propertyReportSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { problem: 'отчёт свойств не по схеме' };
    // После разбора строки декодированы: `\\"` стал кавычкой, и форма
    // секрета снова совпадает с исходной — маска повторяется по значениям.
    return { report: redactDeep(parsed.data, redact) };
  } catch {
    return { problem: 'отчёт свойств — не JSON' };
  }
}
