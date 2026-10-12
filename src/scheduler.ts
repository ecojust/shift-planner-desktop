import type { Assignment, Employee, Issue, PlannerState, Shift } from './domain.ts'

const DAY = 86_400_000
const HOUR = 3_600_000
const EPSILON = 0.000001
const dateText = (time: number) => new Date(time).toISOString().slice(0, 10)

function dateTime(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN
  const time = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(time) && dateText(time) === date ? time : NaN
}

function minutes(clock: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(clock)
  if (!match) return NaN
  const h = Number(match[1]), m = Number(match[2])
  return h < 24 && m < 60 ? h * 60 + m : NaN
}

/** Civil dates use UTC internally so host timezone / DST cannot shift a roster. */
export function datesOfMonth(month: string): string[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return []
  const start = dateTime(`${month}-01`)
  if (!Number.isFinite(start)) return []
  const result: string[] = []
  for (let time = start; dateText(time).startsWith(month); time += DAY) result.push(dateText(time))
  return result
}

/** End earlier than start means an overnight shift. Equal times are invalid. */
export function shiftHours(shift: Shift): number {
  const start = minutes(shift.start), end = minutes(shift.end)
  if (!Number.isFinite(start + end)) return 0
  return ((end - start + 1440) % 1440) / 60
}

interface Work {
  assignment: Assignment
  start: number
  end: number
  hours: number
}

function workFor(assignment: Assignment, shifts: Map<string, Shift>): Work | undefined {
  const shift = shifts.get(assignment.shiftId)
  const day = dateTime(assignment.date)
  if (!shift || !Number.isFinite(day) || shiftHours(shift) <= 0) return undefined
  const start = day + minutes(shift.start) * 60_000
  const hours = shiftHours(shift)
  return { assignment, start, end: start + hours * HOUR, hours }
}

function weekStart(time: number): number {
  const day = Math.floor(time / DAY) * DAY
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY
}

/** Charge actual hours to Monday–Sunday weeks, including Sunday night shifts. */
function weekParts(work: Work): Array<[number, number]> {
  const result: Array<[number, number]> = []
  let cursor = work.start
  while (cursor < work.end) {
    const week = weekStart(cursor)
    const end = Math.min(work.end, week + 7 * DAY)
    result.push([week, (end - cursor) / HOUR])
    cursor = end
  }
  return result
}

function intersectsLeave(employee: Employee, work: Work): boolean {
  return employee.unavailableDates.some(date => {
    const start = dateTime(date)
    return work.start < start + DAY && work.end > start
  })
}

function configurationIssues(state: PlannerState): Issue[] {
  const issues: Issue[] = []
  const error = (message: string) => issues.push({ id: `configuration-${issues.length}`, type: 'configuration', severity: 'error', message })
  if (!datesOfMonth(state.month).length) error('排班月份无效，请使用 YYYY-MM 格式。')
  if (!Number.isFinite(state.rules.minRestHours) || state.rules.minRestHours < 0) error('最短休息时间必须为非负数。')
  if (!Number.isInteger(state.rules.maxConsecutiveDays) || state.rules.maxConsecutiveDays < 1) error('最大连续工作日必须为大于 0 的整数。')
  if (!state.employees.length) error('请先添加员工。')
  if (!state.shifts.length) error('请先添加班次。')
  const employeeIds = new Set<string>(), shiftIds = new Set<string>()
  for (const employee of state.employees) {
    if (!employee.id || employeeIds.has(employee.id)) error(`员工标识重复或为空：${employee.name || employee.id}。`)
    employeeIds.add(employee.id)
    if (!Number.isFinite(employee.maxHoursPerWeek) || employee.maxHoursPerWeek < 0) error(`${employee.name}的每周工时上限无效。`)
    for (const date of employee.unavailableDates) if (!Number.isFinite(dateTime(date))) error(`${employee.name}的请假日期 ${date} 无效。`)
  }
  for (const shift of state.shifts) {
    if (!shift.id || shift.id === 'off' || shiftIds.has(shift.id)) error(`班次标识重复、为空或使用了保留名称：${shift.name}。`)
    shiftIds.add(shift.id)
    if (shiftHours(shift) <= 0) error(`${shift.name}的时间无效，开始和结束时间不能相同。`)
    if (!Number.isInteger(shift.required) || shift.required < 0) error(`${shift.name}的每日需求人数必须为非负整数。`)
  }
  for (const employee of state.employees) {
    for (const id of employee.eligibleShiftIds) if (!shiftIds.has(id)) error(`${employee.name}关联了不存在的班次 ${id}。`)
  }
  const separationIds = new Set<string>()
  for (const group of state.rules.separationGroups || []) {
    if (!group.id || separationIds.has(group.id)) error(`同班限制标识重复或为空：${group.name}。`)
    separationIds.add(group.id)
    for (const id of group.employeeIds) if (!employeeIds.has(id)) error(`同班限制“${group.name}”包含不存在的员工 ${id}。`)
    for (const id of group.shiftIds) if (!shiftIds.has(id)) error(`同班限制“${group.name}”包含不存在的班次 ${id}。`)
  }
  return issues
}

