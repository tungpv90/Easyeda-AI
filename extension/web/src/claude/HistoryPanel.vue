<template>
  <section class="history">
    <div class="history-head">
      <b>History</b>
      <input v-model="query" type="search" placeholder="Search conversations" />
      <button class="ghost" @click="emit('close')">Close</button>
    </div>
    <div class="history-actions">
      <button :disabled="disabled" @click="emit('new')">New conversation</button>
      <span v-if="busy" class="muted small">Claude is working. Stop it or wait before opening another conversation.</span>
    </div>

    <div class="history-list">
      <template v-for="group in groups" :key="group.label">
        <div class="group-label">{{ group.label }}</div>
        <div v-for="item in group.items" :key="item.id" class="entry" :class="{ current: item.id === currentId }">
          <button class="open" :disabled="busy && item.id !== currentId" @click="emit('open', item.id)">
            <span class="title">{{ item.title }}</span>
            <span class="muted small">
              {{ when(item.updatedAt) }} · {{ item.messageCount }} {{ item.messageCount === 1 ? 'message' : 'messages' }}<template v-if="item.model"> · {{ modelName(item.model) }}</template><template v-if="item.id === currentId"> · open</template>
            </span>
          </button>
          <button
            class="ghost danger remove"
            :disabled="busy && item.id === currentId"
            :title="confirming === item.id ? 'Click again to delete' : 'Delete conversation'"
            @click="remove(item.id)"
          >{{ confirming === item.id ? 'Delete?' : '✕' }}</button>
        </div>
      </template>
      <p v-if="!groups.length" class="muted empty">
        {{ query ? 'No conversation matches your search.' : 'No conversations yet. They are saved here when you send a message.' }}
      </p>
    </div>
    <p class="muted small footnote">Opening a conversation continues it: Claude remembers its earlier messages.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ClaudeChatConversationSummary, ClaudeChatModel } from '@copilot/shared/types/claude-chat';

const props = defineProps<{
  conversations: ClaudeChatConversationSummary[];
  currentId?: string;
  models: ClaudeChatModel[];
  busy: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  (event: 'open', id: string): void;
  (event: 'delete', id: string): void;
  (event: 'new'): void;
  (event: 'close'): void;
}>();

const query = ref('');
const confirming = ref<string>();
let confirmTimer: ReturnType<typeof setTimeout> | undefined;

const DAY_MS = 86_400_000;

function startOfDay(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const groups = computed(() => {
  const text = query.value.trim().toLowerCase();
  const items = props.conversations.filter(item => !text || item.title.toLowerCase().includes(text));
  const today = startOfDay(Date.now());
  const buckets: { label: string; from: number }[] = [
    { label: 'Today', from: today },
    { label: 'Yesterday', from: today - DAY_MS },
    { label: 'Previous 7 days', from: today - 7 * DAY_MS },
    { label: 'Previous 30 days', from: today - 30 * DAY_MS },
    { label: 'Older', from: -Infinity },
  ];
  return buckets
    .map((bucket, index) => ({
      label: bucket.label,
      items: items.filter(item => item.updatedAt >= bucket.from && (index === 0 || item.updatedAt < buckets[index - 1].from)),
    }))
    .filter(group => group.items.length);
});

function when(time: number) {
  const date = new Date(time);
  if (time >= startOfDay(Date.now())) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

/** Claude Code reports the full model ID; show its name when the model list knows it. */
function modelName(id: string) {
  const match = props.models.find(item => item.value && item.resolvedModel === id)
    ?? props.models.find(item => item.resolvedModel === id);
  return match ? match.displayName : id;
}

function remove(id: string) {
  clearTimeout(confirmTimer);
  if (confirming.value === id) {
    confirming.value = undefined;
    emit('delete', id);
    return;
  }
  confirming.value = id;
  confirmTimer = setTimeout(() => { confirming.value = undefined; }, 3_000);
}
</script>

<style scoped>
.history { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.history-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; }
.history-head input { flex: 1; min-width: 0; }
.history-actions { display: flex; align-items: center; gap: 8px; padding: 0 10px 6px; flex-wrap: wrap; }
.history-list { flex: 1; overflow-y: auto; padding: 0 10px 8px; }
.group-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); padding: 10px 2px 4px; }
.entry { display: flex; align-items: stretch; gap: 4px; border: 1px solid transparent; border-radius: 6px; }
.entry:hover { background: var(--panel); }
.entry.current { border-color: var(--accent); background: var(--panel); }
.open {
  flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; text-align: left;
  background: transparent; color: var(--text); border: none; padding: 6px 8px;
}
.title { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.remove { align-self: center; margin-right: 4px; min-width: 28px; }
.empty { padding: 12px 2px; }
.footnote { margin: 0; padding: 6px 10px 8px; border-top: 1px solid var(--border); }
.muted { color: var(--muted); }
.small { font-size: 12px; }
</style>
