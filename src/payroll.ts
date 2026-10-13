import type { PlannerState } from './domain'

import { isCivilDate as validDate } from './calendar.ts'
import type { DayKind } from './calendar.ts'
export { dayInfo, HOLIDAY_SOURCE } from './calendar.ts'
export type { DayKind } from './calendar.ts'
export interface PayrollSettings {
  monthlySalary: number
  monthlyWorkdays: number
  hoursPerDay: number
  statutoryMultiplier: number
  restdayMultiplier: number
  ordinaryMultiplier: number
  restdayCompensated: boolean
  employeeSalaries: Record<string, number>
  /** Legacy field, ignored by fixed-amount allowance calculations. */
  dateShiftMultipliers?: Record<string, Record<string, number>>
}
export interface PayrollConfig { payroll: PayrollSettings; calendar: Record<string, DayKind> }
export type PlannerDocument = PlannerState & Partial<PayrollConfig>
export interface PayrollRow {
  employeeId: string; name: string; hourlyRate: number; totalHours: number
  statutoryHours: number; restdayHours: number; ordinaryOvertimeHours: number
  statutoryAllowance: number; restdayAllowance: number; ordinaryAllowance: number; totalAllowance: number
  normalAllowance: number; customAllowance: number
}
export interface PayrollDayRow extends PayrollRow {
  date: string
  shiftIds: string[]
  carriedShiftIds: string[]
  sources: { shiftId: string; assignmentDate: string; hours: number }[]
}
export interface PayrollResult {
  rows: PayrollRow[]; dailyRows: PayrollDayRow[]; totalAllowance: number; statutoryHours: number; restdayHours: number
  ordinaryOvertimeHours: number; warnings: string[]
}
export const PAYROLL_NOTICE = '津贴按元/人/班固定金额计算，只依据排班开始日期，不按工资、工时或倍率折算。'
const dayMs = 86400000
// Used for displayed hours only. Monetary values never pass through floating-point rounding.
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
type Fraction = { numerator: bigint; denominator: bigint }
const zero: Fraction = { numerator: 0n, denominator: 1n }
function fraction(numerator: bigint, denominator: bigint): Fraction {
  if (numerator === 0n) return zero
  let a = numerator, b = denominator
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder }
  return { numerator: numerator / a, denominator: denominator / a }
}
/** Interpret the serialized decimal input, rather than its IEEE-754 binary approximation. */
function decimal(value: number): Fraction {
  if (!Number.isFinite(value) || value < 0) throw new Error('津贴计算金额必须是非负有限数字')
  const [coefficient, exponentText = '0'] = String(value).toLowerCase().split('e')
  const [whole = '0', tail = ''] = coefficient!.split('.')
  const numerator = BigInt(whole + tail)
  const scale = tail.length - Number(exponentText)
  return scale >= 0 ? fraction(numerator, 10n ** BigInt(scale)) : fraction(numerator * 10n ** BigInt(-scale), 1n)
}
function moneyFromCents(value: bigint): number {
  // Excel stores only 15 significant decimal digits. Check the exact integer cents
  // before converting to a number, including aggregate totals across employees.
  if (value > 999_999_999_999_999n) throw new Error('金额超出可精确计算和导出的上限，请调整班次津贴金额')
  return Number(value) / 100
}
export function createPayrollConfig(): PayrollConfig {
  return { payroll: { monthlySalary: 6000, monthlyWorkdays: 21.75, hoursPerDay: 8,
    statutoryMultiplier: 3, restdayMultiplier: 2, ordinaryMultiplier: 1.5,
    restdayCompensated: false, employeeSalaries: {}, dateShiftMultipliers: {} }, calendar: {} }
}

