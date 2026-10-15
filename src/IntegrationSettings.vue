<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { useIntegrations } from './integrations'

const props = defineProps<{ integration: ReturnType<typeof useIntegrations> }>()
const emit = defineEmits<{ close: [] }>()
const { supported, enabled, pending, status, url, token } = props.integration
const message = ref('')
const showToken = ref(false)
const dialog = ref<HTMLElement | null>(null)
const previousFocus = document.activeElement as HTMLElement | null
const endpoint = computed(() => url.value.replace(/\/$/, ''))
const mcpConfig = computed(() => JSON.stringify({
  mcpServers: {
    'shift-schedule-expert': {
      type: 'http',
      url: `${endpoint.value}/mcp`,
      headers: { Authorization: `Bearer ${token.value}` },
    },
  },
}, null, 2))

watch(enabled, () => { showToken.value = false; message.value = '' })

async function toggle() {
  if (!supported || pending.value) return
  message.value = ''
  try {
    if (enabled.value) await props.integration.stop()
    else await props.integration.start()
  } catch (error) {
    message.value = error instanceof Error ? error.message : '操作失败，请重试。'
  }
}

async function copy(value: string, label: string) {
  message.value = ''
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    // Some desktop webviews do not expose the Clipboard API.
    const focused = document.activeElement as HTMLElement | null
    const field = document.createElement('textarea')
    field.value = value
    field.setAttribute('aria-label', '待复制内容')
    field.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;'
    dialog.value?.append(field)
    field.select()
    let copied = false
    try { copied = document.execCommand('copy') } catch { /* Display a copy error below. */ }
    finally { field.remove(); focused?.focus({ preventScroll: true }) }
    if (!copied) { message.value = '复制失败，请重试，或选择地址、显示令牌后手动复制。'; return }
  }
  message.value = `已复制${label}`
}

function controls() {
  return [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])]
    .filter(control => control.getClientRects().length)
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    event.preventDefault()
    emit('close')
  }
  if (event.key !== 'Tab') return
  event.stopPropagation()
  const focusable = controls()
  const first = focusable[0], last = focusable.at(-1)
  if (!first) { event.preventDefault(); dialog.value?.focus(); return }
  const outside = !dialog.value?.contains(document.activeElement)
  if (event.shiftKey && (document.activeElement === first || outside)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && (document.activeElement === last || outside)) { event.preventDefault(); first.focus() }
}

function keepFocus(event: FocusEvent) {
  if (dialog.value && !dialog.value.contains(event.target as Node)) controls()[0]?.focus()
}

let overflow = ''
onMounted(() => {
  overflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  controls()[0]?.focus()
  document.addEventListener('keydown', keydown, true)
  document.addEventListener('focusin', keepFocus)
})
onUnmounted(() => {
  document.body.style.overflow = overflow
  document.removeEventListener('keydown', keydown, true)
  document.removeEventListener('focusin', keepFocus)
  void nextTick(() => { if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }) })
})
</script>

