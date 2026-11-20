// Исполнитель остановился из-за окружения, а не из-за работы.
//
// Исполнитель, которому правила проекта велят пройти шаг, закрытый его
// песочницей (генератор из реестра без сети, локальный сервер без права
// listen, браузерный инструмент, источник задачи вне контекста), отвечает
// `completed=false` и называет причину в итоге. Повтор той же попытки в той же
// песочнице упрётся в тот же шаг: это ход ведущего (поправить политику,
// контекст или вынести шаг в проверки harness), а не автоматический повтор.
//
// Признак — итог исполнителя: структурированного поля для такой остановки в
// ответе нет (правильный путь — вопрос с impact technical, его называет
// запрос). Итог часто говорит о продукте теми же словами («экран „нет сети“»,
// «обработка EACCES», «работа без интернета»), поэтому одного слова мало.
// Фраза засчитывается, только когда в одной фразе итога (между . ; ! ? и
// переводом строки) есть все три части:
// - техническое: код ОС или сети (EPERM, ENOTFOUND…), сеть, реестр, порт,
//   сервер, браузер, генератор, трекер, домашний каталог;
// - отказ: «не удалось», «cannot», «blocked», «запрещает», «недоступен»…;
// - среда: песочница, окружение, изоляция или сам код ОС.
// Текст в кавычках ('…', "…", «…») не учитывается: так пишут тексты и
// сообщения продукта. Несколько явных формулировок засчитываются сами
// («нет доступа к сети», «network is blocked», коды отказа песочницы).
// Обычная незавершённость («не успел», «тесты ещё не написаны») сюда не
// попадает и продолжается черновиком, как раньше.

import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SRT_SHORT_BASE, srtSocketsFit } from '../environment/isolation.ts';

/** Коды и сообщения ОС и сети: и техническое, и среда. */
const osCode =
  /\b(?:EPERM|EACCES|EROFS|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b|operation not permitted|permission denied|read-only file system|getaddrinfo|could not resolve host/gi;
/** Признаки, достаточные сами по себе: их печатает только отказ песочницы или реестра. */
const decisive =
  /\bbootstrap_check_in\b|\bsandbox_apply\b|\bERR_PNPM_META_FETCH_FAIL\b|\bno (?:network|internet) access\b|\bnetwork (?:access )?is (?:disabled|blocked|unavailable|off)\b|нет доступа к (?:сети|интернет)|сеть недоступна/i;
const technical =
  /\b(?:network|internet|registry|dns|listen|bind|port|localhost|127\.0\.0\.1|browser|chrom(?:e|ium)|server|generator|tracker|home director(?:y|ies))\b|~\/|сет[ьиеюя]|сетев|интернет|реестр|порт|сервер|браузер|генератор|трекер|домашн/i;
const refusal =
  /\b(?:cannot|can't|could not|couldn't|unable|fails?|failed|blocked|blocks|denied|denies|not allowed|refused|forbid(?:s|den)?|prevents?|prevented)\b|\berror:|не смог|не удалось|не могу|невозможно|нельзя|отказ|заблокир|запрещ|не да[её]т|не позволя|недоступ|закрыт/i;
const environment =
  /\bsandbox(?:ed|ing)?\b|\benvironment\b|\bisolation\b|песочниц|окружени|изоляци|(?:^|[^а-яё])сред[аеуы](?![а-яё])/i;
/** Текст в кавычках — слова продукта, не отчёт о среде. */
const quoted = /'[^'\n]*'|"[^"\n]*"|«[^»\n]*»/g;

/**
 * Итог исполнителя называет причиной остановки окружение. Возвращает
 * совпавшую фразу (для диагностики) или `undefined`.
 */
export function environmentBlockOf(summary: string): string | undefined {
  const clauses = summary
    .slice(0, 4000)
    .replace(quoted, ' ')
    .split(/[.;!?](?:\s|$)|\n/);
  for (const raw of clauses) {
    const clause = raw.trim();
    if (!clause) continue;
    if (decisive.test(clause)) return clause.slice(0, 300);
    // Код ОС — и техническое, и среда, но не отказ: «permission denied» в
    // описании обработки ошибки ещё не говорит, что шаг не выполнен.
    const code = new RegExp(osCode.source, 'i').test(clause);
    if (
      (code || technical.test(clause)) &&
      refusal.test(clause.replace(osCode, ' ')) &&
      (code || environment.test(clause))
    )
      return clause.slice(0, 300);
  }
  return undefined;
}

/** Общий родитель временных каталогов исполнителей этого процесса. */
let scratchParent: Promise<string> | undefined;

/**
 * Временный каталог исполнителя: свой на каждый вызов, вне каталога
 * состояния (иначе граница codex перестала бы закрывать каталог артефактов
 * целиком) и короткий — песочница Claude Code кладёт сокеты sandbox-runtime в
 * TMPDIR процесса, а длинный путь не помещается в предел unix-сокета.
 *
 * Каталоги вызовов лежат в общем родителе процесса (`dc-srt-<pid>-…` в TMPDIR
 * процесса, если путь укладывается, иначе в `/tmp`; так же его убирает уборка
 * брошенных каталогов srt). Родитель (`parent`) вызывающий закрывает
 * исполнителю на чтение, собственный каталог открыт более конкретным
 * разрешением: соседние исполнители временных файлов друг друга не видят
 * (у codex — те, что есть при построении профиля, как у каталога состояния).
 *
 * Окружение вызова получает `TMPDIR`, `TMP`, `TEMP` и `TMPPREFIX` (zsh кладёт
 * here-document не в TMPDIR, а по TMPPREFIX, по умолчанию `/tmp/zsh`,
 * закрытому исполнителю). TMPDIR, заданный политикой, заменяется. Каталог
 * вызова убирает вызывающий после вызова.
 */
export async function writerScratch(env: NodeJS.ProcessEnv) {
  scratchParent ??= (async () => {
    const name = `dc-srt-${process.pid}-`;
    const base =
      [tmpdir(), SRT_SHORT_BASE].find((b) => srtSocketsFit(join(b, name + 'XXXXXX/w-XXXXXX'))) ??
      SRT_SHORT_BASE;
    return realpath(await mkdtemp(join(base, name)));
  })();
  let parent: string;
  try {
    parent = await scratchParent;
    // Родителя могла убрать уборка: создаётся заново тем же путём.
    await mkdir(parent, { recursive: true, mode: 0o700 });
  } catch (error) {
    scratchParent = undefined;
    throw error;
  }
  const dir = await mkdtemp(join(parent, 'w-'));
  env.TMPDIR = dir;
  env.TMP = dir;
  env.TEMP = dir;
  env.TMPPREFIX = join(dir, 'zsh');
  return { dir, parent };
}
