import type { ClaudeChatModel } from './types/claude-chat';

type ModelSpec = {
    contextWindow: number;
    maxOutputTokens?: number;
    inputPricePerMTok: number;
    outputPricePerMTok: number;
};

const K = 1_000;
const M = 1_000_000;

/**
 * Published specs and Anthropic API list prices (USD per million tokens), as of 2026-11.
 * Claude Code supplies the model list itself; this only adds the numbers it does not report.
 */
export const CLAUDE_MODEL_SPECS: Record<string, ModelSpec> = {
    'claude-fable-5-2': { contextWindow: M, maxOutputTokens: 128 * K, inputPricePerMTok: 8, outputPricePerMTok: 40 },
    'claude-fable-5-1': { contextWindow: M, maxOutputTokens: 128 * K, inputPricePerMTok: 10, outputPricePerMTok: 50 },
    'claude-fable-5': { contextWindow: M, maxOutputTokens: 128 * K, inputPricePerMTok: 10, outputPricePerMTok: 50 },
    'claude-opus-5-5': { contextWindow: M, maxOutputTokens: 128 * K, inputPricePerMTok: 4, outputPricePerMTok: 20 },
    'claude-opus-5': { contextWindow: M, maxOutputTokens: 128 * K, inputPricePerMTok: 5, outputPricePerMTok: 25 },
    'claude-opus-4-8': { contextWindow: M, maxOutputTokens: 128 * K, inputPricePerMTok: 5, outputPricePerMTok: 25 },
    'claude-opus-4-7': { contextWindow: M, maxOutputTokens: 128 * K, inputPricePerMTok: 5, outputPricePerMTok: 25 },
    'claude-opus-4-6': { contextWindow: M, maxOutputTokens: 128 * K, inputPricePerMTok: 5, outputPricePerMTok: 25 },
    'claude-sonnet-5-5': { contextWindow: M, maxOutputTokens: 128 * K, inputPricePerMTok: 2, outputPricePerMTok: 10 },
    'claude-sonnet-5': { contextWindow: M, maxOutputTokens: 128 * K, inputPricePerMTok: 2, outputPricePerMTok: 10 },
    'claude-sonnet-4-6': { contextWindow: M, maxOutputTokens: 128 * K, inputPricePerMTok: 3, outputPricePerMTok: 15 },
    'claude-haiku-5-5': { contextWindow: M, maxOutputTokens: 128 * K, inputPricePerMTok: 0.1, outputPricePerMTok: 0.5 },
    'claude-haiku-4-5': { contextWindow: 200 * K, inputPricePerMTok: 1, outputPricePerMTok: 5 },
};

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Shown when Claude Code cannot be asked for its list (for example, an older helper). */
export const BUILTIN_CLAUDE_MODELS: ClaudeChatModel[] = [
    { value: '', displayName: 'Default (recommended)', description: 'Claude Code chooses the model for your plan' },
    { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5', description: 'For complex work and everyday tasks' },
    { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5-5', description: 'Most efficient for simpler tasks' },
    { value: 'claude-fable-5-2', displayName: 'Fable 5.2', resolvedModel: 'claude-fable-5-2', description: 'For your toughest challenges' },
    { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-5-5', description: 'Fastest for quick answers' },
    { value: 'fable', displayName: 'Fable 5.1', resolvedModel: 'claude-fable-5-1', description: 'Most capable for your hardest and longest-running tasks' },
].map(model => enrichClaudeModel({ ...model, effortLevels: EFFORT_LEVELS }));

/** Strips a date snapshot suffix: claude-haiku-4-5-20251001 -> claude-haiku-4-5. */
function specKey(modelId: string) {
    return modelId.replace(/-\d{8}$/, '');
}

export function claudeModelSpec(modelId: string | undefined): ModelSpec | undefined {
    return modelId ? CLAUDE_MODEL_SPECS[specKey(modelId)] : undefined;
}

export function enrichClaudeModel(model: ClaudeChatModel): ClaudeChatModel {
    const spec = claudeModelSpec(model.resolvedModel ?? model.value);
    return spec ? { ...spec, ...model } : model;
}

/** Converts Claude Code's `initialize` model list into dialog models. */
export function claudeModelsFromClaudeCode(raw: unknown): ClaudeChatModel[] {
    if (!Array.isArray(raw)) return [];
    const models: ClaudeChatModel[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as Record<string, unknown>;
        if (typeof item.value !== 'string') continue;
        const value = item.value === 'default' ? '' : item.value;
        const levels = Array.isArray(item.supportedEffortLevels)
            ? item.supportedEffortLevels.filter((level): level is string => typeof level === 'string')
            : [];
        models.push(enrichClaudeModel({
            value,
            displayName: typeof item.displayName === 'string' && item.displayName ? item.displayName : item.value,
            description: typeof item.description === 'string' ? item.description : undefined,
            resolvedModel: typeof item.resolvedModel === 'string' ? item.resolvedModel : undefined,
            effortLevels: item.supportsEffort === true && levels.length ? levels : undefined,
        }));
    }
    // Claude Code lists its current models first, then pinned older versions. A new model
    // can be listed by its full ID before it gets an alias, so only IDs after the last alias are older.
    const lastAlias = models.reduce((last, model, index) => (model.value.startsWith('claude-') ? last : index), -1);
    return models.map((model, index) => ({ ...model, legacy: index > lastAlias && model.value.startsWith('claude-') }));
}