export function validateSchedule(state: PlannerState): Issue[] {
  const issues = configurationIssues(state)
  const employees = new Map(state.employees.map(employee => [employee.id, employee]))
  const shifts = new Map(state.shifts.map(shift => [shift.id, shift]))
  const byEmployee = new Map<string, Work[]>()
  const cells = new Set<string>()
  const coverage = new Map<string, Set<string>>()
  const add = (type: string, message: string, assignment?: Assignment, severity: 'error' | 'warning' = 'error') => {
    issues.push({ id: `${type}-${issues.length}`, type, severity, message, ...(assignment ? { date: assignment.date, employeeId: assignment.employeeId } : {}) })
  }
  for (const assignment of state.assignments) {
    const employee = employees.get(assignment.employeeId)
    const locked = assignment.locked ? '锁定的' : ''
    if (!employee) { add('unknown-employee', `${locked}排班引用了不存在的员工 ${assignment.employeeId}。`, assignment); continue }
    if (!Number.isFinite(dateTime(assignment.date))) { add('invalid-date', `${employee.name}的${locked}排班日期无效。`, assignment); continue }
    const cell = `${assignment.employeeId}|${assignment.date}`
    if (cells.has(cell)) add('duplicate', `${assignment.date} ${employee.name}同一天有多条排班（含休息），请清除冲突。`, assignment)
    cells.add(cell)
    if (assignment.shiftId === 'off') continue
    const shift = shifts.get(assignment.shiftId)
    if (!shift) { add('unknown-shift', `${employee.name}的${locked}排班引用了不存在的班次。`, assignment); continue }
    if (!employee.eligibleShiftIds.includes(shift.id)) add('qualification', `${assignment.date} ${employee.name}不具备${shift.name}资格${assignment.locked ? '，请调整锁定排班' : ''}。`, assignment)
    const work = workFor(assignment, shifts)
    if (!work) { add('invalid-shift', `${employee.name}的${locked}排班时间无效。`, assignment); continue }
    if (intersectsLeave(employee, work)) add('unavailable', `${assignment.date} ${employee.name}的${shift.name}与请假日期重叠${assignment.locked ? '，请调整锁定排班' : ''}。`, assignment)
    const list = byEmployee.get(employee.id) || []
    list.push(work)
    byEmployee.set(employee.id, list)
    const key = `${assignment.date}|${assignment.shiftId}`
    const staff = coverage.get(key) || new Set<string>()
    staff.add(employee.id)
    coverage.set(key, staff)
  }
  for (const group of state.rules.separationGroups || []) {
    for (const [key, staff] of coverage) {
      const separator = key.indexOf('|')
      const date = key.slice(0, separator), shiftId = key.slice(separator + 1)
      if (group.shiftIds.length && !group.shiftIds.includes(shiftId)) continue
      const members = [...staff].filter(id => group.employeeIds.includes(id))
      if (members.length > 1) {
        const names = members.map(id => employees.get(id)?.name || id).join('、')
        add('separation', `${date} ${shifts.get(shiftId)?.name || shiftId}违反同班限制“${group.name}”：${names}不能安排在同一个班次，请调整手动或锁定排班。`, { employeeId: members[0]!, date, shiftId, locked: false })
      }
    }
  }
  for (const employee of state.employees) {
    const work = (byEmployee.get(employee.id) || []).sort((a, b) => a.start - b.start || a.end - b.end)
    const weeks = new Map<number, number>()
    const workingDates = [...new Set(work.map(item => item.assignment.date))].sort()
    let run = 0, previous = NaN
    for (const date of workingDates) {
      const day = dateTime(date)
      run = day === previous + DAY ? run + 1 : 1
      if (run === state.rules.maxConsecutiveDays + 1) add('consecutive-days', `${date} ${employee.name}连续工作超过 ${state.rules.maxConsecutiveDays} 天。`, { employeeId: employee.id, date, shiftId: '', locked: false })
      previous = day
    }
    for (let index = 0; index < work.length; index++) {
      const item = work[index]!
      if (index) {
        // Max previous end also handles nested / overlapping malformed shifts.
        const previousEnd = Math.max(...work.slice(0, index).map(entry => entry.end))
        const rest = (item.start - previousEnd) / HOUR
        if (rest + EPSILON < state.rules.minRestHours) add('rest', `${item.assignment.date} ${employee.name}班间休息 ${Math.max(0, rest).toFixed(1)} 小时，少于 ${state.rules.minRestHours} 小时。`, item.assignment)
      }
      for (const [week, hours] of weekParts(item)) weeks.set(week, (weeks.get(week) || 0) + hours)
    }
    for (const [week, hours] of weeks) {
      if (hours > employee.maxHoursPerWeek + EPSILON) add('weekly-hours', `${employee.name}在 ${dateText(week)} 起的一周排了 ${Number(hours.toFixed(2))} 小时，超过 ${employee.maxHoursPerWeek} 小时上限。`, { employeeId: employee.id, date: dateText(week), shiftId: '', locked: false })
    }
  }
  for (const date of datesOfMonth(state.month)) {
    for (const shift of state.shifts) {
      const count = coverage.get(`${date}|${shift.id}`)?.size || 0
      if (count < shift.required) add('coverage', `${date} ${shift.name}缺 ${shift.required - count} 人（${count}/${shift.required}）。`, undefined, 'warning')
      else if (count > shift.required) add('overstaffed', `${date} ${shift.name}超出需求 ${count - shift.required} 人（${count}/${shift.required}），请检查手动或锁定排班。`, undefined, 'warning')
      if (count !== shift.required) issues[issues.length - 1]!.date = date
    }
  }
  return issues
}

