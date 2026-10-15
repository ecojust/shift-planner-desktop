import type { PlannerState } from './domain.ts'
const MINUTE = 60_000

/** Match Python Decimal(str(hours)) instead of rounding binary float noise. */
export function hoursToMinutes(hours: number, round: 'ceil' | 'floor'): number {
  if (!Number.isFinite(hours) || hours < 0 || hours > 744) return NaN
  const [coefficient = '', exponent = '0'] = String(hours).toLowerCase().split('e')
  const fractionLength = coefficient.split('.')[1]?.length ?? 0
  const digits = BigInt(coefficient.replace('.', '')) * 60n
  const power = Number(exponent) - fractionLength
  if (power >= 0) return Number(digits * 10n ** BigInt(power))
  const denominator = 10n ** BigInt(-power)
  return Number(round === 'ceil' ? (digits + denominator - 1n) / denominator : digits / denominator)
}

export function monthInterval(month: string): [number, number] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('月份必须为 YYYY-MM')
  const start = Date.parse(`${month}-01T00:00:00Z`)
  if (!Number.isFinite(start)) throw new Error('月份无效')
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  return [start, end.getTime()]
}

/** Discard retired monthly constraints and resolve only missing weekly minimums.
 * Explicit weekly zero remains disabled; legacy monthly values never set it. */
export function resolveHoursState<T extends PlannerState>(state: T): T {
  const { monthlyReferenceHours: _retiredReference, ...current } = state
  return { ...current, employees: state.employees.map(({ minHoursPerMonth: _retiredMinimum, ...employee }) => ({
    ...employee,
    minHoursPerWeek: employee.minHoursPerWeek ?? 0,
  })) } as T
}

/** Actual time inside the month, including previous-month overnight tails.
 * Merge overlapping intervals so an invalid manual roster cannot inflate totals. */
export function monthlyHoursByEmployee(state: Pick<PlannerState, 'month' | 'assignments' | 'shifts'>): Map<string, number> {
  const [monthStart, monthEnd] = monthInterval(state.month)
  const shifts = new Map(state.shifts.map(shift => [shift.id, shift]))
  const intervals = new Map<string, Array<[number, number]>>()
  const clock = (value: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN
  for (const assignment of state.assignments) {
    const shift = shifts.get(assignment.shiftId)
    if (!shift || !/^\d{4}-\d{2}-\d{2}$/.test(assignment.date)) continue
    const date = Date.parse(`${assignment.date}T00:00:00Z`)
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== assignment.date) continue
    const first = clock(shift.start), last = clock(shift.end)
    if (!Number.isFinite(first) || !Number.isFinite(last) || first === last) continue
    const start = Math.max(monthStart, date + first * MINUTE)
    const end = Math.min(monthEnd, date + (last < first ? last + 1440 : last) * MINUTE)
    if (start >= end) continue
    const items = intervals.get(assignment.employeeId) ?? []
    items.push([start, end]); intervals.set(assignment.employeeId, items)
  }
  const result = new Map<string, number>()
  for (const [id, items] of intervals) {
    items.sort((a, b) => a[0] - b[0])
    let [start, end] = items[0]!, milliseconds = 0
    for (const [nextStart, nextEnd] of items.slice(1)) {
      if (nextStart <= end) end = Math.max(end, nextEnd)
      else { milliseconds += end - start; start = nextStart; end = nextEnd }
    }
    result.set(id, (milliseconds + end - start) / 3_600_000)
  }
  return result
}
