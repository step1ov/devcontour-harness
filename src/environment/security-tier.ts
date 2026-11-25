// Уровни безопасности облегчённого режима (0.1.0-alpha.70, docs/light-mode.md
// «Уровни безопасности»). Честная шкала: что на самом деле отделяет
// исполнителя от машины владельца. Harness только определяет текущий
// уровень и показывает его в `doctor`; выбирает уровень владелец (запуск
// harness под отдельным пользователем ОС, в контейнере или в VM).
//
// 0. `none` — границы записи нет (`writeGuard.off`, `isolation.mode: none`).
// 1. `write-guard` — граница записи (умолчание): защита от случайных
//    ошибок, не граница безопасности; Docker и открытые кеши её обходят.
// 2. `os-user` — harness (и исполнитель) работает под пользователем ОС,
//    который не владеет рабочей копией и домашним каталогом владельца.
// 3. `container` — harness работает в контейнере.
// 4. `vm` — harness работает в виртуальной машине.
// Строгий режим (`harnessMode: strict`) — песочница ОС каждого процесса,
// уровень `os-sandbox` вне этой шкалы (заморожен).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';

export const securityTiers = ['none', 'write-guard', 'os-user', 'container', 'vm'] as const;
export type SecurityTier = (typeof securityTiers)[number] | 'os-sandbox';

export interface SecurityFacts {
  /** Процесс в контейнере (/.dockerenv, /run/.containerenv, cgroup). */
  container: boolean;
  /** Машина — виртуальная (`kern.hv_vmm_present`, `systemd-detect-virt --vm`). */
  vm: boolean;
  /**
   * Пользователь процесса не владеет рабочими копиями (`repositories[].path`)
   * — их владелец другой пользователь ОС.
   */
  separateUser: boolean;
  user: string;
}

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/** Факты машины для уровня; тест подменяет `probe`. */
export const securityProbe = {
  facts(repoPaths: readonly string[], platform = process.platform): SecurityFacts {
    const container =
      existsSync('/.dockerenv') ||
      existsSync('/run/.containerenv') ||
      safe(
        () => /docker|containerd|kubepods|lxc|podman/.test(readFileSync('/proc/1/cgroup', 'utf8')),
        false,
      );
    const vm =
      platform === 'darwin'
        ? safe(
            () =>
              execFileSync('/usr/sbin/sysctl', ['-n', 'kern.hv_vmm_present'], {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['ignore', 'pipe', 'ignore'],
              }).trim() === '1',
            false,
          )
        : platform === 'linux'
          ? safe(
              () =>
                execFileSync('systemd-detect-virt', ['--vm', '--quiet'], {
                  timeout: 5000,
                  stdio: 'ignore',
                }) !== undefined,
              false,
            )
          : false;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const owners = repoPaths.flatMap((p) => safe(() => [statSync(p).uid], [] as number[]));
    const separateUser =
      uid !== undefined && uid !== 0 && owners.length > 0 && owners.every((o) => o !== uid);
    return { container, vm, separateUser, user: safe(() => userInfo().username, homedir()) };
  },
};

export interface SecurityTierReport {
  current: SecurityTier;
  facts: SecurityFacts;
  line: string;
  lineEn: string;
}

const ru: Record<SecurityTier, string> = {
  none: 'нет границы записи',
  'write-guard': 'граница записи (от случайных ошибок, не граница безопасности)',
  'os-user': 'отдельный пользователь ОС',
  container: 'контейнер',
  vm: 'виртуальная машина',
  'os-sandbox': 'строгий режим: песочница ОС каждого процесса',
};
const en: Record<SecurityTier, string> = {
  none: 'no write boundary',
  'write-guard': 'write guard (against accidents, not a security boundary)',
  'os-user': 'separate OS user',
  container: 'container',
  vm: 'virtual machine',
  'os-sandbox': 'strict mode: an OS sandbox per process',
};

/** Текущий уровень: самый сильный из определённых; выбор — за владельцем. */
export function securityTierOf(
  input: { strict: boolean; guard: boolean },
  facts: SecurityFacts,
): SecurityTierReport {
  const current: SecurityTier = input.strict
    ? 'os-sandbox'
    : facts.vm
      ? 'vm'
      : facts.container
        ? 'container'
        : facts.separateUser
          ? 'os-user'
          : input.guard
            ? 'write-guard'
            : 'none';
  const scale = 'write-guard → os-user → container → vm';
  return {
    current,
    facts,
    line: `уровень безопасности: ${ru[current]}; шкала ${scale} — выбирает владелец (docs/light-mode.md, «Уровни безопасности»)`,
    lineEn: `security tier: ${en[current]}; scale ${scale} — the owner chooses (docs/light-mode.md, "Security tiers")`,
  };
}
