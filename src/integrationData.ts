import { backupJSON, parseBackup } from './storage.ts'
import { validateSchedule } from './scheduler.ts'
import { isCivilDate } from './calendar.ts'
import type { PlannerDocument } from './payroll.ts'

export class IntegrationError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}

/** Execute against the application's current document, in one synchronous transaction. */
export function createIntegrationHandler(read: () => PlannerDocument, apply: (state: PlannerDocument) => void, busy: () => boolean) {
  let previous = ''
  const newRevision = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')
  let revision = newRevision()
  function snapshot() {
    const json = backupJSON(read())
    if (json !== previous) { previous = json; revision = newRevision() }
    return { revision, state: parseBackup(json) }
  }
  return function handle(method: string, input: unknown = {}) {
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
      next = parseBackup(JSON.stringify(args.state))
    } else {
      if (typeof args.employeeId !== 'string' || !current.state.employees.some(employee => employee.id === args.employeeId)) throw new IntegrationError('员工不存在')
      if (typeof args.date !== 'string' || !isCivilDate(args.date) || Number(args.date.slice(0, 4)) < 1) throw new IntegrationError('日期无效，请使用 YYYY-MM-DD')
      for (const key of ['locked', 'remove', 'unlock']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new IntegrationError(`${key} 必须为布尔值`)
      const existing = current.state.assignments.find(item => item.employeeId === args.employeeId && item.date === args.date)
      if (existing?.locked && args.unlock !== true) throw new IntegrationError('该排班已锁定，请显式提供 unlock: true 后修改')
      const assignments = current.state.assignments.filter(item => item.employeeId !== args.employeeId || item.date !== args.date)
      if (args.remove !== true) {
        if (typeof args.shiftId !== 'string') throw new IntegrationError('缺少 shiftId')
        assignments.push({ employeeId: args.employeeId, date: args.date, shiftId: args.shiftId, locked: args.locked === true })
      }
      next = parseBackup(JSON.stringify({ ...current.state, assignments }))
    }
    // apply must persist before replacing the in-memory document; a failed save rejects the write.
    apply(next)
    return snapshot()
  }
}
