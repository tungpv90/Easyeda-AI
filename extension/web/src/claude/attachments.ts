import {
    ATTACHMENT_EXTENSIONS,
    ATTACHMENT_LIMITS,
    attachmentSizeLimit,
    classifyAttachment,
    formatBytes,
} from '@copilot/shared/claude-attachments';
import type {
    ClaudeChatAttachment,
    ClaudeChatAttachmentKind,
    ClaudeChatClientMessage,
    ClaudeChatServerMessage,
} from '@copilot/shared/types/claude-chat';

/** A file in the composer, before and after it reaches the helper. */
export type PendingAttachment = {
    key: string;
    uploadId: string;
    name: string;
    kind?: ClaudeChatAttachmentKind;
    size: number;
    thumbnail?: string;
    status: 'preparing' | 'uploading' | 'ready' | 'error';
    progress: number;
    error?: string;
    /** Set when the helper has stored the file. */
    id?: string;
};

export type PreparedFile = {
    data: Blob;
    name: string;
    kind: ClaudeChatAttachmentKind;
    mediaType: string;
    thumbnail?: string;
};

/** Claude works best with images up to this many pixels on the long side. */
const MAX_IMAGE_SIDE = 2576;
const THUMBNAIL_SIDE = 160;
const STEP_TIMEOUT_MS = 30_000;

const hasEda = () => typeof window !== 'undefined' && 'eda' in window;

export function newUploadId() {
    const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return random.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64).padEnd(8, '0');
}

/** Opens EasyEDA's file dialog, or the browser's when running outside EasyEDA. */
export async function pickFiles(): Promise<File[]> {
    if (hasEda()) {
        try {
            const files = await eda.sys_FileSystem.openReadFileDialog(ATTACHMENT_EXTENSIONS, true);
            return files ?? [];
        } catch {
            // Fall back to the browser file picker below.
        }
    }
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = ATTACHMENT_EXTENSIONS.join(',');
        input.addEventListener('change', () => resolve([...(input.files ?? [])]));
        input.addEventListener('cancel', () => resolve([]));
        input.click();
    });
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('The image could not be read.'));
        };
        image.src = url;
    });
}

function drawScaled(image: HTMLImageElement, maxSide: number) {
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The image could not be processed.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))), type, quality);
    });
}

/** Shrinks a photo or screenshot that is too large for Claude, and makes a preview. */
async function prepareImage(file: Blob, mediaType: string) {
    const image = await loadImage(file);
    const thumbnail = drawScaled(image, THUMBNAIL_SIDE).toDataURL('image/jpeg', 0.8);
    const tooLarge = Math.max(image.naturalWidth, image.naturalHeight) > MAX_IMAGE_SIDE;
    const budget = ATTACHMENT_LIMITS.imageBytes * 0.75;
    if (!tooLarge && file.size <= budget) return { data: file, mediaType, thumbnail };
    let side = Math.min(MAX_IMAGE_SIDE, Math.max(image.naturalWidth, image.naturalHeight));
    for (let attempt = 0; attempt < 5; attempt++) {
        const data = await canvasBlob(drawScaled(image, side), 'image/jpeg', 0.88);
        if (data.size <= budget) return { data, mediaType: 'image/jpeg', thumbnail };
        side = Math.round(side * 0.75);
    }
    throw new Error('The image is too large, even after shrinking it.');
}

export function renameForType(name: string, mediaType: string) {
    if (mediaType !== 'image/jpeg' || /\.jpe?g$/i.test(name)) return name;
    return `${name.replace(/\.[^.]*$/, '')}.jpg`;
}

