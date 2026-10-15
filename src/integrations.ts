import { ref, onMounted, onUnmounted } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { PlannerDocument } from './payroll'
import { createIntegrationHandler, IntegrationError, type IntegrationSource } from './integrationData'
import { loadIntegrationPermissions, setIntegrationPermission, type IntegrationPermission } from './integrationPermissions'

type ServiceInfo = { enabled: boolean; url: string; token: string; serviceId: string }
type Request = { requestId: string; serviceId: string; method: string; args: unknown; expiresAt: number; source: IntegrationSource }

export function useIntegrations(read: () => PlannerDocument, apply: (state: PlannerDocument, source: IntegrationSource) => void, busy: () => boolean) {
  const supported = isTauri()
  const enabled = ref(false)
  const pending = ref(false)
  const status = ref(supported ? '未开启' : '请在桌面版中开启 MCP')
  const url = ref('')
  const token = ref('')
  const permissions = ref(loadIntegrationPermissions())
  const handle = createIntegrationHandler(read, apply, busy, () => permissions.value)
  let unlisten: (() => void) | undefined
  let preparation: Promise<void> | undefined
  let disposed = false
  let serviceId = ''

  function setPermission(key: IntegrationPermission, value: boolean) {
    permissions.value = setIntegrationPermission(permissions.value, key, value)
  }

  function accept(info: ServiceInfo) {
    serviceId = info.enabled ? info.serviceId : ''
    enabled.value = info.enabled
    url.value = info.enabled ? info.url : ''
    token.value = info.enabled ? info.token : ''
    status.value = info.enabled ? '已开启' : '未开启'
  }
  async function respond(request: Request) {
    let response: unknown
    try {
      if (disposed || !enabled.value || request.serviceId !== serviceId) throw new IntegrationError('MCP 已关闭', 503)
      if (!Number.isFinite(request.expiresAt) || Date.now() >= request.expiresAt) throw new IntegrationError('请求已过期，请重试', 504)
      response = { result: handle(request.method, request.args, request.source) }
    } catch (error) {
      response = { error: { status: error instanceof IntegrationError ? error.status : 400, message: error instanceof Error ? error.message : String(error) } }
    }
    // The HTTP client may have disconnected or the service may have stopped in the meantime.
    await invoke('integration_respond', { requestId: request.requestId, response }).catch(() => {})
  }
  function prepare() {
    if (!preparation) preparation = (async () => {
      const release = await listen<Request>('integration-request', event => void respond(event.payload))
      if (disposed) { release(); return }
      unlisten = release
    })().catch(error => { preparation = undefined; throw error })
    return preparation
  }
  async function start() {
    if (!supported || pending.value || enabled.value) return
    pending.value = true
    status.value = '正在开启…'
    try {
      await prepare()
      if (disposed) return
      const info = await invoke<ServiceInfo>('integration_start')
      if (disposed) { await invoke('integration_stop'); return }
      accept(info)
    } catch (error) { status.value = `开启失败：${String(error instanceof Error ? error.message : error)}` }
    finally { pending.value = false }
  }
  async function stop() {
    if (!supported || pending.value || !enabled.value) return
    pending.value = true
    // Refuse already queued requests as soon as the user switches the service off.
    enabled.value = false
    status.value = '正在关闭…'
    try { accept(await invoke<ServiceInfo>('integration_stop')) }
    catch (error) {
      try { accept(await invoke<ServiceInfo>('integration_status')) } catch { /* Keep rejecting data access until status is known. */ }
      status.value = `关闭失败：${String(error instanceof Error ? error.message : error)}`
    } finally { pending.value = false }
  }
  onMounted(async () => {
    if (!supported) return
    pending.value = true
    try {
      await prepare()
      if (!disposed) { const info = await invoke<ServiceInfo>('integration_status'); if (!disposed) accept(info) }
    } catch (error) { if (!disposed) status.value = `服务状态读取失败：${String(error instanceof Error ? error.message : error)}` }
    finally { pending.value = false }
  })
  onUnmounted(() => {
    disposed = true
    unlisten?.()
    if (supported) void invoke('integration_stop').catch(() => {})
  })
  return { supported, enabled, pending, status, url, token, permissions, setPermission, start, stop }
}
