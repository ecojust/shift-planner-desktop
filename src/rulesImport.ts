import type { PlannerDocument } from './payroll.ts'
import { resolveHoursState } from './hours.ts'
import { MAX_BACKUP_BYTES, parseBackup } from './storage.ts'

type RecordValue = Record<string, unknown>

export interface RulesImport {
  document: PlannerDocument
  timeLimitSeconds?: number
  source: 'current' | 'attempt' | 'unknown'
}

function fail(message: string): never { throw new Error(`规则文件格式错误：${message}`) }
function object(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象`)
  return value as RecordValue
}
function hours(value: unknown, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) fail(`${label}超出范围 0–${maximum}`)
  return value
}
function validateDocument(value: unknown): PlannerDocument {
  try { return parseBackup(JSON.stringify(value)) }
  catch (error) {
    const message = error instanceof Error ? error.message.replace(/^备份格式错误：/, '') : '无法读取排班设置'
    fail(message)
  }
}

/** Read the complete request emitted by “导出规则”, without importing its old
 * provenance. The caller records the accepted replacement as a manual change. */
export function parseRulesImport(text: string): RulesImport {
  if (typeof text !== 'string' || text.length > MAX_BACKUP_BYTES || new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) fail('文件超过 8 MiB 大小上限')
  let decoded: unknown
  try { decoded = JSON.parse(text.replace(/^\uFEFF/, '')) }
  catch { fail('无法读取 JSON 文件') }
  const root = object(decoded, '规则文件')
  if (root.protocolVersion === undefined && root.version === 1 && root.employees !== undefined) fail('这是完整备份，请使用“导入备份”')
  if (root.protocolVersion !== 1) fail('不支持此规则协议版本，请选择“导出规则”生成的文件')
  const rawState = object(root.state, '排班设置 state')
  // Remove untrusted historical metadata before invoking the shared validator.
  // JSON.parse made this detached already; no live state is mutated here.
  const { provenance: _provenance, ...state } = rawState
  let document = validateDocument(state)
  let source: RulesImport['source'] = 'unknown'
  if (root.debug !== undefined) {
    const debug = object(root.debug, '导出信息 debug')
    if (debug.format !== 'shiftflow-solver-debug' || debug.formatVersion !== 1) fail('不支持此规则导出格式版本')
    if (debug.source !== undefined && debug.source !== 'current' && debug.source !== 'attempt') fail('导出来源必须为 current 或 attempt')
    source = debug.source === undefined ? 'unknown' : debug.source
    if (debug.originalHourDefaults !== undefined) {
      if (!Array.isArray(debug.originalHourDefaults) || debug.originalHourDefaults.length !== document.employees.length) fail('原始工时设置必须与成员一一对应')
      const byId = new Map(document.employees.map(employee => [employee.id, employee]))
      const exportedHours = document.employees.map(employee => [employee.minHoursPerMonth, employee.minHoursPerWeek])
      const seen = new Set<string>()
      for (const value of debug.originalHourDefaults) {
        const original = object(value, '原始工时设置')
        if (typeof original.employeeId !== 'string' || !byId.has(original.employeeId)) fail('原始工时设置引用了不存在的成员')
        if (seen.has(original.employeeId)) fail('原始工时设置存在重复成员')
        seen.add(original.employeeId)
        const employee = byId.get(original.employeeId)!
        // A missing legacy minimum means zero, not today's null (follow the
        // monthly reference). Make it explicit so backup normalization cannot
        // change that meaning when the imported document is saved later.
        if (original.minHoursPerMonth === undefined) employee.minHoursPerMonth = 0
        else employee.minHoursPerMonth = original.minHoursPerMonth === null ? null : hours(original.minHoursPerMonth, 744, '原始每月最低工时')
        if (original.minHoursPerWeek === undefined) employee.minHoursPerWeek = 0
        else employee.minHoursPerWeek = hours(original.minHoursPerWeek, 168, '原始每周最低工时')
      }
      // Validate restored weekly bounds and all shared business constraints too.
      const restored = validateDocument(document)
      const resolved = resolveHoursState(restored)
      for (let index = 0; index < resolved.employees.length; index++) {
        const employee = resolved.employees[index]!, expected = exportedHours[index]!
        if (employee.minHoursPerMonth !== expected[0] || employee.minHoursPerWeek !== expected[1]) fail('原始工时设置与导出的排班设置不一致')
      }
      document = restored
    }
  }
  let timeLimitSeconds: number | undefined
  if (root.options !== undefined) {
    const options = object(root.options, '求解选项 options')
    if (options.timeLimitSeconds !== undefined) {
      const seconds = options.timeLimitSeconds
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) fail('求解时限必须为正数')
      // Imported seeds / partial-solution flags never affect generation. Only
      // restore a wait duration that the application's selector can represent.
      if ([5, 15, 30, 60].includes(seconds)) timeLimitSeconds = seconds
    }
  }
  return { document, source, ...(timeLimitSeconds === undefined ? {} : { timeLimitSeconds }) }
}
