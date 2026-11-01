<template>
  <div ref="root" class="model-picker">
    <button class="ghost picker-button" :disabled="disabled" :title="buttonTitle" @click="open = !open">
      <span class="ellipsis">{{ currentLabel }}<template v-if="effort"> · {{ effortLabel(effort) }}</template></span>
      <span class="caret">▾</span>
    </button>

    <div v-if="open" class="picker-panel">
      <template v-for="section in sections" :key="section.key">
        <button v-if="section.key === 'legacy' && !showLegacy" class="link-button small" @click="showLegacy = true">
          Show older versions ({{ section.items.length }})
        </button>
        <template v-else>
          <div class="group-label">{{ section.label }}</div>
          <button
            v-for="item in section.items"
            :key="item.value || 'default'"
            class="model-row"
            :class="{ selected: item.value === modelValue }"
            @click="choose(item)"
          >
            <div class="row-head">
              <span class="check">{{ item.value === modelValue ? '✓' : '' }}</span>
              <b>{{ item.displayName }}</b>
              <span v-if="item.description" class="muted small ellipsis">{{ item.description }}</span>
            </div>
            <div class="specs muted small">
              <code v-if="item.resolvedModel">{{ item.resolvedModel }}</code>
              <span v-if="item.contextWindow">{{ tokens(item.contextWindow) }} context</span>
              <span v-if="item.maxOutputTokens">{{ tokens(item.maxOutputTokens) }} output</span>
              <span v-if="item.inputPricePerMTok !== undefined && item.outputPricePerMTok !== undefined">
                API {{ price(item.inputPricePerMTok) }} / {{ price(item.outputPricePerMTok) }} per 1M tokens
              </span>
            </div>
          </button>
        </template>
      </template>

      <div v-if="effortLevels.length" class="effort">
        <div class="group-label">Effort</div>
        <div class="segmented">
          <button :class="{ on: !effort }" @click="emit('update:effort', '')">Default</button>
          <button
            v-for="level in effortLevels"
            :key="level"
            :class="{ on: effort === level }"
            @click="emit('update:effort', level)"
          >{{ effortLabel(level) }}</button>
        </div>
        <p class="muted small">Higher effort thinks longer before answering and uses your limits faster.</p>
      </div>

      <p class="muted small note">
        Claude Pro and Max plans are not billed per token. The prices are Anthropic API rates for comparison:
        a more expensive model uses up your 5-hour and 7-day limits faster.
        <template v-if="source === 'builtin'"><br />Claude Code could not be asked for your models, so this is the standard list.</template>
        <a href="#" @click.prevent="emit('refresh')">Refresh list</a>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ClaudeChatModel } from '@copilot/shared/types/claude-chat';

const props = defineProps<{
  models: ClaudeChatModel[];
  modelValue: string;
  effort: string;
  source: 'claude-code' | 'builtin';
  disabled?: boolean;
}>();
const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
  (event: 'update:effort', value: string): void;
  (event: 'refresh'): void;
}>();

const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

const root = ref<HTMLElement>();
const open = ref(false);
const showLegacy = ref(false);

const selected = computed(() => props.models.find(item => item.value === props.modelValue));
const effortLevels = computed(() => selected.value?.effortLevels ?? []);
const currentLabel = computed(() => {
  if (!selected.value) return props.modelValue || 'Default';
  // "Default (recommended)" is too long for the header.
  return selected.value.value ? selected.value.displayName : 'Default';
});
const buttonTitle = computed(() => {
  const item = selected.value;
  if (!item) return 'Choose a model';
  return [item.displayName, item.description, item.resolvedModel].filter(Boolean).join(' · ');
});
const sections = computed(() => {
  const current = props.models.filter(item => !item.legacy);
  const legacy = props.models.filter(item => item.legacy);
  const result = [{ key: 'current', label: 'Models', items: current }];
  if (legacy.length) result.push({ key: 'legacy', label: 'Older versions', items: legacy });
  return result;
});

function choose(item: ClaudeChatModel) {
  emit('update:modelValue', item.value);
  if (props.effort && !(item.effortLevels ?? []).includes(props.effort)) emit('update:effort', '');
  if (!item.effortLevels?.length) open.value = false;
}

function effortLabel(level: string) {
  return EFFORT_LABELS[level] ?? level;
}

function tokens(value: number) {
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000)}K`;
}

function price(value: number) {
  return `$${value < 1 ? value.toFixed(2) : +value.toFixed(2)}`;
}

function onDocumentDown(event: MouseEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false;
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') open.value = false;
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentDown);
  document.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentDown);
  document.removeEventListener('keydown', onKey);
});
</script>

<style scoped>
.model-picker { position: relative; min-width: 0; }
.picker-button { display: flex; align-items: center; gap: 4px; max-width: 150px; }
.caret { font-size: 10px; }
.picker-panel {
  position: fixed; top: 38px; left: 8px; right: 8px; z-index: 20;
  max-height: calc(100vh - 56px); overflow-y: auto;
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18); padding: 6px;
  display: flex; flex-direction: column; gap: 2px;
}
.group-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); padding: 6px 6px 2px; }
.model-row {
  display: flex; flex-direction: column; gap: 2px; align-items: stretch; text-align: left;
  background: transparent; color: var(--text); border: 1px solid transparent; border-radius: 6px; padding: 6px;
}
.model-row:hover { background: var(--panel); }
.model-row.selected { border-color: var(--accent); background: var(--panel); }
.row-head { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.check { width: 12px; flex-shrink: 0; color: var(--accent); }
.specs { display: flex; flex-wrap: wrap; gap: 2px 10px; padding-left: 18px; }
.specs code { font-size: 11px; }
.effort { border-top: 1px solid var(--border); margin-top: 4px; padding: 0 6px 4px; }
.effort p { margin: 4px 0 0; }
.segmented { display: flex; flex-wrap: wrap; gap: 4px; }
.segmented button { background: transparent; color: var(--text); border: 1px solid var(--border); padding: 2px 8px; }
.segmented button.on { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.note { border-top: 1px solid var(--border); margin: 4px 0 0; padding: 6px 6px 2px; }
.link-button { background: transparent; border: none; color: var(--accent); text-align: left; padding: 4px 6px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
</style>
