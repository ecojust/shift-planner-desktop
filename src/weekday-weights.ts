import type { PlannerState, Rules } from './domain.ts'

export interface WeightedWeek {
  id: string
  dates: string[]
  selectedDates: string[]
  otherDates: string[]
  totalTarget: number
  selectedTarget: number
  otherTarget: number
  shiftTargets: Record<string, number>
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

/** Allocate integer shift budgets without rounding up once per shift. Ties follow shift order. */
function shiftBudgets(state: PlannerState, total: number): Record<string, number> {
  const baseline = state.shifts.reduce((sum, shift) => sum + shift.required, 0)
  const result: Record<string, number> = Object.create(null)
  const remainder = state.shifts.map((shift, index) => {
    result[shift.id] = baseline ? Math.floor(total * shift.required / baseline) : 0
    return { id: shift.id, index, fraction: baseline ? total * shift.required % baseline : 0 }
  }).sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  const unassigned = total - Object.values(result).reduce((sum, count) => sum + count, 0)
  for (let i = 0; i < unassigned; i++) result[remainder[i]!.id]!++
  return result
}

/** Missing weekdays keep their share outside the month: never renormalize a partial week. */
export function weightedWeeks(state: PlannerState): WeightedWeek[] {
  const rule = state.rules.weekdayWeights
  if (!rule || weekdayWeightRuleError(rule)) return []
  const first = Date.parse(`${state.month}-01T00:00:00Z`)
  if (!Number.isFinite(first)) return []
  const groups = new Map<string, string[]>()
  for (let time = first; new Date(time).toISOString().slice(0, 7) === state.month; time += DAY) {
    const date = new Date(time).toISOString().slice(0, 10)
    const monday = new Date(time - (isoDay(date) - 1) * DAY).toISOString().slice(0, 10)
    if (!groups.has(monday)) groups.set(monday, [])
    groups.get(monday)!.push(date)
  }
  const fullTotal = state.shifts.reduce((sum, shift) => sum + shift.required, 0) * 7
  const fullSelected = Math.ceil(fullTotal * rule.percent / 100)
  const fullOther = fullTotal - fullSelected
  return [...groups].map(([id, dates]) => {
    const selectedDates = dates.filter(date => rule.days.includes(isoDay(date)))
    const otherDates = dates.filter(date => !rule.days.includes(isoDay(date)))
    const selectedTarget = Math.ceil(fullSelected * selectedDates.length / rule.days.length)
    const otherTarget = rule.days.length === 7 ? 0 : Math.ceil(fullOther * otherDates.length / (7 - rule.days.length))
    const totalTarget = selectedTarget + otherTarget
    return { id, dates, selectedDates, otherDates, totalTarget, selectedTarget, otherTarget, shiftTargets: shiftBudgets(state, totalTarget) }
  })
}

export function weightedDayRange(week: WeightedWeek, date: string): [number, number] {
  if (!week.dates.includes(date)) return [0, 0]
  const selected = week.selectedDates.includes(date)
  const count = selected ? week.selectedDates.length : week.otherDates.length
  const total = selected ? week.selectedTarget : week.otherTarget
  return count ? [Math.floor(total / count), Math.ceil(total / count)] : [0, 0]
}

/** A necessary headcount capacity check, not a proof of feasibility under all constraints. */
export function weekdayWeightCapacity(state: PlannerState): { maxPercent: number | null; explanation: string } {
  const explanation = '按每人每天最多一班、请假、可上班次及锁定安排估算；休息间隔、工时上下限和互斥规则仍须通过求解。'
  const rule = state.rules.weekdayWeights
  if (!rule || weekdayWeightRuleError(rule)) return { maxPercent: null, explanation }
  const capacity = new Map<string, number>()
  const minimum = new Map<string, number>()
  const shifts = new Set(state.shifts.filter(s => s.required > 0).map(s => s.id))
  const locked = new Map(state.assignments.filter(a => a.locked).map(a => [`${a.employeeId}:${a.date}`, a.shiftId]))
  for (const week of weightedWeeks(state)) for (const date of week.dates) {
    capacity.set(date, state.employees.filter(e => !e.unavailableDates.includes(date) && e.maxHoursPerWeek > 0 && e.eligibleShiftIds.some(id => shifts.has(id)) && locked.get(`${e.id}:${date}`) !== 'off').length)
    minimum.set(date, state.assignments.filter(a => a.date === date && a.locked && a.shiftId !== 'off').length)
  }
  for (let percent = 100; percent >= 0; percent--) {
    const candidate: Rules['weekdayWeights'] = { days: rule.days, percent }
    if (weekdayWeightRuleError(candidate)) continue
    const weeks = weightedWeeks({ ...state, rules: { ...state.rules, weekdayWeights: candidate } })
    const possible = weeks.every(week => [[week.selectedDates, week.selectedTarget], [week.otherDates, week.otherTarget]].every(([rawDates, rawTotal]) => {
      const dates = rawDates as string[], total = rawTotal as number
      if (!dates.length) return total === 0
      const low = Math.floor(total / dates.length), high = Math.ceil(total / dates.length)
      let min = 0, max = 0
      for (const date of dates) {
        const lower = Math.max(low, minimum.get(date) ?? 0), upper = Math.min(high, capacity.get(date) ?? 0)
        if (lower > upper) return false
        min += lower; max += upper
      }
      return min <= total && total <= max
    }))
    if (possible) return { maxPercent: percent, explanation }
  }
  return { maxPercent: null, explanation }
}
