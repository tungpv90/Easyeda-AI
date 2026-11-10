import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the user's own Claude Code CLI lives. Resolved once per daemon. */
export type ClaudeExecutable = { path: string; needsShell: boolean };

export type ClaudeAuthStatus = {
    loggedIn: boolean;
    authMethod?: string;
    email?: string;
    subscriptionType?: string;
    orgName?: string;
    error?: string;
};

let cached: ClaudeExecutable | undefined;

function candidatePaths() {
    const home = homedir();
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
        return [
            join(home, '.local', 'bin', 'claude.exe'),
            join(home, '.claude', 'local', 'claude.exe'),
            join(appData, 'npm', 'claude.cmd'),
        ];
    }
    return [
        join(home, '.local', 'bin', 'claude'),
        join(home, '.claude', 'local', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
    ];
}

function fromPath(): string | undefined {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(finder, ['claude'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 || !result.stdout) return undefined;
    const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    // Prefer a real executable over npm's .cmd shim on Windows.
    return lines.find(line => /\.exe$/i.test(line)) ?? lines.find(line => /\.cmd$/i.test(line)) ?? lines[0];
}

export function findClaude(): ClaudeExecutable | undefined {
    if (cached && existsSync(cached.path)) return cached;
    const override = process.env.EASYEDA_COPILOT_CLAUDE_PATH?.trim();
    const path = override || fromPath() || candidatePaths().find(existsSync);
    if (!path) return undefined;
    cached = { path, needsShell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(path) };
    return cached;
}

/** cmd.exe needs explicit quoting when we must go through a .cmd shim. */
function quoteForCmd(arg: string) {
    if (/^[\w\-.,:/\\=@]+$/.test(arg)) return arg;
    return `"${arg.replace(/"/g, '""')}"`;
}

export function spawnClaude(claude: ClaudeExecutable, args: string[], options: SpawnOptions = {}): ChildProcess {
    const base: SpawnOptions = { windowsHide: true, ...options };
    if (!claude.needsShell) return spawn(claude.path, args, base);
    const command = [quoteForCmd(claude.path), ...args.map(quoteForCmd)].join(' ');
    return spawn(command, { ...base, shell: true });
}

function collect(child: ChildProcess, timeoutMs: number) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.stdout?.on('data', chunk => { stdout += chunk; });
        child.stderr?.on('data', chunk => { stderr += chunk; });
        child.on('error', error => {
            clearTimeout(timer);
            resolve({ code: -1, stdout, stderr: stderr || error.message });
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

export async function claudeVersion(claude: ClaudeExecutable) {
    const { stdout } = await collect(spawnClaude(claude, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }), 15_000);
    return stdout.trim() || undefined;
}

export async function claudeAuthStatus(claude: ClaudeExecutable): Promise<ClaudeAuthStatus> {
    const { stdout, stderr } = await collect(
        spawnClaude(claude, ['auth', 'status', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] }),
        20_000,
    );
    try {
        const json = JSON.parse(stdout) as Record<string, unknown>;
        return {
            loggedIn: json.loggedIn === true,
            authMethod: typeof json.authMethod === 'string' ? json.authMethod : undefined,
            email: typeof json.email === 'string' ? json.email : undefined,
            subscriptionType: typeof json.subscriptionType === 'string' ? json.subscriptionType : undefined,
            orgName: typeof json.orgName === 'string' ? json.orgName : undefined,
        };
    } catch {
        return { loggedIn: false, error: (stderr || stdout).trim() || 'Could not read Claude Code login status.' };
    }
}

export async function claudeLogout(claude: ClaudeExecutable) {
    await collect(spawnClaude(claude, ['auth', 'logout'], { stdio: ['ignore', 'pipe', 'pipe'] }), 20_000);
}

const MCP_CONFIG_TIMEOUT_MS = 30_000;

export async function claudeMcpRemove(claude: ClaudeExecutable, name: string) {
    const { code } = await collect(
        spawnClaude(claude, ['mcp', 'remove', '--scope', 'user', name], { stdio: ['ignore', 'pipe', 'pipe'] }),
        MCP_CONFIG_TIMEOUT_MS,
    );
    return code === 0;
}

/** Adds a stdio MCP server to the user's Claude Code (all projects), replacing one with the same name. */
export async function claudeMcpAdd(claude: ClaudeExecutable, name: string, command: string[]) {
    // `claude mcp add` refuses a name that already exists.
    await claudeMcpRemove(claude, name);
    const { code, stdout, stderr } = await collect(
        spawnClaude(claude, ['mcp', 'add', '--scope', 'user', name, '--', ...command], { stdio: ['ignore', 'pipe', 'pipe'] }),
        MCP_CONFIG_TIMEOUT_MS,
    );
    if (code !== 0) throw new Error((stderr || stdout).trim() || `claude mcp add ended with code ${code}.`);
}

const MODEL_LIST_TIMEOUT_MS = 30_000;

/**
 * Asks Claude Code which models this account can use. It answers the stream-json
 * `initialize` request without calling the API, so this costs no usage.
 */
export function claudeInitialize(claude: ClaudeExecutable, cwd: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const child = spawnClaude(claude, [
            '-p',
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--verbose',
            '--strict-mcp-config',
        ], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        const requestId = `models-${Date.now()}`;
        let buffer = '';
        let stderr = '';
        let settled = false;
        const finish = (error?: Error, value?: Record<string, unknown>) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.stdin?.end();
            child.kill();
            if (error) reject(error);
            else resolve(value ?? {});
        };
        const timer = setTimeout(() => finish(new Error('Claude Code did not list its models in time.')), MODEL_LIST_TIMEOUT_MS);
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            buffer += chunk;
            let index: number;
            while ((index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index).trim();
                buffer = buffer.slice(index + 1);
                if (!line) continue;
                try {
                    const message = JSON.parse(line);
                    const response = message?.response;
                    if (message?.type !== 'control_response' || response?.request_id !== requestId) continue;
                    if (response.subtype === 'success') finish(undefined, response.response ?? {});
                    else finish(new Error(String(response.error ?? 'Claude Code rejected the request.')));
                } catch {
                    // Not JSON; keep reading.
                }
            }
        });
        child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
        child.stdin?.on('error', () => undefined);
        child.on('error', error => finish(error));
        child.on('close', code => finish(new Error(stderr.trim() || `Claude Code exited (code ${code}).`)));
        child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } })}\n`);
    });
}
