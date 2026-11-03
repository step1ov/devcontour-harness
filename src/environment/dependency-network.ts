// Отказ установки зависимостей по вине сети или реестра пакетов.
//
// Установка (`pnpm install`, `npm ci`) тянет пакеты из реестра: 403 прокси,
// обрыв TLS или DNS роняют её так же, как ошибка в lockfile, и класс `gate`
// засчитывал такой обрыв найденным дефектом и тратил попытку поручения.
// Правило узкое и строится на доказательствах, а не на тексте вообще:
//
// 1. Команда — установка зависимостей известным менеджером пакетов, и её argv
//    закреплён политикой (gate, шаг `prepare` или lifecycle), а не скриптом
//    кандидата: `npm run install`, `sh -c …`, `make deps` не распознаются.
// 2. Каждый код ошибки, который назвал сам менеджер (`ERR_PNPM_*`,
//    `npm error code …`), — сетевой. Любой другой код — ошибка проекта.
// 3. В выводе нет признака ошибки проекта: устаревший lockfile, нет версии,
//    404 пакета, конфликт peer-зависимостей, упавший скрипт жизненного цикла
//    (`ELIFECYCLE`, `npm error command failed`) — такой вывод остаётся `gate`,
//    даже если рядом есть сетевая строка.
// 4. Есть хотя бы одна сетевая подпись: код HTTP 403/407/408/429/5xx реестра,
//    errno соединения, отказ TLS или сертификата.
//
// Сымитировать подпись кандидат может только выводом скрипта, который
// исполняет сам менеджер; упавший скрипт даёт признак ошибки проекта (п. 3).
// Остаток риска (кандидат сам ломает реестр в `.npmrc`) ограничен общими
// пределами класса `environment`: повтор одного отпечатка, пауза очереди и
// `MAX_NEUTRAL_FAILURES` на поручение — дальше решает человек.

/** Причина отказа среды, которую несёт сообщение: стабильный токен в начале. */
export const DEPENDENCY_NETWORK = 'dependency-network';

const managers = new Set(['npm', 'pnpm', 'yarn']);
/** Подкоманды установки; `yarn` без подкоманды — тоже установка. */
const installs: Record<string, Set<string>> = {
  npm: new Set(['install', 'i', 'ci', 'clean-install']),
  pnpm: new Set(['install', 'i', 'fetch']),
  yarn: new Set(['install']),
};
/** Опции до подкоманды, которые берут значение следующим словом. */
const valued = new Set(['-C', '--dir', '--prefix', '--filter', '-F', '--cwd']);

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Argv — установка зависимостей известным менеджером пакетов: `npm
 * install|i|ci|clean-install`, `pnpm install|i|fetch`, `yarn [install]`, в том
 * числе через `corepack` и по абсолютному пути. Опции до подкоманды
 * допускаются (`pnpm -C app install`). Скрипты (`npm run …`), `npx`, `exec`,
 * shell-обёртки — не установка: их содержимое задаёт дерево, а не политика.
 */
export function isDependencyInstall(argv: readonly string[]) {
  let rest = [...argv];
  if (rest[0] && base(rest[0]) === 'corepack') rest = rest.slice(1);
  const manager = rest[0] ? base(rest[0]) : '';
  if (!managers.has(manager)) return false;
  let i = 1;
  while (i < rest.length && rest[i]!.startsWith('-')) i += valued.has(rest[i]!) ? 2 : 1;
  const sub = rest[i];
  if (sub === undefined) return manager === 'yarn' && i === rest.length;
  return installs[manager]!.has(sub);
}

/** Коды HTTP реестра, которые говорят о среде: доступ, прокси, предел частоты, сбой сервера. */
const httpStatus = '(?:403|407|408|429|5\\d\\d)';
/** errno соединения и отказы TLS Node, отдельным словом. */
const errno =
  'ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPROTO|ERR_SOCKET_TIMEOUT|ERR_SOCKET_CONNECTION_TIMEOUT|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_[A-Z_]+|ERR_SSL_[A-Z0-9_]+|ERR_TLS_[A-Z0-9_]+';

/** Код ошибки, названный менеджером, — сетевой. */
const networkCode = new RegExp(
  `^(?:ERR_PNPM_FETCH_${httpStatus}|ERR_PNPM_(?:META_)?FETCH_FAIL|ERR_PNPM_BAD_TARBALL_SIZE|ERR_PNPM_(?:${errno})|E${httpStatus}|${errno})$`,
);