interface EmployeePlan {
  employee: Employee
  work: Work[]
  occupied: Set<string>
  days: Set<number>
  weeks: Map<number, number>
  hours: number
  weekends: number
  shiftCounts: Map<string, number>
}

function addToPlan(plan: EmployeePlan, assignment: Assignment, shifts: Map<string, Shift>, month: string) {
  plan.occupied.add(assignment.date)
  const work = workFor(assignment, shifts)
  if (!work) return
  plan.work.push(work)
  plan.days.add(dateTime(assignment.date))
  for (const [week, hours] of weekParts(work)) plan.weeks.set(week, (plan.weeks.get(week) || 0) + hours)
  if (assignment.date.startsWith(`${month}-`)) {
    plan.hours += work.hours
    plan.shiftCounts.set(assignment.shiftId, (plan.shiftCounts.get(assignment.shiftId) || 0) + 1)
    if ([0, 6].includes(new Date(work.start).getUTCDay())) plan.weekends++
  }
}

function allowed(plan: EmployeePlan, candidate: Work, state: PlannerState, assignments: Assignment[]): boolean {
  const { employee } = plan
  const { date, shiftId } = candidate.assignment
  if (plan.occupied.has(date) || intersectsLeave(employee, candidate) || !employee.eligibleShiftIds.includes(shiftId)) return false
  for (const group of state.rules.separationGroups || []) {
    if (!group.employeeIds.includes(employee.id) || (group.shiftIds.length && !group.shiftIds.includes(shiftId))) continue
    if (assignments.some(item => item.date === date && item.shiftId === shiftId && item.employeeId !== employee.id && group.employeeIds.includes(item.employeeId))) return false
  }
  for (const [week, hours] of weekParts(candidate)) if ((plan.weeks.get(week) || 0) + hours > employee.maxHoursPerWeek + EPSILON) return false
  for (const work of plan.work) {
    const gap = candidate.start >= work.end ? candidate.start - work.end : work.start >= candidate.end ? work.start - candidate.end : -1
    if (gap < 0 || gap / HOUR + EPSILON < state.rules.minRestHours) return false
  }
  const day = dateTime(date)
  let run = 1
  for (let cursor = day - DAY; plan.days.has(cursor); cursor -= DAY) run++
  for (let cursor = day + DAY; plan.days.has(cursor); cursor += DAY) run++
  return run <= state.rules.maxConsecutiveDays
}

