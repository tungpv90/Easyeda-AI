import type { ClaudeChatAttachmentKind } from './types/claude-chat';

const KB = 1024;
const MB = 1024 * KB;

export const ATTACHMENT_LIMITS = {
    /** Files per message. */
    maxFiles: 10,
    /** Claude's API accepts images up to 5 MB; the dialog shrinks larger ones first. */
    imageBytes: 5 * MB,
    pdfBytes: 32 * MB,
    textBytes: 2 * MB,
    /** Larger PDFs and text files are not sent inline; Claude reads them from disk instead. */
    pdfInlineBytes: 10 * MB,
    textInlineBytes: 200 * KB,
    /** All inline files of one message together (the API request limit is 32 MB). */
    inlineBudgetBytes: 20 * MB,
    /** Upload chunk before base64 encoding. */
    chunkBytes: 192 * KB,
    /** data: URL preview shown in the dialog and kept in the history. */
    thumbnailChars: 120 * KB,
} as const;

export const IMAGE_MEDIA_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
};

/** Plain-text formats that are useful in electronics work. */
export const TEXT_EXTENSIONS = [
    'txt', 'md', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'log',
    'net', 'cir', 'sp', 'spice', 'lib', 'mod', 'asc', 'kicad_sch', 'kicad_pcb',
    'c', 'h', 'cpp', 'hpp', 'ino', 'py', 'js', 'ts', 'html', 'htm',
];

/** For a file picker's accept list, e.g. `.png,.pdf,...`. */
export const ATTACHMENT_EXTENSIONS = [...Object.keys(IMAGE_MEDIA_TYPES), 'pdf', ...TEXT_EXTENSIONS].map(ext => `.${ext}`);

export function fileExtension(name: string) {
    const match = /\.([A-Za-z0-9_]+)$/.exec(name);
    return match ? match[1].toLowerCase() : '';
}

/** Decides how a file is sent to Claude, or undefined when it is not supported. */
export function classifyAttachment(name: string, mediaType = ''): { kind: ClaudeChatAttachmentKind; mediaType: string } | undefined {
    const ext = fileExtension(name);
    const type = mediaType.toLowerCase().split(';')[0].trim();
    if (Object.values(IMAGE_MEDIA_TYPES).includes(type)) return { kind: 'image', mediaType: type };
    if (IMAGE_MEDIA_TYPES[ext] && (!type || type.startsWith('image/'))) return { kind: 'image', mediaType: IMAGE_MEDIA_TYPES[ext] };
    if (type === 'application/pdf' || ext === 'pdf') return { kind: 'pdf', mediaType: 'application/pdf' };
    if (type.startsWith('text/') || TEXT_EXTENSIONS.includes(ext) || type === 'application/json' || type === 'application/xml') {
        return { kind: 'text', mediaType: type || 'text/plain' };
    }
    return undefined;
}

export function attachmentSizeLimit(kind: ClaudeChatAttachmentKind) {
    if (kind === 'image') return ATTACHMENT_LIMITS.imageBytes;
    if (kind === 'pdf') return ATTACHMENT_LIMITS.pdfBytes;
    return ATTACHMENT_LIMITS.textBytes;
}

export function formatBytes(bytes: number) {
    if (bytes >= MB) return `${+(bytes / MB).toFixed(1)} MB`;
    if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
    return `${bytes} B`;
}
