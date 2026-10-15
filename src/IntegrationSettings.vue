<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { useIntegrations } from './integrations'
import type { IntegrationPermissions } from './integrationPermissions'

const props = defineProps<{ integration: ReturnType<typeof useIntegrations> }>()
const emit = defineEmits<{ close: [] }>()
const { supported, enabled, pending, status, url, token, permissions } = props.integration
const permissionOptions: { key: keyof IntegrationPermissions; label: string; description: string }[] = [
  { key: 'members', label: '成员', description: '资料、工时、可上班次和请假' },
  { key: 'shifts', label: '班次', description: '时间、人数和固定津贴' },
  { key: 'rules', label: '排班规则', description: '休息、班次规则、月工时和日期' },
  { key: 'assignments', label: '排班结果', description: '新增、修改或删除每日排班' },
]
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

function changePermission(key: keyof IntegrationPermissions, event: Event) {
  const checkbox = event.target as HTMLInputElement
  try {
    props.integration.setPermission(key, checkbox.checked)
    message.value = '修改权限已保存，对 MCP 和 HTTP 立即生效'
  } catch (error) {
    checkbox.checked = permissions.value[key]
    message.value = error instanceof Error ? error.message : '权限保存失败，请重试。'
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
          <div class="integration-heading-title"><h2 id="integration-title">设置</h2><p>连接 AI 助手</p></div>
          <button type="button" class="sp-icon-button" aria-label="关闭设置" @click="emit('close')">×</button>
        </div>

        <div class="integration-body">
          <div class="integration-toggle-row" :aria-busy="pending">
            <div>
              <div class="integration-service-heading"><h3 id="integration-mcp-label">MCP</h3><p class="integration-status" role="status"><span class="integration-status-dot" :class="{ active: enabled, pending }" aria-hidden="true"></span>{{ supported ? status : '请使用桌面版开启' }}</p></div>
              <p id="integration-description">允许外部 AI 读取数据，并按下方权限修改。</p>
            </div>
            <button type="button" class="integration-switch" role="switch" :aria-checked="enabled" aria-labelledby="integration-mcp-label" aria-describedby="integration-description" :disabled="!supported || pending" @click="toggle">
              <span aria-hidden="true"></span>
            </button>
          </div>

          <fieldset class="integration-permissions">
            <legend>允许修改的数据类型</legend>
            <p class="integration-permissions-hint">默认仅成员可修改；未勾选项只读，MCP 与 HTTP 共用。</p>
            <div class="integration-permission-grid"><label v-for="option in permissionOptions" :key="option.key" class="integration-permission">
              <input type="checkbox" :checked="permissions[option.key]" :disabled="!supported" :aria-label="`允许修改${option.label}`" @change="changePermission(option.key, $event)" />
              <span><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span>
            </label></div>
          </fieldset>

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
            <p class="integration-hint">已含令牌，直接粘贴到支持 HTTP 的 MCP 客户端。</p>
          </div>

          <p v-if="supported" class="integration-note">仅允许本机访问；退出软件后服务自动关闭。</p>
          <p v-if="message" class="integration-message" role="status">{{ message }}</p>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.integration-settings { --sp-teal: #245b4e; --integration-padding: 20px; display: flex; flex-direction: column; width: 560px; padding: 0; overflow: hidden; color: #233b33; font-size: 13px; line-height: 1.5; }
.integration-settings h2, .integration-settings p { margin: 0; }
.integration-settings button { color: inherit; }
.integration-settings p { font-size: 12px; color: #64776c; }
.integration-settings .sp-modal-heading { flex-shrink: 0; align-items: center; margin: 0; padding: 10px var(--integration-padding); border-bottom: 1px solid #e6ece7; }
.integration-heading-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px 12px; }
.integration-settings .integration-heading-title h2 { font-size: 18px; }
.integration-settings .integration-heading-title p { margin: 0; font-size: 12px; }
.integration-body { min-height: 0; margin: 4px 6px 6px; padding: 9px calc(var(--integration-padding) - 6px) 10px; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: #bfd0c5 transparent; }
.integration-body::-webkit-scrollbar { width: 6px; }
.integration-body::-webkit-scrollbar-track { background: transparent; }
.integration-body::-webkit-scrollbar-thumb { border-radius: 999px; background: #bfd0c5; }
.integration-body::-webkit-scrollbar-thumb:hover { background: #91ad9d; }
.integration-body::-webkit-scrollbar-button { display: none; }
@supports selector(::-webkit-scrollbar) {
  .integration-body { scrollbar-width: auto; scrollbar-color: auto; }
}
.integration-settings .sp-modal-heading .sp-icon-button { width: 36px; height: 36px; font-size: 25px; line-height: 1; flex-shrink: 0; }
.integration-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.integration-toggle-row > div { min-width: 0; }
.integration-service-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 3px 10px; margin-bottom: 3px; }
.integration-toggle-row h3 { margin: 0; color: #23483d; font-size: 15px; font-weight: 650; }
.integration-toggle-row p { margin: 0; }
.integration-switch { position: relative; flex-shrink: 0; width: 48px; height: 36px; padding: 0; border: 0; border-radius: 20px; background: transparent; }
.integration-switch::before { content: ''; position: absolute; inset: 4px 0; border-radius: 20px; background: #c9d4cc; transition: background .15s; }
.integration-switch span { position: absolute; left: 3px; top: 7px; display: block; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px #16312733; transition: transform .15s; }
.integration-switch[aria-checked="true"]::before { background: #448575; }
.integration-switch[aria-checked="true"] span { transform: translateX(20px); }
.integration-switch:disabled { opacity: .55; cursor: not-allowed; }
.integration-settings button:focus-visible { outline: 2px solid #448575; outline-offset: 3px; }
.integration-status { display: flex; align-items: flex-start; gap: 5px; overflow-wrap: anywhere; }
.integration-settings .integration-status { font-size: 11px; }
.integration-status-dot { flex-shrink: 0; width: 6px; height: 6px; margin-top: 5px; border-radius: 50%; background: #aab8ae; }
.integration-status-dot.active { background: #448575; }
.integration-status-dot.pending { background: #c19a52; }
.integration-permissions { min-width: 0; margin: 12px 0 0; padding: 6px 10px 9px; border: 1px solid #e2e9e3; border-radius: 9px; }
.integration-permissions legend { padding: 0 5px; color: #345747; font-size: 12px; font-weight: 600; }
.integration-settings .integration-permissions-hint { margin-bottom: 6px; font-size: 11px; }
.integration-permission-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px 10px; }
.integration-permission { display: flex; align-items: flex-start; gap: 8px; min-width: 0; min-height: 44px; padding: 5px 0; cursor: pointer; }
.integration-permission input { flex-shrink: 0; width: 16px; height: 16px; margin: 2px 0 0; accent-color: #448575; }
.integration-permission input:focus-visible { outline: 2px solid #448575; outline-offset: 3px; }
.integration-permission > span { min-width: 0; }
.integration-permission strong { display: block; color: #345747; font-size: 12px; font-weight: 600; }
.integration-permission small { display: block; color: #64776c; font-size: 11px; line-height: 1.5; }
.integration-connection { margin-top: 12px; padding-top: 12px; border-top: 1px solid #e6ece7; }
.integration-details { display: grid; gap: 7px; margin: 0 0 10px; }
.integration-details > div { display: grid; grid-template-columns: 86px minmax(0, 1fr); align-items: center; gap: 8px; }
.integration-details dt { color: #456252; font-size: 12px; font-weight: 600; }
.integration-details dd { display: flex; align-items: center; gap: 7px; min-width: 0; margin: 0; padding: 4px 6px 4px 9px; border: 1px solid #e2e9e3; border-radius: 7px; background: #f6f8f6; }
.integration-details code { flex: 1; min-width: 0; color: #304e40; font-size: 11px; overflow-wrap: anywhere; user-select: text; }
.integration-copy { flex-shrink: 0; min-height: 32px; padding: 0 10px; }
.integration-token-actions { display: flex; flex-shrink: 0; gap: 5px; }
.integration-config { width: 100%; min-height: 36px; }
.integration-settings .integration-hint { margin: 6px 0 0; font-size: 11px; }
.integration-settings .integration-note { margin: 11px 0 0; font-size: 11px; }
.integration-settings .integration-message { margin: 7px 0 0; color: #245b54; font-size: 11px; }
@media (max-width: 760px) {
  .integration-settings { --integration-padding: 16px; }
}
@media (max-width: 420px) {
  .integration-settings { --integration-padding: 14px; }
  .integration-settings .sp-modal-heading { padding-top: 7px; padding-bottom: 7px; }
  .integration-settings .sp-modal-heading .sp-icon-button { width: 40px; height: 40px; }
  .integration-toggle-row { gap: 12px; }
  .integration-switch { height: 40px; }
  .integration-switch::before { inset-block: 6px; }
  .integration-switch span { top: 9px; }
  .integration-permissions { padding-right: 8px; padding-left: 8px; }
  .integration-permission-grid { column-gap: 8px; }
  .integration-permission { gap: 6px; }
  .integration-details > div { grid-template-columns: minmax(0, 1fr); gap: 3px; }
  .integration-details dd { flex-wrap: wrap; }
  .integration-token code { flex-basis: 100%; }
  .integration-token-actions { margin-left: auto; }
  .integration-copy { min-height: 40px; }
  .integration-config { min-height: 40px; }
}
@media (pointer: coarse) {
  .integration-copy, .integration-config { min-height: 44px; }
  .integration-settings .sp-modal-heading .sp-icon-button { width: 44px; height: 44px; }
  .integration-switch { height: 44px; }
  .integration-switch::before { inset-block: 8px; }
  .integration-switch span { top: 11px; }
}
@media (prefers-reduced-motion: reduce) { .integration-switch::before, .integration-switch span { transition: none; } }
</style>
