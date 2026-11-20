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
// запрос). Поэтому узнаются только явные признаки отказа среды: сообщения ОС
// и сети в форме вывода ошибки и фразы «песочница/окружение запрещает», «нет
// доступа к сети». Слово «sandbox», «permission denied», «не удалось
// запустить/прочитать» без такой фразы — нет: это бывает и в тексте продукта.
// Обычная незавершённость («не успел», «тесты ещё не написаны») сюда не
// попадает и продолжается черновиком, как раньше.

import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SRT_SHORT_BASE, srtSocketsFit } from '../environment/isolation.ts';

const signals: RegExp[] = [
  // Сообщения ОС и сети в форме вывода ошибки, а не упоминание кода в тексте
  // («добавил обработку EACCES» сюда не попадает).
  /\b(?:listen|bind|connect|open|mkdir|write|unlink|rename|spawn|scandir|access) (?:EPERM|EACCES|EROFS)\b/,
  /\b(?:EPERM|EACCES|EROFS): (?:operation not permitted|permission denied|read-only file system)/i,
  /\bgetaddrinfo (?:ENOTFOUND|EAI_AGAIN)\b|\bCould not resolve host\b/,
  /\boperation not permitted\b|\bread-only file system\b|\bbootstrap_check_in\b|\bsandbox_apply\b/i,
  // Явная фраза: песочница или окружение закрыли шаг.
  /\bsandbox(?:ing)? (?:blocks|blocked|denies|denied|prevents|prevented|forbids|does not allow|doesn't allow)\b/i,
  /\b(?:blocked|denied|prevented) by the (?:sandbox|environment)\b/i,
  /\benvironment (?:blocks|blocked|prevents|prevented|forbids|does not allow|doesn't allow)\b/i,
  /\b(?:no|without) (?:network|internet|registry) access\b|\bnetwork (?:access )?is (?:disabled|blocked|unavailable)\b/i,
  /песочниц[а-яё]* (?:запрещает|запретила|не (?:даёт|дает|дала|позволяет|пускает)|блокирует|закрыва[а-яё]*)/i,
  /(?:окружени[а-яё]*|сред[а-яё]*) (?:запрещает|запретил[а-яё]*|не (?:даёт|дает|дал[а-яё]*|позволя[а-яё]*|пуска[а-яё]*)|блокирует|закрыл[а-яё]*)/i,
  /(?:нет|без) (?:доступа к )?(?:сети|интернет[а-яё]*|реестр[а-яё]*)|сеть (?:недоступна|закрыта|запрещена|отключена)/i,
  /недоступн[а-яё]* (?:в|из|внутри) (?:песочниц|окружени|сред)[а-яё]*/i,
];

/**
 * Итог исполнителя называет причиной остановки окружение. Возвращает
 * совпавший фрагмент (для диагностики) или `undefined`.
 */
export function environmentBlockOf(summary: string): string | undefined {
  const text = summary.slice(0, 4000);
  for (const re of signals) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return undefined;
}

/**
 * Временный каталог исполнителя: свой на каждый вызов, вне каталога
 * состояния (иначе граница codex перестала бы закрывать каталог артефактов
 * целиком) и короткий — песочница Claude Code кладёт сокеты sandbox-runtime в
 * TMPDIR процесса, а длинный путь не помещается в предел unix-сокета. База —
 * TMPDIR процесса, если путь укладывается, иначе `/tmp`; имя `dc-srt-<pid>-…`
 * убирает и уборка брошенных каталогов srt. Окружение вызова получает
 * `TMPDIR`, `TMP`, `TEMP` и `TMPPREFIX` (zsh кладёт here-document не в TMPDIR,
 * а по TMPPREFIX, по умолчанию `/tmp/zsh`, закрытому исполнителю). TMPDIR,
 * заданный политикой, заменяется. Каталог убирает вызывающий после вызова.
 */
export async function writerScratch(env: NodeJS.ProcessEnv) {
  const name = `dc-srt-${process.pid}-`;
  const base =
    [tmpdir(), SRT_SHORT_BASE].find((b) => srtSocketsFit(join(b, name + 'XXXXXX'))) ??
    SRT_SHORT_BASE;
  const dir = await realpath(await mkdtemp(join(base, name)));
  env.TMPDIR = dir;
  env.TMP = dir;
  env.TEMP = dir;
  env.TMPPREFIX = join(dir, 'zsh');
  return dir;
}