const hourFields = ['totalHours', 'statutoryHours', 'restdayHours', 'ordinaryOvertimeHours'] as const
function emptyRow(employeeId: string, name: string): PayrollRow {
  return { employeeId, name, hourlyRate: 0, totalHours: 0, statutoryHours: 0, restdayHours: 0,
    ordinaryOvertimeHours: 0, statutoryAllowance: 0, restdayAllowance: 0, ordinaryAllowance: 0,
    normalAllowance: 0, customAllowance: 0, totalAllowance: 0 }
}
const parseTime = (time: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : NaN
type Work = { start: number; finish: number; shiftId: string; date: string }
type Segment = { start: number; finish: number; shiftId: string; assignmentDate: string }
function fixedAmount(value: number, label: string): bigint {
  if (!Number.isFinite(value) || value < 0 || value > 100000000) throw new Error(`${label}必须在 0 至 100000000 元之间`)
  const exact = decimal(value)
  if (exact.numerator * 100n % exact.denominator !== 0n) throw new Error(`${label}最多保留两位小数`)
  return exact.numerator * 100n / exact.denominator
}

/** Fixed allowances belong to each shift's start date; hours are independently clipped to natural days. */
export function calculatePayroll(state: PlannerState, config: PayrollConfig = createPayrollConfig()): PayrollResult {
  // Retain the config argument for saved-document compatibility; salary, calendar
  // and historic multipliers do not participate in fixed shift allowances.
  void config
  const warnings = new Set<string>([PAYROLL_NOTICE])
  warnings.add('工时按自然日归属本月；月初跨夜工时需保留上月最后一天的排班记录，月末跨出部分计入下月。工时按完整班次时段统计，未自动扣除休息时间；固定津贴只在排班开始日期计一次。')
  const rows: PayrollRow[] = []
  const dailyRows: PayrollDayRow[] = []
  const monthStart = Date.parse(state.month + '-01T00:00:00Z')
  const endDate = new Date(monthStart)
  const monthEnd = endDate.setUTCMonth(endDate.getUTCMonth() + 1)
  let teamCents = 0n
  for (const employee of state.employees) {
    const daily = new Map<string, Segment[]>()
    const dayRows = new Map<string, PayrollDayRow>()
    const dayMoney = new Map<string, bigint>()
    const getDay = (date: string) => {
      let row = dayRows.get(date)
      if (!row) {
        row = { ...emptyRow(employee.id, employee.name), date, shiftIds: [], carriedShiftIds: [], sources: [] }
        dayRows.set(date, row); dayMoney.set(date, 0n)
      }
      return row
    }
    const works: Work[] = []
    const seenAssignments = new Set<string>()
    for (const assignment of state.assignments) {
      if (assignment.employeeId !== employee.id || assignment.shiftId === 'off' || !validDate(assignment.date)) continue
      const shift = state.shifts.find(item => item.id === assignment.shiftId)
      if (!shift) continue
      const key = `${assignment.date}\0${shift.id}`
      if (seenAssignments.has(key)) {
        if (assignment.date.startsWith(state.month + '-')) warnings.add(`${employee.name}在${assignment.date}有重复班次，工时和固定津贴均只计一次。`)
        continue
      }
      seenAssignments.add(key)
      if (assignment.date.startsWith(state.month + '-')) {
        const row = getDay(assignment.date)
        dayMoney.set(assignment.date, dayMoney.get(assignment.date)! + fixedAmount(shift.normalAllowance ?? 0, `${shift.name}的普通津贴`))
        row.shiftIds.push(shift.id)
        row.sources.push({ shiftId: shift.id, assignmentDate: assignment.date, hours: 0 })
      }
      const start = parseTime(shift.start), end = parseTime(shift.end)
      if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) {
        warnings.add(`${employee.name}的${assignment.date}班次时段无效，未计入工时；固定津贴仍按该排班记录计算。`); continue
      }
      const midnight = Date.parse(assignment.date + 'T00:00:00Z')
      const finish = midnight + (end <= start ? end + 1440 : end) * 60000
      works.push({ start: midnight + start * 60000, finish, shiftId: shift.id, date: assignment.date })
    }
    // Hours are still de-duplicated independently of fixed allowances, which were
    // already awarded per distinct assigned shift on its start date above.
    works.sort((a, b) => a.start - b.start || (a.shiftId < b.shiftId ? -1 : a.shiftId > b.shiftId ? 1 : 0) || a.finish - b.finish)
    let coveredUntil = -Infinity
    const assignmentDates = new Set<string>()
    for (const work of works) {
      const touchesMonth = work.finish > monthStart && work.start < monthEnd
      if (assignmentDates.has(work.date) && touchesMonth) warnings.add(`${employee.name}在${work.date}有多个不同班次，固定津贴分别计算，请核对排班。`)
      assignmentDates.add(work.date)
      if (work.start < coveredUntil && touchesMonth) warnings.add(`${employee.name}在${work.date}有重叠班次，工时仅计一次，固定津贴仍按各班次分别计算；重叠工时归开始时间较早的班次，同一开始时间按班次编号确定。`)
      let cursor = Math.max(work.start, coveredUntil)
      coveredUntil = Math.max(coveredUntil, work.finish)
      if (cursor >= work.finish) continue
      const finish = work.finish
      while (cursor < finish) {
        const boundary = (Math.floor(cursor / dayMs) + 1) * dayMs
        const segmentEnd = Math.min(boundary, finish)
        const date = new Date(cursor).toISOString().slice(0, 10)
        if (date.startsWith(state.month + '-')) {
          const segments = daily.get(date) ?? []
          segments.push({ start: cursor, finish: segmentEnd, shiftId: work.shiftId, assignmentDate: work.date })
          daily.set(date, segments)
        }
        cursor = segmentEnd
      }
    }
    for (const [date, segments] of daily) {
      const row = getDay(date)
      segments.sort((a, b) => a.start - b.start)
      for (const segment of segments) {
        const hours = (segment.finish - segment.start) / 3600000
        row.totalHours += hours
        if (!row.shiftIds.includes(segment.shiftId)) row.shiftIds.push(segment.shiftId)
        if (segment.assignmentDate !== date && !row.carriedShiftIds.includes(segment.shiftId)) row.carriedShiftIds.push(segment.shiftId)
        const source = row.sources.find(item => item.shiftId === segment.shiftId && item.assignmentDate === segment.assignmentDate)
        if (source) source.hours += hours
        else row.sources.push({ shiftId: segment.shiftId, assignmentDate: segment.assignmentDate, hours })
      }
    }
    const row = emptyRow(employee.id, employee.name)
    let normalCents = 0n
    for (const day of [...dayRows.values()].sort((a, b) => a.date.localeCompare(b.date))) {
      for (const field of hourFields) { row[field] += day[field]; day[field] = round(day[field]) }
      const dayNormalCents = dayMoney.get(day.date)!
      normalCents += dayNormalCents
      day.normalAllowance = moneyFromCents(dayNormalCents)
      day.totalAllowance = day.normalAllowance
      day.shiftIds.sort(); day.carriedShiftIds.sort()
      day.sources.sort((a, b) => a.assignmentDate.localeCompare(b.assignmentDate) || a.shiftId.localeCompare(b.shiftId))
      for (const source of day.sources) source.hours = round(source.hours)
      dailyRows.push(day)
    }
    for (const field of hourFields) row[field] = round(row[field])
    row.normalAllowance = moneyFromCents(normalCents)
    row.totalAllowance = row.normalAllowance
    teamCents += normalCents
    rows.push(row)
  }
  const sum = (field: keyof PayrollRow) => round(rows.reduce((total, row) => total + Number(row[field]), 0))
  return { rows, dailyRows, totalAllowance: moneyFromCents(teamCents), statutoryHours: sum('statutoryHours'), restdayHours: sum('restdayHours'), ordinaryOvertimeHours: sum('ordinaryOvertimeHours'), warnings: [...warnings] }
}

export function payrollRows(result: PayrollResult): (string | number)[][] {
  return [
    ['员工', '本月工时', '额外津贴（固定元/人/班）'],
    ...result.rows.map(row => [row.name, row.totalHours, row.totalAllowance]),
    ['合计', round(result.rows.reduce((sum, row) => sum + row.totalHours, 0)), result.totalAllowance],
    [],
    ['每日明细', '日期', '计入工时', '当日额外津贴（固定）', '班次及开始日期'],
    ...result.dailyRows.map(row => [row.name, row.date, row.totalHours, row.totalAllowance, row.sources.map(source => `${source.assignmentDate} ${source.shiftId} ${source.hours}h`).join('；')]),
    ...result.warnings.map(warning => [warning]),
  ]
}