function randomSource(seed: number) {
  let value = seed >>> 0
  return () => {
    value += 0x6D2B79F5
    let n = value
    n = Math.imul(n ^ (n >>> 15), n | 1)
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
    return ((n ^ (n >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Seeded multi-start greedy planner. Never relaxes a constraint to fill a gap.
 * Locked cells and every out-of-month assignment are preserved, even when
 * invalid; validation explains those conflicts instead of silently deleting.
 */
export function generateSchedule(state: PlannerState, seed = 1010): { assignments: Assignment[]; issues: Issue[] } {
  const dates = datesOfMonth(state.month)
  const activeDates = new Set(dates)
  const fixed = state.assignments.filter(item => item.locked || !activeDates.has(item.date)).map(item => ({ ...item }))
  if (configurationIssues(state).some(issue => issue.severity === 'error')) {
    return { assignments: state.assignments.map(item => ({ ...item })), issues: validateSchedule(state) }
  }
  const shifts = new Map(state.shifts.map(shift => [shift.id, shift]))
  let best = fixed, bestScore = Infinity
  for (let attempt = 0; attempt < 32; attempt++) {
    const random = randomSource(seed + attempt * 7919)
    const assignments = fixed.map(item => ({ ...item }))
    const plans = state.employees.map(employee => ({ employee, work: [], occupied: new Set<string>(), days: new Set<number>(), weeks: new Map<number, number>(), hours: 0, weekends: 0, shiftCounts: new Map<string, number>() } as EmployeePlan))
    for (const item of fixed) {
      const plan = plans.find(entry => entry.employee.id === item.employeeId)
      if (plan) addToPlan(plan, item, shifts, state.month)
    }
    let missing = 0
    // Alternate traversal to avoid always leaving shortages at the month end.
    const traversal = attempt % 4 === 3 ? [...dates].reverse() : dates
    for (const date of traversal) {
      const slots = state.shifts.map(shift => ({ shift, count: new Set(assignments.filter(item => item.date === date && item.shiftId === shift.id && plans.some(plan => plan.employee.id === item.employeeId)).map(item => item.employeeId)).size }))
      while (slots.some(slot => slot.count < slot.shift.required)) {
        const choices = slots.filter(slot => slot.count < slot.shift.required).map(slot => {
          const prototype = workFor({ employeeId: '', date, shiftId: slot.shift.id, locked: false }, shifts)!
          return { slot, prototype, candidates: plans.filter(plan => allowed(plan, prototype, state, assignments)) }
        }).sort((a, b) => a.candidates.length - b.candidates.length || b.prototype.start - a.prototype.start)
        const { slot, prototype, candidates } = choices[0]!
        if (!candidates.length) {
          missing += slot.shift.required - slot.count
          slot.count = slot.shift.required
          continue
        }
        const weekend = [0, 6].includes(new Date(prototype.start).getUTCDay())
        const scored = candidates.map(plan => ({ plan, score:
          plan.hours / Math.max(1, plan.employee.maxHoursPerWeek) * 10
          + (plan.shiftCounts.get(slot.shift.id) || 0) * 0.7
          + (state.rules.balanceWeekends && weekend ? plan.weekends * 2 : 0)
          + ((plan.weeks.get(weekStart(prototype.start)) || 0) / Math.max(1, plan.employee.maxHoursPerWeek)) * 3
          + random() * (attempt % 3 === 0 ? 2 : 0.8)
        })).sort((a, b) => a.score - b.score)
        const chosen = scored[0]!.plan
        const assignment = { employeeId: chosen.employee.id, date, shiftId: slot.shift.id, locked: false }
        assignments.push(assignment)
        addToPlan(chosen, assignment, shifts, state.month)
        slot.count++
      }
    }
    const ratios = plans.filter(plan => plan.employee.maxHoursPerWeek > 0).map(plan => plan.hours / plan.employee.maxHoursPerWeek)
    const mean = ratios.reduce((sum, value) => sum + value, 0) / Math.max(1, ratios.length)
    const fairness = ratios.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    const score = missing * 1_000_000 + fairness
    if (score < bestScore) { bestScore = score; best = assignments }
  }
  best.sort((a, b) => a.date.localeCompare(b.date) || a.employeeId.localeCompare(b.employeeId) || a.shiftId.localeCompare(b.shiftId))
  return { assignments: best, issues: validateSchedule({ ...state, assignments: best }) }
}
