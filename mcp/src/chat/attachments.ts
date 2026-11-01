import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    ATTACHMENT_LIMITS,
    attachmentSizeLimit,
    classifyAttachment,
    formatBytes,
} from '@copilot/shared/claude-attachments';
import type { ClaudeChatAttachment } from '@copilot/shared/types/claude-chat';

/** An attachment saved by the helper; path never goes to the dialog. */
export type StoredAttachment = ClaudeChatAttachment & { path: string; createdAt: number };

type Upload = {
    uploadId: string;
    name: string;
    kind: ClaudeChatAttachment['kind'];
    mediaType: string;
    size: number;
    thumbnail?: string;
    chunks: Buffer[];
    received: number;
    nextIndex: number;
    startedAt: number;
};

const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THUMBNAIL_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
/** An unfinished upload is dropped after this. */
const UPLOAD_TTL_MS = 10 * 60_000;
/** An uploaded file that was never sent is deleted after this. */
const UNSENT_TTL_MS = 6 * 60 * 60_000;
const MAX_UPLOADS = 20;

export function isAttachmentId(id: unknown): id is string {
    return typeof id === 'string' && ATTACHMENT_ID_PATTERN.test(id);
}

/** Keeps letters (any language), digits and simple punctuation; never a path. */
export function safeFileName(name: string) {
    const base = name.split(/[\\/]/).pop() ?? '';
    const cleaned = base.replace(/[^\p{L}\p{N} ._()+-]/gu, '_').replace(/^[.\s]+/, '').trim().slice(-120);
    return cleaned || 'attachment';
}

/** Checks that the bytes match the declared kind, so Claude gets a usable file. */
export function contentMatches(kind: ClaudeChatAttachment['kind'], mediaType: string, data: Buffer) {
    if (kind === 'pdf') return data.subarray(0, 1024).includes('%PDF-');
    if (kind === 'text') {
        if (data.includes(0)) return false;
        try {
            new TextDecoder('utf-8', { fatal: true }).decode(data);
            return true;
        } catch {
            return false;
        }
    }
    const head = data.subarray(0, 12);
    switch (mediaType) {
        case 'image/png': return head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        case 'image/jpeg': return head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
        case 'image/gif': return head.subarray(0, 4).toString('latin1') === 'GIF8';
        case 'image/webp': return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
        default: return false;
    }
}

/**
 * Receives files from the dialog in acknowledged chunks and saves them under
 * the chat workspace, where Claude Code may also read them with its Read tool.
 */
export class AttachmentStore {
    private readonly uploads = new Map<string, Upload>();
    private readonly unsent = new Map<string, StoredAttachment>();

    constructor(readonly dir: string) {}

    begin(input: { uploadId: string; name: string; mediaType: string; size: number; thumbnail?: string }) {
        this.sweep();
        if (!UPLOAD_ID_PATTERN.test(String(input.uploadId))) throw new Error('Invalid upload id.');
        if (this.uploads.has(input.uploadId)) throw new Error('This upload has already started.');
        if (this.uploads.size >= MAX_UPLOADS) throw new Error('Too many uploads at once.');
        const name = safeFileName(String(input.name ?? ''));
        const kind = classifyAttachment(name, String(input.mediaType ?? ''));
        if (!kind) throw new Error(`${name}: this file type cannot be attached. Use an image (PNG, JPEG, GIF, WebP), a PDF or a text file.`);
        const size = Number(input.size);
        if (!Number.isInteger(size) || size <= 0) throw new Error(`${name} is empty.`);
        const limit = attachmentSizeLimit(kind.kind);
        if (size > limit) throw new Error(`${name} is ${formatBytes(size)}; the limit for this type is ${formatBytes(limit)}.`);
        const thumbnail = typeof input.thumbnail === 'string'
            && input.thumbnail.length <= ATTACHMENT_LIMITS.thumbnailChars
            && THUMBNAIL_PATTERN.test(input.thumbnail) ? input.thumbnail : undefined;
        this.uploads.set(input.uploadId, {
            uploadId: input.uploadId, name, kind: kind.kind, mediaType: kind.mediaType, size, thumbnail,
            chunks: [], received: 0, nextIndex: 0, startedAt: Date.now(),
        });
    }

    /** Returns the number of bytes received so far. */
    chunk(uploadId: string, index: number, data: string) {
        const upload = this.uploads.get(uploadId);
        if (!upload) throw new Error('Unknown upload.');
        if (index !== upload.nextIndex) throw new Error('Upload chunks arrived out of order.');
        const bytes = Buffer.from(String(data ?? ''), 'base64');
        if (!bytes.length || bytes.length > ATTACHMENT_LIMITS.chunkBytes) throw new Error('Invalid upload chunk.');
        if (upload.received + bytes.length > upload.size) throw new Error(`${upload.name} is larger than announced.`);
        upload.chunks.push(bytes);
        upload.received += bytes.length;
        upload.nextIndex += 1;
        return upload.received;
    }

