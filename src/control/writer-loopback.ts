// Сеть loopback исполнителя по итогам пробы (`smoke --writer-probe --apply-loopback`).
//
// Проба нашла шаги, закрытые только локальным портом, и повторила их под
// `network: loopback` в той же изоляции: они прошли, граница loopback
// держится. Здесь это изменение записывается в файл политики — профиль
// инструментов исполнителя получает `network: "loopback"` (127.0.0.1 и ::1,
// без интернета); у исполнителя без профиля появляется свой профиль. Больше
// ничего в политике не меняется: области записи, домены, isolation.mode и
// сеть ревьюера прежние.

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  HarnessError,
  executionPolicySchema,
  policyIssues,
  profileNetwork,
  roleBinding,
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
  repositoryId: string;
  probe: WriterProbeResult;
  now?: () => number;
}): { policy: ExecutionPolicy; receipt: WriterLoopbackReceipt } {
  const changes = loopbackChanges(input.probe);
  if (!changes.length)
    throw new HarnessError(
      'INVALID_INPUT',
      'Проба не нашла шагов, которые открывает сеть loopback',
    );
  const text = readFileSync(input.policyPath, 'utf8');
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
  const temp = `${input.policyPath}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2) + '\n');
  if (readFileSync(input.policyPath, 'utf8') !== text) {
    rmSync(temp, { force: true });
    throw new HarnessError(
      'PATH_CONFLICT',
      `Файл политики ${input.policyPath} изменился во время пробы: повторите команду`,
    );
  }
  renameSync(temp, input.policyPath);
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
