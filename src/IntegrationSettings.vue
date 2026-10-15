<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { useIntegrations } from './integrations'
import type { IntegrationPermissions } from './integrationPermissions'
import { createHttpApiDocs, type HttpApiDoc } from './httpApiDocs'

const props = defineProps<{ integration: ReturnType<typeof useIntegrations> }>()
const emit = defineEmits<{ close: [] }>()
type ServiceName = 'mcp' | 'http'
const { supported, services, permissions } = props.integration
const serviceOptions: { key: ServiceName; label: string; description: string }[] = [
  { key: 'mcp', label: 'MCP', description: '供支持 MCP 的 AI 客户端连接。' },
  { key: 'http', label: 'HTTP API', description: '供脚本或应用通过 REST 接口访问。' },
]
const serviceName = (service: ServiceName) => service === 'mcp' ? 'MCP' : 'HTTP'
const endpoint = (service: ServiceName) => services[service].url.replace(/\/$/, '')
const serviceAddress = (service: ServiceName) => `${endpoint(service)}/${service === 'mcp' ? 'mcp' : 'api'}`
const httpDocs = computed(() => createHttpApiDocs(endpoint('http'), 'YOUR_HTTP_ACCESS_TOKEN'))
const permissionOptions: { key: keyof IntegrationPermissions; label: string; description: string }[] = [
  { key: 'members', label: '成员', description: '资料、工时、可上班次和请假' },
  { key: 'shifts', label: '班次', description: '时间、人数和固定津贴' },
  { key: 'rules', label: '排班规则', description: '休息、班次规则、月工时和日期' },
  { key: 'assignments', label: '排班结果', description: '新增、修改或删除每日排班' },
]
const message = ref('')
const showToken = ref<Record<ServiceName, boolean>>({ mcp: false, http: false })
const dialog = ref<HTMLElement | null>(null)
const previousFocus = document.activeElement as HTMLElement | null
const mcpConfig = computed(() => JSON.stringify({
  mcpServers: {
    'shift-schedule-expert': {
      type: 'http',
      url: serviceAddress('mcp'),
      headers: { Authorization: `Bearer ${services.mcp.token}` },
    },
  },
}, null, 2))

for (const service of serviceOptions) watch(() => [services[service.key].enabled, services[service.key].serviceId], () => { showToken.value[service.key] = false; message.value = '' })

