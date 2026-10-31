'use strict';
/**
 * Entry of ClaudeChatSetup.exe (a Node.js single executable application).
 *
 * - Double-click / no arguments: install the Claude Chat helper for EasyEDA Copilot.
 * - `<file.js> ...args`: behave like `node <file.js> ...args`. The installed copy of
 *   this exe is the runtime for the helper, the MCP server and their worker processes.
 * - `--uninstall`: remove the helper.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');

const args = process.argv.slice(2);

if (args[0] && /\.[cm]?js$/i.test(args[0]) && fs.existsSync(args[0])) {
    runScript(path.resolve(args[0]), args.slice(1));
} else {
    runInstaller();
}

function runScript(script, scriptArgs) {
    process.argv = [process.execPath, script, ...scriptArgs];
    // import() of disk files is not available in a single executable; require(esm) is.
    createRequire(script)(script);
}

function runInstaller() {
    const sea = require('node:sea');
    const APP_NAME = 'EasyEDA Copilot Claude Chat';
    const HOME = os.homedir();
    const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    const INSTALL_ROOT = process.env.EASYEDA_COPILOT_INSTALL_DIR || path.join(LOCAL_APP_DATA, 'EasyEDA Copilot', 'Claude Chat');
    const STATE_DIR = process.env.EASYEDA_COPILOT_CHAT_HOME || path.join(HOME, '.easyeda-copilot', 'chat');
    const RUNTIME_NAME = 'ClaudeChat.exe';

    const log = (line = '') => process.stdout.write(`${line}\n`);
    const readText = asset => Buffer.from(sea.getAsset(asset)).toString('utf8').trim();

    /** Payload format (gzip): repeated [u32 name length][name][u32 data length][data]. */
    function extractPayload(target) {
        const data = zlib.gunzipSync(Buffer.from(sea.getAsset('app.pack.gz')));
        let offset = 0;
        let count = 0;
        while (offset < data.length) {
            const nameLength = data.readUInt32LE(offset); offset += 4;
            const name = data.subarray(offset, offset + nameLength).toString('utf8'); offset += nameLength;
            const size = data.readUInt32LE(offset); offset += 4;
            const file = path.join(target, ...name.split('/'));
            if (!file.startsWith(target + path.sep)) throw new Error(`Bad path in payload: ${name}`);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, data.subarray(offset, offset + size));
            offset += size;
            count += 1;
        }
        return count;
    }

    function processImage(pid) {
        const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
        return (result.stdout || '').split(',')[0].replace(/"/g, '').trim().toLowerCase();
    }

    /** Stops a running helper (and the Claude/MCP processes under it) so its files can be replaced. */
    function stopRunningHelper() {
        const pidFile = path.join(STATE_DIR, 'daemon.pid');
        let pid;
        try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch { return; }
        if (Number.isInteger(pid) && pid > 0) {
            const image = processImage(pid);
            if (image === RUNTIME_NAME.toLowerCase() || image === 'node.exe') {
                spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
                log('Stopped the previous helper.');
            }
        }
        fs.rmSync(pidFile, { force: true });
    }

    function findClaude() {
        const found = spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true });
        if (found.status === 0 && found.stdout.trim()) return found.stdout.split(/\r?\n/)[0].trim();
        const candidates = [
            path.join(HOME, '.local', 'bin', 'claude.exe'),
            path.join(HOME, '.claude', 'local', 'claude.exe'),
            path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm', 'claude.cmd'),
        ];
        return candidates.find(file => fs.existsSync(file));
    }

    /** Installs Claude Code with Anthropic's official Windows installer when it is missing. */
    function ensureClaudeCode() {
        const existing = findClaude();
        if (existing) {
            log(`Claude Code: ${existing}`);
            return;
        }
        if (process.env.EASYEDA_COPILOT_SKIP_CLAUDE_INSTALL) {
            log('Claude Code is not installed (install skipped).');
            return;
        }
        log('Claude Code is not installed. Installing it now (official installer from claude.ai)...');
        const result = spawnSync('powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex',
        ], { stdio: 'inherit' });
        const installed = findClaude();
        if (result.status === 0 && installed) {
            log(`Claude Code installed: ${installed}`);
            return;
        }
        log('Could not install Claude Code automatically. Install it from https://claude.com/claude-code,');
        log('then open Claude Chat again. Everything else is ready.');
    }

    function removeOldVersions(keep) {
        for (const entry of fs.readdirSync(INSTALL_ROOT, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name === keep) continue;
            try {
                fs.rmSync(path.join(INSTALL_ROOT, entry.name), { recursive: true, force: true });
            } catch {
                // A file may still be locked; it is removed on the next install.
            }
        }
    }

    function helper(versionDir, extra) {
        const runtime = path.join(versionDir, RUNTIME_NAME);
        const entry = path.join(versionDir, 'app', 'dist', 'index.js');
        return spawnSync(runtime, [entry, 'chat', ...extra], { stdio: 'inherit', windowsHide: true });
    }

    function install() {
        const version = readText('version.txt');
        log(`${APP_NAME} ${version}`);
        log('');
        stopRunningHelper();

        const versionDir = path.join(INSTALL_ROOT, version);
        fs.rmSync(versionDir, { recursive: true, force: true });
        fs.mkdirSync(versionDir, { recursive: true });
        log(`Installing to ${versionDir} ...`);
        const count = extractPayload(versionDir);
        fs.copyFileSync(process.execPath, path.join(versionDir, RUNTIME_NAME));
        log(`Copied ${count} files.`);
        removeOldVersions(version);

        ensureClaudeCode();

        // Registers the login autostart entry and starts the helper now.
        if (helper(versionDir, ['--install']).status !== 0) throw new Error('The helper could not be registered.');
        log('');
        log('Done. In EasyEDA Pro open Copilot -> Claude Chat and sign in with your Claude account.');
    }

    function uninstall() {
        stopRunningHelper();
        const versions = fs.existsSync(INSTALL_ROOT) ? fs.readdirSync(INSTALL_ROOT) : [];
        const current = versions.map(name => path.join(INSTALL_ROOT, name))
            .find(dir => fs.existsSync(path.join(dir, RUNTIME_NAME)));
        if (current) helper(current, ['--uninstall']);
        fs.rmSync(INSTALL_ROOT, { recursive: true, force: true });
        log('Claude Chat helper removed.');
    }

    /** Keeps the console window open briefly when the user double-clicked the installer. */
    function finish(code) {
        if (process.env.EASYEDA_COPILOT_NO_PAUSE || !process.stdin.isTTY) process.exit(code);
        log('');
        log('This window closes in 15 seconds (or press Enter).');
        const timer = setTimeout(() => process.exit(code), 15_000);
        process.stdin.once('data', () => { clearTimeout(timer); process.exit(code); });
    }

    try {
        if (process.platform !== 'win32') throw new Error('This installer is for Windows.');
        if (args.includes('--uninstall')) uninstall();
        else install();
        finish(0);
    } catch (error) {
        log('');
        log(`Installation failed: ${error && error.message ? error.message : error}`);
        finish(1);
    }
}
