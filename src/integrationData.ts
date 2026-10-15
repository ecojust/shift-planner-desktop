import { backupJSON, parseBackup } from './storage.ts'
import { validateSchedule } from './scheduler.ts'
import { isCivilDate } from './calendar.ts'
import type { PlannerDocument } from './payroll.ts'
import { DEFAULT_INTEGRATION_PERMISSIONS, type IntegrationPermission, type IntegrationPermissions } from './integrationPermissions.ts'
import { configurationFields, markSchedulesCurrent, withChangeProvenance } from './dataProvenance.ts'
import { checkDesktopResult, type SolverRequest, type SolverResult, type SolverStatus } from './DesktopSolver.ts'
import { createSolverRequest } from './solverDebug.ts'
import type { Issue } from './domain.ts'

export type IntegrationSource = 'mcp' | 'http'

interface IntegrationGenerationDetails {
  month: string
  status: SolverStatus
  message: string
  issues: Issue[]
  stats: SolverResult['stats']
  revision: string
}
export type IntegrationGenerationOutcome = IntegrationGenerationDetails & (
  | { success: false; saved: false }
  | { success: true; saved: true; state: PlannerDocument; generatedAt: string }
)
export interface IntegrationGenerationLease {
  /** The host also checks its monotonic revision, catching edits later undone. */
  assertCurrent(): void
  release(outcome?: IntegrationGenerationOutcome, error?: unknown): void
}
export interface IntegrationGenerationAdapter {
  solve(request: SolverRequest, signal?: AbortSignal): Promise<SolverResult>
  /** Acquire the same lock used by manual generation before starting any work. */
  acquire(request: SolverRequest, source: IntegrationSource): IntegrationGenerationLease
}
export interface IntegrationRequestContext {
  requestId?: string
  signal?: AbortSignal
  assertActive?(): void
  /** The native request must still be awaiting this result before saving it. */
  claimCommit?(): Promise<void>
}

export class IntegrationError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}

