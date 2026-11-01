import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeModelsFromClaudeCode, enrichClaudeModel } from '@copilot/shared/claude-models';
import { ChatHistory, MAX_EVENTS, isConversationId } from '../src/chat/history';

async function withDir(run: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'chat-history-'));
    try {
        await run(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test('a conversation starts with the first user message and merges streamed text', () => withDir(async dir => {
    const history = new ChatHistory(dir);
    assert.equal(history.record({ type: 'chat.text.start', id: 'x' }), false, 'nothing is stored before a user message');
    assert.equal(history.current, undefined);

    assert.equal(history.record({ type: 'chat.user', text: '  Check the PCB\nfor DRC errors  ' }), true);
    history.record({ type: 'chat.state', busy: true, sessionId: 'session-1', model: 'claude-opus-5-5' });
    history.record({ type: 'chat.text.start', id: 'm1:0' });
    history.record({ type: 'chat.text.delta', id: 'm1:0', text: 'Hello' });
    history.record({ type: 'chat.text.delta', id: 'm1:0', text: ', world' });
    history.record({ type: 'usage', usage: { fiveHour: 0.1 } });
    history.record({ type: 'chat.result', isError: false });
    history.noteRequest('sonnet', 'high');
    await history.save();

    const current = history.current!;
    assert.equal(current.title, 'Check the PCB for DRC errors');
    assert.equal(current.sessionId, 'session-1');
    assert.equal(current.model, 'claude-opus-5-5');
    assert.equal(current.requestedModel, 'sonnet');
    assert.equal(current.effort, 'high');
    assert.deepEqual(current.events.map(event => event.type), ['chat.user', 'chat.text.start', 'chat.text.delta', 'chat.result']);
    assert.deepEqual(current.events[2], { type: 'chat.text.delta', id: 'm1:0', text: 'Hello, world' });

    const reopened = new ChatHistory(dir);
    const [summary] = await reopened.list();
    assert.equal(summary.id, current.id);
    assert.equal(summary.messageCount, 1);
    const loaded = await reopened.open(current.id);
    assert.equal(loaded.sessionId, 'session-1');
    assert.equal(reopened.current?.id, current.id);
}));

test('starting a new conversation keeps the previous one in the list', () => withDir(async dir => {
    const history = new ChatHistory(dir);
    history.record({ type: 'chat.user', text: 'first' });
    const firstId = history.current!.id;
    await history.startNew();
    assert.equal(history.current, undefined);
    history.record({ type: 'chat.user', text: 'second' });

    const list = await history.list();
    assert.deepEqual(list.map(item => item.title).sort(), ['first', 'second']);

    await history.remove(firstId);
    assert.deepEqual((await history.list()).map(item => item.title), ['second']);
    assert.equal(await history.load(firstId), undefined);
}));

test('history ignores unknown ids and corrupt files', () => withDir(async dir => {
    const history = new ChatHistory(dir);
    assert.equal(isConversationId('../secret'), false);
    assert.equal(await history.load('../secret'), undefined);
    await assert.rejects(history.open('../secret'));
    await writeFile(join(dir, '00000000-0000-4000-8000-000000000000.json'), '{not json');
    await writeFile(join(dir, 'notes.txt'), 'hello');
    assert.deepEqual(await history.list(), []);
}));

test('long conversations keep only the newest events', () => withDir(async dir => {
    const history = new ChatHistory(dir);
    history.record({ type: 'chat.user', text: 'start' });
    for (let index = 0; index < MAX_EVENTS + 10; index++) history.record({ type: 'chat.tool', id: `t${index}`, name: 'tool', summary: '' });
    assert.equal(history.current!.events.length, MAX_EVENTS);
    await history.save();
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(await readFile(join(dir, files[0]), 'utf8')).events.length, MAX_EVENTS);
}));

test('Claude Code model list is converted and enriched with specs', () => {
    const models = claudeModelsFromClaudeCode([
        {
            value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)',
            description: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'high'],
        },
        { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
        { displayName: 'no value' },
    ]);
    assert.equal(models.length, 2);
    assert.equal(models[0].value, '', 'default maps to no --model flag');
    assert.deepEqual(models[0].effortLevels, ['low', 'high']);
    assert.equal(models[0].contextWindow, 1_000_000);
    assert.equal(models[0].inputPricePerMTok, 4);
    assert.equal(models[0].legacy, false);
    assert.equal(models[1].legacy, true);
    assert.equal(models[1].contextWindow, 200_000, 'date snapshot suffix is ignored');
    assert.equal(models[1].effortLevels, undefined);
    assert.deepEqual(claudeModelsFromClaudeCode('nope'), []);
    assert.equal(enrichClaudeModel({ value: 'x', displayName: 'Unknown' }).contextWindow, undefined);
});
