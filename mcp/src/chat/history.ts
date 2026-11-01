import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaudeChatConversationSummary, ClaudeChatServerMessage } from '@copilot/shared/types/claude-chat';

/** Stored conversations; the oldest are removed beyond this. */
export const MAX_CONVERSATIONS = 200;
/** Stored dialog events per conversation; the oldest are dropped beyond this. */
export const MAX_EVENTS = 1_500;
const TITLE_LIMIT = 80;
const SAVE_DELAY_MS = 1_000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Dialog messages that make up a conversation's visible history. */
const RECORDED = new Set<ClaudeChatServerMessage['type']>([
    'chat.user',
    'chat.text.start',
    'chat.text.delta',
    'chat.tool',
    'chat.tool.result',
    'chat.permission',
    'chat.permission.resolved',
    'chat.result',
    'chat.error',
]);

export type StoredConversation = {
    version: 1;
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    /** Claude Code session to resume when the conversation continues. */
    sessionId?: string;
    /** Model reported by Claude Code. */
    model?: string;
    /** Model and effort the user picked in the dialog. */
    requestedModel?: string;
    effort?: string;
    events: ClaudeChatServerMessage[];
};

export function isConversationId(id: unknown): id is string {
    return typeof id === 'string' && ID_PATTERN.test(id);
}

function titleFrom(text: string) {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line || 'Untitled conversation';
}

export function summarize(conversation: StoredConversation): ClaudeChatConversationSummary {
    return {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        model: conversation.model,
        messageCount: conversation.events.filter(event => event.type === 'chat.user').length,
    };
}

/** Ids of the files attached anywhere in a conversation. */
export function attachmentIds(conversation: StoredConversation) {
    return conversation.events.flatMap(event => (event.type === 'chat.user' ? event.attachments ?? [] : []).map(file => file.id));
}

function parse(text: string): StoredConversation | undefined {
    try {
        const value = JSON.parse(text) as StoredConversation;
        if (value?.version !== 1 || !isConversationId(value.id) || !Array.isArray(value.events)) return undefined;
        return value;
    } catch {
        return undefined;
    }
}

/**
 * Keeps each Claude Chat conversation as one JSON file, so the dialog can list,
 * reopen and continue earlier conversations (Claude Code resumes the session).
 */
export class ChatHistory {
    current?: StoredConversation;
    private saveTimer?: ReturnType<typeof setTimeout>;
    private ready?: Promise<void>;
    /** Summaries of saved conversations, read from disk once. */
    private summaries?: Map<string, ClaudeChatConversationSummary>;

    constructor(
        private readonly dir: string,
        private readonly log: (line: string) => void = () => undefined,
        /** Deletes the saved files of a removed conversation's attachments. */
        private readonly removeAttachments: (ids: string[]) => Promise<void> = async () => undefined,
    ) {}

    /** Adds one dialog message to the current conversation. Returns true when a new conversation started. */
    record(message: ClaudeChatServerMessage): boolean {
        if (message.type === 'chat.state') {
            if (this.current && message.sessionId) {
                this.current.sessionId = message.sessionId;
                if (message.model) this.current.model = message.model;
                this.scheduleSave();
            }
            return false;
        }
        if (!RECORDED.has(message.type)) return false;

        let created = false;
        if (!this.current) {
            if (message.type !== 'chat.user') return false;
            const now = Date.now();
            const title = titleFrom(message.text || message.attachments?.map(file => file.name).join(', ') || '');
            this.current = { version: 1, id: randomUUID(), title, createdAt: now, updatedAt: now, events: [] };
            created = true;
        }

        const events = this.current.events;
        const last = events[events.length - 1];
        if (message.type === 'chat.text.delta' && last?.type === 'chat.text.delta' && last.id === message.id) {
            events[events.length - 1] = { ...last, text: last.text + message.text };
        } else {
            events.push({ ...message });
            if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
        }
        this.current.updatedAt = Date.now();
        if (message.type === 'chat.result') this.save().catch(() => undefined);
        else this.scheduleSave();
        return created;
    }

    /** Remembers what the user picked for the message just sent. */
    noteRequest(model?: string, effort?: string) {
        if (!this.current) return;
        this.current.requestedModel = model || undefined;
        this.current.effort = effort || undefined;
        this.scheduleSave();
    }

    /** The next message starts a new conversation. */
    async startNew() {
        await this.save();
        this.current = undefined;
    }

    async open(id: string) {
        const conversation = await this.load(id);
        if (!conversation) throw new Error('This conversation is no longer in the history.');
        await this.save();
        this.current = conversation;
        return conversation;
    }

    async load(id: string): Promise<StoredConversation | undefined> {
        if (!isConversationId(id)) return undefined;
        if (this.current?.id === id) return this.current;
        try {
            return parse(await readFile(this.file(id), 'utf8'));
        } catch {
            return undefined;
        }
    }

    async remove(id: string) {
        if (!isConversationId(id)) return;
        const conversation = await this.load(id);
        if (this.current?.id === id) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
            this.current = undefined;
        }
        await rm(this.file(id), { force: true });
        this.summaries?.delete(id);
        if (conversation) await this.removeAttachments(attachmentIds(conversation));
    }

    /** Newest first; includes the current conversation even before it is saved. */
    async list(): Promise<ClaudeChatConversationSummary[]> {
        const byId = new Map(await this.savedSummaries());
        if (this.current) byId.set(this.current.id, summarize(this.current));
        return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async save() {
        clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
        const conversation = this.current;
        if (!conversation) return;
        await this.ensureDir();
        const file = this.file(conversation.id);
        const temp = `${file}.${process.pid}.tmp`;
        try {
            await writeFile(temp, JSON.stringify(conversation));
            await rename(temp, file);
            this.summaries?.set(conversation.id, summarize(conversation));
        } catch (error) {
            this.log(`Could not save chat history: ${(error as Error).message}`);
            await rm(temp, { force: true }).catch(() => undefined);
        }
    }

    /** Deletes the oldest conversations beyond MAX_CONVERSATIONS. */
    async prune() {
        const all = (await this.readAll()).sort((a, b) => b.updatedAt - a.updatedAt);
        for (const conversation of all.slice(MAX_CONVERSATIONS)) {
            if (conversation.id === this.current?.id) continue;
            await rm(this.file(conversation.id), { force: true });
            this.summaries?.delete(conversation.id);
            await this.removeAttachments(attachmentIds(conversation));
        }
    }

    private async savedSummaries() {
        if (!this.summaries) {
            const summaries = new Map<string, ClaudeChatConversationSummary>();
            for (const conversation of await this.readAll()) summaries.set(conversation.id, summarize(conversation));
            this.summaries ??= summaries;
        }
        return this.summaries;
    }

    private scheduleSave() {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.save().catch(() => undefined);
        }, SAVE_DELAY_MS);
        this.saveTimer.unref?.();
    }

    private async readAll() {
        let names: string[];
        try {
            names = await readdir(this.dir);
        } catch {
            return [];
        }
        const conversations: StoredConversation[] = [];
        for (const name of names) {
            if (!name.endsWith('.json') || !isConversationId(name.slice(0, -5))) continue;
            const conversation = parse(await readFile(join(this.dir, name), 'utf8').catch(() => ''));
            if (conversation) conversations.push(conversation);
        }
        return conversations;
    }

    private ensureDir() {
        this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
        return this.ready;
    }

    private file(id: string) {
        return join(this.dir, `${id}.json`);
    }
}
