import type { PlannerState } from './domain.ts'

export interface WeightedWeek {
  id: string
  dates: string[]
  selectedDates: string[]
  otherDates: string[]
  totalTarget: number
  selectedTarget: number
  otherTarget: number
  /** Complete seven-day baseline; examples do not constrain the solver. */
  fullTotal: number
}

export function weekdayWeightRuleError(value: unknown): string | null {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '上班权重必须包含星期和百分比。'
  const rule = value as Record<string, unknown>
  if (!Array.isArray(rule.days) || rule.days.length === 0 || rule.days.length > 7 || rule.days.some(d => !Number.isInteger(d) || d < 1 || d > 7) || new Set(rule.days).size !== rule.days.length) return '请选择不重复的星期，范围为 1–7。'
  if (typeof rule.percent !== 'number' || !Number.isInteger(rule.percent) || rule.percent < 0 || rule.percent > 100) return '上班权重百分比必须为 0–100 的整数。'
  if (rule.days.length === 7 && rule.percent !== 100) return '选中全部七天时，合计比例必须为 100%。'
  return null
}

const DAY = 86400000
function isoDay(date: string) { return new Date(`${date}T00:00:00Z`).getUTCDay() || 7 }

type WeightRule = NonNullable<PlannerState['rules']['weekdayWeights']>
type WeekDates = Pick<WeightedWeek, 'id' | 'dates' | 'selectedDates' | 'otherDates'>

/** Exact integer ceiling without multiplying a large safe integer beyond its range. */
function ceilShare(value: number, numerator: number, denominator: number) {
  return Math.floor(value / denominator) * numerator + Math.ceil((value % denominator) * numerator / denominator)
}
function targets(week: WeekDates, rule: WeightRule, fullTotal: number): WeightedWeek {
  const selectedFull = ceilShare(fullTotal, rule.percent, 100)
  const selectedTarget = ceilShare(selectedFull, week.selectedDates.length, rule.days.length)
  const otherTarget = rule.days.length === 7 ? 0 : ceilShare(fullTotal - selectedFull, week.otherDates.length, 7 - rule.days.length)
  return { ...week, fullTotal, selectedTarget, otherTarget, totalTarget: selectedTarget + otherTarget }
}

/**
 * Preview only: fullTotal is an explicit seven-day example, not a fixed staffing quota.
 * Missing weekdays retain their shares outside the month and are never renormalized.
 * The default example uses minimum daily coverage × 7; it may not meet the weights.
 */
export function weightedWeeks(state: PlannerState, fullTotal = state.shifts.reduce((sum, shift) => sum + shift.required, 0) * 7): WeightedWeek[] {
  const rule = state.rules.weekdayWeights
  if (!rule || weekdayWeightRuleError(rule) || !Number.isSafeInteger(fullTotal) || fullTotal < 0) return []
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(state.month) || Number(state.month.slice(0, 4)) < 1) return []
  const first = Date.parse(`${state.month}-01T00:00:00Z`)
  if (!Number.isFinite(first)) return []
  const groups = new Map<string, string[]>()
  for (let time = first; new Date(time).toISOString().slice(0, 7) === state.month; time += DAY) {
    const date = new Date(time).toISOString().slice(0, 10)
    const monday = new Date(time - (isoDay(date) - 1) * DAY).toISOString().slice(0, 10)
    if (!groups.has(monday)) groups.set(monday, [])
    groups.get(monday)!.push(date)
  }
  return [...groups].map(([id, dates]) => targets({
    id, dates,
    selectedDates: dates.filter(date => rule.days.includes(isoDay(date))),
    otherDates: dates.filter(date => !rule.days.includes(isoDay(date))),
  }, rule, fullTotal))
}

/**
 * Match actual group totals to a legal complete-week baseline W ∈ [0, 7 × employees].
 * A full week's W equals its actual total; a partial week may have several witnesses.
 * This checks the group totals only. Callers must also enforce coverage and balanced
 * daily counts (difference ≤ 1) within each group, plus all employee constraints.
 */
export function findWeightedWeek(state: PlannerState, week: WeightedWeek, selectedActual: number, otherActual: number): WeightedWeek | null {
  const rule = state.rules.weekdayWeights
  if (!rule || weekdayWeightRuleError(rule) || !Number.isSafeInteger(selectedActual) || selectedActual < 0 || !Number.isSafeInteger(otherActual) || otherActual < 0) return null
  if (selectedActual > week.selectedDates.length * state.employees.length || otherActual > week.otherDates.length * state.employees.length) return null
  const max = state.employees.length * 7
  const full = week.dates.length === 7
  const start = full ? selectedActual + otherActual : 0
  const end = full ? Math.min(start, max) : max
  for (let total = start; total <= end; total++) {
    const result = targets(week, rule, total)
    if (result.selectedTarget === selectedActual && result.otherTarget === otherActual) return result
  }
  return null
}

export function weightedDayRange(week: WeightedWeek, date: string): [number, number] {
  if (!week.dates.includes(date)) return [0, 0]
  const selected = week.selectedDates.includes(date)
  const count = selected ? week.selectedDates.length : week.otherDates.length
  const total = selected ? week.selectedTarget : week.otherTarget
  return count ? [Math.floor(total / count), Math.ceil(total / count)] : [0, 0]
}

