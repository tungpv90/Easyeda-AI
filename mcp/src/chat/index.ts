import { appendFileSync, mkdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CLAUDE_CHAT_DEFAULT_PORT } from '@copilot/shared/types/claude-chat';
import { startBridge, type Bridge } from '../bridge/index';
import { installAutostart, startDetached, uninstallAutostart } from './autostart';
import { mcpServerCommand, registerClaudeCodeMcp, unregisterClaudeCodeMcp } from './claude-code-mcp';
import { ChatServer } from './server';
import { MCP_SERVER_NAME } from './session';

const HOST = '127.0.0.1';
const MAX_LOG_BYTES = 5 * 1024 * 1024;

const USAGE = `Usage: easyeda-copilot-mcp chat [--install [--no-claude-code] | --uninstall] [--port <port>]

Runs the local helper used by the "Claude Chat" dialog in EasyEDA Pro.
It uses your own Claude Code login (run "claude" once and sign in).

  --install     Start the helper now and every time you log in to this computer,
                and add the EasyEDA tools to your Claude Code (terminal, VS Code).
                --no-claude-code leaves your Claude Code configuration unchanged.
  --uninstall   Stop starting the helper at login and remove the tools from Claude Code.
  --port        WebSocket port for the dialog (default ${CLAUDE_CHAT_DEFAULT_PORT}).`;

function isPortInUse(port: number) {
    return new Promise<boolean>(done => {
        const socket = createConnection({ host: HOST, port });
        socket.once('connect', () => { socket.destroy(); done(true); });
        socket.once('error', () => done(false));
    });
}

function makeLogger(logFile: string) {
    try {
        if (statSync(logFile).size > MAX_LOG_BYTES) truncateSync(logFile, 0);
    } catch {
        // No log yet.
    }
    return (line: string) => {
        const text = `[${new Date().toISOString()}] ${line}`;
        try {
            appendFileSync(logFile, `${text}\n`);
        } catch {
            // Logging must never stop the daemon.
        }
        if (process.stdout.isTTY) console.log(text);
    };
}

/** A failure here must not fail the install: the chat dialog does not need this entry. */
async function addToClaudeCode(mcpEntry: string, stateDir: string) {
    const manual = `claude mcp add --scope user ${MCP_SERVER_NAME} -- ${mcpServerCommand(mcpEntry).map(arg => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')}`;
    try {
        const command = await registerClaudeCodeMcp(mcpEntry, stateDir);
        if (command) {
            console.log(`Claude Code: added the "${MCP_SERVER_NAME}" MCP server for all your projects.`);
            console.log('The EasyEDA tools are available in new Claude Code sessions (terminal, VS Code).');
        } else {
            console.log(`Claude Code was not found. After installing it, run:\n  ${manual}`);
        }
    } catch (error) {
        console.log(`Could not add the EasyEDA tools to Claude Code: ${(error as Error).message}`);
        console.log(`To add them yourself, run:\n  ${manual}`);
    }
}

export async function runChat(argv: string[], mcpEntry: string) {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(USAGE);
        return;
    }
    const portIndex = argv.indexOf('--port');
    const port = Number(portIndex >= 0 ? argv[portIndex + 1] : process.env.EASYEDA_COPILOT_CHAT_PORT || CLAUDE_CHAT_DEFAULT_PORT);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid port: ${argv[portIndex + 1]}`);

    const stateDir = resolve(process.env.EASYEDA_COPILOT_CHAT_HOME || join(homedir(), '.easyeda-copilot', 'chat'));
    mkdirSync(stateDir, { recursive: true });
    const logFile = join(stateDir, 'daemon.log');
    const pidFile = join(stateDir, 'daemon.pid');
    const errorLog = join(stateDir, 'daemon-error.log');

    if (argv.includes('--uninstall')) {
        const path = await uninstallAutostart();
        console.log(`Removed autostart entry: ${path}`);
        if (await unregisterClaudeCodeMcp(stateDir).catch(() => false)) console.log('Removed the EasyEDA tools from Claude Code.');
        console.log('A helper that is already running keeps running until you log out or end it.');
        return;
    }

    if (argv.includes('--install')) {
        const path = await installAutostart(mcpEntry, errorLog);
        console.log(`Autostart entry: ${path}`);
        if (process.platform !== 'darwin' && !(await isPortInUse(port))) startDetached(mcpEntry, errorLog);
        console.log('The Claude Chat helper is running and will start again after each login.');
        if (!argv.includes('--no-claude-code')) await addToClaudeCode(mcpEntry, stateDir);
        console.log('Open EasyEDA Pro -> Copilot -> Claude Chat and sign in with your Claude account.');
        return;
    }

    if (await isPortInUse(port)) {
        console.log(`Something is already listening on ${HOST}:${port}; the Claude Chat helper is probably running.`);
        return;
    }

    const log = makeLogger(logFile);
    const bridgeHost = process.env.EASYEDA_COPILOT_MCP_WS_HOST || HOST;
    const bridgePort = Number(process.env.EASYEDA_COPILOT_MCP_WS_PORT || 8787);
    const mcpEnv = { EASYEDA_COPILOT_MCP_WS_HOST: bridgeHost, EASYEDA_COPILOT_MCP_WS_PORT: String(bridgePort) };
    let bridge: Bridge | undefined;
    try {
        // Hold the EasyEDA bridge so the extension stays connected between chat turns.
        bridge = await startBridge({ host: bridgeHost, port: bridgePort });
    } catch (error) {
        log(`EasyEDA bridge unavailable: ${(error as Error).message}`);
    }

    const server = new ChatServer({ host: HOST, port, stateDir, mcpEntry, mcpEnv, bridge, log });
    await server.start();
    // Lets the installer stop this helper before replacing its files.
    writeFileSync(pidFile, String(process.pid));

    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        log('Stopping.');
        await server.close().catch(() => undefined);
        await bridge?.close().catch(() => undefined);
        rmSync(pidFile, { force: true });
        process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}
