import type { PlannerDocument } from './payroll.ts'
import { isCivilDate } from './calendar.ts'

export type ChangeSource = 'manual' | 'mcp' | 'http'
export interface ChangeStamp { source: ChangeSource; at: string }
export interface DataProvenance {
  fields: Record<string, ChangeStamp>
  pendingExternalChange?: { source: 'mcp' | 'http'; at: string; categories: string[] }
  /** Latest accepted external assignment change per month, independent of configuration edits. */
  scheduleUpdates?: Record<string, { source: 'mcp' | 'http'; at: string }>
  /** Latest configuration change that made each existing month's schedule stale. */
  invalidatedSchedules?: Record<string, ChangeStamp>
}

/** Summarize a card's own paths and descendants without including sibling cards. */
export function latestConfigurationChange(provenance: DataProvenance | undefined, paths: readonly string[]): ChangeStamp | undefined {
  if (!provenance || !paths.length) return undefined
  const scopes = paths.filter(Boolean)
  let latest: ChangeStamp | undefined
  // Prefer an existing card summary when timestamps tie with its field records.
  for (const path of scopes) {
    const stamp = provenance.fields[path]
    if (stamp && (!latest || stamp.at > latest.at)) latest = stamp
  }
  for (const [path, stamp] of Object.entries(provenance.fields)) {
    if ((!latest || stamp.at > latest.at) && scopes.some(scope => path.startsWith(`${scope}.`))) latest = stamp
  }
  return latest
}

export const MAX_PROVENANCE_FIELDS = 100000
export const MAX_PROVENANCE_BYTES = 4 * 1024 * 1024
const categories = ['团队', '成员', '班次', '排班规则', '日期设置', '工时设置', '津贴'] as const
const entityCollections = new Set(['employees', 'shifts', 'rules.separationGroups', 'rules.nonConsecutiveShifts', 'rules.weeklyShiftLimits'])
const roots = ['teamName', 'employees', 'shifts', 'rules', 'calendar', 'monthlyReferenceHours', 'payroll'] as const
const scheduleConfigurationRoots = new Set(['employees', 'shifts', 'rules', 'calendar', 'monthlyReferenceHours'])
const resettableRoots = new Set(['calendar', 'monthlyReferenceHours', 'rules.weekdayWeights', 'rules.separationGroups', 'rules.nonConsecutiveShifts', 'rules.weeklyShiftLimits'])

/** Arrays of entities use persistent IDs; arrays of field values are a single leaf. */
function collectConfiguration(state: PlannerDocument): { fields: Record<string, unknown>; paths: Set<string> } {
  const fields: Record<string, unknown> = Object.create(null)
  const paths = new Set<string>()
  function walk(path: string, value: unknown): void {
    if (value === undefined) return
    paths.add(path)
    if (entityCollections.has(path) && Array.isArray(value)) {
      for (const entity of value) {
        const entityPath = `${path}.${entity.id}`
        paths.add(entityPath)
        for (const [key, child] of Object.entries(entity)) if (key !== 'id') walk(`${entityPath}.${key}`, child)
      }
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) walk(`${path}.${key}`, child)
    } else {
      fields[path] = value
    }
  }
  for (const root of roots) walk(root, state[root])
  return { fields, paths }
}

/** Flatten configuration only; navigation, assignments and tracking metadata are excluded. */
export function configurationFields(state: PlannerDocument): Record<string, unknown> {
  return collectConfiguration(state).fields
}

/** An omitted optional value can still have a recorded "restore default" edit.
 * Only known resettable paths qualify; removed entity rows never retain history. */
function allowedProvenancePath(state: PlannerDocument, present: Set<string>): (path: string) => boolean {
  const employees = new Set(state.employees.map(employee => employee.id))
  const shifts = new Set(state.shifts.map(shift => shift.id))
  return path => {
    if (present.has(path) || resettableRoots.has(path)) return true
    const parts = path.split('.')
    if (parts.length === 2 && parts[0] === 'calendar') {
      return parts[1]!.slice(0, 4) !== '0000' && isCivilDate(parts[1]!)
    }
    if (parts.length === 2 && parts[0] === 'monthlyReferenceHours') {
      return validMonth(parts[1]!)
    }
    if (parts.length === 3 && parts[0] === 'employees') return employees.has(parts[1]!) && parts[2] === 'avatar'
    if (parts.length === 3 && parts[0] === 'shifts') return shifts.has(parts[1]!) && (parts[2] === 'staffingMode' || parts[2] === 'normalAllowance')
    return false
  }
}

