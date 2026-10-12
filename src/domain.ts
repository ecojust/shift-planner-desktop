export interface Employee {
  id: string
  name: string
  role: string
  group: string
  color: string
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
}

export interface Rules {
  minRestHours: number
  maxConsecutiveDays: number
  balanceWeekends: boolean
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
