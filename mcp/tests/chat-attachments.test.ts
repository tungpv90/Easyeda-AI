import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ATTACHMENT_LIMITS, classifyAttachment } from '@copilot/shared/claude-attachments';
import { AttachmentStore, publicAttachment, safeFileName, userMessageContent } from '../src/chat/attachments';
import { ChatHistory } from '../src/chat/history';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

async function withDir(run: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'chat-attachments-'));
    try {
        await run(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

async function upload(store: AttachmentStore, uploadId: string, name: string, mediaType: string, data: Buffer) {
    store.begin({ uploadId, name, mediaType, size: data.length });
    const chunk = ATTACHMENT_LIMITS.chunkBytes;
    for (let offset = 0, index = 0; offset < data.length; offset += chunk, index++) {
        store.chunk(uploadId, index, data.subarray(offset, offset + chunk).toString('base64'));
    }
    return store.end(uploadId);
}

test('attachment types are recognised by media type or extension', () => {
    assert.deepEqual(classifyAttachment('photo.JPG', ''), { kind: 'image', mediaType: 'image/jpeg' });
    assert.deepEqual(classifyAttachment('x', 'image/webp'), { kind: 'image', mediaType: 'image/webp' });
    assert.deepEqual(classifyAttachment('LM317.pdf', ''), { kind: 'pdf', mediaType: 'application/pdf' });
    assert.equal(classifyAttachment('board.net', '')?.kind, 'text');
    assert.equal(classifyAttachment('notes', 'text/markdown')?.kind, 'text');
    assert.equal(classifyAttachment('setup.exe', 'application/octet-stream'), undefined);
    assert.equal(classifyAttachment('picture.svg', 'image/svg+xml'), undefined);
});

test('file names cannot escape the attachment folder', () => {
    assert.equal(safeFileName('../../etc/passwd'), 'passwd');
    assert.equal(safeFileName('C:\\Users\\x\\Sơ đồ mạch.pdf'), 'Sơ đồ mạch.pdf');
    assert.equal(safeFileName('..'), 'attachment');
    assert.equal(safeFileName('a<b>:c?.txt'), 'a_b__c_.txt');
});

test('an upload in several chunks is saved and handed to one message', () => withDir(async dir => {
    const store = new AttachmentStore(dir);
    const big = Buffer.concat([PDF, Buffer.alloc(ATTACHMENT_LIMITS.chunkBytes * 2, 0x20)]);
    const pdf = await upload(store, 'upload-0001', 'datasheet.pdf', 'application/pdf', big);
    assert.equal(pdf.kind, 'pdf');
    assert.deepEqual(await readFile(pdf.path), big);
    assert.equal('path' in publicAttachment(pdf), false, 'the dialog never sees the local path');

    assert.deepEqual(store.take([pdf.id]).map(file => file.id), [pdf.id]);
    assert.throws(() => store.take([pdf.id]), /no longer available/, 'a file belongs to one message');
    store.restore([pdf]);
    assert.equal(store.take([pdf.id]).length, 1);
}));

test('uploads are checked for order, size and content', () => withDir(async dir => {
    const store = new AttachmentStore(dir);
    assert.throws(() => store.begin({ uploadId: 'bad id!', name: 'a.png', mediaType: 'image/png', size: 4 }), /Invalid upload id/);
    assert.throws(() => store.begin({ uploadId: 'upload-0002', name: 'tool.exe', mediaType: '', size: 4 }), /cannot be attached/);
    assert.throws(
        () => store.begin({ uploadId: 'upload-0003', name: 'huge.png', mediaType: 'image/png', size: ATTACHMENT_LIMITS.imageBytes + 1 }),
        /limit/,
    );

    store.begin({ uploadId: 'upload-0004', name: 'a.png', mediaType: 'image/png', size: PNG.length });
    assert.throws(() => store.chunk('upload-0004', 1, PNG.toString('base64')), /out of order/);

    await assert.rejects(upload(store, 'upload-0005', 'fake.png', 'image/png', Buffer.from('not an image at all')), /valid IMAGE/);
    await assert.rejects(upload(store, 'upload-0006', 'binary.txt', 'text/plain', Buffer.from([0x41, 0x00, 0x42])), /UTF-8/);

    store.begin({ uploadId: 'upload-0007', name: 'short.pdf', mediaType: 'application/pdf', size: PDF.length + 10 });
    store.chunk('upload-0007', 0, PDF.toString('base64'));
    await assert.rejects(store.end('upload-0007'), /not uploaded completely/);
}));

test('discarded files are deleted', () => withDir(async dir => {
    const store = new AttachmentStore(dir);
    const image = await upload(store, 'upload-0008', 'shot.png', 'image/png', PNG);
    await store.discard(image.id);
    assert.equal(existsSync(image.path), false);
    assert.throws(() => store.take([image.id]), /no longer available/);
}));

test('the user message carries images, PDFs and text inline and lists every file', () => withDir(async dir => {
    const store = new AttachmentStore(dir);
    const image = await upload(store, 'upload-0009', 'board.png', 'image/png', PNG);
    const pdf = await upload(store, 'upload-0010', 'ldo.pdf', 'application/pdf', PDF);
    const text = await upload(store, 'upload-0011', 'netlist.net', '', Buffer.from('R1 1 2 10k\n'));
    const large = await upload(store, 'upload-0012', 'log.txt', 'text/plain', Buffer.alloc(ATTACHMENT_LIMITS.textInlineBytes + 1, 0x61));

    const content = await userMessageContent('Check these', [image, pdf, text, large]);
    assert.deepEqual(content.map(block => block.type), ['image', 'document', 'text', 'text']);
    assert.equal((content[0].source as { data: string }).data, PNG.toString('base64'));
    assert.match(String(content[2].text), /<attached_file name="netlist.net">\nR1 1 2 10k/);
    const note = String(content[3].text);
    assert.match(note, /^Check these\n\nAttached files, in order, saved locally:/);
    for (const file of [image, pdf, text, large]) assert.ok(note.includes(file.path));
    assert.match(note, /log\.txt .*too large to include; read it with the Read tool/);

    const onlyFiles = await userMessageContent('', [pdf]);
    assert.match(String(onlyFiles[1].text), /^Attached files/);
}));

test('deleting a conversation deletes its attached files', () => withDir(async dir => {
    const removed: string[] = [];
    const history = new ChatHistory(dir, undefined, async ids => { removed.push(...ids); });
    history.record({
        type: 'chat.user',
        text: '',
        attachments: [{ id: '11111111-1111-4111-8111-111111111111', name: 'schematic.png', mediaType: 'image/png', size: 10, kind: 'image' }],
    });
    const id = history.current!.id;
    assert.equal(history.current!.title, 'schematic.png', 'a message with only files is named after them');
    await history.save();
    await history.remove(id);
    assert.deepEqual(removed, ['11111111-1111-4111-8111-111111111111']);
}));
