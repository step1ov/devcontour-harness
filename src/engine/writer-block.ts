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
// запрос). Поэтому узнаются только явные признаки отказа среды: коды ОС и
// сети, песочница, «нет сети/доступа», «не удалось запустить/прочитать».
// Обычная незавершённость («не успел», «тесты ещё не написаны») сюда не
// попадает и продолжается черновиком, как раньше.

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const signals: RegExp[] = [
  /\b(?:EPERM|EACCES|EROFS|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b/,
  /operation not permitted|permission denied|read-only file system|bootstrap_check_in/i,
  /\bsandbox(?:ed)?\b|песочниц/i,
  /\b(?:no|without) (?:network|internet|registry) access\b/i,
  /\bnetwork (?:is )?(?:unavailable|blocked|disabled|denied|off)\b/i,
  /(?:нет|без) (?:доступа к )?(?:сети|интернета|реестр[ау])/i,
  /сет[ьи] (?:недоступн|закрыт|запрещ|отключ)/i,
  // «Cannot read properties of undefined» — ошибка кода, не среды: чтение и
  // открытие файла сюда не входят, запуск — только сервера или браузера.
  /\b(?:cannot|can't|could not|couldn't|unable to|not allowed to|failed to) (?:listen|bind|reach|connect to|download|fetch|access the (?:network|registry|tracker|internet)|(?:start|launch) (?:the |a )?(?:local |dev |web )?(?:server|browser))\b/i,
  /(?:не удалось|не могу|не смог|невозможно|нельзя|не получилось) (?:запустить|открыть|прочитать|скачать|загрузить|подключиться|достучаться|получить доступ|слушать)/i,
  /\b(?:unavailable|not available|inaccessible) (?:in|inside|from|under) (?:the|this) (?:sandbox|environment|attempt)\b/i,
  /недоступн\w* (?:в|из|внутри) (?:песочниц|окружени|сред)/i,
  /(?:окружени\w*|сред\w*) (?:не (?:дал\w*|позволя\w*|пуска\w*)|запрещает|блокирует)/i,
  /\benvironment (?:blocks|blocked|prevents|prevented|does not allow|doesn't allow|forbids)\b/i,
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
 * Временный каталог исполнителя внутри его области записи: `<каталог
 * вызова>.tmp` рядом с каталогом артефактов вызова (не внутри него —
 * `result.json` и журнал исполнитель не трогает). Окружение вызова получает
 * `TMPDIR`, `TMP`, `TEMP` и `TMPPREFIX` (zsh кладёт here-document не в
 * TMPDIR, а по TMPPREFIX, по умолчанию `/tmp/zsh`). TMPDIR, заданный
 * политикой, заменяется: каталог вне области записи песочница исполнителю не
 * открывает. Каталог убирается после вызова.
 */
export async function writerScratch(callDir: string, env: NodeJS.ProcessEnv) {
  const dir = resolve(callDir) + '.tmp';
  await mkdir(dir, { recursive: true });
  env.TMPDIR = dir;
  env.TMP = dir;
  env.TEMP = dir;
  env.TMPPREFIX = join(dir, 'zsh');
  return dir;
}
