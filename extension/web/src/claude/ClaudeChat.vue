<template>
  <div class="claude-chat">
    <header class="bar">
      <div class="title">
        <span class="dot" :class="connectionClass" :title="connectionLabel"></span>
        <strong>Claude</strong>
        <span v-if="account?.loggedIn" class="muted account" :title="account.email">
          {{ account.email }}<template v-if="account.subscriptionType"> · {{ planName }}</template>
        </span>
      </div>
      <div class="actions">
        <span v-if="usageText" class="muted usage" title="Claude subscription usage (5-hour / 7-day window)">{{ usageText }}</span>
        <ModelPicker
          v-if="ready"
          v-model="model"
          v-model:effort="effort"
          :models="models"
          :source="modelsSource"
          :disabled="busy"
          @refresh="requestModels(true)"
        />
        <button class="ghost" :class="{ active: showHistory }" :disabled="!ready" title="Earlier conversations" @click="showHistory = !showHistory">History</button>
        <button class="ghost" :disabled="!ready" title="Start a new conversation" @click="newChat">New</button>
        <button v-if="account?.loggedIn" class="ghost" title="Sign out of Claude Code" @click="logout">Sign out</button>
      </div>
    </header>

    <!-- 1. Helper not reachable -->
    <section v-if="status !== 'connected'" class="panel">
      <template v-if="status === 'blocked'">
        <h3>Allow External Interactions</h3>
        <p>Open <b>Settings → Extensions → Extensions Manager</b>, select EasyEDA Copilot and enable
          <b>External Interactions</b>. Then reopen this dialog.</p>
        <p class="muted small">{{ connectionError }}</p>
      </template>
      <template v-else-if="helperMissing">
        <h3>Claude Chat is not installed on this computer</h3>
        <p>Run <b>ClaudeChatSetup.exe</b> (it comes with this extension) once. This window connects by itself.</p>
        <button @click="reconnect">Retry now</button>
      </template>
      <p v-else class="muted">Connecting to Claude…</p>
    </section>

    <!-- 2. Claude Code missing or not signed in -->
    <section v-else-if="daemonError" class="panel">
      <h3>Claude Code not found</h3>
      <p>Run <b>ClaudeChatSetup.exe</b> again; it installs Claude Code. Then reopen this window.</p>
    </section>

    <section v-else-if="account && !account.loggedIn" class="panel">
      <h3>Sign in with your Claude account</h3>
      <p>Use your Claude Pro or Max subscription. Your sign-in stays in Claude Code on this computer.</p>
      <button v-if="!login.active" @click="startLogin">Sign in with Claude</button>
      <template v-else>
        <p v-if="login.url">A browser window should open. If not,
          <a href="#" @click.prevent="openExternal(login.url)">open the sign-in page</a>.</p>
        <p class="muted small">If the page shows a code, paste it here:</p>
        <div class="row">
          <input v-model="login.code" placeholder="Authentication code" @keydown.enter="sendLoginCode" />
          <button :disabled="!login.code.trim()" @click="sendLoginCode">Submit</button>
          <button class="ghost" @click="cancelLogin">Cancel</button>
        </div>
      </template>
      <p v-if="login.error" class="error small">{{ login.error }}</p>
      <p v-if="account.error" class="muted small">{{ account.error }}</p>
    </section>

    <section v-else-if="!account" class="panel"><p class="muted">Checking Claude sign-in…</p></section>

    <!-- 3. History -->
    <HistoryPanel
      v-else-if="showHistory"
      :conversations="conversations"
      :current-id="currentConversationId"
      :models="models"
      :busy="busy"
      :disabled="!ready"
      @open="openConversation"
      @delete="deleteConversation"
      @new="newChat"
      @close="showHistory = false"
    />

    <!-- 4. Chat -->
    <template v-else>
      <div v-if="noEasyEda" class="notice">
        This EasyEDA window is not connected to the helper yet. It usually connects within a few seconds;
        if not, use <b>Copilot → MCP</b> to restart the connection.
      </div>
      <main ref="scroller" class="messages" @click="onMessagesClick">
        <div v-if="!items.length" class="empty">
          <p><b>Ask Claude to work on your project.</b></p>
          <p class="muted">Examples:</p>
          <button v-for="example in examples" :key="example" class="example" @click="useExample(example)">{{ example }}</button>
        </div>
        <template v-for="item in items" :key="item.key">
          <div v-if="item.kind === 'user'" class="msg user">{{ item.text }}</div>
          <div v-else-if="item.kind === 'assistant' && item.text" class="msg assistant markdown" v-html="render(item.text)"></div>
          <details v-else-if="item.kind === 'tool'" class="tool" :class="item.state">
            <summary>
              <span class="tool-icon">{{ item.state === 'running' ? '⏳' : item.state === 'error' ? '⚠' : '✓' }}</span>
              <code>{{ item.name }}</code>
              <span class="muted small ellipsis">{{ item.summary }}</span>
            </summary>
            <pre v-if="item.preview">{{ item.preview }}</pre>
          </details>
          <div v-else-if="item.kind === 'permission'" class="permission">
            <div><b>Claude wants to use <code>{{ item.toolName }}</code></b></div>
            <div v-if="item.description" class="small">{{ item.description }}</div>
            <div v-if="item.summary" class="muted small ellipsis">{{ item.summary }}</div>
            <div v-if="!item.resolved" class="row">
              <button @click="respond(item, true)">Allow</button>
              <button class="ghost" @click="respond(item, true, true)">Always allow</button>
              <button class="ghost danger" @click="respond(item, false)">Deny</button>
            </div>
            <div v-else class="muted small">{{ item.resolved === 'allow' ? 'Allowed' : 'Denied' }}</div>
          </div>
          <div v-else-if="item.kind === 'error'" class="msg error-msg">{{ item.text }}</div>
        </template>
        <div v-if="busy" class="muted small working">Claude is working…</div>
      </main>

      <footer class="composer">
        <textarea
          ref="inputEl"
          v-model="draft"
          rows="3"
          placeholder="Message Claude (Enter to send, Shift+Enter for a new line)"
          @keydown.enter.exact.prevent="submit"
        ></textarea>
        <button v-if="busy" class="danger" @click="interrupt">Stop</button>
        <button v-else :disabled="!draft.trim()" @click="submit">Send</button>
      </footer>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import DOMPurify from 'dompurify';
