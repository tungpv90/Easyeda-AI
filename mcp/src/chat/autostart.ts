import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const LABEL = 'io.github.biosshot.easyeda-copilot-chat';

/**
 * The command that starts the daemon. From an npx cache we re-launch through npx
 * (the cache can be cleaned); from a global or local install we run the file itself.
 * The daemon writes its own log file, so no output redirection is needed here.
 */
export function daemonCommand(entry: string): string[] {
    if (/[\\/]_npx[\\/]/.test(entry)) return ['npx', '-y', 'easyeda-copilot-mcp', 'chat'];
    return [process.execPath, entry, 'chat'];
}

function windowsStartupPath() {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'easyeda-copilot-chat.vbs');
}

function macPlistPath() {
    return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function linuxDesktopPath() {
    const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
    return join(config, 'autostart', 'easyeda-copilot-chat.desktop');
}

function shellQuote(arg: string) {
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function xmlEscape(text: string) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function windowsCommandLine(command: string[]) {
    const [program, ...args] = command;
    const line = command.map(arg => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ');
    // npx is a .cmd shim and must go through cmd.exe.
    return program === 'npx' ? `cmd /c npx ${args.join(' ')}` : line;
}

export async function installAutostart(entry: string, errorLog: string) {
    const command = daemonCommand(entry);
    if (process.platform === 'win32') {
        const path = windowsStartupPath();
        await mkdir(dirname(path), { recursive: true });
        // Window style 0: no console window at login.
        const vbsString = windowsCommandLine(command).replace(/"/g, '""');
        await writeFile(path, `CreateObject("WScript.Shell").Run "${vbsString}", 0, False\r\n`);
        return path;
    }
    if (process.platform === 'darwin') {
        const path = macPlistPath();
        await mkdir(dirname(path), { recursive: true });
        // A login shell gives launchd the user's PATH (node, npx, claude).
        const script = command.map(shellQuote).join(' ');
        await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>${xmlEscape(script)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardErrorPath</key><string>${xmlEscape(errorLog)}</string>
</dict>
</plist>
`);
        spawnSync('launchctl', ['unload', path], { stdio: 'ignore' });
        spawnSync('launchctl', ['load', '-w', path], { stdio: 'ignore' });
        return path;
    }
    const path = linuxDesktopPath();
    await mkdir(dirname(path), { recursive: true });
    const script = `${command.map(shellQuote).join(' ')} 2>> ${shellQuote(errorLog)}`;
    await writeFile(path, `[Desktop Entry]
Type=Application
Name=EasyEDA Copilot Claude Chat
Exec=sh -lc ${shellQuote(script)}
X-GNOME-Autostart-enabled=true
NoDisplay=true
`);
    return path;
}

export async function uninstallAutostart() {
    if (process.platform === 'darwin') {
        spawnSync('launchctl', ['unload', '-w', macPlistPath()], { stdio: 'ignore' });
        await rm(macPlistPath(), { force: true });
        return macPlistPath();
    }
    const path = process.platform === 'win32' ? windowsStartupPath() : linuxDesktopPath();
    await rm(path, { force: true });
    return path;
}

/** Starts the daemon now in the background (on macOS, launchd already did). */
export function startDetached(entry: string, errorLog: string) {
    const [command, ...args] = daemonCommand(entry);
    const err = openSync(errorLog, 'a');
    try {
        const child = spawn(command, args, {
            detached: true,
            stdio: ['ignore', 'ignore', err],
            windowsHide: true,
            shell: process.platform === 'win32' && command === 'npx',
        });
        child.unref();
    } finally {
        closeSync(err);
    }
}
