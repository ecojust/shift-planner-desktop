export interface Employee {
  id: string
  name: string
  role: string
  group: string
  color: string
  /** null follows this month's team reference; missing is a legacy zero minimum. */
  minHoursPerMonth?: number | null
  minHoursPerWeek?: number
  maxHoursPerWeek: number
  eligibleShiftIds: string[]
  unavailableDates: string[]
}

export interface Shift {
  id: string
  name: string
  shortName: string
  start: string
  end: string
  color: string
  required: number
  /** Fixed yuan per person per shift, paid once on the start date; missing means 0. */
  normalAllowance?: number
}

export interface Rules {
  minRestHours: number
  maxConsecutiveDays: number
  /** Legacy backup key, ignored by the current scheduler. */
  balanceWeekends?: boolean
  /** Team-wide hard allocation; ISO weekdays: Monday=1, Sunday=7. */
  weekdayWeights?: { days: number[]; percent: number }
  /** Each group permits at most one member per date / shift. Empty shiftIds means all shifts. */
  separationGroups?: { id: string; name: string; employeeIds: string[]; shiftIds: string[] }[]
}

export interface Assignment {
  employeeId: string
  date: string
  /** `off` is an explicit day off; locked days off survive generation. */
  shiftId: string
  locked: boolean
}

export interface PlannerState {
  version: 1
  teamName: string
  /** YYYY-MM */
  month: string
  /** Manual reference hours by YYYY-MM. Missing months use calendar workdays × 8. */
  monthlyReferenceHours?: Record<string, number>
  employees: Employee[]
  shifts: Shift[]
  rules: Rules
  assignments: Assignment[]
}

export interface Issue {
  id: string
  type: string
  severity: 'error' | 'warning'
  message: string
  date?: string
  employeeId?: string
}