import type {
  ClaudeChatAccount,
  ClaudeChatConversationSummary,
  ClaudeChatModel,
  ClaudeChatServerMessage,
  ClaudeChatUsage,
} from '@copilot/shared/types/claude-chat';
import { BUILTIN_CLAUDE_MODELS } from '@copilot/shared/claude-models';
import { markdown } from '../utils/markdown';
import { ChatConnection, openExternal, type ConnectionStatus } from './connection';
import HistoryPanel from './HistoryPanel.vue';
import ModelPicker from './ModelPicker.vue';

type Item =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string }
  | { kind: 'tool'; key: string; name: string; summary: string; state: 'running' | 'ok' | 'error'; preview?: string }
  | { kind: 'permission'; key: string; requestId: string; toolName: string; summary: string; description?: string; resolved?: 'allow' | 'deny' }
  | { kind: 'error'; key: string; text: string };

/** Conversations used to be kept here; the helper stores them now. */
const LEGACY_STORAGE_KEY = 'easyeda-copilot-claude-chat';
const PREFS_KEY = 'easyeda-copilot-claude-chat-prefs';

const examples = [
  'Summarize the schematic on the current page.',
  'Check the PCB for DRC errors and explain the important ones.',
  'Find an LDO that gives 3.3 V at 500 mA from 5 V and add it with its capacitors.',
];

const status = ref<ConnectionStatus>('connecting');
const connectionError = ref<string>();
const daemonError = ref<string>();
const account = ref<ClaudeChatAccount>();
const usage = ref<ClaudeChatUsage>();
const instanceCount = ref<number>();
const busy = ref(false);
const prefs = loadPrefs();
const model = ref(prefs.model);
const effort = ref(prefs.effort);
const models = ref<ClaudeChatModel[]>(BUILTIN_CLAUDE_MODELS);
const modelsSource = ref<'claude-code' | 'builtin'>('builtin');
let modelsRequested = false;
const conversations = ref<ClaudeChatConversationSummary[]>([]);
const currentConversationId = ref<string>();
const showHistory = ref(false);
const draft = ref('');
const helperMissing = ref(false);
const items = ref<Item[]>([]);
const scroller = ref<HTMLElement>();
const inputEl = ref<HTMLTextAreaElement>();
const login = reactive({ active: false, url: '', code: '', error: '' });
let keyCounter = 0;

