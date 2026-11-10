import type { ClaudeChatEditorContext, ClaudeChatSelectedItem } from './types/claude-chat';

export const EDITOR_CONTEXT_LIMITS = {
    /** Selected primitives listed for Claude; the rest are only counted. */
    maxItems: 60,
    maxTextLength: 120,
} as const;

const DOCUMENT_LABEL = { schematic: 'schematic page', pcb: 'PCB' } as const;

function text(value: unknown) {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    // The values are quoted in a prompt; keep them on one line and out of the surrounding tags.
    const clean = String(value).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, EDITOR_CONTEXT_LIMITS.maxTextLength);
    return clean || undefined;
}

/** Checks a context received from a dialog. Returns undefined when nothing usable is left. */
export function normalizeEditorContext(raw: unknown): ClaudeChatEditorContext | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const input = raw as Record<string, unknown>;
    const context: ClaudeChatEditorContext = {
        projectName: text(input.projectName),
        documentType: input.documentType === 'schematic' || input.documentType === 'pcb' ? input.documentType : undefined,
        documentName: text(input.documentName),
        documentUuid: text(input.documentUuid),
    };
    const selection = input.selection as { total?: unknown; items?: unknown } | undefined;
    if (selection && Array.isArray(selection.items)) {
        const items: ClaudeChatSelectedItem[] = [];
        for (const entry of selection.items.slice(0, EDITOR_CONTEXT_LIMITS.maxItems)) {
            if (!entry || typeof entry !== 'object') continue;
            const item = entry as Record<string, unknown>;
            const id = text(item.id);
            if (!id) continue;
            items.push({ id, type: text(item.type) ?? 'Primitive', designator: text(item.designator), name: text(item.name), net: text(item.net) });
        }
        const total = Number.isInteger(selection.total) ? Math.max(selection.total as number, items.length) : items.length;
        if (total > 0) context.selection = { total, items };
    }
    return context.documentType || context.projectName || context.selection ? context : undefined;
}

function itemLabel(item: ClaudeChatSelectedItem) {
    return item.designator ?? item.net ?? item.name ?? item.type;
}

/** Short label for the dialog, e.g. "Sheet 1 · R1, C2 +3". */
export function describeEditorContext(context: ClaudeChatEditorContext | undefined) {
    if (!context) return '';
    const parts: string[] = [];
    const document = context.documentName ?? (context.documentType ? DOCUMENT_LABEL[context.documentType] : undefined);
    if (document) parts.push(document);
    const selection = context.selection;
    if (selection?.total) {
        const names = [...new Set(selection.items.map(itemLabel))];
        const shown = names.slice(0, 3);
        const more = selection.total - selection.items.length + names.length - shown.length;
        parts.push(`${shown.join(', ')}${more > 0 ? ` +${more}` : ''}`);
    }
    return parts.join(' · ');
}

/** The block added to a message for Claude. */
export function formatEditorContext(context: ClaudeChatEditorContext | undefined) {
    if (!context) return '';
    const lines: string[] = [];
    if (context.projectName) lines.push(`Project: ${context.projectName}`);
    if (context.documentType) {
        const name = context.documentName ? ` "${context.documentName}"` : '';
        const uuid = context.documentUuid ? ` (uuid ${context.documentUuid})` : '';
        lines.push(`Open document: ${DOCUMENT_LABEL[context.documentType]}${name}${uuid}`);
    }
    const selection = context.selection;
    if (selection?.total) {
        lines.push(`Selected in the editor (${selection.total}):`);
        for (const item of selection.items) {
            const details = [
                item.designator,
                item.name && item.name !== item.designator ? item.name : undefined,
                item.net ? `net ${item.net}` : undefined,
                `id ${item.id}`,
            ].filter(Boolean).join(', ');
            lines.push(`- ${item.type}: ${details}`);
        }
        if (selection.total > selection.items.length) lines.push(`- ... and ${selection.total - selection.items.length} more`);
    } else if (context.documentType) {
        lines.push('Nothing is selected in the editor.');
    }
    return lines.length ? `<easyeda_context>\n${lines.join('\n')}\n</easyeda_context>` : '';
}

export function withEditorContext(message: string, context: ClaudeChatEditorContext | undefined) {
    return [message.trim(), formatEditorContext(context)].filter(Boolean).join('\n\n');
}