function category(path: string): string {
  if (path === 'teamName') return '团队'
  if (path.startsWith('employees.')) return '成员'
  if (path.startsWith('shifts.')) return path.endsWith('.normalAllowance') ? '津贴' : '班次'
  if (path.startsWith('rules.')) return '排班规则'
  if (path.startsWith('calendar.')) return '日期设置'
  if (path.startsWith('monthlyReferenceHours.')) return '工时设置'
  return '津贴'
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function validMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value.slice(0, 4) !== '0000'
}

function changedScheduleMonths(previous: PlannerDocument, next: PlannerDocument): Set<string> {
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

/** Apply trusted local history to a proposed document; submitted history is never authoritative. */
export function withChangeProvenance(previous: PlannerDocument, next: PlannerDocument, source: ChangeSource, at = new Date().toISOString()): PlannerDocument {
  if (!['manual', 'mcp', 'http'].includes(source)) throw new Error('未知的配置修改来源')
  if (!validTimestamp(at)) throw new Error('配置修改时间必须为有效 ISO 时间')
  const before = collectConfiguration(previous)
  const after = collectConfiguration(next)
  const allowedPath = allowedProvenancePath(next, after.paths)
  const changed = [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])]
    .filter(path => JSON.stringify(before.fields[path]) !== JSON.stringify(after.fields[path]))
  const { provenance: _submitted, ...document } = next
  const trusted = previous.provenance
  const scheduledMonths = new Set(next.assignments.map(assignment => assignment.date.slice(0, 7)))
  const invalidatedSchedules: Record<string, ChangeStamp> = Object.create(null)
  for (const [month, stamp] of Object.entries(trusted?.invalidatedSchedules ?? {})) {
    if (scheduledMonths.has(month)) invalidatedSchedules[month] = { ...stamp }
  }
  if (changed.some(path => scheduleConfigurationRoots.has(path.split('.')[0]!))) {
    for (const month of scheduledMonths) invalidatedSchedules[month] = { source, at }
  }
  let scheduleUpdates = trusted?.scheduleUpdates
  // Manual configuration watchers may intentionally omit assignments from their
  // snapshots. Never infer an external schedule write from those local snapshots.
  if (source !== 'manual') {
    const months = changedScheduleMonths(previous, next)
    if (months.size) {
      scheduleUpdates = Object.assign(Object.create(null), trusted?.scheduleUpdates)
      for (const month of months) scheduleUpdates![month] = { source, at }
    }
  }
  if (!changed.length && !trusted && !scheduleUpdates) return document

  const fields: Record<string, ChangeStamp> = Object.create(null)
  for (const [path, stamp] of Object.entries(trusted?.fields ?? {})) {
    if (allowedPath(path)) fields[path] = { ...stamp }
  }
  const stamp: ChangeStamp = { source, at }
  for (const field of changed) {
    const parts = field.split('.')
    while (parts.length) {
      const path = parts.join('.')
      if (allowedPath(path)) fields[path] = { ...stamp }
      parts.pop()
    }
  }
  let pendingExternalChange = trusted?.pendingExternalChange
  if (source !== 'manual' && changed.length) {
    const affected = new Set([...(pendingExternalChange?.categories ?? []), ...changed.map(category)])
    pendingExternalChange = { source, at, categories: categories.filter(name => affected.has(name)) }
  }
  return { ...document, provenance: { fields, ...(pendingExternalChange ? { pendingExternalChange: { ...pendingExternalChange, categories: [...pendingExternalChange.categories] } } : {}), ...(scheduleUpdates ? { scheduleUpdates } : {}), ...(Object.keys(invalidatedSchedules).length ? { invalidatedSchedules } : {}) } }
}

/** A successful generation acknowledges only the months it actually replaced. */
export function markSchedulesCurrent<T extends PlannerDocument>(state: T, months: readonly string[]): T {
  const provenance = state.provenance
  const invalidated = provenance?.invalidatedSchedules
  if (!invalidated || !months.some(month => Object.hasOwn(invalidated, month))) return state
  const current = new Set(months)
  const remaining: Record<string, ChangeStamp> = Object.create(null)
  for (const [month, stamp] of Object.entries(invalidated)) if (!current.has(month)) remaining[month] = { ...stamp }
  const { invalidatedSchedules: _invalidated, ...history } = provenance
  return { ...state, provenance: { ...history, ...(Object.keys(remaining).length ? { invalidatedSchedules: remaining } : {}) } }
}

