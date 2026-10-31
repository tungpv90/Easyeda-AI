import {
    CLAUDE_CHAT_DEFAULT_PORT,
    CLAUDE_CHAT_PROTOCOL_VERSION,
    type ClaudeChatClientMessage,
    type ClaudeChatServerMessage,
} from '@copilot/shared/types/claude-chat';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'blocked';

const SOCKET_ID = 'easyeda-copilot-claude-chat';
const PING_INTERVAL_MS = 4_000;
const SILENCE_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 3_000;

const hasEda = () => typeof window !== 'undefined' && 'eda' in window;

/**
 * Connection to the local chat daemon. Inside EasyEDA it goes through
 * eda.sys_WebSocket (needs "External Interactions"); in a plain browser
 * (vite dev) it uses a normal WebSocket.
 *
 * eda.sys_WebSocket has no close/error callback, so a heartbeat decides
 * whether the daemon is still there.
 */
export class ChatConnection {
    status: ConnectionStatus = 'disconnected';
    error?: string;

    private readonly url: string;
    private native?: WebSocket;
    private pingTimer?: ReturnType<typeof setInterval>;
    private retryTimer?: ReturnType<typeof setTimeout>;
    private lastMessageAt = 0;
    private stopped = false;

    constructor(
        private readonly onMessage: (message: ClaudeChatServerMessage) => void,
        private readonly onStatus: (status: ConnectionStatus, error?: string) => void,
        port = CLAUDE_CHAT_DEFAULT_PORT,
    ) {
        this.url = `ws://127.0.0.1:${port}`;
    }

    connect() {
        this.stopped = false;
        clearTimeout(this.retryTimer);
        this.closeSocket();
        this.setStatus('connecting');
        this.lastMessageAt = Date.now();

        try {
            if (hasEda()) {
                eda.sys_WebSocket.register(
                    SOCKET_ID,
                    this.url,
                    event => this.receive(event.data),
                    () => this.opened(),
                );
            } else {
                const socket = new WebSocket(this.url);
                this.native = socket;
                socket.onopen = () => this.opened();
                socket.onmessage = event => this.receive(event.data);
                socket.onclose = () => { if (this.native === socket) this.lost(); };
            }
        } catch (error) {
            // eda.sys_WebSocket throws when External Interactions is off.
            this.setStatus('blocked', (error as Error)?.message || String(error));
            return;
        }

        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    }

    send(message: ClaudeChatClientMessage) {
        const data = JSON.stringify(message);
        try {
            if (this.native) this.native.send(data);
            else if (hasEda()) eda.sys_WebSocket.send(SOCKET_ID, data);
        } catch {
            this.lost();
        }
    }

    dispose() {
        this.stopped = true;
        clearInterval(this.pingTimer);
        clearTimeout(this.retryTimer);
        this.closeSocket();
    }

    private opened() {
        this.lastMessageAt = Date.now();
        this.setStatus('connected');
        this.send({ type: 'hello', protocol: CLAUDE_CHAT_PROTOCOL_VERSION, client: 'easyeda-claude-chat' });
    }

    private receive(data: unknown) {
        this.lastMessageAt = Date.now();
        if (this.status !== 'connected') this.opened();
        let message: ClaudeChatServerMessage;
        try {
            message = JSON.parse(typeof data === 'string' ? data : String(data));
        } catch {
            return;
        }
        if (message.type !== 'pong') this.onMessage(message);
    }

    private heartbeat() {
        if (Date.now() - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
            this.lost();
            return;
        }
        if (this.status === 'connected') this.send({ type: 'ping' });
    }

    private lost() {
        if (this.stopped) return;
        clearInterval(this.pingTimer);
        this.closeSocket();
        this.setStatus('disconnected');
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.connect(), RETRY_DELAY_MS);
    }

    private closeSocket() {
        if (this.native) {
            const socket = this.native;
            this.native = undefined;
            socket.onclose = null;
            socket.close();
        }
        if (hasEda()) {
            // Also clears a registration left over from a previous dialog window.
            try { eda.sys_WebSocket.close(SOCKET_ID); } catch { /* not registered */ }
        }
    }

    private setStatus(status: ConnectionStatus, error?: string) {
        this.status = status;
        this.error = error;
        this.onStatus(status, error);
    }
}

export function openExternal(url: string) {
    if (!/^https?:\/\//i.test(url)) return;
    if (hasEda()) {
        try {
            eda.sys_Window.open(url);
            return;
        } catch {
            // Fall back to the browser API below.
        }
    }
    window.open(url, '_blank', 'noopener');
}