async function toggle(service: ServiceName) {
  if (!supported || services[service].pending) return
  message.value = ''
  try {
    if (services[service].enabled) await props.integration.stop(service)
    else await props.integration.start(service)
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

function copyHttpExample(doc: HttpApiDoc) {
  if (!services.http.enabled) return
  const example = createHttpApiDocs(endpoint('http'), services.http.token).find(item => item.id === doc.id)
  if (example) void copy(example.example, 'HTTP 示例（已包含 HTTP 访问令牌）')
}

function controls() {
  return [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') ?? [])]
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
          <div class="integration-heading-title"><h2 id="integration-title">设置</h2><p>本机服务与访问权限</p></div>
          <button type="button" class="sp-icon-button" aria-label="关闭设置" @click="emit('close')">×</button>
        </div>

        <div class="integration-body">
          <div class="integration-services">
            <section v-for="service in serviceOptions" :key="service.key" class="integration-service" :data-integration-service="service.key" :aria-labelledby="`integration-${service.key}-label`">
              <div class="integration-toggle-row" :aria-busy="services[service.key].pending">
                <div>
                  <div class="integration-service-heading"><h3 :id="`integration-${service.key}-label`">{{ service.label }}</h3><p class="integration-status" role="status"><span class="integration-status-dot" :class="{ active: services[service.key].enabled, pending: services[service.key].pending }" aria-hidden="true"></span>{{ supported ? services[service.key].status : '请使用桌面版开启' }}</p></div>
                  <p :id="`integration-${service.key}-description`">{{ service.description }}</p>
                </div>
                <button type="button" class="integration-switch" role="switch" :aria-checked="services[service.key].enabled" :aria-labelledby="`integration-${service.key}-label`" :aria-describedby="`integration-${service.key}-description`" :disabled="!supported || services[service.key].pending" @click="toggle(service.key)"><span aria-hidden="true"></span></button>
              </div>

              <div v-if="services[service.key].enabled" class="integration-connection">
                <dl class="integration-details">
                  <div>
                    <dt>{{ serviceName(service.key) }} 地址</dt>
                    <dd><code>{{ serviceAddress(service.key) }}</code><button type="button" class="sp-button integration-copy" :aria-label="`复制 ${service.label} 地址`" @click="copy(serviceAddress(service.key), `${service.label} 地址`)">复制</button></dd>
                  </div>
                  <div>
                    <dt :id="`integration-${service.key}-token-label`">访问令牌</dt>
                    <dd class="integration-token">
                      <code :aria-labelledby="`integration-${service.key}-token-label`">{{ showToken[service.key] ? services[service.key].token : '••••••••••••••••••••••••' }}</code>
                      <div class="integration-token-actions">
                        <button type="button" class="sp-button integration-copy" :aria-pressed="showToken[service.key]" :aria-label="`${showToken[service.key] ? '隐藏' : '显示'} ${serviceName(service.key)} 访问令牌`" @click="showToken[service.key] = !showToken[service.key]">{{ showToken[service.key] ? '隐藏' : '显示' }}</button>
                        <button type="button" class="sp-button integration-copy" :aria-label="`复制 ${serviceName(service.key)} 访问令牌`" @click="copy(services[service.key].token, `${serviceName(service.key)} 访问令牌`)">复制</button>
                      </div>
                    </dd>
                  </div>
                </dl>
                <template v-if="service.key === 'mcp'">
                  <button type="button" class="sp-button sp-primary integration-config" @click="copy(mcpConfig, 'MCP 配置（已包含 MCP 访问令牌）')">复制 MCP 配置</button>
                  <p class="integration-hint">配置已含 MCP 令牌，粘贴到支持 HTTP 连接的 MCP 客户端。</p>
                </template>
                <details v-else class="integration-http-docs">
                  <summary>HTTP 接口与示例 <span>4 个接口</span></summary>
                  <div class="integration-http-docs-body">
                    <p>请求需携带 <code>Authorization: Bearer &lt;HTTP 访问令牌&gt;</code>，JSON 请求体需设置 <code>Content-Type: application/json</code>。</p>
                    <p>修改前先读取最新 <code>revision</code>，写入时一并提交，防止覆盖他人的更新。<code>PUT /api/state</code> 提交完整 <code>state</code>，请保留所有未修改数据。</p>
                    <p class="integration-api-errors">401：令牌无效；403：未授予对应修改权限；409：版本过期或正在编辑，请重新读取，或完成编辑并返回排班日历后重试。</p>
                    <p class="integration-copy-hint">预览隐藏令牌；点击「复制示例」会加入当前 HTTP 令牌。</p>
                    <details v-for="doc in httpDocs" :key="doc.id" class="integration-api-route" :data-http-route="doc.id">
                      <summary><span class="integration-api-method" :class="{ write: doc.method !== 'GET' }">{{ doc.method }}</span><code>{{ doc.path }}</code><span class="integration-api-title">{{ doc.title }}</span></summary>
                      <div class="integration-api-content">
                        <div class="integration-api-address"><code>{{ endpoint('http') }}{{ doc.path }}</code><button type="button" class="sp-button integration-copy" :aria-label="`复制 ${doc.method} ${doc.path} 地址`" @click="copy(`${endpoint('http')}${doc.path}`, 'HTTP 接口地址')">复制地址</button></div>
                        <p>{{ doc.description }}</p>
                        <dl class="integration-api-parameters"><div v-for="parameter in doc.parameters" :key="parameter.name"><dt>{{ parameter.name }}</dt><dd>{{ parameter.description }}</dd></div></dl>
                        <template v-if="doc.body">
                          <div class="integration-example-heading"><strong>{{ doc.id === 'put-state' ? '完整请求体结构示意' : 'JSON 请求参数' }}</strong><button type="button" class="sp-button integration-copy" :aria-label="`复制 ${doc.method} ${doc.path} 参数`" @click="copy(doc.body, '请求参数结构')">复制参数</button></div>
                          <pre>{{ doc.body }}</pre>
                        </template>
                        <p class="integration-api-response">返回：<code>{{ doc.response }}</code></p>
                        <div class="integration-example-heading"><strong>{{ doc.language }} 示例</strong><button type="button" class="sp-button integration-copy" :aria-label="`复制 ${doc.method} ${doc.path} 示例`" @click="copyHttpExample(doc)">复制示例</button></div>
                        <pre>{{ doc.example }}</pre>
                      </div>
                    </details>
                  </div>
                </details>
              </div>
              <p v-else class="integration-hint">开启后查看连接地址、令牌{{ service.key === 'http' ? '和接口示例' : '及客户端配置' }}。</p>
            </section>
          </div>

          <fieldset class="integration-permissions">
            <legend>允许修改的数据类型</legend>
            <p class="integration-permissions-hint">默认仅成员可修改；未勾选项只读，MCP 与 HTTP 共用。</p>
            <div class="integration-permission-grid"><label v-for="option in permissionOptions" :key="option.key" class="integration-permission">
              <input type="checkbox" :checked="permissions[option.key]" :disabled="!supported" :aria-label="`允许修改${option.label}`" @change="changePermission(option.key, $event)" />
              <span><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span>
            </label></div>
          </fieldset>
          <p v-if="supported" class="integration-note">两个服务独立开启，仅允许本机访问；退出软件后自动关闭。</p>
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
.integration-services { display: grid; gap: 10px; }
.integration-service { min-width: 0; padding: 12px; border: 1px solid #e2e9e3; border-radius: 10px; background: #fff; }
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
.integration-settings button:focus-visible, .integration-settings summary:focus-visible { outline: 2px solid #448575; outline-offset: 3px; }
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
.integration-details > div { display: grid; grid-template-columns: 80px minmax(0, 1fr); align-items: center; gap: 8px; }
.integration-details dt { color: #456252; font-size: 12px; font-weight: 600; }
.integration-details dd { display: flex; align-items: center; gap: 7px; min-width: 0; margin: 0; padding: 4px 6px 4px 9px; border: 1px solid #e2e9e3; border-radius: 7px; background: #f6f8f6; }
.integration-details code { flex: 1; min-width: 0; color: #304e40; font-size: 11px; overflow-wrap: anywhere; user-select: text; }
.integration-copy { flex-shrink: 0; min-height: 32px; padding: 0 10px; }
.integration-token-actions { display: flex; flex-shrink: 0; gap: 5px; }
.integration-config { width: 100%; min-height: 36px; }
.integration-settings .integration-hint { margin: 6px 0 0; font-size: 11px; }
.integration-settings .integration-note { margin: 11px 0 0; font-size: 11px; }
.integration-settings .integration-message { margin: 7px 0 0; color: #245b54; font-size: 11px; }
.integration-http-docs { border-top: 1px solid #e6ece7; padding-top: 3px; }
.integration-http-docs summary { cursor: pointer; color: #345747; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.integration-http-docs > summary { min-height: 36px; padding: 8px 0; font-weight: 600; }
.integration-http-docs > summary > span { margin-left: 5px; color: #82958a; font-size: 11px; font-weight: 400; }
.integration-http-docs-body { display: grid; gap: 8px; padding-top: 5px; }
.integration-settings .integration-http-docs-body p { font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }
.integration-http-docs-body code { font-size: 11px; overflow-wrap: anywhere; }
.integration-settings .integration-api-errors { color: #7a887f; }
.integration-settings .integration-copy-hint { color: #476f5c; }
.integration-api-route { min-width: 0; border: 1px solid #e1e8e2; border-radius: 7px; background: #fafcfb; }
.integration-api-route > summary { padding: 10px; min-height: 40px; }
.integration-api-method { display: inline-block; margin-right: 6px; font-size: 10px; font-weight: 650; color: #3f7961; }
.integration-api-method.write { color: #846a37; }
.integration-api-title { margin-left: 8px; font-size: 11px; color: #7e8f84; }
.integration-api-content { min-width: 0; padding: 0 10px 10px; }
.integration-api-content > p { margin-top: 9px; }
.integration-api-address { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 8px; padding: 8px 0; border-top: 1px solid #e3eae5; }
.integration-api-address > code { flex: 1; min-width: 0; color: #345747; }
.integration-api-parameters { display: grid; gap: 6px; margin: 10px 0; font-size: 11px; line-height: 1.6; }
.integration-api-parameters > div { display: grid; grid-template-columns: minmax(70px, 100px) minmax(0, 1fr); gap: 6px; }
.integration-api-parameters dt { color: #456252; font-weight: 600; overflow-wrap: anywhere; }
.integration-api-parameters dd { margin: 0; color: #64776c; overflow-wrap: anywhere; }
.integration-example-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
.integration-example-heading strong { color: #456252; font-size: 11px; font-weight: 600; }
.integration-api-content pre { max-width: 100%; margin: 6px 0 0; padding: 9px; border: 1px solid #e2e9e4; border-radius: 6px; background: #f0f5f1; color: #345747; font: 11px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
@media (max-width: 760px) {
  .integration-settings { --integration-padding: 16px; }
}
@media (max-width: 420px) {
  .integration-settings { --integration-padding: 14px; }
  .integration-settings .sp-modal-heading { padding-top: 7px; padding-bottom: 7px; }
  .integration-settings .sp-modal-heading .sp-icon-button { width: 40px; height: 40px; }
  .integration-service { padding: 10px; }
  .integration-toggle-row { gap: 12px; }
  .integration-api-route > summary { padding: 9px 8px; }
  .integration-api-content { padding-right: 8px; padding-left: 8px; }
  .integration-api-title { display: block; margin-left: 14px; margin-top: 2px; }
  .integration-api-parameters > div { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .integration-http-docs > summary { min-height: 40px; }
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
  .integration-copy, .integration-config, .integration-http-docs > summary, .integration-api-route > summary { min-height: 44px; }
  .integration-settings .sp-modal-heading .sp-icon-button { width: 44px; height: 44px; }
  .integration-switch { height: 44px; }
  .integration-switch::before { inset-block: 8px; }
  .integration-switch span { top: 11px; }
}
@media (prefers-reduced-motion: reduce) { .integration-switch::before, .integration-switch span { transition: none; } }
</style>
