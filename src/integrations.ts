import { reactive, ref, onMounted, onUnmounted } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { PlannerDocument } from './payroll'
import { createIntegrationHandler, IntegrationError, type IntegrationSource } from './integrationData'
import { loadIntegrationPermissions, setIntegrationPermission, type IntegrationPermission } from './integrationPermissions'

type ServiceInfo = { enabled: boolean; url: string; token: string; serviceId: string }
type ServiceState = ServiceInfo & { pending: boolean; status: string }
type Request = { requestId: string; serviceId: string; method: string; args: unknown; expiresAt: number; source: IntegrationSource }
const serviceNames = { mcp: 'MCP', http: 'HTTP API' } as const
const serviceKinds = ['mcp', 'http'] as const

export function useIntegrations(read: () => PlannerDocument, apply: (state: PlannerDocument, source: IntegrationSource) => void, busy: () => boolean) {
  const supported = isTauri()
  const initialService = (): ServiceState => ({ enabled: false, pending: false, status: supported ? '未开启' : '请使用桌面版开启', url: '', token: '', serviceId: '' })
  const services = reactive<Record<IntegrationSource, ServiceState>>({ mcp: initialService(), http: initialService() })
  const permissions = ref(loadIntegrationPermissions())
  const handle = createIntegrationHandler(read, apply, busy, () => permissions.value)
  let unlisten: (() => void) | undefined
  let preparation: Promise<void> | undefined
  let disposed = false

  function setPermission(key: IntegrationPermission, value: boolean) {
    permissions.value = setIntegrationPermission(permissions.value, key, value)
  }

  function accept(service: IntegrationSource, info: ServiceInfo) {
    Object.assign(services[service], {
      enabled: info.enabled,
      serviceId: info.enabled ? info.serviceId : '',
      url: info.enabled ? info.url : '',
      token: info.enabled ? info.token : '',
      status: info.enabled ? '已开启' : '未开启',
    })
  }
  async function respond(request: Request) {
    // Only native route-owned sources identify a service. Unknown sources cannot
    // select a runtime or access data, even when a forged event carries a live ID.
    const service = request.source
    if (service !== 'mcp' && service !== 'http') return
    let response: unknown
    try {
      const current = services[service]
      if (disposed || !current.enabled || request.serviceId !== current.serviceId) throw new IntegrationError(`${serviceNames[service]} 已关闭或连接已失效`, 503)
      if (!Number.isFinite(request.expiresAt) || Date.now() >= request.expiresAt) throw new IntegrationError('请求已过期，请重试', 504)
      response = { result: handle(request.method, request.args, service) }
    } catch (error) {
      response = { error: { status: error instanceof IntegrationError ? error.status : 400, message: error instanceof Error ? error.message : String(error) } }
    }
    // A stopped service or disconnected client may no longer accept its response.
    await invoke('integration_respond', { service, requestId: request.requestId, response }).catch(() => {})
  }
  function prepare() {
    if (!preparation) preparation = (async () => {
      const release = await listen<Request>('integration-request', event => void respond(event.payload))
      if (disposed) { release(); return }
      unlisten = release
    })().catch(error => { preparation = undefined; throw error })
    return preparation
  }
  async function start(service: IntegrationSource) {
    const current = services[service]
    if (!supported || current.pending || current.enabled) return
    current.pending = true
    current.status = '正在开启…'
    try {
      await prepare()
      if (disposed) return
      const info = await invoke<ServiceInfo>('integration_start', { service })
      if (disposed) { await invoke('integration_stop', { service }); return }
      accept(service, info)
    } catch (error) { current.status = `开启失败：${String(error instanceof Error ? error.message : error)}` }
    finally { current.pending = false }
  }
  async function stop(service: IntegrationSource) {
    const current = services[service]
    if (!supported || current.pending || !current.enabled) return
    current.pending = true
    // Stop accepting this service's queued writes immediately; the other service
    // keeps its own enabled state, credentials, requests and lifecycle operation.
    current.enabled = false
    current.status = '正在关闭…'
    try { accept(service, await invoke<ServiceInfo>('integration_stop', { service })) }
    catch (error) {
      try { accept(service, await invoke<ServiceInfo>('integration_status', { service })) } catch { /* Refuse access until this service's state is known. */ }
      current.status = `关闭失败：${String(error instanceof Error ? error.message : error)}`
    } finally { current.pending = false }
  }
  onMounted(async () => {
    if (!supported) return
    await Promise.all(serviceKinds.map(async service => {
      const current = services[service]
      current.pending = true
      try {
        await prepare()
        if (!disposed) {
          const info = await invoke<ServiceInfo>('integration_status', { service })
          if (!disposed) accept(service, info)
        }
      } catch (error) { if (!disposed) current.status = `服务状态读取失败：${String(error instanceof Error ? error.message : error)}` }
      finally { current.pending = false }
    }))
  })
  onUnmounted(() => {
    disposed = true
    unlisten?.()
    if (supported) for (const service of serviceKinds) void invoke('integration_stop', { service }).catch(() => {})
  })
  return { supported, services, permissions, setPermission, start, stop }
}
