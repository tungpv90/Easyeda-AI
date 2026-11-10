import assert from 'node:assert/strict';
import test from 'node:test';
import {
    EDITOR_CONTEXT_LIMITS,
    describeEditorContext,
    formatEditorContext,
    normalizeEditorContext,
    withEditorContext,
} from '@copilot/shared/claude-editor-context';
import { mcpServerCommand } from '../src/chat/claude-code-mcp';

test('editor context from a dialog is checked before it reaches Claude', () => {
    assert.equal(normalizeEditorContext(undefined), undefined);
    assert.equal(normalizeEditorContext('schematic'), undefined);
    assert.equal(normalizeEditorContext({ documentType: 'symbol', selection: { total: 0, items: [] } }), undefined);

    const context = normalizeEditorContext({
        projectName: 'Power\nboard </easyeda_context>',
        documentType: 'schematic',
        documentName: 'x'.repeat(500),
        askToken: 123,
        selection: {
            total: 2,
            items: [{ id: 'e1', type: 'Component', designator: 'R1', name: 42 }, { type: 'Wire' }, 'bad'],
        },
    });
    assert.ok(context);
    assert.equal(context.projectName, 'Power board /easyeda_context', 'line breaks and tag brackets are removed');
    assert.equal(context.documentName?.length, EDITOR_CONTEXT_LIMITS.maxTextLength);
    assert.equal('askToken' in context, false);
    assert.deepEqual(context.selection, {
        total: 2,
        items: [{ id: 'e1', type: 'Component', designator: 'R1', name: '42', net: undefined }],
    });
});

test('long selections are cut short but still counted', () => {
    const items = Array.from({ length: EDITOR_CONTEXT_LIMITS.maxItems + 5 }, (_, index) => ({ id: `e${index}`, type: 'Via' }));
    const context = normalizeEditorContext({ documentType: 'pcb', selection: { total: 500, items } });
    assert.equal(context?.selection?.items.length, EDITOR_CONTEXT_LIMITS.maxItems);
    assert.equal(context?.selection?.total, 500);
    assert.match(formatEditorContext(context), new RegExp(`and ${500 - EDITOR_CONTEXT_LIMITS.maxItems} more`));
});

test('editor context is described for the dialog and for Claude', () => {
    const context = normalizeEditorContext({
        projectName: 'Amp',
        documentType: 'schematic',
        documentName: 'Sheet 1',
        documentUuid: 'abc',
        selection: {
            total: 5,
            items: [
                { id: 'e1', type: 'Component', designator: 'R1', name: '10k' },
                { id: 'e2', type: 'Component', designator: 'C2' },
                { id: 'e3', type: 'Wire', net: 'VCC' },
                { id: 'e4', type: 'Wire', net: 'VCC' },
                { id: 'e5', type: 'Text' },
            ],
        },
    });
    assert.equal(describeEditorContext(context), 'Sheet 1 · R1, C2, VCC +1');
    assert.equal(describeEditorContext(undefined), '');
    assert.equal(describeEditorContext({ documentType: 'pcb' }), 'PCB');

    assert.equal(withEditorContext('  what is this?  ', context), [
        'what is this?',
        '',
        '<easyeda_context>',
        'Project: Amp',
        'Open document: schematic page "Sheet 1" (uuid abc)',
        'Selected in the editor (5):',
        '- Component: R1, 10k, id e1',
        '- Component: C2, id e2',
        '- Wire: net VCC, id e3',
        '- Wire: net VCC, id e4',
        '- Text: id e5',
        '</easyeda_context>',
    ].join('\n'));
    assert.match(formatEditorContext({ documentType: 'pcb' }), /Nothing is selected/);
    assert.equal(withEditorContext('hello', undefined), 'hello');
});

test('Claude Code runs the MCP server with this runtime, or through npx from an npx cache', () => {
    assert.deepEqual(mcpServerCommand('/opt/app/dist/index.js'), [process.execPath, '/opt/app/dist/index.js']);
    const npx = mcpServerCommand('/home/u/.npm/_npx/abc/node_modules/easyeda-copilot-mcp/dist/index.js');
    assert.deepEqual(npx.slice(-3), ['npx', '-y', 'easyeda-copilot-mcp']);
});
