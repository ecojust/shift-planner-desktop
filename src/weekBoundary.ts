import type { PlannerState } from './domain.ts'
import { isCivilDate } from './calendar.ts'

const DAY = 86_400_000
const text = (time: number) => new Date(time).toISOString().slice(0, 10)
type BoundaryState = Pick<PlannerState, 'month' | 'employees' | 'assignments'> & Pick<PlannerState, 'scheduleCoverage'>

export interface BoundaryEmployeeWeek {
  employeeId: string
  knownDates: string[]
  unknownPastDates: string[]
  unknownFutureDates: string[]
}
export interface BoundaryWeek {
  weekStart: string
  weekEnd: string
  dates: string[]
  monthDates: string[]
  outsideDates: string[]
  employees: BoundaryEmployeeWeek[]
}
export interface WeekBoundaryContext {
  startDate: string
  endDate: string
  referenceDate: string
  weeks: BoundaryWeek[]
  incompleteHistory: Array<{ employeeId: string; weekStart: string; unknownDates: string[] }>
}
export interface BoundaryOptions { referenceDate?: string }
export function schedulingReferenceDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** An explicit cell is known; a blank is rest only after that member's whole
 * month has been generated/confirmed. A colleague's record proves nothing. */
export function isBoundaryCellKnown(state: BoundaryState, employeeId: string, date: string): boolean {
  return state.scheduleCoverage?.[date.slice(0, 7)]?.employeeIds.includes(employeeId) === true
    || state.assignments.some(item => item.employeeId === employeeId && item.date === date)
}

/** The reference date is frozen by the request so local and native solvers use
 * the same distinction between unknown history and future planning. */
export function getWeekBoundaryContext(state: BoundaryState, options: BoundaryOptions = {}): WeekBoundaryContext | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(state.month) || state.month.startsWith('0000-')) return null
  const referenceDate = options.referenceDate ?? schedulingReferenceDate()
  if (!isCivilDate(referenceDate)) return null
  const first = Date.parse(`${state.month}-01T00:00:00Z`)
  if (!Number.isFinite(first)) return null
  const following = new Date(first)
  following.setUTCMonth(following.getUTCMonth() + 1)
  const last = following.getTime() - DAY
  const start = first - ((new Date(first).getUTCDay() + 6) % 7) * DAY
  const end = last + (6 - (new Date(last).getUTCDay() + 6) % 7) * DAY
  const boundaryCells = new Set(state.assignments.filter(item => !item.date.startsWith(`${state.month}-`) && item.date >= text(start) && item.date <= text(end))
    .map(item => `${item.employeeId}\0${item.date}`))
  const confirmed = new Map(Object.entries(state.scheduleCoverage ?? {}).map(([month, record]) => [month, new Set(record.employeeIds)]))
  const known = (employeeId: string, date: string) => confirmed.get(date.slice(0, 7))?.has(employeeId) || boundaryCells.has(`${employeeId}\0${date}`)
  const weeks: BoundaryWeek[] = []
  for (let monday = start; monday <= end; monday += 7 * DAY) {
    const dates = Array.from({ length: 7 }, (_, index) => text(monday + index * DAY))
    const outsideDates = dates.filter(date => !date.startsWith(`${state.month}-`))
    weeks.push({ weekStart: dates[0]!, weekEnd: dates[6]!, dates,
      monthDates: dates.filter(date => date.startsWith(`${state.month}-`)), outsideDates,
      employees: state.employees.map(employee => {
        const knownDates = outsideDates.filter(date => known(employee.id, date))
        const unknown = outsideDates.filter(date => !knownDates.includes(date))
        return { employeeId: employee.id, knownDates,
          unknownPastDates: unknown.filter(date => date < referenceDate),
          unknownFutureDates: unknown.filter(date => date >= referenceDate) }
      }) })
  }
  return { startDate: text(start), endDate: text(end), referenceDate, weeks,
    incompleteHistory: weeks.flatMap(week => week.employees.filter(employee => employee.unknownPastDates.length)
      .map(employee => ({ employeeId: employee.employeeId, weekStart: week.weekStart, unknownDates: employee.unknownPastDates }))) }
}

export interface PreviousWeekContext {
  previousMonth: string
  weekStart: string
  weekEnd: string
  historyDates: string[]
}
/** Compatibility helper: only complete member-by-member history is complete. */
export function getPreviousWeekContext(state: BoundaryState): PreviousWeekContext | null {
  const context = getWeekBoundaryContext(state)
  const week = context?.weeks[0]
  if (!week || !week.outsideDates.length || week.outsideDates[0]! > `${state.month}-01`
    || week.employees.some(employee => employee.knownDates.length !== week.outsideDates.length)) return null
  return { previousMonth: week.outsideDates[0]!.slice(0, 7), weekStart: week.weekStart, weekEnd: week.weekEnd, historyDates: week.outsideDates }
}