/** Checks the type and size and prepares images; throws a message for the user. */
export async function prepareFile(file: File): Promise<PreparedFile> {
    const name = file.name || 'pasted-image.png';
    const kind = classifyAttachment(name, file.type);
    if (!kind) throw new Error('This file type cannot be attached. Use an image, a PDF or a text file.');
    if (kind.kind === 'image') {
        const image = await prepareImage(file, kind.mediaType);
        return { data: image.data, name: renameForType(name, image.mediaType), kind: 'image', mediaType: image.mediaType, thumbnail: image.thumbnail };
    }
    const limit = attachmentSizeLimit(kind.kind);
    if (file.size > limit) throw new Error(`This file is ${formatBytes(file.size)}; the limit is ${formatBytes(limit)}.`);
    if (!file.size) throw new Error('This file is empty.');
    return { data: file, name, kind: kind.kind, mediaType: kind.mediaType };
}

function toBase64(bytes: Uint8Array) {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
}

type Waiter = {
    expect: 'attachment.ack' | 'attachment.ready';
    resolve: (message: ClaudeChatServerMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

/**
 * Sends files to the helper in chunks, one at a time: each chunk waits for the
 * helper's acknowledgement, so EasyEDA's WebSocket never queues a large file.
 */
export class AttachmentUploader {
    private readonly waiters = new Map<string, Waiter>();

    constructor(private readonly send: (message: ClaudeChatClientMessage) => void) {}

    /** Returns true when the message belonged to an upload. */
    handle(message: ClaudeChatServerMessage) {
        if (message.type !== 'attachment.ack' && message.type !== 'attachment.ready' && message.type !== 'attachment.error') return false;
        const waiter = this.waiters.get(message.uploadId);
        if (!waiter) return true;
        if (message.type === 'attachment.error') this.settle(message.uploadId, undefined, new Error(message.message));
        else if (message.type === waiter.expect) this.settle(message.uploadId, message);
        return true;
    }

    async upload(uploadId: string, file: PreparedFile, onProgress: (fraction: number) => void): Promise<ClaudeChatAttachment> {
        const bytes = new Uint8Array(await file.data.arrayBuffer());
        await this.step(uploadId, 'attachment.ack', {
            type: 'attachment.begin', uploadId, name: file.name, mediaType: file.mediaType, size: bytes.length, thumbnail: file.thumbnail,
        });
        const chunk = ATTACHMENT_LIMITS.chunkBytes;
        for (let offset = 0, index = 0; offset < bytes.length; offset += chunk, index++) {
            const data = toBase64(bytes.subarray(offset, offset + chunk));
            await this.step(uploadId, 'attachment.ack', { type: 'attachment.chunk', uploadId, index, data });
            onProgress(Math.min(1, (offset + chunk) / bytes.length));
        }
        const ready = await this.step(uploadId, 'attachment.ready', { type: 'attachment.end', uploadId });
        return (ready as ClaudeChatServerMessage & { type: 'attachment.ready' }).attachment;
    }

    cancel(uploadId: string) {
        if (!this.waiters.has(uploadId)) return;
        this.settle(uploadId, undefined, new Error('Cancelled.'));
        this.send({ type: 'attachment.cancel', uploadId });
    }

    /** The helper went away; pending uploads cannot finish. */
    failAll(reason: string) {
        for (const uploadId of [...this.waiters.keys()]) this.settle(uploadId, undefined, new Error(reason));
    }

    private step(uploadId: string, expect: Waiter['expect'], message: ClaudeChatClientMessage) {
        return new Promise<ClaudeChatServerMessage>((resolve, reject) => {
            const timer = setTimeout(() => this.settle(uploadId, undefined, new Error('The helper did not answer in time.')), STEP_TIMEOUT_MS);
            this.waiters.set(uploadId, { expect, resolve, reject, timer });
            this.send(message);
        });
    }

    private settle(uploadId: string, message?: ClaudeChatServerMessage, error?: Error) {
        const waiter = this.waiters.get(uploadId);
        if (!waiter) return;
        this.waiters.delete(uploadId);
        clearTimeout(waiter.timer);
        if (error) waiter.reject(error);
        else waiter.resolve(message!);
    }
}