const ready = computed(() => status.value === 'connected' && account.value?.loggedIn === true);
const noEasyEda = computed(() => instanceCount.value === 0);
const planName = computed(() => {
  const plan = account.value?.subscriptionType ?? '';
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : '';
});
const usageText = computed(() => {
  const value = usage.value;
  if (!value || (value.fiveHour === undefined && value.sevenDay === undefined)) return '';
  const pct = (n?: number) => (n === undefined ? '–' : `${Math.round(n * 100)}%`);
  return `${pct(value.fiveHour)} / ${pct(value.sevenDay)}`;
});
const connectionClass = computed(() => (status.value === 'connected' ? (ready.value ? 'ok' : 'warn') : 'off'));
const connectionLabel = computed(() => ({
  connected: 'Connected to the Claude helper',
  connecting: 'Connecting…',
  disconnected: 'Helper not running',
  blocked: 'External Interactions is off',
}[status.value]));

function nextKey() {
  keyCounter += 1;
  return `${Date.now().toString(36)}-${keyCounter}`;
}

function loadPrefs(): { model: string; effort: string } {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return {
      model: typeof parsed.model === 'string' ? parsed.model : '',
      effort: typeof parsed.effort === 'string' ? parsed.effort : '',
    };
  } catch {
    return { model: '', effort: '' };
  }
}

watch([model, effort], ([modelValue, effortValue]) => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ model: modelValue, effort: effortValue }));
  } catch {
    // Storage can be unavailable; the chat still works.
  }
});

// A model that does not support the chosen effort level runs at its default.
watch([models, model], () => {
  const selected = models.value.find(item => item.value === model.value);
  if (selected && effort.value && !(selected.effortLevels ?? []).includes(effort.value)) effort.value = '';
});

const textBlocks = new Map<string, Item & { kind: 'assistant' }>();
const toolItems = new Map<string, Item & { kind: 'tool' }>();

function push(item: Item) {
  items.value.push(item);
  // Return the reactive proxy so later mutations re-render.
  return items.value[items.value.length - 1];
}

