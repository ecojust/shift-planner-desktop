import type { PlannerState } from './domain.ts'
import { isCivilDate } from './calendar.ts'

const DAY = 86_400_000

export interface PreviousWeekContext {
  previousMonth: string
  weekStart: string
  /** Sunday, inclusive. */
  weekEnd: string
  /** The retained days from Monday through the day before this month. */
  historyDates: string[]
}

/** Sparse saved rosters leave rest days blank. Any current member's record in
 * the previous month, including an explicit rest day, makes that month known. */
export function getPreviousWeekContext(state: Pick<PlannerState, 'month' | 'employees' | 'assignments'>): PreviousWeekContext | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(state.month) || state.month.startsWith('0000-')) return null
  const first = Date.parse(`${state.month}-01T00:00:00Z`)
  if (!Number.isFinite(first)) return null
  const previousDays = (new Date(first).getUTCDay() + 6) % 7
  if (!previousDays) return null
  const previousMonth = new Date(first - DAY).toISOString().slice(0, 7)
  const employeeIds = new Set(state.employees.map(employee => employee.id))
  if (!state.assignments.some(assignment => employeeIds.has(assignment.employeeId)
    && assignment.date.startsWith(`${previousMonth}-`) && isCivilDate(assignment.date))) return null
  const start = first - previousDays * DAY
  const text = (time: number) => new Date(time).toISOString().slice(0, 10)
  return {
    previousMonth,
    weekStart: text(start),
    weekEnd: text(start + 6 * DAY),
    historyDates: Array.from({ length: previousDays }, (_, index) => text(start + index * DAY)),
  }
}
