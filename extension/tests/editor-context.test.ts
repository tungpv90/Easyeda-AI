import assert from 'node:assert/strict';
import test from 'node:test';
import { findDocumentName, getClaudeChatContext, requestClaudeAsk } from '../src/eda/editor-context.ts';

type Primitive = Record<string, () => unknown>;

const globals = globalThis as typeof globalThis & {
    eda: Record<string, Record<string, () => Promise<unknown>>>;
    EDMT_EditorDocumentType: { SCHEMATIC_PAGE: number; PCB: number };
};

globals.EDMT_EditorDocumentType = { SCHEMATIC_PAGE: 1, PCB: 2 };

const project = {
    friendlyName: ' Amp ',
    data: [{
        name: 'Board1',
        schematic: { name: 'Main', uuid: 's1', page: [{ name: 'Power', uuid: 'p1' }, { name: 'MCU', uuid: 'p2' }] },
        pcb: { name: 'PCB1', uuid: 'b1' },
    }, { name: 'Single', uuid: 's2', page: [{ name: 'P1', uuid: 'p3' }] }],
};

function primitive(id: string, type: string, extra: Primitive = {}): Primitive {
    return { getState_PrimitiveId: () => id, getState_PrimitiveType: () => type, ...extra };
}

function useEditor(document: { documentType: number; uuid: string } | undefined, selected: Primitive[] = []) {
    const calls = { project: 0, primitives: 0 };
    const control = {
        getAllSelectedPrimitives_PrimitiveId: async () => selected.map(item => item.getState_PrimitiveId?.()),
        getAllSelectedPrimitives: async () => { calls.primitives += 1; return selected; },
    };
    globals.eda = {
        dmt_SelectControl: { getCurrentDocumentInfo: async () => document },
        dmt_Project: { getCurrentProjectInfo: async () => { calls.project += 1; return project; } },
        sch_SelectControl: control,
        pcb_SelectControl: control,
    };
    return calls;
}

test('finds the name of a schematic page or PCB in the project tree', () => {
    assert.equal(findDocumentName(project, 'p2'), 'Main / MCU');
    assert.equal(findDocumentName(project, 'p3'), 'P1', 'a single page needs no schematic prefix');
    assert.equal(findDocumentName(project, 'b1'), 'PCB1');
    assert.equal(findDocumentName(project, 'nope'), undefined);
    assert.equal(findDocumentName(undefined, 'p1'), undefined);
});

test('reports the open schematic page and its selection', async () => {
    const calls = useEditor({ documentType: 1, uuid: 'p1' }, [
        primitive('e1', 'Component', { getState_Designator: () => 'R1', getState_Name: () => '10k' }),
        primitive('e2', 'Wire', { getState_Net: () => 'VCC', getState_Designator: () => { throw new Error('no designator'); } }),
        { getState_PrimitiveType: () => 'Text' },
    ]);
    const context = await getClaudeChatContext();
    assert.equal(context.projectName, 'Amp');
    assert.equal(context.documentType, 'schematic');
    assert.equal(context.documentName, 'Main / Power');
    assert.equal(context.documentUuid, 'p1');
    assert.deepEqual(context.selection, {
        total: 3,
        items: [
            { id: 'e1', type: 'Component', designator: 'R1', name: '10k', net: undefined },
            { id: 'e2', type: 'Wire', designator: undefined, name: undefined, net: 'VCC' },
        ],
    });

    // The dialog polls: an unchanged document and selection are not read again.
    await getClaudeChatContext();
    assert.deepEqual(calls, { project: 1, primitives: 1 });
});

test('reports a PCB without a selection and nothing for other documents', async () => {
    useEditor({ documentType: 2, uuid: 'b1' });
    const pcb = await getClaudeChatContext();
    assert.equal(pcb.documentType, 'pcb');
    assert.equal(pcb.documentName, 'PCB1');
    assert.equal(pcb.selection, undefined);

    useEditor({ documentType: 9, uuid: 'lib' });
    assert.equal((await getClaudeChatContext()).documentType, undefined);
    useEditor(undefined);
    assert.equal((await getClaudeChatContext()).documentType, undefined);
});

test('"Ask Claude about selection" hands the dialog a new token', async () => {
    useEditor(undefined);
    const before = (await getClaudeChatContext()).askToken;
    requestClaudeAsk();
    const after = (await getClaudeChatContext()).askToken;
    assert.equal(typeof after, 'number');
    assert.notEqual(after, before);
});
