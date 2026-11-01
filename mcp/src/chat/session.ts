import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ClaudeChatAttachment, ClaudeChatServerMessage, ClaudeChatUsage } from '@copilot/shared/types/claude-chat';
import { spawnClaude, type ClaudeExecutable } from './claude-cli';

export const MCP_SERVER_NAME = 'easyeda-copilot';

/** Built-in Claude Code tools the chat may use. Commands, edits and writes stay disabled. */
const BUILT_IN_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'];
/** Tools that never need a prompt: every EasyEDA tool (mutations are checkpoint-backed) and read-only search. */
const AUTO_ALLOWED_TOOLS = [`mcp__${MCP_SERVER_NAME}`, 'Read', 'Glob', 'Grep', 'TodoWrite'];
const INTERRUPT_GRACE_MS = 5_000;
const PREVIEW_LIMIT = 600;
const EFFORT_PATTERN = /^[a-z]+$/;
export const SESSION_GONE_MESSAGE = 'Claude Code no longer has the saved session for this conversation, so Claude does not remember the earlier messages. Send your message again to continue in a new session.';

export type SessionOptions = {
    claude: ClaudeExecutable;
    cwd: string;
    mcpConfigPath: string;
    systemPrompt: string;
    addDirs: string[];
    emit: (message: ClaudeChatServerMessage) => void;
    log: (line: string) => void;
};

type PendingPermission = { toolName: string; input: unknown };

type StreamJson = Record<string, any>;

function truncate(text: string, limit = PREVIEW_LIMIT) {
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function toolDisplayName(name: string) {
    const prefix = `mcp__${MCP_SERVER_NAME}__`;
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function summarizeInput(input: unknown) {
    if (!input || typeof input !== 'object') return '';
    const entries = Object.entries(input as Record<string, unknown>)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    return truncate(entries.join(', '), 240);
}

function toolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (part?.type === 'text') return String(part.text ?? '');
            if (part?.type === 'image') return '[image]';
            return '';
        }).filter(Boolean).join('\n');
    }
    return content === undefined ? '' : JSON.stringify(content);
}

/**
 * One long-lived `claude -p` process in stream-json mode. The process keeps the
 * conversation; if it dies, the next message resumes the same session id.
 */
export class ClaudeChatSession {
    private child?: ChildProcess;
    private buffer = '';
    private sessionId?: string;
    private model?: string;
    private mcpStatus?: string;
    private busy = false;
    private interruptTimer?: ReturnType<typeof setTimeout>;
    private readonly pending = new Map<string, PendingPermission>();
    private readonly alwaysAllowed = new Set<string>();
    private readonly streamedMessages = new Set<string>();
    private currentMessageId?: string;
    private stderrTail = '';
    private requestedModel?: string;
    private requestedEffort?: string;

    constructor(private readonly options: SessionOptions) {}

    state(): ClaudeChatServerMessage {
        return { type: 'chat.state', busy: this.busy, sessionId: this.sessionId, model: this.model, mcpStatus: this.mcpStatus };
    }

    pendingPermissions(): ClaudeChatServerMessage[] {
        return [...this.pending.entries()].map(([requestId, value]) => ({
            type: 'chat.permission',
            requestId,
            toolName: toolDisplayName(value.toolName),
            summary: summarizeInput(value.input),
        }));
    }

    get isBusy() {
        return this.busy;
    }

    /**
     * extra.content replaces the plain text block, e.g. with attached images and
     * documents; extra.attachments is what the dialog shows with the message.
     */
    send(text: string, model?: string, effort?: string, extra: { content?: unknown[]; attachments?: ClaudeChatAttachment[] } = {}) {
        if (this.busy) throw new Error('Claude is still working on the previous message.');
        const wantedModel = model?.trim() || undefined;
        const wantedEffort = effort?.trim() || undefined;
        if (wantedEffort && !EFFORT_PATTERN.test(wantedEffort)) throw new Error(`Unknown effort level: ${wantedEffort}`);
        if (this.child && (wantedModel !== this.requestedModel || wantedEffort !== this.requestedEffort)) this.stopProcess();
        this.requestedModel = wantedModel;
        this.requestedEffort = wantedEffort;
        const child = this.ensureProcess();
        this.setBusy(true);
        this.options.emit(extra.attachments?.length
            ? { type: 'chat.user', text, attachments: extra.attachments }
            : { type: 'chat.user', text });
        this.write(child, {
            type: 'user',
            message: { role: 'user', content: extra.content ?? [{ type: 'text', text }] },
            parent_tool_use_id: null,
        });
    }