/** Validate persisted/imported metadata using actual document paths and bounded plain values. */
export function parseDataProvenance(value: unknown, state: PlannerDocument): DataProvenance {
  function fail(message: string): never { throw new Error(`备份格式错误：配置修改来源${message}`) }
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('必须是对象')
    return value as Record<string, unknown>
  }
  const exactKeys = (value: Record<string, unknown>, allowed: string[]) => {
    if (Object.keys(value).some(key => !allowed.includes(key))) fail('包含未知字段')
  }
  const raw = object(value)
  exactKeys(raw, ['fields', 'pendingExternalChange', 'scheduleUpdates', 'invalidatedSchedules'])
  if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_PROVENANCE_BYTES) fail('记录超过 4 MB')
  const rawFields = object(raw.fields)
  if (Object.keys(rawFields).length > MAX_PROVENANCE_FIELDS) fail(`记录不能超过 ${MAX_PROVENANCE_FIELDS} 项`)
  const allowedPath = allowedProvenancePath(state, collectConfiguration(state).paths)
  const fields: Record<string, ChangeStamp> = Object.create(null)
  for (const [path, value] of Object.entries(rawFields)) {
    // This is a flat dictionary, never a path setter. Actual IDs may themselves be
    // named "constructor"; they remain harmless dotted keys in a null-prototype map.
    if (path.length > 256 || !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(path) || !allowedPath(path)) fail('字段路径无效')
    const stamp = object(value)
    exactKeys(stamp, ['source', 'at'])
    if (stamp.source !== 'manual' && stamp.source !== 'mcp' && stamp.source !== 'http') fail('标记未知')
    if (!validTimestamp(stamp.at)) fail('时间必须为有效 ISO 时间')
    fields[path] = { source: stamp.source, at: stamp.at }
  }
  const provenance: DataProvenance = { fields }
  if (raw.invalidatedSchedules !== undefined) {
    const invalidated = object(raw.invalidatedSchedules)
    if (Object.keys(invalidated).length > 1200) fail('排班失效记录最多保存 1200 个月')
    const invalidatedSchedules: Record<string, ChangeStamp> = Object.create(null)
    for (const [month, value] of Object.entries(invalidated)) {
      if (!validMonth(month)) fail('排班失效月份必须为有效 YYYY-MM')
      const stamp = object(value)
      exactKeys(stamp, ['source', 'at'])
      if (stamp.source !== 'manual' && stamp.source !== 'mcp' && stamp.source !== 'http') fail('排班失效来源必须为手动、MCP 或 HTTP')
      if (!validTimestamp(stamp.at)) fail('排班失效时间必须为有效 ISO 时间')
      invalidatedSchedules[month] = { source: stamp.source, at: stamp.at }
    }
    if (Object.keys(invalidatedSchedules).length) provenance.invalidatedSchedules = invalidatedSchedules
  }
  if (raw.scheduleUpdates !== undefined) {
    const updates = object(raw.scheduleUpdates)
    if (Object.keys(updates).length > 1200) fail('排班更新时间最多保存 1200 个月')
    const scheduleUpdates: NonNullable<DataProvenance['scheduleUpdates']> = Object.create(null)
    for (const [month, value] of Object.entries(updates)) {
      if (!validMonth(month)) fail('排班更新月份必须为有效 YYYY-MM')
      const stamp = object(value)
      exactKeys(stamp, ['source', 'at'])
      if (stamp.source !== 'mcp' && stamp.source !== 'http') fail('排班更新来源必须为 MCP 或 HTTP')
      if (!validTimestamp(stamp.at)) fail('排班更新时间必须为有效 ISO 时间')
      scheduleUpdates[month] = { source: stamp.source, at: stamp.at }
    }
    provenance.scheduleUpdates = scheduleUpdates
  }
  if (raw.pendingExternalChange === undefined) return provenance
  const pending = object(raw.pendingExternalChange)
  exactKeys(pending, ['source', 'at', 'categories'])
  if (pending.source !== 'mcp' && pending.source !== 'http') fail('外部提示来源无效')
  if (!validTimestamp(pending.at)) fail('外部提示时间必须为有效 ISO 时间')
  if (!Array.isArray(pending.categories) || pending.categories.length < 1 || pending.categories.length > categories.length
    || new Set(pending.categories).size !== pending.categories.length
    || pending.categories.some(name => !categories.includes(name))) fail('外部提示分类无效')
  return { ...provenance, pendingExternalChange: { source: pending.source, at: pending.at, categories: [...pending.categories] } }
}