function scrollToBottom() {
  nextTick(() => {
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function handle(message: ClaudeChatServerMessage) {
  apply(message);
  scrollToBottom();
}

function clearItems() {
  items.value = [];
  textBlocks.clear();
  toolItems.clear();
}

/** Shows a stored conversation by replaying its messages. */
function showConversation(message: ClaudeChatServerMessage & { type: 'history.current' }) {
  clearItems();
  currentConversationId.value = message.conversation?.id;
  if (message.conversation) {
    if (message.requestedModel !== undefined) model.value = message.requestedModel;
    if (message.effort !== undefined) effort.value = message.effort;
  }
  for (const event of message.events) apply(event);
  if (!busy.value) {
    // Left over from a helper that stopped mid-turn; they can no longer finish.
    for (const item of items.value) {
      if (item.kind === 'permission' && !item.resolved) item.resolved = 'deny';
      if (item.kind === 'tool' && item.state === 'running') item.state = 'error';
    }
  }
}

function requestModels(refresh = false) {
  modelsRequested = true;
  connection.send({ type: 'models.list', refresh });
}

function apply(message: ClaudeChatServerMessage) {
  switch (message.type) {
    case 'hello':
      daemonError.value = message.error;
      break;
    case 'auth.status':
      account.value = message.account;
      if (message.account.loggedIn) {
        login.active = false;
        if (!modelsRequested) requestModels();
      } else {
        modelsRequested = false;
      }
      break;
    case 'models':
      if (message.models.length) models.value = message.models;
      modelsSource.value = message.source;
      break;
    case 'history.list':
      conversations.value = message.conversations;
      currentConversationId.value = message.currentId;
      break;
    case 'history.current':
      showConversation(message);
      break;
    case 'auth.login.output':
      if (message.url) {
        login.url = message.url;
        openExternal(message.url);
      }
      break;
    case 'auth.login.done':
      login.active = false;
      login.code = '';
      login.error = message.ok ? '' : (message.error ?? 'Sign-in failed.');
      break;
    case 'chat.state':
      busy.value = message.busy;
      break;
    case 'chat.user':
      push({ kind: 'user', key: nextKey(), text: message.text });
      break;
    case 'chat.text.start': {
      const item = push({ kind: 'assistant', key: nextKey(), text: '' }) as Item & { kind: 'assistant' };
      textBlocks.set(message.id, item);
      break;
    }
    case 'chat.text.delta': {
      const item = textBlocks.get(message.id);
      if (item) item.text += message.text;
      break;
    }
    case 'chat.tool': {
      const item = push({ kind: 'tool', key: nextKey(), name: message.name, summary: message.summary, state: 'running' }) as Item & { kind: 'tool' };
      toolItems.set(message.id, item);
      break;
    }
    case 'chat.tool.result': {
      const item = toolItems.get(message.id);
      if (item) {
        item.state = message.isError ? 'error' : 'ok';
        item.preview = message.preview;
      }
      break;
    }
    case 'chat.permission':
      if (!items.value.some(item => item.kind === 'permission' && item.requestId === message.requestId)) {
        push({ kind: 'permission', key: nextKey(), requestId: message.requestId, toolName: message.toolName, summary: message.summary, description: message.description });
      }
      break;
    case 'chat.permission.resolved':
      for (const item of items.value) {
        if (item.kind === 'permission' && item.requestId === message.requestId && !item.resolved) {
          item.resolved = message.allow ? 'allow' : 'deny';
        }
      }
      break;
    case 'chat.result':
      for (const item of toolItems.values()) if (item.state === 'running') item.state = message.isError ? 'error' : 'ok';
      if (message.isError && message.error) {
        push({ kind: 'error', key: nextKey(), text: friendlyError(message.error) });
        if (/log ?in|auth|api key|credential/i.test(message.error)) connection.send({ type: 'auth.status' });
      }
      break;
    case 'chat.error':
      push({ kind: 'error', key: nextKey(), text: message.message });
      break;
    case 'usage':
      usage.value = message.usage;
      break;
    case 'easyeda.instances':
      instanceCount.value = message.count;
      break;
    default:
      break;
  }
}

function friendlyError(error: string) {
  if (/rate|limit|usage/i.test(error)) return `Claude usage limit reached: ${error}`;
  return error;
}

const connection = new ChatConnection(handle, (value, error) => {
  status.value = value;
  connectionError.value = error;
  // Once a connection attempt has failed, keep the install hint up until the helper answers.
  if (value === 'disconnected') helperMissing.value = true;
  if (value === 'connected') helperMissing.value = false;
  if (value !== 'connected') {
    busy.value = false;
    // A restarted helper may run a different Claude Code; ask again.
    modelsRequested = false;
  }
});

function render(text: string) {
  return DOMPurify.sanitize(markdown(text));
}

function onMessagesClick(event: MouseEvent) {
  const anchor = (event.target as HTMLElement | null)?.closest('a');
  if (!anchor) return;
  event.preventDefault();
  openExternal(anchor.href);
}

function submit() {
  const text = draft.value.trim();
  if (!text || busy.value || !ready.value) return;
  draft.value = '';
  connection.send({ type: 'chat.send', text, model: model.value || undefined, effort: effort.value || undefined });
}

function useExample(text: string) {
  draft.value = text;
  inputEl.value?.focus();
}

function interrupt() {
  connection.send({ type: 'chat.interrupt' });
}

function newChat() {
  connection.send({ type: 'chat.new' });
  clearItems();
  currentConversationId.value = undefined;
  showHistory.value = false;
}

function openConversation(id: string) {
  showHistory.value = false;
  if (id !== currentConversationId.value) connection.send({ type: 'history.open', id });
}

function deleteConversation(id: string) {
  connection.send({ type: 'history.delete', id });
}

function respond(item: Item & { kind: 'permission' }, allow: boolean, always = false) {
  item.resolved = allow ? 'allow' : 'deny';
  connection.send({ type: 'permission.respond', requestId: item.requestId, allow, always });
}

function startLogin() {
  login.active = true;
  login.url = '';
  login.error = '';
  connection.send({ type: 'auth.login' });
}

function sendLoginCode() {
  if (!login.code.trim()) return;
  connection.send({ type: 'auth.login.input', text: login.code });
  login.code = '';
}

function cancelLogin() {
  connection.send({ type: 'auth.login.cancel' });
  login.active = false;
}

function logout() {
  connection.send({ type: 'auth.logout' });
}

function reconnect() {
  connection.connect();
}


onMounted(() => {
  connection.connect();
  scrollToBottom();
});
onUnmounted(() => connection.dispose());
</script>

<style>
:root {
  --bg: #ffffff;
  --panel: #f6f6f4;
  --border: #e2e1dc;
  --text: #1f1e1c;
  --muted: #6f6d66;
  --accent: #c96442;
  --accent-text: #ffffff;
  --user: #efeee9;
  --ok: #3c8c5a;
  --warn: #c99a2e;
  --off: #b9b7b0;
  --error: #b3261e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1f1e1c;
    --panel: #2a2926;
    --border: #3a3935;
    --text: #ecebe6;
    --muted: #a3a199;
    --user: #34332f;
    --error: #f28b82;
  }
}
html, body, #app { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 13px/1.5 'Segoe UI', system-ui, sans-serif; }
/* Shared by the chat, model picker and history panel. */
textarea, input, select { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
select { padding: 2px 4px; }
button { font: inherit; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-text); border-radius: 6px; padding: 5px 12px; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
button.ghost { background: transparent; color: var(--text); border-color: var(--border); padding: 3px 8px; }
button.ghost.active { border-color: var(--accent); color: var(--accent); }
button.danger { background: var(--error); border-color: var(--error); color: #fff; }
button.ghost.danger { background: transparent; color: var(--error); border-color: var(--error); }
a { color: var(--accent); }
</style>

<style scoped>
.claude-chat { display: flex; flex-direction: column; height: 100vh; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.account { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--off); flex-shrink: 0; }
.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.usage { font-size: 11px; margin-right: 4px; }
.panel { padding: 16px; overflow: auto; }
.panel h3 { margin: 0 0 8px; font-size: 15px; }
.panel p, .panel li { margin: 6px 0; }
.panel ol { padding-left: 20px; }
.notice { margin: 8px 10px 0; padding: 6px 8px; border-radius: 6px; background: var(--panel); border: 1px solid var(--border); font-size: 12px; }
.row { display: flex; gap: 6px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
.row input { flex: 1; min-width: 120px; }
.messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.empty { margin: auto 0; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.empty p { margin: 0; }
.example { text-align: left; background: var(--panel); color: var(--text); border: 1px solid var(--border); }
.msg { padding: 8px 10px; border-radius: 8px; overflow-wrap: anywhere; }
.msg.user { align-self: flex-end; max-width: 85%; background: var(--user); white-space: pre-wrap; }
.msg.assistant { padding: 0 2px; }
.msg.assistant :deep(p) { margin: 4px 0; }
.msg.assistant :deep(pre) { overflow-x: auto; }
.error-msg { color: var(--error); background: var(--panel); border: 1px solid var(--border); white-space: pre-wrap; }
.tool { border: 1px solid var(--border); border-radius: 6px; background: var(--panel); font-size: 12px; }
.tool summary { display: flex; align-items: center; gap: 6px; padding: 4px 8px; cursor: pointer; list-style: none; min-width: 0; }
.tool summary::-webkit-details-marker { display: none; }
.tool.error { border-color: var(--error); }
.tool pre { margin: 0; padding: 6px 8px; border-top: 1px solid var(--border); max-height: 200px; overflow: auto; white-space: pre-wrap; font-size: 11px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.permission { border: 1px solid var(--accent); border-radius: 8px; padding: 8px 10px; background: var(--panel); }
.working { padding-left: 2px; }
.composer { display: flex; gap: 6px; align-items: flex-end; padding: 8px 10px; border-top: 1px solid var(--border); }
.composer textarea { flex: 1; resize: none; }
.error { color: var(--error); }
</style>
