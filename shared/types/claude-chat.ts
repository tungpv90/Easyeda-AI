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
    | { type: 'chat.send'; text: string; model?: string }
    | { type: 'chat.interrupt' }
    | { type: 'chat.new' }
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
    | { type: 'easyeda.instances'; count: number; projects: string[] };
