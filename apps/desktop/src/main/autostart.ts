import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Автозапуск ядра при входе в систему.
 *
 * Речь именно о ядре, а не о приложении: агент должен работать, даже когда
 * окно не открыто — иначе рутины по расписанию и телеграм невозможны.
 * Приложение при этом просто находит уже работающее ядро.
 *
 * На каждой системе это делается своим способом, и все три сводятся к одному:
 * положить куда надо запись «запусти вот эту команду».
 */
export interface AutostartTarget {
  /** Чем запускать: путь к node или к самому исполняемому файлу. */
  command: string;
  /** Аргументы: путь к cli и параметры запуска. */
  args: string[];
  /**
   * Переменные окружения. Кроме папки данных сюда может попасть
   * `ELECTRON_RUN_AS_NODE`, если ядро запускается Node от Electron.
   */
  env: Record<string, string>;
}

const LABEL = 'AxonCore';

export function isSupported(): boolean {
  return ['win32', 'darwin', 'linux'].includes(process.platform);
}

export function isEnabled(): boolean {
  switch (process.platform) {
    case 'win32':
      return fs.existsSync(windowsEntry());
    case 'darwin':
      return fs.existsSync(macEntry());
    case 'linux':
      return fs.existsSync(linuxEntry());
    default:
      return false;
  }
}

export function enable(target: AutostartTarget): void {
  switch (process.platform) {
    case 'win32':
      return enableWindows(target);
    case 'darwin':
      return enableMac(target);
    case 'linux':
      return enableLinux(target);
    default:
      throw new Error('Автозапуск на этой системе не поддерживается');
  }
}

export function disable(): void {
  for (const file of [windowsEntry(), macEntry(), linuxEntry()]) {
    fs.rmSync(file, { force: true });
  }
  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['unload', macEntry()], { stdio: 'ignore' });
  }
  if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', `${LABEL}.service`], { stdio: 'ignore' });
  }
}

// ─── Windows ────────────────────────────────────────────────────────────────

function windowsEntry(): string {
  return path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    `${LABEL}.vbs`,
  );
}

/**
 * Ярлык в папке «Автозагрузка».
 *
 * Через .vbs, а не .cmd: командный файл при входе в систему открывает чёрное
 * окно консоли, которое остаётся висеть. Скрипт запускает то же самое со
 * скрытым окном.
 */
function enableWindows(target: AutostartTarget): void {
  const command = [target.command, ...target.args].map(quote).join(' ');
  const script = [
    `Set shell = CreateObject("WScript.Shell")`,
    ...Object.entries(target.env).map(
      ([key, value]) => `shell.Environment("PROCESS")(${vbString(key)}) = ${vbString(value)}`,
    ),
    `shell.Run ${vbString(command)}, 0, False`,
  ].join('\r\n');

  fs.mkdirSync(path.dirname(windowsEntry()), { recursive: true });
  fs.writeFileSync(windowsEntry(), script, 'utf8');
}

function quote(part: string): string {
  return /\s/.test(part) ? `""${part}""` : part;
}

function vbString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

// ─── macOS ──────────────────────────────────────────────────────────────────

function macEntry(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.axon.core.plist`);
}

function enableMac(target: AutostartTarget): void {
  const args = [target.command, ...target.args]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join('\n');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.axon.core</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(target.env)
  .map(([k, v]) => `    <key>${escapeXml(k)}</key><string>${escapeXml(v)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;

  fs.mkdirSync(path.dirname(macEntry()), { recursive: true });
  fs.writeFileSync(macEntry(), plist, 'utf8');
  spawnSync('launchctl', ['load', macEntry()], { stdio: 'ignore' });
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Linux ──────────────────────────────────────────────────────────────────

function linuxEntry(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${LABEL}.service`);
}

function enableLinux(target: AutostartTarget): void {
  const command = [target.command, ...target.args].join(' ');
  const unit = `[Unit]
Description=Axon core

[Service]
ExecStart=${command}
${Object.entries(target.env)
  .map(([k, v]) => `Environment=${k}=${v}`)
  .join('\n')}
Restart=on-failure

[Install]
WantedBy=default.target
`;

  fs.mkdirSync(path.dirname(linuxEntry()), { recursive: true });
  fs.writeFileSync(linuxEntry(), unit, 'utf8');
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  spawnSync('systemctl', ['--user', 'enable', '--now', `${LABEL}.service`], { stdio: 'ignore' });
}