/**
 * Necessary headcount upper bound with a variable W, never a feasibility guarantee.
 * Every date retains required coverage and fixed shifts also cap its headcount.
 * Minimum-mode optional shifts can grow; fixed zero-capacity shifts cannot.
 * Hour limits, rest, detailed eligibility matching and
 * separation groups still require the scheduler to solve the actual assignments.
 */
export function weekdayWeightCapacity(state: PlannerState): { maxPercent: number | null; explanation: string } {
  const explanation = '按全部班次满足人数要求估算：最低人数班可增排，固定人数班不能超额；结合每人每天最多一班、请假、可上班次及锁定安排计算人数上限。班次资格、休息间隔、工时上下限和互斥规则仍须在生成排班时同时满足，该估算不代表一定可排。'
  const rule = state.rules.weekdayWeights
  if (!rule || weekdayWeightRuleError(rule)) return { maxPercent: null, explanation }
  const weeks = weightedWeeks(state)
  if (!weeks.length) return { maxPercent: null, explanation }
  const capacity = new Map<string, number>()
  const minimum = new Map<string, number>()
  const shifts = new Map(state.shifts.map(shift => [shift.id, shift]))
  const employees = new Map(state.employees.map(employee => [employee.id, employee]))
  const lockedByDate = new Map<string, Map<string, Set<string>>>()
  for (const assignment of state.assignments) {
    if (!assignment.locked) continue
    let byEmployee = lockedByDate.get(assignment.date)
    if (!byEmployee) lockedByDate.set(assignment.date, byEmployee = new Map())
    let ids = byEmployee.get(assignment.employeeId)
    if (!ids) byEmployee.set(assignment.employeeId, ids = new Set())
    ids.add(assignment.shiftId)
  }
  for (const week of weeks) for (const date of week.dates) {
    const locked = lockedByDate.get(date) ?? new Map<string, Set<string>>()
    const lockedCounts = new Map<string, number>()
    let workingLocks = 0
    for (const [employeeId, ids] of locked) {
      const employee = employees.get(employeeId)
      if (!employee || ids.size !== 1) return { maxPercent: null, explanation }
      const shiftId = ids.values().next().value!
      if (shiftId === 'off') continue
      const shift = shifts.get(shiftId)
      if (!shift || !employee.eligibleShiftIds.includes(shiftId) || employee.unavailableDates.includes(date) || employee.maxHoursPerWeek <= 0) return { maxPercent: null, explanation }
      const count = (lockedCounts.get(shiftId) ?? 0) + 1
      if (shift.staffingMode === 'fixed' && count > shift.required) return { maxPercent: null, explanation }
      lockedCounts.set(shiftId, count)
      workingLocks++
    }
    const available = state.employees.filter(employee => !locked.has(employee.id) && !employee.unavailableDates.includes(date) && employee.maxHoursPerWeek > 0)
    const eligibleEmployees = new Set<string>()
    let availableSlots = 0
    let required = 0
    for (const shift of state.shifts) {
      const count = lockedCounts.get(shift.id) ?? 0
      required += Math.max(shift.required, count)
      const remaining = shift.staffingMode === 'fixed' ? shift.required - count : available.length
      if (remaining <= 0) continue
      let eligible = 0
      for (const employee of available) {
        if (!employee.eligibleShiftIds.includes(shift.id)) continue
        eligible++
        eligibleEmployees.add(employee.id)
      }
      availableSlots += Math.min(remaining, eligible)
    }
    // Both bounds can overestimate a bipartite employee/shift matching, but
    // neither can underestimate it. Shared qualifications must not be greedily
    // consumed here: that could turn a feasible mixed-mode model into "no room".
    capacity.set(date, workingLocks + Math.min(eligibleEmployees.size, availableSlots))
    minimum.set(date, required)
    if (minimum.get(date)! > capacity.get(date)!) return { maxPercent: null, explanation }
  }
  function fitsGroup(dates: string[], total: number) {
    if (!dates.length) return total === 0
    const low = Math.floor(total / dates.length), high = Math.ceil(total / dates.length)
    let min = 0, max = 0
    for (const date of dates) {
      const lower = Math.max(low, minimum.get(date) ?? 0), upper = Math.min(high, capacity.get(date) ?? 0)
      if (lower > upper) return false
      min += lower; max += upper
    }
    return min <= total && total <= max
  }
  for (let percent = 100; percent >= 0; percent--) {
    if (rule.days.length === 7 && percent !== 100) continue
    const candidate = { days: rule.days, percent }
    const possible = weeks.every(week => {
      const firstTotal = week.dates.length === 7 ? week.dates.reduce((sum, date) => sum + minimum.get(date)!, 0) : 0
      const lastTotal = week.dates.length === 7 ? week.dates.reduce((sum, date) => sum + capacity.get(date)!, 0) : state.employees.length * 7
      for (let fullTotal = firstTotal; fullTotal <= lastTotal; fullTotal++) {
        const result = targets(week, candidate, fullTotal)
        if (fitsGroup(week.selectedDates, result.selectedTarget) && fitsGroup(week.otherDates, result.otherTarget)) return true
      }
      return false
    })
    if (possible) return { maxPercent: percent, explanation }
  }
  return { maxPercent: null, explanation }
}