    interrupt() {
        const child = this.child;
        if (!child || !this.busy) return;
        this.write(child, { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
        this.denyAllPending('Interrupted by the user.');
        // A turn stuck in a long tool call may not stop; kill it and resume later.
        clearTimeout(this.interruptTimer);
        this.interruptTimer = setTimeout(() => {
            if (this.busy && this.child === child) {
                this.options.log('Interrupt grace period expired; restarting Claude.');
                this.stopProcess();
            }
        }, INTERRUPT_GRACE_MS);
    }

    reset() {
        this.stopProcess();
        this.switchTo(undefined);
    }

    /** Continues an earlier Claude Code session with the next message. */
    resume(sessionId: string | undefined) {
        if (this.busy) throw new Error('Wait until Claude finishes, or stop it first.');
        this.stopProcess();
        this.switchTo(sessionId);
    }

    private switchTo(sessionId: string | undefined) {
        this.sessionId = sessionId;
        this.model = undefined;
        this.alwaysAllowed.clear();
        this.streamedMessages.clear();
        this.options.emit(this.state());
    }

    respondPermission(requestId: string, allow: boolean, always = false) {
        const pending = this.pending.get(requestId);
        if (!pending || !this.child) return;
        this.pending.delete(requestId);
        if (allow && always) this.alwaysAllowed.add(pending.toolName);
        this.writePermission(this.child, requestId, allow, pending.input, allow ? undefined : 'The user denied this action in the EasyEDA dialog.');
        this.options.emit({ type: 'chat.permission.resolved', requestId, allow });
    }

    dispose() {
        this.stopProcess();
    }

    private ensureProcess() {
        if (this.child) return this.child;
        const args = [
            '-p',
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--verbose',
            '--include-partial-messages',
            '--permission-prompt-tool', 'stdio',
            '--strict-mcp-config',
            '--mcp-config', this.options.mcpConfigPath,
            '--restricted',
            '--tools', BUILT_IN_TOOLS.join(','),
            '--allowedTools', AUTO_ALLOWED_TOOLS.join(','),
            '--append-system-prompt', this.options.systemPrompt,
        ];
        for (const dir of this.options.addDirs) args.push('--add-dir', dir);
        if (this.requestedModel) args.push('--model', this.requestedModel);
        if (this.requestedEffort) args.push('--effort', this.requestedEffort);
        if (this.sessionId) args.push('--resume', this.sessionId);

        this.options.log(`Starting Claude Code${this.sessionId ? ` (resume ${this.sessionId})` : ''}.`);
        const child = spawnClaude(this.options.claude, args, {
            cwd: this.options.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'easyeda-copilot-chat' },
        });
        this.child = child;
        this.buffer = '';
        this.stderrTail = '';

        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => this.onStdout(child, chunk));
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            this.stderrTail = (this.stderrTail + chunk).slice(-2000);
        });
        child.stdin?.on('error', () => undefined);
        child.on('error', error => {
            this.options.emit({ type: 'chat.error', message: `Could not start Claude Code: ${error.message}` });
        });
        child.on('close', code => this.onExit(child, code));
        return child;
    }

    private onExit(child: ChildProcess, code: number | null) {
        if (this.child !== child) return;
        this.child = undefined;
        clearTimeout(this.interruptTimer);
        this.denyAllPending();
        if (this.busy) {
            const detail = this.stderrTail.trim().split(/\r?\n/).slice(-3).join('\n');
            this.options.emit({
                type: 'chat.result',
                isError: true,
                error: detail || `Claude Code stopped (exit code ${code ?? 'unknown'}).`,
            });
            this.setBusy(false);
        }
        this.options.log(`Claude Code exited with code ${code ?? 'null'}.`);
    }

    private stopProcess() {
        const child = this.child;
        if (!child) return;
        this.child = undefined;
        clearTimeout(this.interruptTimer);
        this.denyAllPending();
        child.stdin?.end();
        child.kill();
        if (this.busy) {
            this.options.emit({ type: 'chat.result', isError: true, error: 'Stopped.' });
            this.setBusy(false);
        }
    }

    private setBusy(busy: boolean) {
        this.busy = busy;
        this.options.emit(this.state());
    }

    private write(child: ChildProcess, message: unknown) {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
    }

    private writePermission(child: ChildProcess, requestId: string, allow: boolean, input: unknown, message?: string) {
        this.write(child, {
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: requestId,
                response: allow
                    ? { behavior: 'allow', updatedInput: input ?? {} }
                    : { behavior: 'deny', message: message ?? 'Denied.' },
            },
        });
    }

    private denyAllPending(message = 'The chat session was stopped.') {
        for (const [requestId, value] of this.pending) {
            if (this.child) this.writePermission(this.child, requestId, false, value.input, message);
            this.options.emit({ type: 'chat.permission.resolved', requestId, allow: false });
        }
        this.pending.clear();
    }

    private onStdout(child: ChildProcess, chunk: string) {
        this.buffer += chunk;
        let index: number;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + 1);
            if (!line) continue;
            let message: StreamJson;
            try {
                message = JSON.parse(line);
            } catch {
                this.options.log(`Ignored non-JSON output: ${truncate(line, 200)}`);
                continue;
            }
            try {
                this.handle(child, message);
            } catch (error) {
                this.options.log(`Failed to handle ${message.type}: ${(error as Error).message}`);
            }
        }
    }

    private handle(child: ChildProcess, message: StreamJson) {
        switch (message.type) {
            case 'system':
                if (message.subtype === 'init') {
                    this.sessionId = message.session_id;
                    this.model = message.model;
                    const server = (message.mcp_servers as { name: string; status: string }[] | undefined)
                        ?.find(entry => entry.name === MCP_SERVER_NAME);
                    this.mcpStatus = server?.status;
                    this.options.emit(this.state());
                }
                return;
            case 'stream_event':
                this.handleStreamEvent(message.event);
                return;
            case 'assistant':
                this.handleAssistant(message.message);
                return;
            case 'user':
                this.handleToolResults(message.message);
                return;
            case 'control_request':
                this.handleControlRequest(child, message);
                return;
            case 'rate_limit_event':
                this.handleRateLimit(message.rate_limit_info);
                return;
            case 'result': {
                clearTimeout(this.interruptTimer);
                this.denyAllPending();
                const errors = Array.isArray(message.errors) ? message.errors.map(String) : [];
                const sessionGone = errors.some(text => /no conversation found/i.test(text));
                this.options.emit({
                    type: 'chat.result',
                    isError: message.is_error === true,
                    error: sessionGone
                        ? SESSION_GONE_MESSAGE
                        : message.is_error
                            ? errors.join('\n') || String(message.result ?? message.subtype ?? 'Unknown error')
                            : undefined,
                    durationMs: message.duration_ms,
                    costUsd: message.total_cost_usd,
                    numTurns: message.num_turns,
                });
                this.setBusy(false);
                if (sessionGone) {
                    // Start a new Claude Code session with the next message.
                    this.sessionId = undefined;
                    this.stopProcess();
                }
                return;
            }
            default:
                return;
        }
    }

    private handleStreamEvent(event: StreamJson | undefined) {
        if (!event) return;
        if (event.type === 'message_start') {
            this.currentMessageId = event.message?.id;
            return;
        }
        const messageId = this.currentMessageId;
        if (!messageId) return;
        const blockId = `${messageId}:${event.index}`;
        if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
            this.streamedMessages.add(messageId);
            this.options.emit({ type: 'chat.text.start', id: blockId });
            if (event.content_block.text) this.options.emit({ type: 'chat.text.delta', id: blockId, text: event.content_block.text });
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            this.options.emit({ type: 'chat.text.delta', id: blockId, text: event.delta.text });
        }
    }

    private handleAssistant(message: StreamJson | undefined) {
        if (!message || !Array.isArray(message.content)) return;
        const streamed = this.streamedMessages.has(message.id);
        message.content.forEach((block: StreamJson, index: number) => {
            if (block.type === 'tool_use') {
                this.options.emit({
                    type: 'chat.tool',
                    id: block.id,
                    name: toolDisplayName(block.name),
                    summary: summarizeInput(block.input),
                });
            } else if (block.type === 'text' && !streamed && block.text) {
                const id = `${message.id}:full:${index}`;
                this.options.emit({ type: 'chat.text.start', id });
                this.options.emit({ type: 'chat.text.delta', id, text: block.text });
            }
        });
    }

    private handleToolResults(message: StreamJson | undefined) {
        if (!message || !Array.isArray(message.content)) return;
        for (const block of message.content) {
            if (block?.type !== 'tool_result') continue;
            this.options.emit({
                type: 'chat.tool.result',
                id: block.tool_use_id,
                isError: block.is_error === true,
                preview: truncate(toolResultText(block.content)),
            });
        }
    }

    private handleControlRequest(child: ChildProcess, message: StreamJson) {
        const requestId = String(message.request_id);
        const request = message.request ?? {};
        if (request.subtype !== 'can_use_tool') {
            this.write(child, {
                type: 'control_response',
                response: { subtype: 'error', request_id: requestId, error: `Unsupported request: ${request.subtype}` },
            });
            return;
        }
        const toolName = String(request.tool_name);
        if (this.alwaysAllowed.has(toolName)) {
            this.writePermission(child, requestId, true, request.input);
            return;
        }
        this.pending.set(requestId, { toolName, input: request.input });
        this.options.emit({
            type: 'chat.permission',
            requestId,
            toolName: toolDisplayName(toolName),
            summary: summarizeInput(request.input),
            description: typeof request.description === 'string' ? request.description : undefined,
        });
    }

    private handleRateLimit(info: StreamJson | undefined) {
        if (!info) return;
        const windows = info.unifiedWindows ?? {};
        const usage: ClaudeChatUsage = {
            fiveHour: typeof windows.five_hour?.utilization === 'number' ? windows.five_hour.utilization : undefined,
            sevenDay: typeof windows.seven_day?.utilization === 'number' ? windows.seven_day.utilization : undefined,
            status: typeof info.status === 'string' ? info.status : undefined,
        };
        this.options.emit({ type: 'usage', usage });
    }
}