    async end(uploadId: string): Promise<StoredAttachment> {
        const upload = this.uploads.get(uploadId);
        if (!upload) throw new Error('Unknown upload.');
        this.uploads.delete(uploadId);
        if (upload.received !== upload.size) throw new Error(`${upload.name} was not uploaded completely.`);
        const data = Buffer.concat(upload.chunks);
        if (!contentMatches(upload.kind, upload.mediaType, data)) {
            throw new Error(`${upload.name} does not look like a valid ${upload.kind === 'text' ? 'UTF-8 text' : upload.kind.toUpperCase()} file.`);
        }
        const id = randomUUID();
        const folder = join(this.dir, id);
        await mkdir(folder, { recursive: true });
        const path = join(folder, upload.name);
        await writeFile(path, data);
        const attachment: StoredAttachment = {
            id, name: upload.name, mediaType: upload.mediaType, size: upload.size, kind: upload.kind,
            thumbnail: upload.thumbnail, path, createdAt: Date.now(),
        };
        this.unsent.set(id, attachment);
        return attachment;
    }

    cancel(uploadId: string) {
        this.uploads.delete(uploadId);
    }

    /** Hands uploaded files to a message; they then belong to the conversation. */
    take(ids: unknown): StoredAttachment[] {
        if (ids === undefined) return [];
        if (!Array.isArray(ids)) throw new Error('Invalid attachments.');
        if (ids.length > ATTACHMENT_LIMITS.maxFiles) throw new Error(`Attach at most ${ATTACHMENT_LIMITS.maxFiles} files per message.`);
        const attachments = ids.map(id => {
            const attachment = isAttachmentId(id) ? this.unsent.get(id) : undefined;
            if (!attachment) throw new Error('An attached file is no longer available. Remove it and attach it again.');
            return attachment;
        });
        for (const attachment of attachments) this.unsent.delete(attachment.id);
        return attachments;
    }

    /** Puts files back when a message could not be sent. */
    restore(attachments: StoredAttachment[]) {
        for (const attachment of attachments) this.unsent.set(attachment.id, attachment);
    }

    async discard(id: string) {
        const attachment = isAttachmentId(id) ? this.unsent.get(id) : undefined;
        if (!attachment) return;
        this.unsent.delete(id);
        await this.removeFiles([id]);
    }

    /** Deletes the saved files of attachments, e.g. of a deleted conversation. */
    async removeFiles(ids: string[]) {
        for (const id of ids) {
            if (isAttachmentId(id)) await rm(join(this.dir, id), { recursive: true, force: true }).catch(() => undefined);
        }
    }

    private sweep() {
        const now = Date.now();
        for (const [id, upload] of this.uploads) if (now - upload.startedAt > UPLOAD_TTL_MS) this.uploads.delete(id);
        for (const [id, attachment] of this.unsent) {
            if (now - attachment.createdAt > UNSENT_TTL_MS) {
                this.unsent.delete(id);
                this.removeFiles([id]).catch(() => undefined);
            }
        }
    }
}

/** What the dialog may see: everything except the local path. */
export function publicAttachment({ path: _path, createdAt: _createdAt, ...attachment }: StoredAttachment): ClaudeChatAttachment {
    return attachment;
}

const KIND_LABEL = { image: 'image', pdf: 'PDF', text: 'text file' } as const;

/**
 * Builds the user message for Claude Code: images, PDFs and small text files
 * inline, then the text with a list of the saved files. A file that does not
 * fit the inline budget is only listed, and Claude reads it with Read.
 */
export async function userMessageContent(text: string, attachments: StoredAttachment[]) {
    const blocks: Record<string, unknown>[] = [];
    const notes: string[] = [];
    let budget: number = ATTACHMENT_LIMITS.inlineBudgetBytes;
    for (const attachment of attachments) {
        const inlineLimit = attachment.kind === 'pdf'
            ? ATTACHMENT_LIMITS.pdfInlineBytes
            : attachment.kind === 'text' ? ATTACHMENT_LIMITS.textInlineBytes : ATTACHMENT_LIMITS.imageBytes;
        const inline = attachment.size <= inlineLimit && attachment.size <= budget;
        if (inline) {
            budget -= attachment.size;
            const data = await readFile(attachment.path);
            if (attachment.kind === 'image') {
                blocks.push({ type: 'image', source: { type: 'base64', media_type: attachment.mediaType, data: data.toString('base64') } });
            } else if (attachment.kind === 'pdf') {
                blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } });
            } else {
                blocks.push({ type: 'text', text: `<attached_file name="${attachment.name}">\n${data.toString('utf8')}\n</attached_file>` });
            }
        }
        notes.push(`- ${attachment.name} (${KIND_LABEL[attachment.kind]}, ${formatBytes(attachment.size)}): ${attachment.path}${inline ? '' : ' (too large to include; read it with the Read tool)'}`);
    }
    const parts = [text.trim()];
    if (notes.length) parts.push(`Attached files, in order, saved locally:\n${notes.join('\n')}`);
    blocks.push({ type: 'text', text: parts.filter(Boolean).join('\n\n') });
    return blocks;
}
