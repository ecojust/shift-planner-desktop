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
 * Every date retains the sum of per-shift minimum coverage; optional shifts count
 * toward available staffing too. Hour limits, rest, eligibility by shift and
 * separation groups still require the scheduler to solve the actual assignments.
 */
export function weekdayWeightCapacity(state: PlannerState): { maxPercent: number | null; explanation: string } {
  const explanation = '在每班每日最低人数不减少的前提下，枚举可增排的完整周班次数，按每人每天最多一班、请假、可上班次及锁定安排估算人数上限；各班资格、休息间隔、工时上下限和互斥规则仍须通过求解，不代表一定可排。'
  const rule = state.rules.weekdayWeights
  if (!rule || weekdayWeightRuleError(rule)) return { maxPercent: null, explanation }
  const weeks = weightedWeeks(state)
  if (!weeks.length) return { maxPercent: null, explanation }
  const capacity = new Map<string, number>()
  const minimum = new Map<string, number>()
  const shifts = new Set(state.shifts.map(shift => shift.id))
  const locked = new Map(state.assignments.filter(a => a.locked).map(a => [`${a.employeeId}:${a.date}`, a.shiftId]))
  for (const week of weeks) for (const date of week.dates) {
    capacity.set(date, state.employees.filter(employee => {
      if (employee.unavailableDates.includes(date) || employee.maxHoursPerWeek <= 0) return false
      const fixed = locked.get(`${employee.id}:${date}`)
      if (fixed !== undefined) return fixed !== 'off' && shifts.has(fixed) && employee.eligibleShiftIds.includes(fixed)
      return employee.eligibleShiftIds.some(id => shifts.has(id))
    }).length)
    minimum.set(date, state.shifts.reduce((sum, shift) => sum + Math.max(shift.required, new Set(state.assignments.filter(a => a.date === date && a.locked && a.shiftId === shift.id).map(a => a.employeeId)).size), 0))
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
