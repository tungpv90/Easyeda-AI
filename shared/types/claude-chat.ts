/**
 * Protocol between the EasyEDA "Claude Chat" dialog and the local chat daemon
 * (`easyeda-copilot-mcp chat`). JSON text frames over ws://127.0.0.1:8788.
 */

export const CLAUDE_CHAT_DEFAULT_PORT = 8788;
export const CLAUDE_CHAT_PROTOCOL_VERSION = 1;

export type ClaudeChatAccount = {
    loggedIn: boolean;
    authMethod?: string;
    email?: string;
    subscriptionType?: string;
    orgName?: string;
    error?: string;
};

/** One model the user's Claude Code accepts, with published specs where known. */
export type ClaudeChatModel = {
    /** Value passed to `claude --model`; empty string means Claude Code's default. */
    value: string;
    displayName: string;
    description?: string;
    /** Full model ID the value resolves to, e.g. claude-opus-5-5. */
    resolvedModel?: string;
    /** Effort levels the model accepts (`claude --effort`). */
    effortLevels?: string[];
    contextWindow?: number;
    maxOutputTokens?: number;
    /** Anthropic API list price in USD per million tokens, for comparison only. */
    inputPricePerMTok?: number;
    outputPricePerMTok?: number;
    /** A pinned older version rather than one of the current aliases. */
    legacy?: boolean;
};

export type ClaudeChatConversationSummary = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    /** Model reported by Claude Code for the last turn. */
    model?: string;
    messageCount: number;
};

export type ClaudeChatUsage = {
    fiveHour?: number;
    sevenDay?: number;
    status?: string;
};

/** Messages sent by the dialog. */
export type ClaudeChatClientMessage =
    | { type: 'hello'; protocol: number; client: string }
    | { type: 'ping' }
    | { type: 'auth.status' }
    | { type: 'auth.login' }
    | { type: 'auth.login.input'; text: string }
    | { type: 'auth.login.cancel' }
    | { type: 'auth.logout' }
    | { type: 'chat.send'; text: string; model?: string; effort?: string }
    | { type: 'chat.interrupt' }
    | { type: 'chat.new' }
    | { type: 'models.list'; refresh?: boolean }
    | { type: 'history.list' }
    | { type: 'history.open'; id: string }
    | { type: 'history.delete'; id: string }
    | { type: 'permission.respond'; requestId: string; allow: boolean; always?: boolean };

/** Messages sent by the daemon. */
export type ClaudeChatServerMessage =
    | {
        type: 'hello';
        protocol: number;
        daemonVersion: string;
        claudePath?: string;
        claudeVersion?: string;
        error?: string;
    }
    | { type: 'pong' }
    | { type: 'auth.status'; account: ClaudeChatAccount }
    | { type: 'auth.login.output'; text: string; url?: string }
    | { type: 'auth.login.done'; ok: boolean; error?: string }
    | { type: 'chat.state'; busy: boolean; sessionId?: string; model?: string; mcpStatus?: string }
    | { type: 'chat.user'; text: string }
    | { type: 'chat.text.start'; id: string }
    | { type: 'chat.text.delta'; id: string; text: string }
    | { type: 'chat.tool'; id: string; name: string; summary: string }
    | { type: 'chat.tool.result'; id: string; isError: boolean; preview: string }
    | {
        type: 'chat.permission';
        requestId: string;
        toolName: string;
        summary: string;
        description?: string;
    }
    | { type: 'chat.permission.resolved'; requestId: string; allow: boolean }
    | {
        type: 'chat.result';
        isError: boolean;
        error?: string;
        durationMs?: number;
        costUsd?: number;
        numTurns?: number;
    }
    | { type: 'chat.error'; message: string }
    | { type: 'usage'; usage: ClaudeChatUsage }
    | { type: 'easyeda.instances'; count: number; projects: string[] }
    /** source: 'claude-code' when listed by the user's Claude Code, 'builtin' when it could not be asked. */
    | { type: 'models'; models: ClaudeChatModel[]; source: 'claude-code' | 'builtin'; error?: string }
    | { type: 'history.list'; conversations: ClaudeChatConversationSummary[]; currentId?: string }
    /**
     * The conversation shown in the dialog. events replays its stored messages;
     * no conversation (and no events) means a new, empty chat.
     */
    | {
        type: 'history.current';
        conversation?: ClaudeChatConversationSummary;
        requestedModel?: string;
        effort?: string;
        events: ClaudeChatServerMessage[];
    };
