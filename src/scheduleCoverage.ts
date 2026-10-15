import type { PlannerState, ScheduleMonthCoverage } from './domain.ts'
import { isCivilDate } from './calendar.ts'

export const MAX_SCHEDULE_COVERAGE_MONTHS = 1200
export const MAX_SCHEDULE_COVERAGE_EMPLOYEES = 200

function validMonth(month: string): boolean {
  return /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month)
}

function replaceCoverage<T extends PlannerState>(state: T, coverage: Record<string, ScheduleMonthCoverage>): T {
  if (Object.keys(coverage).length) return { ...state, scheduleCoverage: coverage }
  const { scheduleCoverage: _removed, ...rest } = state
  return rest as T
}

/** Remove deleted members without inferring completeness from existing assignments. */
export function pruneScheduleCoverage<T extends PlannerState>(state: T): T {
  if (!state.scheduleCoverage) return state
  const employeeIds = new Set(state.employees.map(employee => employee.id))
  const coverage: Record<string, ScheduleMonthCoverage> = Object.create(null)
  let changed = false
  for (const [month, entry] of Object.entries(state.scheduleCoverage)) {
    const remaining = entry.employeeIds.filter(id => employeeIds.has(id))
    if (!remaining.length) { changed = true; continue }
    if (remaining.length !== entry.employeeIds.length) {
      coverage[month] = { employeeIds: remaining }
      changed = true
    } else coverage[month] = entry
  }
  return changed ? replaceCoverage(state, coverage) : state
}

/** Record every current member's completed month after trusted generation. */
export function markScheduleCoverageComplete<T extends PlannerState>(state: T, months: readonly string[]): T {
  if (months.some(month => !validMonth(month))) throw new Error('排班覆盖月份必须为有效 YYYY-MM')
  const current = pruneScheduleCoverage(state)
  const ids = current.employees.map(employee => employee.id)
  if (ids.length > MAX_SCHEDULE_COVERAGE_EMPLOYEES) throw new Error('排班覆盖成员不能超过 200 人')
  const coverage: Record<string, ScheduleMonthCoverage> = Object.assign(Object.create(null), current.scheduleCoverage)
  let changed = false
  for (const month of new Set(months)) {
    if (!ids.length) {
      if (Object.hasOwn(coverage, month)) { delete coverage[month]; changed = true }
      continue
    }
    const previous = coverage[month]?.employeeIds
    // Member ordering is presentation only and does not alter known dates.
    if (previous?.length === ids.length && ids.every(id => previous.includes(id))) continue
    coverage[month] = { employeeIds: [...ids] }
    changed = true
  }
  if (Object.keys(coverage).length > MAX_SCHEDULE_COVERAGE_MONTHS) throw new Error('排班覆盖最多保存 1200 个月')
  return changed ? replaceCoverage(current, coverage) : current
}

/** Clearing a month must explicitly revoke the meaning of its formerly blank cells. */
export function clearScheduleCoverage<T extends PlannerState>(state: T, months: readonly string[]): T {
  if (!state.scheduleCoverage || !months.some(month => Object.hasOwn(state.scheduleCoverage!, month))) return state
  const removed = new Set(months)
  const coverage: Record<string, ScheduleMonthCoverage> = Object.create(null)
  for (const [month, entry] of Object.entries(state.scheduleCoverage)) if (!removed.has(month)) coverage[month] = entry
  return replaceCoverage(state, coverage)
}

/** A single saved work/rest record never upgrades the rest of its month to known. */
export function isScheduleDateKnown(state: PlannerState, employeeId: string, date: string): boolean {
  if (!isCivilDate(date) || date.startsWith('0000-') || !state.employees.some(employee => employee.id === employeeId)) return false
  return state.assignments.some(assignment => assignment.employeeId === employeeId && assignment.date === date)
    || state.scheduleCoverage?.[date.slice(0, 7)]?.employeeIds.includes(employeeId) === true
}
