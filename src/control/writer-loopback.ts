// Сеть loopback исполнителя по итогам пробы (`smoke --writer-probe --apply-loopback`).
//
// Проба нашла шаги, закрытые только локальным портом, и повторила их под
// `network: loopback` в той же изоляции: они прошли, граница loopback
// держится. Здесь это изменение записывается в файл политики — профиль
// инструментов исполнителя получает `network: "loopback"` (127.0.0.1 и ::1,
// без интернета); у исполнителя без профиля появляется свой профиль. Больше
// ничего в политике не меняется: области записи, домены, isolation.mode и
// сеть ревьюера прежние.

import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { processAlive } from '../environment/lifecycle.ts';
import { randomBytes } from 'node:crypto';
import {
  HarnessError,
  executionPolicySchema,
  policyIssues,
  profileNetwork,
  roleBinding,
  sha256,
  type ExecutionPolicy,
} from '../contracts/index.ts';
import type { WriterLoopbackReceipt, WriterProbeResult } from './writer-probe.ts';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
   Политика правится как сырой JSON файла: поля, которых нет в изменении, остаются как были. */

type Change = WriterLoopbackReceipt['changes'][number];

/**
 * Исполнители пробы, которым сеть loopback открывает закрытые шаги
 * (`loopback.status: resolves`), — изменения политики.
 */
export const loopbackChanges = (probe: WriterProbeResult): Change[] =>
  probe.writers.flatMap((w) =>
    w.loopback?.status === 'resolves'
      ? [
          {
            runtime: w.runtime,
            toolProfile: w.loopback.change.toolProfile,
            created: w.loopback.change.created,
            roles: w.loopback.change.roles,
          },
        ]
      : [],
  );

/**
 * Сырая политика с сетью loopback у исполнителей `changes` репозитория
 * `repositoryId`. Существующий профиль получает `network: "loopback"`; новый
 * профиль (`created`) — `{ runtime, network: "loopback" }`, и writer каждой
 * роли (своей у репозитория, иначе общей) — ссылку на него. Экспортируется
 * для тестов.
 */
export function withLoopback(raw: any, repositoryId: string, changes: Change[]): any {
  const next = structuredClone(raw);
  next.toolProfiles ??= {};
  const repo = (next.repositories as any[]).find((r) => r.id === repositoryId);
  for (const change of changes) {
    if (!change.created) {
      const profile = next.toolProfiles[change.toolProfile];
      if (!profile)
        throw new HarnessError(
          'INVALID_INPUT',
          `Профиля ${change.toolProfile} нет в политике: она изменилась после пробы — повторите пробу`,
        );
      profile.network = 'loopback';
      continue;
    }
    if (next.toolProfiles[change.toolProfile])
      throw new HarnessError(
        'INVALID_INPUT',
        `Профиль ${change.toolProfile} уже есть в политике: она изменилась после пробы — повторите пробу`,
      );
    next.toolProfiles[change.toolProfile] = { runtime: change.runtime, network: 'loopback' };
    for (const role of change.roles) {
      const binding = repo?.roles?.[role] ?? next.roles?.[role];
      if (!binding?.writer)
        throw new HarnessError(
          'INVALID_INPUT',
          `Роли ${role} нет в политике: она изменилась после пробы — повторите пробу`,
        );
      binding.writer.toolProfile = change.toolProfile;
    }
  }
  return next;
}

/**
 * Записать сеть loopback в файл политики: только если файл тот же, что
 * прочитан (иначе отказ), через временный файл и rename. Возвращает новую
 * политику и запись с причиной.
 */
export function applyWriterLoopback(input: {
  policyPath: string;
  /**
   * sha256 байтов файла политики, которые проба проверяла (прочитаны до
   * пробы): другой файл к моменту записи — отказ `PATH_CONFLICT`, иначе
   * изменение легло бы на политику, которую проба не видела.
   */
  probedSha: string;
  repositoryId: string;
  probe: WriterProbeResult;
  now?: () => number;
  /** Точки внутренних проверок записи (только тесты): перед rename и после него. */
  hooks?: { beforeRename?: () => void; afterRename?: () => void };
}): { policy: ExecutionPolicy; receipt: WriterLoopbackReceipt } {
  const changes = loopbackChanges(input.probe);
  if (!changes.length)
    throw new HarnessError(
      'INVALID_INPUT',
      'Проба не нашла шагов, которые открывает сеть loopback',
    );
  const conflict = () =>
    new HarnessError(
      'PATH_CONFLICT',
      `Файл политики ${input.policyPath} изменился после того, как проба его прочитала: повторите пробу`,
    );
  const release = lockPolicy(input.policyPath);
  try {
    return applyLocked(input, changes, conflict);
  } finally {
    release();
  }
}