const fieldPermissions: Readonly<Record<string, IntegrationPermission>> = Object.freeze({
  employees: 'members', shifts: 'shifts', rules: 'rules', calendar: 'rules', assignments: 'assignments',
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

/** Stable entity paths distinguish actual configuration edits from list reordering. */
function changedScheduleConfiguration(previous: PlannerDocument, next: PlannerDocument): boolean {
  const roots = new Set(['employees', 'shifts', 'rules'])
  const before = configurationFields(previous), after = configurationFields(next)
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .some(path => roots.has(path.split('.')[0]!) && !equalData(before[path], after[path]))
}

function changedAssignmentMonths(previous: PlannerDocument, next: PlannerDocument): Set<string> {
  const before = new Map(previous.assignments.map(item => [`${item.employeeId}\0${item.date}`, item]))
  const after = new Map(next.assignments.map(item => [`${item.employeeId}\0${item.date}`, item]))
  const months = new Set<string>()
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldAssignment = before.get(key), newAssignment = after.get(key)
    if (oldAssignment?.shiftId !== newAssignment?.shiftId || oldAssignment?.locked !== newAssignment?.locked) {
      if (oldAssignment) months.add(oldAssignment.date.slice(0, 7))
      if (newAssignment) months.add(newAssignment.date.slice(0, 7))
    }
  }
  return months
}

/** Existing reads/writes stay synchronous. Generation owns a lease across its
 * asynchronous solve, then commits against the same current document revision. */
export function createIntegrationHandler(read: () => PlannerDocument, apply: (state: PlannerDocument, source: IntegrationSource) => void, busy: () => boolean, readPermissions: () => Readonly<IntegrationPermissions> = () => DEFAULT_INTEGRATION_PERMISSIONS, generation?: IntegrationGenerationAdapter) {
  let previous = ''
  let activeGeneration = false
  const newRevision = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')
  let revision = newRevision()
  function snapshot() {
    const json = backupJSON(read())
    if (json !== previous) { previous = json; revision = newRevision() }
    return { revision, state: parseBackup(json) }
  }
  function assertRequestActive(context: IntegrationRequestContext) {
    context.assertActive?.()
    if (context.signal?.aborted) {
      if (context.signal.reason instanceof IntegrationError) throw context.signal.reason
      throw new IntegrationError('请求已取消，原排班未改变', 409)
    }
  }
  async function generate(args: Record<string, unknown>, current: ReturnType<typeof snapshot>, source: IntegrationSource, context: IntegrationRequestContext): Promise<IntegrationGenerationOutcome> {
    if (Object.keys(args).some(key => !['revision', 'month', 'timeLimitSeconds'].includes(key))) throw new IntegrationError('生成排班只接受 revision、month 和 timeLimitSeconds 参数')
    if (typeof args.revision !== 'string' || !args.revision.trim()) throw new IntegrationError('revision 必须为读取当前数据时返回的字符串')
    const month = args.month === undefined ? current.state.month : args.month
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1900 || Number(month.slice(0, 4)) > 2200) throw new IntegrationError('生成月份必须为 1900–2200 年之间的 YYYY-MM')
    const timeLimitSeconds = args.timeLimitSeconds === undefined ? 15 : args.timeLimitSeconds
    if (typeof timeLimitSeconds !== 'number' || !Number.isFinite(timeLimitSeconds) || timeLimitSeconds < 1 || timeLimitSeconds > 60) throw new IntegrationError('timeLimitSeconds 必须为 1–60 秒之间的数字')
    if (activeGeneration || busy()) throw new IntegrationError('应用正在编辑或生成排班，请完成操作并返回排班日历后重试', 409)
    if (readPermissions().assignments !== true) throw new IntegrationError('未授权修改排班结果，请在右上角设置中开启对应写入权限', 403)
    if (args.revision !== current.revision) throw new IntegrationError('排班数据已更改，请重新读取最新 revision 后重试', 409)
    assertRequestActive(context)
    if (!generation) throw new IntegrationError('外部自动排班仅在已准备好内置排班功能的桌面版中可用', 503)
    const request = createSolverRequest({ ...current.state, month }, { timeLimitSeconds, allowPartial: false, seed: crypto.getRandomValues(new Uint32Array(1))[0]! % 2147483647 }, context.requestId ?? `integration-${newRevision()}`)
    let lease: IntegrationGenerationLease | undefined
    let outcome: IntegrationGenerationOutcome | undefined
    let failure: unknown
    activeGeneration = true
    try {
      lease = generation.acquire(request, source)
      const assertCurrent = () => {
        assertRequestActive(context)
        lease!.assertCurrent()
        if (readPermissions().assignments !== true) throw new IntegrationError('排班结果写入权限已撤销，原排班未改变', 403)
        if (snapshot().revision !== current.revision) throw new IntegrationError('排班期间数据已更改，请重新读取最新 revision 后重试；原排班未改变', 409)
      }
      assertCurrent()
      const result = await generation.solve(request, context.signal)
      assertCurrent()
      const checked = checkDesktopResult(request, result)
      const statuses: readonly SolverStatus[] = ['OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN', 'MODEL_INVALID', 'ERROR']
      const status: SolverStatus = statuses.includes(result?.status) ? result.status : 'ERROR'
      const stats = result?.stats ?? { wallTimeSeconds: 0, shortageCount: 0, optimal: false }
      const details = { month, status, message: checked.message, issues: checked.issues, stats }
      if (!checked.success || !checked.assignments) {
        outcome = { ...details, success: false, saved: false, revision: current.revision }
        return outcome
      }
      // The solver returns the whole roster. Its independent check proved that
      // history and locks survived; keep the original history order ourselves.
      const assignments = [
        ...current.state.assignments.filter(item => !item.date.startsWith(`${month}-`)),
        ...checked.assignments.filter(item => item.date.startsWith(`${month}-`)),
      ]
      const next = parseBackup(JSON.stringify({ ...current.state, assignments }))
      assertCurrent()
      if (context.claimCommit) await context.claimCommit()
      // No awaits are permitted between this final lifecycle/revision check and
      // apply, whose host contract persists successfully before replacing state.
      assertCurrent()
      const generatedAt = new Date().toISOString()
      let accepted = withChangeProvenance(current.state, next, source, generatedAt)
      accepted = { ...accepted, provenance: {
        ...(accepted.provenance ?? { fields: Object.create(null) }),
        // A real successful generation deserves a new stamp even when the
        // solver reproduces the existing assignments byte for byte.
        scheduleUpdates: Object.assign(Object.create(null), accepted.provenance?.scheduleUpdates, { [month]: { source, at: generatedAt } }),
      } }
      accepted = markSchedulesCurrent(accepted, [month])
      apply(accepted, source)
      outcome = { ...details, success: true, saved: true, ...snapshot(), generatedAt }
      return outcome
    } catch (error) {
      failure = error
      throw error
    } finally {
      // UI cleanup errors must never turn an already persisted result into an
      // apparent failure, and failed acquisition must not strand the data lock.
      try { lease?.release(outcome, failure) } catch { /* The data outcome remains authoritative. */ }
      activeGeneration = false
    }
  }
  return function handle(method: string, input: unknown = {}, source?: IntegrationSource, context: IntegrationRequestContext = {}) {
    if (source !== 'mcp' && source !== 'http') throw new IntegrationError('外部请求来源无效', 403)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new IntegrationError('参数必须是对象')
    const args = input as Record<string, unknown>
    const current = snapshot()
    if (method === 'get_state') return current
    if (method === 'validate_schedule') return { revision: current.revision, issues: validateSchedule(current.state) }
    if (method === 'generate_schedule') return generate(args, current, source, context)
    if (!['replace_state', 'set_assignment'].includes(method)) throw new IntegrationError('未知工具', 404)
    if (activeGeneration || busy()) throw new IntegrationError('应用正在编辑或生成排班，请完成操作并返回排班日历后重试', 409)
    if (args.revision !== current.revision) throw new IntegrationError('排班数据已更改，请重新读取最新 revision 后重试', 409)
    let next: PlannerDocument
    if (method === 'replace_state') {
      if (!args.state || typeof args.state !== 'object' || Array.isArray(args.state)) throw new IntegrationError('备份格式错误：文档必须是对象')
      // Provenance comes from the trusted current document, never from callers.
      const candidate = { ...(args.state as Record<string, unknown>) }
      delete candidate.provenance
      // Older clients may echo retired limits; they do not reactivate them.
      delete candidate.monthlyReferenceHours
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
    let accepted = withChangeProvenance(current.state, next, source)
    if (method === 'replace_state' && !changedScheduleConfiguration(current.state, next)) {
      const nonemptyMonths = new Set(next.assignments.map(item => item.date.slice(0, 7)))
      const currentMonths = [...changedAssignmentMonths(current.state, next)].filter(month => {
        if (!nonemptyMonths.has(month) || !accepted.provenance?.invalidatedSchedules?.[month]) return false
        // Coverage is a warning in the validator, but an incomplete monthly result
        // must not acknowledge a configuration change as successfully rescheduled.
        return !validateSchedule({ ...next, month }).some(issue => issue.severity === 'error' || issue.type === 'coverage')
      })
      accepted = markSchedulesCurrent(accepted, currentMonths)
    }
    // apply must persist before replacing the in-memory document; a failed save rejects the write.
    apply(accepted, source)
    return snapshot()
  }
}
