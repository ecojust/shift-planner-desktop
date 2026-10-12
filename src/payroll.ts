import type { PlannerState } from './domain'

import { dayInfo, isCivilDate as validDate, calendarYearInfo } from './calendar.ts'
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
}
export interface PayrollConfig { payroll: PayrollSettings; calendar: Record<string, DayKind> }
export type PlannerDocument = PlannerState & Partial<PayrollConfig>
export interface PayrollRow {
  employeeId: string; name: string; hourlyRate: number; totalHours: number
  statutoryHours: number; restdayHours: number; ordinaryOvertimeHours: number
  statutoryAllowance: number; restdayAllowance: number; ordinaryAllowance: number; totalAllowance: number
}
export interface PayrollResult {
  rows: PayrollRow[]; totalAllowance: number; statutoryHours: number; restdayHours: number
  ordinaryOvertimeHours: number; warnings: string[]
}
export const PAYROLL_NOTICE = '按标准工时制估算；金额为加班工资，不含月薪。实际结算需核对工资基数、实际出勤、补休及适用工时制度。'
const dayMs = 86400000
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
export function createPayrollConfig(): PayrollConfig {
  return { payroll: { monthlySalary: 6000, monthlyWorkdays: 21.75, hoursPerDay: 8,
    statutoryMultiplier: 3, restdayMultiplier: 2, ordinaryMultiplier: 1.5,
    restdayCompensated: false, employeeSalaries: {} }, calendar: {} }
}

/** Natural-day accounting: split overnight shifts at midnight, then clip to the selected calendar month. */
export function calculatePayroll(state: PlannerState, config: PayrollConfig = createPayrollConfig()): PayrollResult {
  const settings = config.payroll
  if (!Number.isFinite(settings.monthlyWorkdays) || settings.monthlyWorkdays <= 0 || !Number.isFinite(settings.hoursPerDay) || settings.hoursPerDay <= 0) throw new Error('月计薪天数和标准日工时必须大于 0')
  const warnings = new Set<string>([PAYROLL_NOTICE])
  const calendarInfo = calendarYearInfo(Number(state.month.slice(0, 4)))
  if (!calendarInfo.verified) warnings.add(`${calendarInfo.reason}未手动确认的日期暂按工作日和周末估算，请核对后再结算。`)
  warnings.add('按自然日归属本月工时；月初跨夜工时需保留上月最后一天的排班记录，月末跨出部分计入下月。班次时段视为全程计薪，未自动扣除休息时间。')
  const rows: PayrollRow[] = []
  for (const employee of state.employees) {
    const salary = settings.employeeSalaries[employee.id] ?? settings.monthlySalary
    const hourlyRate = Math.max(0, Number.isFinite(salary) ? salary : 0) / settings.monthlyWorkdays / settings.hoursPerDay
    const daily = new Map<string, Array<[number, number]>>()
    for (const assignment of state.assignments) {
      if (assignment.employeeId !== employee.id || assignment.shiftId === 'off' || !validDate(assignment.date)) continue
      const shift = state.shifts.find(item => item.id === assignment.shiftId)
      if (!shift) continue
      const parse = (time: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : NaN
      const start = parse(shift.start), end = parse(shift.end)
      if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) {
        warnings.add(`${employee.name}的${assignment.date}班次时段无效，未计入金额。`); continue
      }
      const midnight = Date.parse(assignment.date + 'T00:00:00Z')
      let cursor = midnight + start * 60000
      const finish = midnight + (end <= start ? end + 1440 : end) * 60000
      while (cursor < finish) {
        const boundary = (Math.floor(cursor / dayMs) + 1) * dayMs
        const segmentEnd = Math.min(boundary, finish)
        const date = new Date(cursor).toISOString().slice(0, 10)
        if (date.startsWith(state.month + '-')) {
          const segments = daily.get(date) ?? []; segments.push([cursor, segmentEnd]); daily.set(date, segments)
        }
        cursor = segmentEnd
      }
    }
    let statutoryHours = 0, restdayHours = 0, ordinaryOvertimeHours = 0, totalHours = 0
    for (const [date, segments] of daily) {
      // Merge accidental overlapping entries so duplicate imports cannot inflate pay.
      segments.sort((a, b) => a[0] - b[0])
      let totalMs = 0, currentStart = segments[0]![0], currentEnd = segments[0]![1]
      for (const [start, end] of segments.slice(1)) {
        if (start < currentEnd) warnings.add(`${employee.name}在${date}有重叠班次，津贴仅计不重复工时。`)
        if (start <= currentEnd) currentEnd = Math.max(currentEnd, end)
        else { totalMs += currentEnd - currentStart; currentStart = start; currentEnd = end }
      }
      totalMs += currentEnd - currentStart
      const hours = totalMs / 3600000
      totalHours += hours
      const info = dayInfo(date, config.calendar)
      if (info.kind === 'statutory') statutoryHours += hours
      else if (info.kind === 'restday') restdayHours += hours
      else ordinaryOvertimeHours += Math.max(0, hours - settings.hoursPerDay)
    }
    const statutoryAllowance = round(hourlyRate * statutoryHours * settings.statutoryMultiplier)
    const restdayAllowance = settings.restdayCompensated ? 0 : round(hourlyRate * restdayHours * settings.restdayMultiplier)
    const ordinaryAllowance = round(hourlyRate * ordinaryOvertimeHours * settings.ordinaryMultiplier)
    rows.push({ employeeId: employee.id, name: employee.name, hourlyRate: round(hourlyRate), totalHours: round(totalHours),
      statutoryHours: round(statutoryHours), restdayHours: round(restdayHours), ordinaryOvertimeHours: round(ordinaryOvertimeHours),
      statutoryAllowance, restdayAllowance, ordinaryAllowance, totalAllowance: round(statutoryAllowance + restdayAllowance + ordinaryAllowance) })
  }
  const sum = (field: keyof PayrollRow) => round(rows.reduce((total, row) => total + Number(row[field]), 0))
  return { rows, totalAllowance: sum('totalAllowance'), statutoryHours: sum('statutoryHours'), restdayHours: sum('restdayHours'), ordinaryOvertimeHours: sum('ordinaryOvertimeHours'), warnings: [...warnings] }
}

export function payrollRows(result: PayrollResult): (string | number)[][] {
  return [
    ['员工', '小时工资（元）', '本月工时', '法定日工时', '休息日工时', '工作日延时', '法定日加班工资', '休息日加班工资', '工作日延时工资', '加班工资合计'],
    ...result.rows.map(row => [row.name, row.hourlyRate, row.totalHours, row.statutoryHours, row.restdayHours, row.ordinaryOvertimeHours, row.statutoryAllowance, row.restdayAllowance, row.ordinaryAllowance, row.totalAllowance]),
    ['合计', '', '', result.statutoryHours, result.restdayHours, result.ordinaryOvertimeHours, '', '', '', result.totalAllowance],
    ...result.warnings.map(warning => [warning]),
  ]
}
