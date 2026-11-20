import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Ежедневная проверка обновлений без сессии ведущего: задание launchd
 * пользователя (macOS, `~/Library/LaunchAgents`). Задание запускает
 * `harness update --apply --scheduled`: в режиме notify — только проверка
 * (строка в панели и status), в auto — установка в безопасных пределах,
 * когда нет прогона; off — ничего. На Linux задание не создаётся: ответ
 * содержит текст для systemd user timer или cron.
 */
export const SCHEDULE_HOUR = 9;
export const SCHEDULE_MINUTE = 30;

export const scheduleLabel = (stateDir: string) =>
  'dev.devcontour-harness.update.' +
  createHash('sha256').update(resolve(stateDir)).digest('hex').slice(0, 12);

const launchAgents = () => join(process.env.HOME || homedir(), 'Library', 'LaunchAgents');
export const plistPath = (stateDir: string) =>
  join(launchAgents(), scheduleLabel(stateDir) + '.plist');

const xml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export function scheduleArgs(harnessBin: string, stateDir: string, prefix?: string): string[] {
  return [
    process.execPath,
    harnessBin,
    'update',
    '--apply',
    '--scheduled',
    '--state',
    resolve(stateDir),
    ...(prefix ? ['--prefix', resolve(prefix)] : []),
  ];
}

export function launchdPlist(label: string, args: string[], log: string, path: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${SCHEDULE_HOUR}</integer>
    <key>Minute</key>
    <integer>${SCHEDULE_MINUTE}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export function linuxInstructions(args: string[]): string {
  const cmd = args
    .map((a) => (/[^\w@%+=:,./-]/.test(a) ? `'${a.replaceAll("'", "'\\''")}'` : a))
    .join(' ');
  return [
    'Linux: создайте systemd user timer (или строку cron) сами.',
    '',
    '~/.config/systemd/user/harness-update.service:',
    '  [Unit]',
    '  Description=devcontour-harness update',
    '  [Service]',
    '  Type=oneshot',
    `  ExecStart=${cmd}`,
    '',
    '~/.config/systemd/user/harness-update.timer:',
    '  [Unit]',
    '  Description=devcontour-harness update daily',
    '  [Timer]',
    `  OnCalendar=*-*-* ${String(SCHEDULE_HOUR).padStart(2, '0')}:${String(SCHEDULE_MINUTE).padStart(2, '0')}`,
    '  Persistent=true',
    '  [Install]',
    '  WantedBy=timers.target',
    '',
    'systemctl --user daemon-reload && systemctl --user enable --now harness-update.timer',
    '',
    `cron: ${SCHEDULE_MINUTE} ${SCHEDULE_HOUR} * * * ${cmd}`,
  ].join('\n');
}

const launchctl = () => process.env.HARNESS_LAUNCHCTL_BIN || 'launchctl';
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);

/** Включить задание: файл plist и загрузка в launchd (прежнее задание выгружается). */
export function enableSchedule(stateDir: string, args: string[], log: string) {
  const file = plistPath(stateDir);
  mkdirSync(launchAgents(), { recursive: true });
  const label = scheduleLabel(stateDir);
  if (existsSync(file)) {
    try {
      execFileSync(launchctl(), ['bootout', `gui/${uid()}`, file], { stdio: 'ignore' });
    } catch {
      // не было загружено
    }
  }
  writeFileSync(file, launchdPlist(label, args, log, process.env.PATH ?? '/usr/bin:/bin'));
  let loaded = true;
  let reason: string | undefined;
  try {
    execFileSync(launchctl(), ['bootstrap', `gui/${uid()}`, file], { stdio: 'pipe' });
  } catch (error) {
    loaded = false;
    reason = (error as Error).message.split('\n')[0];
  }
  return { file, label, loaded, ...(reason ? { reason } : {}) };
}

/** Выключить задание: выгрузить и удалить свой plist (только файл этого каталога состояния). */
export function disableSchedule(stateDir: string) {
  const file = plistPath(stateDir);
  const existed = existsSync(file);
  if (existed) {
    try {
      execFileSync(launchctl(), ['bootout', `gui/${uid()}`, file], { stdio: 'ignore' });
    } catch {
      // не было загружено
    }
    rmSync(file);
  }
  return { file, existed };
}