/** Чтение, сверка и замена файла политики под замком (`applyWriterLoopback`). */
function applyLocked(
  input: Parameters<typeof applyWriterLoopback>[0],
  changes: Change[],
  conflict: () => HarnessError,
): ReturnType<typeof applyWriterLoopback> {
  const text = readFileSync(input.policyPath, 'utf8');
  if (sha256(text) !== input.probedSha) throw conflict();
  const raw = JSON.parse(text);
  const next = withLoopback(raw, input.repositoryId, changes);
  const policy = executionPolicySchema.parse(next);
  // Отказ — только за то, что внесло само изменение: прежние замечания
  // политики (их называют validate и doctor) применение не прячет и не чинит.
  const before = new Set(policyIssues(executionPolicySchema.parse(raw)).map((i) => i.message));
  const issues = policyIssues(policy).filter((i) => !before.has(i.message));
  if (issues.length)
    throw new HarnessError(
      'INVALID_INPUT',
      'Политика с сетью loopback не проходит проверку: ' + issues.map((i) => i.message).join('; '),
    );
  // Изменение — ровно то, что проба проверила: каждая роль получила loopback.
  for (const change of changes)
    for (const role of change.roles) {
      const writer = roleBinding(policy, role, input.repositoryId)?.writer;
      const profile = writer?.toolProfile ? policy.toolProfiles[writer.toolProfile] : undefined;
      if (
        writer?.toolProfile !== change.toolProfile ||
        profileNetwork(writer.runtime, profile) !== 'loopback'
      )
        throw new HarnessError('INTERNAL', `Роль ${role} не получила сеть loopback`);
    }
  const written = JSON.stringify(next, null, 2) + '\n';
  const temp = `${input.policyPath}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, written);
  input.hooks?.beforeRename?.();
  if (readFileSync(input.policyPath, 'utf8') !== text) {
    rmSync(temp, { force: true });
    throw conflict();
  }
  renameSync(temp, input.policyPath);
  input.hooks?.afterRename?.();
  // Файл после замены — наш: запись другого процесса сразу после rename
  // видна здесь, и harness не выдаёт чужой файл за применённый loopback.
  if (readFileSync(input.policyPath, 'utf8') !== written)
    throw new HarnessError(
      'PATH_CONFLICT',
      `Файл политики ${input.policyPath} перезаписан другим процессом сразу после записи loopback: проверьте файл и повторите пробу`,
    );
  const reason = input.probe.writers
    .flatMap((w) => (w.loopback?.status === 'resolves' ? [w.loopback.reason] : []))
    .join(' ');
  return {
    policy,
    receipt: {
      policy: input.policyPath,
      at: new Date((input.now ?? Date.now)()).toISOString(),
      reason,
      changes,
      note: 'Сеть профиля входит в digest изоляции: графы, согласованные под прежней политикой, получат APPROVAL_STALE — согласуйте их заново (review-plan). Интернет исполнителю закрыт, ревьюер сети профиля не получает.',
    },
  };
}

/**
 * Исключительный замок записи файла политики: `<политика>.lock` с pid
 * владельца, созданный атомарно (`wx`). Замок другого живого процесса —
 * отказ `PATH_CONFLICT`; замок умершего процесса снимается. Возвращает
 * снятие замка.
 *
 * Предел: замок согласительный. Его держат только вызовы harness, а редактор
 * или другой инструмент, сохранивший файл между последней сверкой и rename,
 * потеряет свою правку (rename атомарен, но заменяет файл целиком). Запись
 * сразу после rename ловит сверка содержимого после замены.
 */
function lockPolicy(policyPath: string): () => void {
  const lock = policyPath + '.lock';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid }) + '\n');
      } finally {
        closeSync(fd);
      }
      return () => rmSync(lock, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number | undefined;
      try {
        pid = (JSON.parse(readFileSync(lock, 'utf8')) as { pid?: unknown }).pid as number;
      } catch {
        pid = undefined;
      }
      if (typeof pid === 'number' && Number.isInteger(pid) && !processAlive(pid)) {
        rmSync(lock, { force: true });
        continue;
      }
      throw new HarnessError(
        'PATH_CONFLICT',
        `Файл политики ${policyPath} сейчас записывает другой процесс (замок ${lock}${pid ? `, pid ${pid}` : ''}): повторите позже`,
      );
    }
  }
  throw new HarnessError('PATH_CONFLICT', `Не удалось взять замок ${lock}: повторите позже`);
}
