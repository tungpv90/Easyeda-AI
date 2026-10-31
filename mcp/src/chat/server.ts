import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import {
    CLAUDE_CHAT_PROTOCOL_VERSION,
    type ClaudeChatClientMessage,
    type ClaudeChatServerMessage,
} from '@copilot/shared/types/claude-chat';
import type { Bridge } from '../bridge/index';
import { DOCS_DIR, MCP_VERSION, SKILL_DOC_PATH, TEMP_DIR } from '../utils/dirs';
import {
    claudeAuthStatus,
    claudeLogout,
    claudeVersion,
    findClaude,
    spawnClaude,
    type ClaudeExecutable,
} from './claude-cli';
import { ClaudeChatSession, MCP_SERVER_NAME } from './session';

export type ChatServerOptions = {
    host: string;
    port: number;
    stateDir: string;
    /** Absolute path of the MCP stdio entry (dist/index.js) that Claude Code launches. */
    mcpEntry: string;
    /** Environment for the MCP process, e.g. a non-default EasyEDA bridge port. */
    mcpEnv?: Record<string, string>;
    bridge?: Bridge;
    log: (line: string) => void;
};

const EASYEDA_HOSTS = /(^|\.)(easyeda\.com|lceda\.cn|jlceda\.com|jlc\.com|jlcpcb\.com|oshwhub\.com)$/i;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/;
const INSTANCE_POLL_MS = 5_000;

/**
 * Browsers let any web page open a WebSocket to localhost, so only the EasyEDA
 * client (or a local dev server) may talk to the daemon.
 */
export function isAllowedOrigin(origin: string | undefined, extra: string[] = []) {
    if (!origin) return true;
    if (extra.includes('*') || extra.includes(origin)) return true;
    if (origin === 'null') return false;
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return false;
    }
    // The desktop client serves its UI from a custom scheme; ordinary web pages cannot use one.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
    return LOOPBACK_HOSTS.has(url.hostname) || EASYEDA_HOSTS.test(url.hostname);
}

/** Blocks DNS-rebinding: the Host header must name the loopback address we listen on. */
export function isAllowedHost(hostHeader: string | undefined, port: number) {
    if (!hostHeader) return false;
    const host = hostHeader.toLowerCase();
    return [...LOOPBACK_HOSTS].some(name => host === `${name}:${port}` || host === name);
}

function systemPrompt() {
    return [
        'You are running inside the "Claude Chat" dialog of the EasyEDA Copilot extension in EasyEDA Pro.',
        `Work on the user's open EasyEDA project through the ${MCP_SERVER_NAME} MCP tools.`,
        `Before your first design action, read the local skill guide at ${SKILL_DOC_PATH} and follow it.`,
        'You cannot run shell commands or write local files in this dialog.',
        'Save a checkpoint before large edits so the user can undo them.',
        'Reply in the language the user writes in. Keep replies short and concrete.',
    ].join(' ');
}

export class ChatServer {
    private wss?: WebSocketServer;
    private readonly clients = new Set<WebSocket>();
    private claude?: ClaudeExecutable;
    private claudeVersionText?: string;
    private session?: ClaudeChatSession;
    private login?: ChildProcess;
    private instanceTimer?: ReturnType<typeof setInterval>;
    private lastInstances = '';
    private readonly extraOrigins = (process.env.EASYEDA_COPILOT_CHAT_ORIGINS ?? '')
        .split(',').map(value => value.trim()).filter(Boolean);

    private workspace = '';
    private mcpConfigPath = '';

    constructor(private readonly options: ChatServerOptions) {}

    /** Finds Claude Code; retried later because it may be installed after the helper started. */
    private async ensureClaude() {
        if (this.claude) return this.claude;
        const claude = findClaude();
        if (!claude) {
            this.options.log('Claude Code was not found. Install it from https://claude.com/claude-code, or set EASYEDA_COPILOT_CLAUDE_PATH.');
            return undefined;
        }
        this.claude = claude;
        this.claudeVersionText = await claudeVersion(claude).catch(() => undefined);
        this.options.log(`Using Claude Code ${this.claudeVersionText ?? '(unknown version)'} at ${claude.path}`);
        this.session = new ClaudeChatSession({
            claude,
            cwd: this.workspace,
            mcpConfigPath: this.mcpConfigPath,
            systemPrompt: systemPrompt(),
            addDirs: [DOCS_DIR, TEMP_DIR],
            emit: message => this.broadcast(message),
            log: this.options.log,
        });
        return claude;
    }