/** Коды, которые назвал менеджер: `ERR_PNPM_*` и `npm error code …` / `npm ERR! code …`. */
function reportedCodes(text: string) {
  const codes = [...text.matchAll(/\bERR_PNPM_[A-Z0-9_]+/g)].map((m) => m[0]);
  for (const m of text.matchAll(/^\s*npm (?:error|ERR!) code (\S+)/gm)) codes.push(m[1]!);
  return codes;
}

/**
 * Признаки ошибки проекта: при любом из них отказ остаётся `gate`. Коды pnpm и
 * npm перечислены и для читателя — п. 2 их и так не пропустит.
 */
const projectSignatures: RegExp[] = [
  /\bERR_PNPM_(?:OUTDATED_LOCKFILE|NO_MATCHING_VERSION|FETCH_404|PEER_DEP_ISSUES|LOCKFILE_[A-Z_]+|TARBALL_INTEGRITY|[A-Z_]*LIFECYCLE[A-Z_]*)\b/,
  /^\s*npm (?:error|ERR!) code (?:E404|ETARGET|ERESOLVE|EUSAGE|EINTEGRITY|ELIFECYCLE|\d+)\b/m,
  // Упавший скрипт жизненного цикла (preinstall, postinstall, prepare):
  // pnpm — `ELIFECYCLE` и дерево «Failed in … at …», npm — `command failed`.
  /\bELIFECYCLE\b/,
  /\bcommand failed\b/i,
  /\bFailed in \d+(?:\.\d+)?m?s at\b/,
  /\b404 Not Found\b/i,
  /\bResponse Code: 404\b/,
  /\bis not in (?:this|the npm) registry\b/i,
  /\bNo matching version found\b/i,
  // npm ci при lockfile, расходящемся с package.json.
  /\bcan only install packages when your package\.json and\b/,
  // yarn: нет пакета или версии, lockfile нужно обновить; berry — те же
  // отказы кодами YN0035, YN0028 и упавшая сборка пакета YN0009.
  /\bCouldn't find (?:package|any versions)\b/,
  /\bYour lockfile needs to be updated\b/,
  /\bYN0(?:009|028|035)\b/,
];

const networkSignatures: RegExp[] = [
  new RegExp(`\\bERR_PNPM_FETCH_${httpStatus}\\b`),
  /\bERR_PNPM_(?:META_)?FETCH_FAIL\b/,
  /\bERR_PNPM_BAD_TARBALL_SIZE\b/,
  new RegExp(`\\bERR_PNPM_(?:${errno})\\b`),
  new RegExp(`^\\s*npm (?:error|ERR!) code E${httpStatus}\\b`, 'm'),
  new RegExp(`\\b(?:${errno})\\b`),
  /\bsocket hang up\b/i,
  /\bClient network socket disconnected before secure TLS connection was established\b/,
  new RegExp(`\\bGET https?://\\S+ error \\((?:${errno}|${httpStatus})\\)`),
  new RegExp(
    `\\b${httpStatus} (?:Forbidden|Too Many Requests|Proxy Authentication Required|Request Timeout|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)\\b`,
  ),
];

const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Отказ установки зависимостей по сети или реестру — строка вывода с подписью,
 * или `undefined`, когда правило не выполнено и отказ остаётся провалом
 * проверки. Вызывается только для команды, завершившейся с ошибкой.
 */
export function dependencyNetworkFailure(argv: readonly string[], output: string) {
  if (!isDependencyInstall(argv)) return undefined;
  const text = output.replace(ansi, '');
  if (reportedCodes(text).some((code) => !networkCode.test(code))) return undefined;
  if (projectSignatures.some((re) => re.test(text))) return undefined;
  for (const line of text.split('\n'))
    if (networkSignatures.some((re) => re.test(line))) {
      const trimmed = line.trim();
      return trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed;
    }
  return undefined;
}

/** Сообщение отказа: токен причины первым, чтобы `explain` показал его и после обрезки. */
export const dependencyNetworkMessage = (signature: string, detail: string) =>
  `${DEPENDENCY_NETWORK}: установка зависимостей не получила пакеты из реестра — отказ сети или реестра, а не проекта (${signature}). ${detail}`;