<template>
  <Teleport to="body">
    <div class="sp-overlay" @click.self="emit('close')">
      <section ref="dialog" class="sp-modal integration-settings" role="dialog" aria-modal="true" aria-labelledby="integration-title" tabindex="-1">
        <div class="sp-modal-heading">
          <div><h2 id="integration-title">Setting</h2><p>连接你的 AI 助手</p></div>
          <button type="button" class="sp-icon-button" aria-label="关闭设置" @click="emit('close')">×</button>
        </div>

        <div class="integration-toggle-row" :aria-busy="pending">
          <div>
            <h3 id="integration-mcp-label">MCP</h3>
            <p id="integration-description">允许外部 AI 读取和修改成员、班次及排班数据。</p>
          </div>
          <button type="button" class="integration-switch" role="switch" :aria-checked="enabled" aria-labelledby="integration-mcp-label" aria-describedby="integration-description" :disabled="!supported || pending" @click="toggle">
            <span aria-hidden="true"></span>
          </button>
        </div>
        <p class="integration-status" role="status"><span class="integration-status-dot" :class="{ active: enabled, pending }" aria-hidden="true"></span>{{ supported ? status : '请使用桌面版开启 MCP 服务。' }}</p>

        <div v-if="enabled" class="integration-connection">
          <dl class="integration-details">
            <div>
              <dt>MCP 地址</dt>
              <dd><code>{{ endpoint }}/mcp</code><button type="button" class="sp-button integration-copy" aria-label="复制 MCP 地址" @click="copy(`${endpoint}/mcp`, 'MCP 地址')">复制</button></dd>
            </div>
            <div>
              <dt>HTTP API 地址</dt>
              <dd><code>{{ endpoint }}/api</code><button type="button" class="sp-button integration-copy" aria-label="复制 HTTP API 地址" @click="copy(`${endpoint}/api`, 'HTTP API 地址')">复制</button></dd>
            </div>
            <div>
              <dt id="integration-token-label">访问令牌</dt>
              <dd class="integration-token">
                <code aria-labelledby="integration-token-label">{{ showToken ? token : '••••••••••••••••••••••••' }}</code>
                <div class="integration-token-actions">
                  <button type="button" class="sp-button integration-copy" :aria-pressed="showToken" :aria-label="showToken ? '隐藏访问令牌' : '显示访问令牌'" @click="showToken = !showToken">{{ showToken ? '隐藏' : '显示' }}</button>
                  <button type="button" class="sp-button integration-copy" aria-label="复制访问令牌" @click="copy(token, '访问令牌')">复制</button>
                </div>
              </dd>
            </div>
          </dl>
          <button type="button" class="sp-button sp-primary integration-config" @click="copy(mcpConfig, 'MCP 配置（已包含访问令牌）')">复制 MCP 配置</button>
          <p class="integration-hint">配置已包含访问令牌，可粘贴到支持 HTTP 连接的 MCP 客户端中。</p>
        </div>

        <p v-if="supported" class="integration-note">仅允许本机访问；退出软件后服务自动关闭。</p>
        <p v-if="message" class="integration-message" role="status">{{ message }}</p>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.integration-settings { --sp-teal: #245b4e; width: 560px; color: #233b33; font-size: 13px; line-height: 1.65; }
.integration-settings h2, .integration-settings p { margin: 0; }
.integration-settings button { color: inherit; }
.integration-settings p { font-size: 13px; color: #64776c; }
.integration-settings .sp-modal-heading { margin-bottom: 25px; }
.integration-settings .sp-modal-heading .sp-icon-button { font-size: 25px; line-height: 1; flex-shrink: 0; }
.integration-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.integration-toggle-row h3 { margin: 0 0 4px; color: #23483d; font-size: 16px; font-weight: 650; }
.integration-toggle-row p { margin: 0; }
.integration-switch { position: relative; flex-shrink: 0; width: 48px; height: 28px; padding: 3px; border: 0; border-radius: 20px; background: #c9d4cc; transition: background .15s; }
.integration-switch span { display: block; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px #16312733; transition: transform .15s; }
.integration-switch[aria-checked="true"] { background: #448575; }
.integration-switch[aria-checked="true"] span { transform: translateX(20px); }
.integration-switch:disabled { opacity: .55; cursor: not-allowed; }
.integration-settings button:focus-visible { outline: 2px solid #448575; outline-offset: 3px; }
.integration-status { display: flex; align-items: flex-start; gap: 7px; margin: 13px 0 0; overflow-wrap: anywhere; }
.integration-status-dot { flex-shrink: 0; width: 7px; height: 7px; margin-top: 7px; border-radius: 50%; background: #aab8ae; }
.integration-status-dot.active { background: #448575; }
.integration-status-dot.pending { background: #c19a52; }
.integration-connection { margin-top: 22px; padding-top: 20px; border-top: 1px solid #e6ece7; }
.integration-details { display: grid; gap: 15px; margin: 0 0 20px; }
.integration-details dt { margin-bottom: 6px; color: #456252; font-size: 12px; font-weight: 600; }
.integration-details dd { display: flex; align-items: center; gap: 10px; margin: 0; padding: 9px 10px 9px 12px; border: 1px solid #e2e9e3; border-radius: 8px; background: #f6f8f6; }
.integration-details code { flex: 1; min-width: 0; color: #304e40; font-size: 12px; overflow-wrap: anywhere; user-select: text; }
.integration-copy { flex-shrink: 0; min-height: 32px; padding: 0 11px; }
.integration-token-actions { display: flex; flex-shrink: 0; gap: 6px; }
.integration-config { width: 100%; }
.integration-settings .integration-hint { margin: 9px 0 0; font-size: 12px; }
.integration-settings .integration-note { margin: 21px 0 0; font-size: 12px; }
.integration-settings .integration-message { margin: 14px 0 0; color: #245b54; font-size: 12px; }
@media (max-width: 420px) {
  .integration-toggle-row { gap: 15px; }
  .integration-details dd { flex-wrap: wrap; }
  .integration-token code { flex-basis: 100%; }
  .integration-token-actions { margin-left: auto; }
  .integration-copy { min-height: 36px; }
}
@media (prefers-reduced-motion: reduce) { .integration-switch, .integration-switch span { transition: none; } }
</style>