    async start() {
        const { host, port, stateDir, log } = this.options;
        const workspace = join(stateDir, 'workspace');
        await mkdir(workspace, { recursive: true });
        const mcpConfigPath = join(stateDir, 'mcp.json');
        await writeFile(mcpConfigPath, JSON.stringify({
            mcpServers: {
                [MCP_SERVER_NAME]: {
                    type: 'stdio',
                    command: process.execPath,
                    args: [this.options.mcpEntry],
                    env: this.options.mcpEnv ?? {},
                },
            },
        }, null, 2));

        this.workspace = workspace;
        this.mcpConfigPath = mcpConfigPath;
        await this.ensureClaude();

        const wss = new WebSocketServer({
            host,
            port,
            maxPayload: 1024 * 1024,
            verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) => {
                if (!isAllowedHost(req.headers.host, port)) {
                    log(`Rejected connection with Host "${req.headers.host}".`);
                    return false;
                }
                if (!isAllowedOrigin(origin || undefined, this.extraOrigins)) {
                    log(`Rejected connection from origin "${origin}". Set EASYEDA_COPILOT_CHAT_ORIGINS="${origin}" to allow it.`);
                    return false;
                }
                return true;
            },
        });
        await new Promise<void>((resolve, reject) => {
            wss.once('listening', resolve);
            wss.once('error', reject);
        });
        this.wss = wss;
        wss.on('connection', (socket, req) => this.onConnection(socket, req));
        if (this.options.bridge) {
            this.instanceTimer = setInterval(() => this.pollInstances(), INSTANCE_POLL_MS);
        }
        log(`Claude Chat daemon listening on ws://${host}:${port}`);
    }

    async close() {
        clearInterval(this.instanceTimer);
        this.session?.dispose();
        this.login?.kill();
        for (const client of this.clients) client.close();
        await new Promise<void>(resolve => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    }

    private onConnection(socket: WebSocket, req: IncomingMessage) {
        this.options.log(`Dialog connected (origin: ${req.headers.origin ?? 'none'}).`);
        this.clients.add(socket);
        socket.on('close', () => this.clients.delete(socket));
        socket.on('error', () => this.clients.delete(socket));
        socket.on('message', data => {
            let message: ClaudeChatClientMessage;
            try {
                message = JSON.parse(data.toString()) as ClaudeChatClientMessage;
            } catch {
                return;
            }
            this.onMessage(socket, message).catch(error => {
                this.send(socket, { type: 'chat.error', message: (error as Error).message });
            });
        });
    }

    private async onMessage(socket: WebSocket, message: ClaudeChatClientMessage) {
        switch (message.type) {
            case 'ping':
                this.send(socket, { type: 'pong' });
                return;
            case 'hello':
                await this.ensureClaude();
                this.send(socket, {
                    type: 'hello',
                    protocol: CLAUDE_CHAT_PROTOCOL_VERSION,
                    daemonVersion: MCP_VERSION,
                    claudePath: this.claude?.path,
                    claudeVersion: this.claudeVersionText,
                    error: this.claude ? undefined : 'Claude Code is not installed on this computer.',
                });
                if (this.session) {
                    this.send(socket, this.session.state());
                    for (const prompt of this.session.pendingPermissions()) this.send(socket, prompt);
                }
                this.lastInstances = '';
                await this.pollInstances();
                await this.sendAuthStatus(socket);
                return;
            case 'auth.status':
                await this.sendAuthStatus(socket);
                return;
            case 'auth.login':
                this.startLogin();
                return;
            case 'auth.login.input':
                this.login?.stdin?.write(`${message.text.trim()}\n`);
                return;
            case 'auth.login.cancel':
                this.login?.kill();
                return;
            case 'auth.logout':
                if (!this.claude) return;
                this.session?.reset();
                await claudeLogout(this.claude);
                await this.sendAuthStatus();
                return;
            case 'chat.send':
                if (!this.session) throw new Error('Claude Code is not installed on this computer.');
                if (!message.text?.trim()) return;
                this.session.send(message.text, message.model);
                return;
            case 'chat.interrupt':
                this.session?.interrupt();
                return;
            case 'chat.new':
                this.session?.reset();
                return;
            case 'permission.respond':
                this.session?.respondPermission(message.requestId, message.allow === true, message.always === true);
                return;
            default:
                return;
        }
    }

    private async sendAuthStatus(socket?: WebSocket) {
        const account = this.claude
            ? await claudeAuthStatus(this.claude)
            : { loggedIn: false, error: 'Claude Code is not installed on this computer.' };
        const message: ClaudeChatServerMessage = { type: 'auth.status', account };
        if (socket) this.send(socket, message);
        else this.broadcast(message);
    }

    /** Runs `claude auth login --claudeai`; the browser sign-in URL is forwarded to the dialog. */
    private startLogin() {
        if (!this.claude || this.login) return;
        const child = spawnClaude(this.claude, ['auth', 'login', '--claudeai'], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.login = child;
        let sentUrl = false;
        const forward = (chunk: Buffer | string) => {
            const text = chunk.toString();
            const url = sentUrl ? undefined : text.match(URL_PATTERN)?.[0];
            if (url) sentUrl = true;
            this.broadcast({ type: 'auth.login.output', text, url });
        };
        child.stdout?.on('data', forward);
        child.stderr?.on('data', forward);
        child.stdin?.on('error', () => undefined);
        child.on('error', error => {
            this.broadcast({ type: 'auth.login.done', ok: false, error: error.message });
        });
        child.on('close', code => {
            if (this.login === child) this.login = undefined;
            this.broadcast({ type: 'auth.login.done', ok: code === 0, error: code === 0 ? undefined : `Sign-in ended (code ${code}).` });
            this.sendAuthStatus().catch(() => undefined);
        });
    }

    private async pollInstances() {
        const bridge = this.options.bridge;
        if (!bridge) return;
        try {
            const instances = await bridge.listEasyEdaInstances();
            const projects = instances.map(instance => instance.projectName);
            const key = JSON.stringify(projects);
            if (key === this.lastInstances) return;
            this.lastInstances = key;
            this.broadcast({ type: 'easyeda.instances', count: instances.length, projects });
        } catch {
            // The bridge may be reconnecting; try again on the next tick.
        }
    }

    private send(socket: WebSocket, message: ClaudeChatServerMessage) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }

    private broadcast(message: ClaudeChatServerMessage) {
        for (const client of this.clients) this.send(client, message);
    }
}
