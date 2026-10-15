import { backupJSON, parseBackup } from './storage.ts'
import { validateSchedule } from './scheduler.ts'
import { isCivilDate } from './calendar.ts'
import type { PlannerDocument } from './payroll.ts'
import { DEFAULT_INTEGRATION_PERMISSIONS, type IntegrationPermission, type IntegrationPermissions } from './integrationPermissions.ts'
import { withChangeProvenance } from './dataProvenance.ts'

export type IntegrationSource = 'mcp' | 'http'

export class IntegrationError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}

const fieldPermissions: Readonly<Record<string, IntegrationPermission>> = Object.freeze({
  employees: 'members', shifts: 'shifts', rules: 'rules', monthlyReferenceHours: 'rules', calendar: 'rules', assignments: 'assignments',
})
const permissionNames: Record<IntegrationPermission, string> = { members: '成员', shifts: '班次', rules: '排班规则', assignments: '排班结果' }

/** Object key order is not a data change; array order is retained in the document. */
function equalData(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalData(value, right[index]))
  }
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equalData(a[key], b[key]))
}

/** Execute against the application's current document, in one synchronous transaction. */
export function createIntegrationHandler(read: () => PlannerDocument, apply: (state: PlannerDocument, source: IntegrationSource) => void, busy: () => boolean, readPermissions: () => Readonly<IntegrationPermissions> = () => DEFAULT_INTEGRATION_PERMISSIONS) {
  let previous = ''
  const newRevision = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')
  let revision = newRevision()
  function snapshot() {
    const json = backupJSON(read())
    if (json !== previous) { previous = json; revision = newRevision() }
    return { revision, state: parseBackup(json) }
  }
  return function handle(method: string, input: unknown = {}, source?: IntegrationSource) {
    if (source !== 'mcp' && source !== 'http') throw new IntegrationError('外部请求来源无效', 403)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new IntegrationError('参数必须是对象')
    const args = input as Record<string, unknown>
    const current = snapshot()
    if (method === 'get_state') return current
    if (method === 'validate_schedule') return { revision: current.revision, issues: validateSchedule(current.state) }
    if (!['replace_state', 'set_assignment'].includes(method)) throw new IntegrationError('未知工具', 404)
    if (busy()) throw new IntegrationError('应用正在编辑或生成排班，请完成操作并返回排班日历后重试', 409)
    if (args.revision !== current.revision) throw new IntegrationError('排班数据已更改，请重新读取最新 revision 后重试', 409)
    let next: PlannerDocument
    if (method === 'replace_state') {
      if (!args.state || typeof args.state !== 'object' || Array.isArray(args.state)) throw new IntegrationError('备份格式错误：文档必须是对象')
      // Provenance comes from the trusted current document, never from callers.
      const candidate = { ...(args.state as Record<string, unknown>) }
      delete candidate.provenance
      const currentDocument = current.state as unknown as Record<string, unknown>
      next = parseBackup(JSON.stringify(candidate))
      // Reject unsupported top-level fields even if the backup parser would discard them.
      for (const key of Object.keys(candidate)) {
        if (key !== 'provenance' && !Object.hasOwn(fieldPermissions, key) && !equalData(candidate[key], currentDocument[key])) {
          throw new IntegrationError(`不允许通过外部接口修改字段：${key}`, 403)
        }
      }
    } else {
      if (typeof args.employeeId !== 'string' || !current.state.employees.some(employee => employee.id === args.employeeId)) throw new IntegrationError('员工不存在')
      if (typeof args.date !== 'string' || !isCivilDate(args.date) || Number(args.date.slice(0, 4)) < 1) throw new IntegrationError('日期无效，请使用 YYYY-MM-DD')
      for (const key of ['locked', 'remove', 'unlock']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new IntegrationError(`${key} 必须为布尔值`)
      const existing = current.state.assignments.find(item => item.employeeId === args.employeeId && item.date === args.date)
      if (existing?.locked && args.unlock !== true) throw new IntegrationError('该排班已锁定，请显式提供 unlock: true 后修改')
      let assignments = current.state.assignments.filter(item => item.employeeId !== args.employeeId || item.date !== args.date)
      if (args.remove !== true) {
        if (typeof args.shiftId !== 'string') throw new IntegrationError('缺少 shiftId')
        const assignment = { employeeId: args.employeeId, date: args.date, shiftId: args.shiftId, locked: args.locked === true }
        assignments = existing
          ? current.state.assignments.map(item => item === existing ? assignment : item)
          : [...current.state.assignments, assignment]
      }
      next = parseBackup(JSON.stringify({ ...current.state, assignments }))
    }
    const currentDocument = current.state as unknown as Record<string, unknown>
    const nextDocument = next as unknown as Record<string, unknown>
    const changed = [...new Set([...Object.keys(currentDocument), ...Object.keys(nextDocument)])]
      .filter(key => key !== 'provenance' && !equalData(currentDocument[key], nextDocument[key]))
    const permissions = readPermissions()
    const denied = new Set<string>()
    for (const key of changed) {
      const permission = Object.hasOwn(fieldPermissions, key) ? fieldPermissions[key] : undefined
      if (!permission) throw new IntegrationError(`不允许通过外部接口修改字段：${key}`, 403)
      if (permissions?.[permission] !== true) denied.add(permissionNames[permission])
    }
    if (denied.size) throw new IntegrationError(`未授权修改${[...denied].join('、')}，请在右上角设置中开启对应写入权限`, 403)
    if (!changed.length) return current
    // apply must persist before replacing the in-memory document; a failed save rejects the write.
    apply(withChangeProvenance(current.state, next, source), source)
    return snapshot()
  }
}
