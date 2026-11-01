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
import { BUILTIN_CLAUDE_MODELS, claudeModelsFromClaudeCode } from '@copilot/shared/claude-models';
import type { Bridge } from '../bridge/index';
import { DOCS_DIR, MCP_VERSION, SKILL_DOC_PATH, TEMP_DIR } from '../utils/dirs';
import {
    claudeAuthStatus,
    claudeInitialize,
    claudeLogout,
    claudeVersion,
    findClaude,
    spawnClaude,
    type ClaudeExecutable,
} from './claude-cli';
import { ClaudeChatSession, MCP_SERVER_NAME } from './session';
import { ChatHistory, summarize } from './history';
import { AttachmentStore, publicAttachment, userMessageContent } from './attachments';

type ModelList = Extract<ClaudeChatServerMessage, { type: 'models' }>;

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
/** The model list depends on the account and Claude Code version; ask again after this. */
const MODEL_CACHE_MS = 30 * 60_000;

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
        'The user can attach images, PDFs such as datasheets, and text files. Each message lists its attachments with a local path; open a file with Read when it was too large to include or when you need it again later.',
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
    private history?: ChatHistory;
    private attachments?: AttachmentStore;
    private models?: { list: ModelList; at: number };
    private modelsLoading?: Promise<ModelList>;

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
            emit: message => this.emit(message),
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
        // Inside Claude's working folder, so Claude Code can also open the files with Read.
        const attachments = new AttachmentStore(join(workspace, 'attachments'));
        this.attachments = attachments;
        this.history = new ChatHistory(join(stateDir, 'history'), log, ids => attachments.removeFiles(ids));
        this.history.prune().catch(() => undefined);
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
        await this.history?.save().catch(() => undefined);
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
                if (this.session) this.send(socket, this.session.state());
                this.send(socket, this.currentConversation());
                if (this.session) {
                    for (const prompt of this.session.pendingPermissions()) this.send(socket, prompt);
                }
                await this.sendHistoryList(socket);
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
                this.models = undefined;
                await this.startNewConversation();
                await this.sendAuthStatus();
                return;
            case 'chat.send': {
                if (!this.session) throw new Error('Claude Code is not installed on this computer.');
                if (this.session.isBusy) throw new Error('Claude is still working on the previous message.');
                const text = typeof message.text === 'string' ? message.text : '';
                const attachments = this.attachments?.take(message.attachments) ?? [];
                if (!text.trim() && !attachments.length) return;
                try {
                    const content = attachments.length ? await userMessageContent(text, attachments) : undefined;
                    this.session.send(text, message.model, message.effort, { content, attachments: attachments.map(publicAttachment) });
                } catch (error) {
                    // Keep the files so the user can try again.
                    this.attachments?.restore(attachments);
                    throw error;
                }
                this.history?.noteRequest(message.model, message.effort);
                return;
            }
            case 'attachment.begin':
                await this.onUpload(socket, message.uploadId, async store => {
                    store.begin(message);
                    this.send(socket, { type: 'attachment.ack', uploadId: message.uploadId, index: -1, received: 0 });
                });
                return;
            case 'attachment.chunk':
                await this.onUpload(socket, message.uploadId, async store => {
                    const received = store.chunk(message.uploadId, message.index, message.data);
                    this.send(socket, { type: 'attachment.ack', uploadId: message.uploadId, index: message.index, received });
                });
                return;
            case 'attachment.end':
                await this.onUpload(socket, message.uploadId, async store => {
                    const attachment = await store.end(message.uploadId);
                    this.send(socket, { type: 'attachment.ready', uploadId: message.uploadId, attachment: publicAttachment(attachment) });
                });
                return;
            case 'attachment.cancel':
                this.attachments?.cancel(message.uploadId);
                return;
            case 'attachment.discard':
                await this.attachments?.discard(message.id);
                return;
            case 'chat.interrupt':
                this.session?.interrupt();
                return;
            case 'chat.new':
                this.session?.reset();
                await this.startNewConversation();
                return;
            case 'models.list':
                this.send(socket, await this.listModels(message.refresh === true));
                return;
            case 'history.list':
                await this.sendHistoryList(socket);
                return;
            case 'history.open': {
                if (!this.history) return;
                if (this.session?.isBusy) throw new Error('Wait until Claude finishes, or stop it first.');
                const conversation = await this.history.open(message.id);
                this.session?.resume(conversation.sessionId);
                this.broadcast(this.currentConversation());
                await this.sendHistoryList();
                return;
            }
            case 'history.delete': {
                if (!this.history) return;
                const isCurrent = this.history.current?.id === message.id;
                if (isCurrent && this.session?.isBusy) throw new Error('Stop Claude before deleting this conversation.');
                await this.history.remove(message.id);
                if (isCurrent) {
                    this.session?.reset();
                    this.broadcast(this.currentConversation());
                }
                await this.sendHistoryList();
                return;
            }
            case 'permission.respond':
                this.session?.respondPermission(message.requestId, message.allow === true, message.always === true);
                return;
            default:
                return;
        }
    }

    /** Runs one upload step; a failure cancels the upload and is reported to that dialog only. */
    private async onUpload(socket: WebSocket, uploadId: string, step: (store: AttachmentStore) => Promise<void>) {
        const store = this.attachments;
        if (!store) return;
        try {
            await step(store);
        } catch (error) {
            store.cancel(uploadId);
            this.send(socket, { type: 'attachment.error', uploadId: String(uploadId), message: (error as Error).message });
        }
    }

    private emit(message: ClaudeChatServerMessage) {
        const started = this.history?.record(message) ?? false;
        this.broadcast(message);
        if (started || message.type === 'chat.result') this.sendHistoryList().catch(() => undefined);
    }

    private currentConversation(): ClaudeChatServerMessage {
        const conversation = this.history?.current;
        if (!conversation) return { type: 'history.current', events: [] };
        return {
            type: 'history.current',
            conversation: summarize(conversation),
            requestedModel: conversation.requestedModel ?? '',
            effort: conversation.effort ?? '',
            events: conversation.events,
        };
    }

    private async startNewConversation() {
        await this.history?.startNew();
        this.broadcast(this.currentConversation());
        await this.sendHistoryList();
    }

    private async sendHistoryList(socket?: WebSocket) {
        if (!this.history) return;
        const message: ClaudeChatServerMessage = {
            type: 'history.list',
            conversations: await this.history.list(),
            currentId: this.history.current?.id,
        };
        if (socket) this.send(socket, message);
        else this.broadcast(message);
    }

    /** Models this account can use, as listed by Claude Code; the built-in list if it cannot be asked. */
    private listModels(refresh: boolean): Promise<ModelList> {
        if (!refresh && this.models && Date.now() - this.models.at < MODEL_CACHE_MS) return Promise.resolve(this.models.list);
        this.modelsLoading ??= this.loadModels().finally(() => { this.modelsLoading = undefined; });
        return this.modelsLoading;
    }

    private async loadModels(): Promise<ModelList> {
        const claude = await this.ensureClaude();
        if (!claude) {
            return { type: 'models', models: BUILTIN_CLAUDE_MODELS, source: 'builtin', error: 'Claude Code is not installed on this computer.' };
        }
        try {
            const init = await claudeInitialize(claude, this.workspace);
            const models = claudeModelsFromClaudeCode(init.models);
            if (!models.length) throw new Error('Claude Code returned no models.');
            const list: ModelList = { type: 'models', models, source: 'claude-code' };
            this.models = { list, at: Date.now() };
            return list;
        } catch (error) {
            const reason = (error as Error).message;
            this.options.log(`Could not list Claude models: ${reason}`);
            return { type: 'models', models: BUILTIN_CLAUDE_MODELS, source: 'builtin', error: reason };
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
            this.models = undefined;
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
