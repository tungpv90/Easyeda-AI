import type { ClaudeChatEditorContext, ClaudeChatSelectedItem } from '@copilot/shared/types/claude-chat';
import { EDITOR_CONTEXT_LIMITS } from '@copilot/shared/claude-editor-context';

type NamedItem = { name?: string; uuid?: string };

type ProjectItem = NamedItem & {
    page?: NamedItem[];
    schematic?: (NamedItem & { page?: NamedItem[] }) | null;
    pcb?: NamedItem | null;
};

type ProjectInfo = { friendlyName?: string; data?: ProjectItem[] };

type SelectedPrimitive = {
    getState_PrimitiveId?: () => string | undefined;
    getState_PrimitiveType?: () => unknown;
    getState_Designator?: () => string | undefined;
    getState_Name?: () => string | undefined;
    getState_Net?: () => string | undefined;
};

let askToken: number | undefined;
let namesFor: { uuid: string; projectName?: string; documentName?: string } | undefined;
let selectionFor: { key: string; items: ClaudeChatSelectedItem[] } | undefined;

/** "Ask Claude about selection": the open Claude Chat dialog sees the new token with its next context. */
export function requestClaudeAsk() {
    askToken = Date.now();
}

/** Name of a schematic page or PCB in the project tree; a page of a multi-page schematic as "Schematic / Page". */
export function findDocumentName(project: ProjectInfo | undefined, uuid: string): string | undefined {
    const inSchematic = (schematic: NamedItem & { page?: NamedItem[] } | null | undefined) => {
        const pages = schematic?.page ?? [];
        const page = pages.find(item => item.uuid === uuid);
        if (!page) return undefined;
        return pages.length > 1 && schematic?.name ? `${schematic.name} / ${page.name}` : page.name ?? schematic?.name;
    };
    for (const item of project?.data ?? []) {
        if (item.uuid === uuid && item.name) return item.name;
        if (item.pcb?.uuid === uuid) return item.pcb.name;
        const name = inSchematic(item) ?? inSchematic(item.schematic);
        if (name) return name;
    }
    return undefined;
}

function read(getter: (() => unknown) | undefined, owner: unknown) {
    try {
        const value = getter?.call(owner);
        return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    } catch {
        return undefined;
    }
}

function selectedItem(primitive: SelectedPrimitive): ClaudeChatSelectedItem | undefined {
    const id = read(primitive.getState_PrimitiveId, primitive);
    if (!id) return undefined;
    return {
        id,
        type: read(primitive.getState_PrimitiveType, primitive) ?? 'Primitive',
        designator: read(primitive.getState_Designator, primitive),
        name: read(primitive.getState_Name, primitive),
        net: read(primitive.getState_Net, primitive),
    };
}

/** The open document and selection of this EasyEDA window, for the Claude Chat dialog. */
export async function getClaudeChatContext(): Promise<ClaudeChatEditorContext> {
    const context: ClaudeChatEditorContext = { askToken };
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => undefined);
    const isSchematic = document?.documentType === EDMT_EditorDocumentType.SCHEMATIC_PAGE;
    const isPcb = document?.documentType === EDMT_EditorDocumentType.PCB;
    if (!document || (!isSchematic && !isPcb)) return context;

    // The project tree is only read again when another document is opened.
    if (namesFor?.uuid !== document.uuid) {
        const project = await eda.dmt_Project.getCurrentProjectInfo().catch(() => undefined) as ProjectInfo | undefined;
        namesFor = {
            uuid: document.uuid,
            projectName: project?.friendlyName?.trim() || undefined,
            documentName: findDocumentName(project, document.uuid),
        };
    }
    context.projectName = namesFor.projectName;
    context.documentName = namesFor.documentName;
    context.documentType = isSchematic ? 'schematic' : 'pcb';
    context.documentUuid = document.uuid;

    const control = isSchematic ? eda.sch_SelectControl : eda.pcb_SelectControl;
    const ids = await control.getAllSelectedPrimitives_PrimitiveId().catch(() => [] as string[]);
    if (!ids.length) return context;
    // The dialog asks every few seconds; the primitives are only read again when the selection changes.
    const key = `${document.uuid}:${ids.join(',')}`;
    if (selectionFor?.key !== key) {
        const selected = await control.getAllSelectedPrimitives().catch(() => []) as SelectedPrimitive[];
        const items = selected.slice(0, EDITOR_CONTEXT_LIMITS.maxItems)
            .map(selectedItem)
            .filter((item): item is ClaudeChatSelectedItem => item !== undefined);
        selectionFor = { key, items };
    }
    context.selection = { total: ids.length, items: selectionFor.items };
    return context;
}
