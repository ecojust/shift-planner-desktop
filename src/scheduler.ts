import type { Assignment, Employee, Issue, PlannerState, Shift } from './domain.ts'
import { hoursToMinutes } from './hours.ts'
import { weekdayWeightRuleError, weightedWeeks, weightedWeekTargets, findWeightedWeek, weightedGroups, weightedHistoryFits, weightedDayRange, type WeightedWeek } from './weekday-weights.ts'
import { getWeekBoundaryContext, type BoundaryOptions, type WeekBoundaryContext } from './weekBoundary.ts'

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

interface MonthWindow {
  start: number
  end: number
  weeks: Array<{ start: number; end: number; days: number; week: number }>
}

function monthWindow(month: string): MonthWindow | undefined {
  const dates = datesOfMonth(month)
  if (!dates.length) return undefined
  const start = dateTime(dates[0]!), end = start + dates.length * DAY
  const weeks: MonthWindow['weeks'] = []
  for (let week = weekStart(start); week < end; week += 7 * DAY) {
    const first = Math.max(start, week), last = Math.min(end, week + 7 * DAY)
    weeks.push({ start: first, end: last, days: (last - first) / DAY, week })
  }
  return { start, end, weeks }
}

function overlapMinutes(work: Work, start: number, end: number): number {
  return Math.max(0, Math.min(work.end, end) - Math.max(work.start, start)) / 60_000
}

function workedMinutes(work: Work[], start: number, end: number): number {
  let lastEnd = start, total = 0
  for (const item of work) {
    const first = Math.max(item.start, start, lastEnd), last = Math.min(item.end, end)
    if (first < last) total += (last - first) / 60_000
    lastEnd = Math.max(lastEnd, last)
  }
  return total
}

// A minimum must be attained, so fractional minutes round up; a cap rounds down.
const minimumMinutes = (hours: number) => hoursToMinutes(hours, 'ceil')
const maximumMinutes = (employee: Employee) => hoursToMinutes(employee.maxHoursPerWeek, 'floor')
const minimumWeekMinutes = (employee: Employee, days: number) => Math.ceil(minimumMinutes(employee.minHoursPerWeek ?? 0) * days / 7)

interface WeeklyMinimum { target: number; knownDays: number; outside: number }
function weeklyMinimumTargets(employee: Employee, fixedWork: Work[], window: MonthWindow, context: WeekBoundaryContext, planning = false): Map<number, WeeklyMinimum> {
  const sorted = [...fixedWork].sort((a, b) => a.start - b.start || a.end - b.end)
  return new Map(window.weeks.map(week => {
    const boundary = context.weeks.find(item => item.weekStart === dateText(week.week))!
    const member = boundary.employees.find(item => item.employeeId === employee.id)!
    const knownDays = boundary.monthDates.length + member.knownDates.length + (planning ? member.unknownFutureDates.length : 0)
    return [week.week, { target: !planning && member.unknownFutureDates.length ? 0 : minimumWeekMinutes(employee, knownDays), knownDays,
      outside: Math.max(0, workedMinutes(sorted, week.week, week.week + 7 * DAY) - workedMinutes(sorted, Math.max(window.start, week.week), Math.min(window.end, week.week + 7 * DAY))) }]
  }))
}

interface ValidationOptions extends BoundaryOptions {
  /** Internal planning context: only future unknown cells may be completed. */
  planning?: boolean
  boundaryState?: PlannerState
  includeBoundaryWarnings?: boolean
}

export function boundaryWarnings(state: PlannerState, options: BoundaryOptions = {}): Issue[] {
  const context = getWeekBoundaryContext(state, options)
  if (!context) return []
  const issues: Issue[] = []
  for (const week of context.weeks) {
    const past = week.employees.filter(employee => employee.unknownPastDates.length)
    const future = week.employees.filter(employee => employee.unknownFutureDates.length)
    if (past.length) issues.push({ id: `boundary-history-${week.weekStart}`, type: 'boundary-history-incomplete', severity: 'warning', date: week.monthDates[0], target: 'calendar',
      message: `${week.weekStart} 至 ${week.weekEnd} 这一周，${past.length} 名成员的月外历史排班不完整；未将未知日期视为休息，周最低暂按已知日期折算，完整周规则仍待核对。` })
    if (future.length) issues.push({ id: `boundary-future-${week.weekStart}`, type: 'boundary-future-unconfirmed', severity: 'warning', date: week.monthDates[0], target: 'calendar',
      message: `${week.weekStart} 至 ${week.weekEnd} 这一周，${future.length} 名成员的相邻月份未来排班尚未确认；生成时会临时预排完整周，月外预排不自动保存，最终周规则需在相邻月份排班后确认。` })
  }
  return issues
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
  const validMonth = !!datesOfMonth(state.month).length
  if (!validMonth) error('排班月份无效，请使用 YYYY-MM 格式。')
  if (!Number.isFinite(state.rules.minRestHours) || state.rules.minRestHours < 0) error('最短休息时间必须为非负数。')
  if (!Number.isInteger(state.rules.maxConsecutiveDays) || state.rules.maxConsecutiveDays < 1) error('最大连续工作日必须为大于 0 的整数。')
  if (!state.employees.length) error('请先添加员工。')
  if (!state.shifts.length) error('请先添加班次。')
  const weightError = weekdayWeightRuleError(state.rules.weekdayWeights)
  if (weightError) error(weightError)
  const employeeIds = new Set<string>(), shiftIds = new Set<string>()
  for (const employee of state.employees) {
    if (!employee.id || employeeIds.has(employee.id)) error(`员工标识重复或为空：${employee.name || employee.id}。`)
    employeeIds.add(employee.id)
    if (!Number.isFinite(employee.maxHoursPerWeek) || employee.maxHoursPerWeek < 0 || employee.maxHoursPerWeek > 168) error(`${employee.name}的每周工时上限必须在 0～168 小时之间。`)
    const weekMinimum = employee.minHoursPerWeek === undefined ? 0 : employee.minHoursPerWeek
    if (!Number.isFinite(weekMinimum) || weekMinimum < 0 || weekMinimum > 168) error(`${employee.name}的周最低工时必须在 0～168 小时之间。`)
    else if (weekMinimum > employee.maxHoursPerWeek) error(`${employee.name}的周最低工时不能超过周最高工时。`)
    for (const date of employee.unavailableDates) if (!Number.isFinite(dateTime(date))) error(`${employee.name}的请假日期 ${date} 无效。`)
  }
  for (const shift of state.shifts) {
    if (!shift.id || shift.id === 'off' || shiftIds.has(shift.id)) error(`班次标识重复、为空或使用了保留名称：${shift.name}。`)
    shiftIds.add(shift.id)
    if (shiftHours(shift) <= 0) error(`${shift.name}的时间无效，开始和结束时间不能相同。`)
    if (!Number.isInteger(shift.required) || shift.required < 0) error(`${shift.name}的每日需求人数必须为非负整数。`)
    if (shift.staffingMode !== undefined && shift.staffingMode !== 'minimum' && shift.staffingMode !== 'fixed') error(`${shift.name}的人数模式必须为“最少人数”或“固定人数”。`)
  }
  for (const employee of state.employees) {
    for (const id of employee.eligibleShiftIds) if (!shiftIds.has(id)) error(`${employee.name}关联了不存在的班次 ${id}。`)
  }
  for (const [key, label] of [['nonConsecutiveShifts', '班次不相连'], ['weeklyShiftLimits', '周班次限制']] as const) {
    const rules: unknown = state.rules[key]
    if (rules === undefined) continue
    if (!Array.isArray(rules) || rules.length > 24) {
      error(`${label}必须为列表，且最多添加 24 条。`)
      continue
    }
    const ids = new Set<string>(), selectedShifts = new Set<string>()
    for (const item of rules as unknown[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        error(`${label}中存在无效规则。`)
        continue
      }
      const rule = item as Record<string, unknown>
      if (typeof rule.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(rule.id) || ids.has(rule.id)) error(`${label}的规则标识无效或重复。`)
      else ids.add(rule.id)
      if (typeof rule.shiftId !== 'string' || !shiftIds.has(rule.shiftId)) error(`${label}关联了不存在的班次。`)
      else if (selectedShifts.has(rule.shiftId)) error(`${label}中同一个班次只能设置一次。`)
      else selectedShifts.add(rule.shiftId)
      if (key === 'weeklyShiftLimits' && (typeof rule.maxPerWeek !== 'number' || !Number.isInteger(rule.maxPerWeek) || rule.maxPerWeek < 0 || rule.maxPerWeek > 7)) error('周班次限制的每周次数必须为 0～7 的整数。')
    }
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

export function validateSchedule(state: PlannerState, options: ValidationOptions = {}): Issue[] {
  const issues = configurationIssues(state)
  const window = monthWindow(state.month)
  const context = getWeekBoundaryContext(options.boundaryState ?? state, options)
  const employees = new Map(state.employees.map(employee => [employee.id, employee]))
  const shifts = new Map(state.shifts.map(shift => [shift.id, shift]))
  const byEmployee = new Map<string, Work[]>()
  const cells = new Set<string>()
  const coverage = new Map<string, Set<string>>()
  const add = (type: string, message: string, assignment?: Assignment, severity: 'error' | 'warning' = 'error') => {
    issues.push({ id: `${type}-${issues.length}`, type, severity, message, ...(assignment ? { date: assignment.date, employeeId: assignment.employeeId } : {}) })
  }
  const paddingDays = Math.max(7, state.rules.maxConsecutiveDays, Math.ceil(state.rules.minRestHours / 24) + 1)
  const relevantStart = context ? dateTime(context.startDate) - paddingDays * DAY : -Infinity
  const relevantEnd = context ? dateTime(context.endDate) + (paddingDays + 1) * DAY : Infinity
  for (const assignment of state.assignments) {
    const assignmentDay = dateTime(assignment.date)
    if (Number.isFinite(assignmentDay) && (assignmentDay < relevantStart || assignmentDay >= relevantEnd)) continue
    const inRelevantWeek = !context || (assignmentDay >= dateTime(context.startDate) && assignmentDay <= dateTime(context.endDate))
    const employee = employees.get(assignment.employeeId)
    if (!inRelevantWeek && (!employee || (assignment.shiftId !== 'off' && !shifts.has(assignment.shiftId)))) continue
    const locked = assignment.locked ? '锁定的' : ''
    if (!employee) { add('unknown-employee', `${locked}排班引用了不存在的员工 ${assignment.employeeId}。`, assignment); continue }
    if (!Number.isFinite(dateTime(assignment.date))) { add('invalid-date', `${employee.name}的${locked}排班日期无效。`, assignment); continue }
    const cell = `${assignment.employeeId}|${assignment.date}`
    if (inRelevantWeek && cells.has(cell)) add('duplicate', `${assignment.date} ${employee.name}同一天有多条排班（含休息），请清除冲突。`, assignment)
    cells.add(cell)
    if (assignment.shiftId === 'off') continue
    const shift = shifts.get(assignment.shiftId)
    if (!shift) { add('unknown-shift', `${employee.name}的${locked}排班引用了不存在的班次。`, assignment); continue }
    if (inRelevantWeek && !employee.eligibleShiftIds.includes(shift.id)) add('qualification', `${assignment.date} ${employee.name}不具备${shift.name}资格${assignment.locked ? '，请调整锁定排班' : ''}。`, assignment)
    const work = workFor(assignment, shifts)
    if (!work) { add('invalid-shift', `${employee.name}的${locked}排班时间无效。`, assignment); continue }
    if ((inRelevantWeek || context && work.end > dateTime(context.startDate) && work.start < dateTime(context.endDate) + DAY) && intersectsLeave(employee, work)) add('unavailable', `${assignment.date} ${employee.name}的${shift.name}与请假日期重叠${assignment.locked ? '，请调整锁定排班' : ''}。`, assignment)
    const list = byEmployee.get(employee.id) || []
    list.push(work)
    byEmployee.set(employee.id, list)
    const key = `${assignment.date}|${assignment.shiftId}`
    const staff = coverage.get(key) || new Set<string>()
    staff.add(employee.id)
    coverage.set(key, staff)
  }
  // Past retained staffing is historical context. Every future day in the
  // planning window, including confirmed rosters, must respect current caps.
  for (const [key, staff] of coverage) {
    const separator = key.indexOf('|')
    const date = key.slice(0, separator), shift = shifts.get(key.slice(separator + 1))!
    const plannedFuture = options.planning && context && date >= context.referenceDate && date >= context.startDate && date <= context.endDate
    if (!date.startsWith(`${state.month}-`) && !plannedFuture) continue
    if (shift.staffingMode === 'fixed' && staff.size > shift.required) {
      add('overstaffed', `${date} ${shift.name}超出固定人数 ${staff.size - shift.required} 人（已排 ${staff.size} / 每日固定 ${shift.required}），请调整手动或锁定排班。`)
      issues[issues.length - 1]!.date = date
    }
  }
  for (const group of state.rules.separationGroups || []) {
    for (const [key, staff] of coverage) {
      const separator = key.indexOf('|')
      const date = key.slice(0, separator), shiftId = key.slice(separator + 1)
      if (context && (date < context.startDate || date > context.endDate)) continue
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
      if (run > state.rules.maxConsecutiveDays && context && day >= dateTime(context.startDate) && day - (run - 1) * DAY <= dateTime(context.endDate)) add('consecutive-days', `${date} ${employee.name}连续工作超过 ${state.rules.maxConsecutiveDays} 天。`, { employeeId: employee.id, date, shiftId: '', locked: false })
      previous = day
    }
    for (let index = 0; index < work.length; index++) {
      const item = work[index]!
      if (index) {
        // Max previous end also handles nested / overlapping malformed shifts.
        const previousEnd = Math.max(...work.slice(0, index).map(entry => entry.end))
        const rest = (item.start - previousEnd) / HOUR
        const involved = context && (item.assignment.date >= context.startDate && item.assignment.date <= context.endDate || work.slice(0, index).some(entry => entry.end === previousEnd && entry.assignment.date >= context.startDate && entry.assignment.date <= context.endDate))
        if (rest + EPSILON < state.rules.minRestHours && involved) add('rest', `${item.assignment.date} ${employee.name}班间休息 ${Math.max(0, rest).toFixed(1)} 小时，少于 ${state.rules.minRestHours} 小时。`, item.assignment)
      }
      for (const [week, hours] of weekParts(item)) weeks.set(week, (weeks.get(week) || 0) + hours)
    }
    const touchedWeeks = new Set(work.filter(item => context && item.assignment.date >= context.startDate && item.assignment.date <= context.endDate).flatMap(item => weekParts(item).map(([week]) => week)))
    for (const [week, hours] of weeks) {
      if (hours * 60 > maximumMinutes(employee) + EPSILON && (window?.weeks.some(item => item.week === week) || touchedWeeks.has(week))) add('weekly-hours', `${employee.name}在 ${dateText(week)} 起的一周排了 ${Number(hours.toFixed(2))} 小时，超过 ${employee.maxHoursPerWeek} 小时上限。`, { employeeId: employee.id, date: dateText(week), shiftId: '', locked: false })
    }
    if (window && context) {
      // These rules count shift START dates, unlike weekly hours, which split an
      // overnight shift's actual hours across weeks. Only the selected month's
      // adjacent pairs / touching weeks are constrained; distant history stays
      // intact and is not retroactively subject to newly added shift rules.
      if (!issues.some(issue => issue.type === 'configuration')) {
        const startsByShift = new Map<string, Set<number>>()
        for (const item of work) {
          const days = startsByShift.get(item.assignment.shiftId) || new Set<number>()
          days.add(dateTime(item.assignment.date))
          startsByShift.set(item.assignment.shiftId, days)
        }
        const inMonth = (day: number) => options.planning ? day >= dateTime(context.startDate) && day < dateTime(context.endDate) + DAY : day >= window.start && day < window.end
        for (const rule of state.rules.nonConsecutiveShifts || []) {
          const starts = startsByShift.get(rule.shiftId) || new Set<number>()
          for (const day of [...starts].sort((a, b) => a - b)) {
            if (!starts.has(day - DAY) || (!inMonth(day) && !inMonth(day - DAY))) continue
            const name = shifts.get(rule.shiftId)!.name
            issues.push({ id: `consecutive-shift-${issues.length}`, type: 'consecutive-shift', severity: 'error',
              employeeId: employee.id, date: dateText(inMonth(day) ? day : day - DAY), shiftId: rule.shiftId,
              message: `${employee.name}在 ${dateText(day - DAY)}、${dateText(day)} 连续两天上${name}，违反该班次不能相连的规则。`,
              suggestion: `将其中一天改为其他可上班次或休息；如排班已锁定，请先解锁，或在排班规则中移除${name}的“班次不相连”限制。`, target: 'rules' })
          }
        }
        for (const rule of state.rules.weeklyShiftLimits || []) {
          const starts = startsByShift.get(rule.shiftId) || new Set<number>()
          for (const week of window.weeks) {
            const counted = [...starts].filter(day => day >= week.week && day < week.week + 7 * DAY).sort((a, b) => a - b)
            if (counted.length <= rule.maxPerWeek) continue
            const name = shifts.get(rule.shiftId)!.name
            const carried = counted.filter(day => !inMonth(day)).length
            issues.push({ id: `weekly-shift-limit-${issues.length}`, type: 'weekly-shift-limit', severity: 'error',
              employeeId: employee.id, date: dateText(counted.find(inMonth) ?? week.start), shiftId: rule.shiftId,
              message: `${employee.name}在 ${dateText(week.week)} 至 ${dateText(week.week + 6 * DAY)} 这一周已排${name} ${counted.length} 次${carried ? `（含跨月已知排班 ${carried} 次）` : ''}，超过每周最多 ${rule.maxPerWeek} 次的限制。`,
              suggestion: `本周至少减少 ${counted.length - rule.maxPerWeek} 次${name}，改为其他可上班次或休息，或在排班规则中提高该班次的周次数上限；不足一周也按原上限计算。`, target: 'rules' })
          }
        }
      }
      const targets = weeklyMinimumTargets(employee, work, window, context, options.planning)
      for (const week of window.weeks) {
        const minutes = workedMinutes(work, week.week, week.week + 7 * DAY)
        const { target: minimum, knownDays, outside } = targets.get(week.week)!
        const explanation = knownDays === 7 ? '合并相邻月份的已知或临时预排，按完整自然周计算'
          : `月外排班不完整，暂按 ${employee.minHoursPerWeek} × ${knownDays}/7 折算并向上取整到分钟`
        if (minutes + EPSILON < minimum) add('weekly-min-hours', `${employee.name}在 ${dateText(week.week)} 起的一周，已知实际工时 ${Number((minutes / 60).toFixed(2))} 小时，少于周最低工时 ${Number((minimum / 60).toFixed(2))} 小时（${explanation}；月外已知工时 ${Number((outside / 60).toFixed(2))} 小时）。`, { employeeId: employee.id, date: dateText(week.start), shiftId: '', locked: false })
      }
    }
  }
  const weighted = weightedWeeks(state, undefined, options)
  for (const week of weighted) {
    // A confirmed target-month projection need not independently meet a
    // prorated quota: provisional neighboring days may hold the remainder.
    // Check the complete evidence during generation; saved views stay pending.
    const boundary = context?.weeks.find(item => item.weekStart === week.id)
    if (!options.planning && boundary?.employees.some(employee => employee.unknownFutureDates.length)) continue
    const dateTotal = (date: string) => state.shifts.reduce((sum, shift) => sum + (coverage.get(`${date}|${shift.id}`)?.size || 0), 0)
    const quotaIssue = (type: string, message: string) => {
      add(type, message)
      issues[issues.length - 1]!.date = week.dates[0]!
    }
    const selectedActual = week.selectedDates.reduce((sum, date) => sum + dateTotal(date), 0)
    const otherActual = week.otherDates.reduce((sum, date) => sum + dateTotal(date), 0)
    if (!findWeightedWeek(state, week, selectedActual, otherActual)) {
      quotaIssue('weekday-quota', `${week.id} 起的一周，所选星期 ${selectedActual + (week.history?.selectedTotal ?? 0)} 人次、其余星期 ${otherActual + (week.history?.otherTotal ?? 0)} 人次，不符合实际总班次数的星期权重；${week.history ? '已合并相邻月份同一自然周的已知排班。' : '月边界保留缺失星期原份额。'}`)
    }
    for (const [index, group] of weightedGroups(week).entries()) {
      const label = index === 0 ? '所选星期' : '其余星期'
      const dates = [...group.historyDates, ...group.dates]
      const counts = dates.map(dateTotal)
      if (counts.length && Math.max(...counts) - Math.min(...counts) > 1) quotaIssue('weekday-balance', `${week.id} 起的一周，${label}应平摊排班人次；当前每天为 ${counts.join('、')} 人次，最多相差 1 人次。`)
    }
  }
  // Both staffing modes retain their daily floor, including weighted weeks.
  for (const date of datesOfMonth(state.month)) {
    for (const shift of state.shifts) {
      const count = coverage.get(`${date}|${shift.id}`)?.size || 0
      if (count < shift.required) {
        add('coverage', `${date} ${shift.name}缺 ${shift.required - count} 人（已排 ${count} / 每日${shift.staffingMode === 'fixed' ? '固定' : '最少'} ${shift.required}）。`, undefined, 'warning')
        issues[issues.length - 1]!.date = date
      }
    }
  }
  if (options.includeBoundaryWarnings !== false) issues.push(...boundaryWarnings(options.boundaryState ?? state, options))
  return issues
}

interface EmployeePlan {
  employee: Employee
  work: Work[]
  occupied: Set<string>
  days: Set<number>
  weeks: Map<number, number>
  hours: number
  monthWeeks: Map<number, number>
  shiftCounts: Map<string, number>
  shiftStartDates: Map<string, Set<number>>
  weeklyShiftCounts: Map<string, Map<number, number>>
}

function addToPlan(plan: EmployeePlan, assignment: Assignment, shifts: Map<string, Shift>, month: string, window: MonthWindow) {
  plan.occupied.add(assignment.date)
  const work = workFor(assignment, shifts)
  if (!work) return
  plan.work.push(work)
  const day = dateTime(assignment.date)
  plan.days.add(day)
  const starts = plan.shiftStartDates.get(assignment.shiftId) || new Set<number>()
  if (!starts.has(day)) {
    starts.add(day)
    plan.shiftStartDates.set(assignment.shiftId, starts)
    const counts = plan.weeklyShiftCounts.get(assignment.shiftId) || new Map<number, number>()
    const week = weekStart(day)
    counts.set(week, (counts.get(week) || 0) + 1)
    plan.weeklyShiftCounts.set(assignment.shiftId, counts)
  }
  for (const [week, hours] of weekParts(work)) plan.weeks.set(week, (plan.weeks.get(week) || 0) + hours)
  plan.hours += overlapMinutes(work, window.start, window.end) / 60
  for (const week of window.weeks) {
    const minutes = overlapMinutes(work, week.week, week.week + 7 * DAY)
    if (minutes) plan.monthWeeks.set(week.week, (plan.monthWeeks.get(week.week) || 0) + minutes)
  }
  if (assignment.date.startsWith(`${month}-`)) {
    plan.shiftCounts.set(assignment.shiftId, (plan.shiftCounts.get(assignment.shiftId) || 0) + 1)
  }
}

function allowed(plan: EmployeePlan, candidate: Work, state: PlannerState, assignments: Assignment[]): boolean {
  const { employee } = plan
  const { date, shiftId } = candidate.assignment
  if (plan.occupied.has(date) || intersectsLeave(employee, candidate) || !employee.eligibleShiftIds.includes(shiftId)) return false
  const day = dateTime(date)
  if (state.rules.nonConsecutiveShifts?.some(rule => rule.shiftId === shiftId)) {
    const starts = plan.shiftStartDates.get(shiftId)
    if (starts?.has(day - DAY) || starts?.has(day + DAY)) return false
  }
  const limit = state.rules.weeklyShiftLimits?.find(rule => rule.shiftId === shiftId)
  if (limit && (plan.weeklyShiftCounts.get(shiftId)?.get(weekStart(day)) || 0) >= limit.maxPerWeek) return false
  for (const group of state.rules.separationGroups || []) {
    if (!group.employeeIds.includes(employee.id) || (group.shiftIds.length && !group.shiftIds.includes(shiftId))) continue
    if (assignments.some(item => item.date === date && item.shiftId === shiftId && item.employeeId !== employee.id && group.employeeIds.includes(item.employeeId))) return false
  }
  for (const [week, hours] of weekParts(candidate)) if (((plan.weeks.get(week) || 0) + hours) * 60 > maximumMinutes(employee) + EPSILON) return false
  for (const work of plan.work) {
    const gap = candidate.start >= work.end ? candidate.start - work.end : work.start >= candidate.end ? work.start - candidate.end : -1
    if (gap < 0 || gap / HOUR + EPSILON < state.rules.minRestHours) return false
  }
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

function weightedDailyTargets(weeks: WeightedWeek[], fixed: Assignment[], employeeIds: Set<string>, shifts: Map<string, Shift>, random: () => number): Map<string, number> {
  const counts = new Map<string, Set<string>>()
  for (const item of fixed) {
    if (!employeeIds.has(item.employeeId) || !shifts.has(item.shiftId)) continue
    const keys = counts.get(item.date) || new Set<string>()
    keys.add(`${item.employeeId}|${item.shiftId}`)
    counts.set(item.date, keys)
  }
  const targets = new Map<string, number>()
  for (const week of weeks) {
    for (const { dates, target: total } of weightedGroups(week)) {
      if (!dates.length) continue
      const [base] = weightedDayRange(week, dates[0]!)
      const remainder = total - base * dates.length
      // Try different remainder days across attempts; preserve feasible locked
      // workloads by giving their required extra seat priority.
      const order = dates.map(date => ({ date, needsExtra: (counts.get(date)?.size || 0) > base ? 1 : 0, tie: random() }))
        .sort((a, b) => b.needsExtra - a.needsExtra || a.tie - b.tie)
      order.forEach((item, index) => targets.set(item.date, base + (index < remainder ? 1 : 0)))
    }
  }
  return targets
}

/**
 * Seeded multi-start greedy planner. Never relaxes a constraint to fill a gap.
 * Locked cells and every out-of-month assignment are preserved, even when
 * invalid; validation explains those conflicts instead of silently deleting.
 */
export function generateSchedule(state: PlannerState, seed = 1010, onSolutionCount?: (count: number) => void, options: BoundaryOptions = {}): { assignments: Assignment[]; issues: Issue[]; success: boolean; boundaryPreview: Assignment[]; boundaryContext?: WeekBoundaryContext } {
  const context = getWeekBoundaryContext(state, options)
  const dates = context?.weeks.flatMap(week => week.dates) ?? datesOfMonth(state.month)
  const window = monthWindow(state.month)
  const activeDates = new Set(datesOfMonth(state.month))
  const fixed = state.assignments.filter(item => item.locked || !activeDates.has(item.date)).map(item => ({ ...item }))
  if (!window || !context || configurationIssues(state).some(issue => issue.severity === 'error')) {
    return { assignments: state.assignments.map(item => ({ ...item })), issues: validateSchedule(state, options), success: false, boundaryPreview: [] }
  }
  const originalOutside = state.assignments.filter(item => !activeDates.has(item.date))
  const futureCells = new Set(context.weeks.flatMap(week => week.employees.flatMap(employee => employee.unknownFutureDates.map(date => `${employee.employeeId}\0${date}`))))
  const originalCells = new Set(fixed.map(item => `${item.employeeId}\0${item.date}`))
  for (const week of context.weeks) for (const employee of week.employees) {
    for (const date of [...employee.knownDates, ...employee.unknownPastDates]) {
      const cell = `${employee.employeeId}\0${date}`
      if (!originalCells.has(cell)) fixed.push({ employeeId: employee.employeeId, date, shiftId: 'off', locked: true })
    }
  }
  const planningOptions: ValidationOptions = { ...options, planning: true, boundaryState: state, includeBoundaryWarnings: false }
  const shifts = new Map(state.shifts.map(shift => [shift.id, shift]))
  const fixedWork = fixed.map(item => workFor(item, shifts)).filter((item): item is Work => !!item)
  const weekMinimums = new Map(state.employees.map(employee => [employee.id, weeklyMinimumTargets(employee, fixedWork.filter(item => item.assignment.employeeId === employee.id), window, context, true)]))
  const weekMinimum = (employee: Employee, week: number) => weekMinimums.get(employee.id)!.get(week)!.target
  const weightExamples = weightedWeeks(state, undefined, { ...options, planning: true })
  const employeeIds = new Set(state.employees.map(employee => employee.id))
  const fixedCounts = new Map<string, Set<string>>()
  const fixedRest = new Set<string>()
  for (const item of fixed) {
    if (item.shiftId === 'off') fixedRest.add(`${item.employeeId}\0${item.date}`)
    if (!shifts.has(item.shiftId)) continue
    const employees = fixedCounts.get(item.date) ?? new Set<string>()
    employees.add(item.employeeId); fixedCounts.set(item.date, employees)
  }
  const demandDates = new Set([...activeDates, ...context.weeks.flatMap(week => week.outsideDates.filter(date => date >= context.referenceDate))])
  const dailyMinimum = state.shifts.reduce((sum, shift) => sum + shift.required, 0)
  const dailyMaximum = state.shifts.every(shift => shift.staffingMode === 'fixed') ? Math.min(dailyMinimum, state.employees.length) : state.employees.length
  let best = fixed, bestRank = [Infinity, Infinity, Infinity, Infinity]
  for (let attempt = 0; attempt < 32; attempt++) {
    const random = randomSource(seed + attempt * 7919)
    // A stable shift preference leaves usable rest windows between workdays.
    // Rotate preferences between strategies instead of forcing daily shift variety.
    const preferredShift = new Map(state.employees.map((employee, index) => [employee.id, employee.eligibleShiftIds[(index + Math.floor(attempt / 4)) % Math.max(1, employee.eligibleShiftIds.length)]]))
    const assignments = fixed.map(item => ({ ...item }))
    const plans = state.employees.map(employee => ({ employee, work: [], occupied: new Set<string>(), days: new Set<number>(), weeks: new Map<number, number>(), monthWeeks: new Map<number, number>(), hours: 0, shiftCounts: new Map<string, number>(), shiftStartDates: new Map<string, Set<number>>(), weeklyShiftCounts: new Map<string, Map<number, number>>() } as EmployeePlan))
    for (const item of fixed) {
      const plan = plans.find(entry => entry.employee.id === item.employeeId)
      if (plan) addToPlan(plan, item, shifts, state.month, window)
    }
    // These are search candidates, never fixed limits derived from required.
    // The desktop solver searches the full domain; this browser heuristic tries
    // increasing legal budgets and validates the final actual counts independently.
    const weighted = weightExamples.map(example => {
      const requiredSlots = plans.reduce((sum, plan) => {
        const longest = Math.max(0, ...state.shifts.filter(shift => plan.employee.eligibleShiftIds.includes(shift.id) && (shift.staffingMode !== 'fixed' || shift.required > 0)).map(shift => shiftHours(shift) * 60))
        const needed = Math.max(0, weekMinimum(plan.employee, dateTime(example.id)) - (plan.monthWeeks.get(dateTime(example.id)) || 0))
        return sum + (longest ? Math.ceil(needed / longest) : 0)
      }, 0)
      const choices: WeightedWeek[] = []
      for (let fullTotal = 0; fullTotal <= state.employees.length * 7; fullTotal++) {
        const candidate = weightedWeekTargets(example, state.rules.weekdayWeights!, fullTotal)
        if (candidate.totalTarget < requiredSlots || !weightedHistoryFits(candidate)) continue
        const fits = [[candidate.selectedDates, candidate.selectedTarget], [candidate.otherDates, candidate.otherTarget]].every(([rawDates, rawTotal]) => {
          const group = rawDates as string[], total = rawTotal as number
          if (!group.length) return total === 0
          const [low, high] = weightedDayRange(candidate, group[0]!)
          let floor = 0, ceiling = 0
          for (const date of group) {
            const lockedWork = fixedCounts.get(date)?.size ?? 0
            const available = plans.filter(plan => !plan.employee.unavailableDates.includes(date) && plan.employee.maxHoursPerWeek > 0 && plan.employee.eligibleShiftIds.length && !fixedRest.has(`${plan.employee.id}\0${date}`)).length
            const min = Math.max(low, dailyMinimum, lockedWork), max = Math.min(high, dailyMaximum, available)
            if (min > max) return false
            floor += min; ceiling += max
          }
          return floor <= total && total <= ceiling
        })
        if (fits && !choices.some(week => week.totalTarget === candidate.totalTarget && week.selectedTarget === candidate.selectedTarget)) choices.push(candidate)
      }
      // No candidate is not a proof of infeasibility; validation reports it and
      // the existing roster is retained for the exact desktop solver to retry.
      return choices[Math.min(Math.floor(attempt / 8), Math.max(0, choices.length - 1))] ?? example
    })
    const dayTargets = weightedDailyTargets(weighted, fixed, employeeIds, shifts, random)
    const countOn = (date: string, shiftId?: string) => new Set(assignments.filter(item => item.date === date && shifts.has(item.shiftId) && (!shiftId || item.shiftId === shiftId) && employeeIds.has(item.employeeId)).map(item => item.employeeId)).size
    const gain = (plan: EmployeePlan, prototype: Work) => window.weeks.reduce((sum, week) => sum + Math.min(Math.max(0, weekMinimum(plan.employee, week.week) - (plan.monthWeeks.get(week.week) || 0)), overlapMinutes(prototype, week.week, week.week + 7 * DAY)), 0)
    const pick = (candidates: Array<{ plan: EmployeePlan; prototype: Work }>, requireGain = false, targetWeek?: MonthWindow['weeks'][number]) => {
      const scored = candidates.map(({ plan, prototype }) => {
        const weekGain = gain(plan, prototype)
        // Sunday-night hours mostly belong to Monday's week. When repairing a
        // specific week's minimum, prefer the hours actually credited to that week.
        const targetGain = targetWeek ? Math.min(Math.max(0, weekMinimum(plan.employee, targetWeek.week) - (plan.monthWeeks.get(targetWeek.week) || 0)), overlapMinutes(prototype, targetWeek.week, targetWeek.week + 7 * DAY)) : 0
        return { plan, prototype, useful: weekGain > EPSILON, score:
          -weekGain * 1000
          - targetGain * 10000
          + (preferredShift.get(plan.employee.id) === prototype.assignment.shiftId ? 0 : 30)
          + plan.hours / Math.max(1, plan.employee.maxHoursPerWeek) * 10
          - (plan.shiftCounts.get(prototype.assignment.shiftId) || 0) * 0.7
          + random() * (attempt % 3 === 0 ? 2 : 0.8) }
      }).filter(item => !requireGain || item.useful).sort((a, b) => a.score - b.score)
      const chosen = scored[0]
      if (!chosen) return false
      const assignment = { ...chosen.prototype.assignment, employeeId: chosen.plan.employee.id }
      assignments.push(assignment)
      addToPlan(chosen.plan, assignment, shifts, state.month, window)
      return true
    }
    const candidatesOn = (date: string, shiftList: Shift[], onlyPlan?: EmployeePlan) => {
      if (weighted.length && countOn(date) >= (dayTargets.get(date) ?? 0)) return []
      return shiftList.flatMap(shift => {
        if (shift.staffingMode === 'fixed' && countOn(date, shift.id) >= shift.required) return []
        const prototype = workFor({ employeeId: '', date, shiftId: shift.id, locked: false }, shifts)!
        return (onlyPlan ? [onlyPlan] : plans).filter(plan => allowed(plan, prototype, state, assignments)).map(plan => ({ plan, prototype }))
      })
    }
    const traversal = attempt % 4 === 3 ? [...dates].reverse() : dates
    // Cover every shift first; weighted ratios do not remove this daily floor.
    for (const date of traversal) {
      if (!demandDates.has(date)) continue
      const ordered = [...state.shifts].sort((a, b) => candidatesOn(date, [a]).length - candidatesOn(date, [b]).length || b.start.localeCompare(a.start))
      for (const shift of ordered) while (countOn(date, shift.id) < shift.required) {
        if (!pick(candidatesOn(date, [shift]))) break
      }
    }
    if (weighted.length) {
      for (const date of traversal) while (countOn(date) < (dayTargets.get(date) ?? 0)) {
        if (!pick(candidatesOn(date, state.shifts))) break
      }
    } else {
      // Add qualified staff even when all daily minimums are covered. Complete
      // each boundary/full week using the actual hours credited to that week.
      // Secure boundary remainders first: fixed adjacent work may leave only
      // one usable day, and interior choices must preserve that rest window.
      for (const week of [...window.weeks].sort((a, b) => a.days - b.days || a.week - b.week)) {
        const group = plans.map(plan => ({ plan, tie: random() })).sort((a, b) => (b.plan.employee.minHoursPerWeek ?? 0) - (a.plan.employee.minHoursPerWeek ?? 0) || a.tie - b.tie)
        for (const { plan } of group) {
          while ((plan.monthWeeks.get(week.week) || 0) + EPSILON < weekMinimum(plan.employee, week.week)) {
            const candidates = traversal.flatMap(date => candidatesOn(date, state.shifts, plan)).filter(item => overlapMinutes(item.prototype, week.week, week.week + 7 * DAY) > 0)
            if (!pick(candidates, true, week)) break
          }
        }
      }
    }
    const missing = [...demandDates].reduce((sum, date) => sum + state.shifts.reduce((total, shift) => total + Math.max(0, shift.required - countOn(date, shift.id)), 0), 0)
    const ratios = plans.filter(plan => plan.employee.maxHoursPerWeek > 0).map(plan => plan.hours / plan.employee.maxHoursPerWeek)
    const mean = ratios.reduce((sum, value) => sum + value, 0) / Math.max(1, ratios.length)
    const fairness = ratios.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    const deficit = plans.reduce((sum, plan) => sum
      + window.weeks.reduce((total, week) => total + Math.max(0, weekMinimum(plan.employee, week.week) - (plan.monthWeeks.get(week.week) || 0)), 0), 0)
    const weightErrors = weighted.length ? validateSchedule({ ...state, assignments }, planningOptions).filter(issue => issue.type.startsWith('weekday-')).length : 0
    const rank = [deficit + weightErrors * 1e6, missing, assignments.length, fairness]
    const firstDifference = rank.findIndex((value, index) => Math.abs(value - bestRank[index]!) > EPSILON)
    if (firstDifference >= 0 && rank[firstDifference]! < bestRank[firstDifference]!) { bestRank = rank; best = assignments }
    // Stop once all hard requirements and coverage pass; further random restarts
    // only polish fairness and needlessly delay an already usable roster.
    if (deficit < EPSILON && missing === 0 && weightErrors === 0 && !validateSchedule({ ...state, assignments }, planningOptions).some(issue => issue.severity === 'error' || issue.type === 'coverage')) {
      // This heuristic stops at its first complete roster. Attempts with rule
      // violations or missing coverage must never appear as feasible solutions.
      try { onSolutionCount?.(1) } catch { /* Optional progress cannot affect the result. */ }
      break
    }
  }
  best.sort((a, b) => a.date.localeCompare(b.date) || a.employeeId.localeCompare(b.employeeId) || a.shiftId.localeCompare(b.shiftId))
  const planningIssues = validateSchedule({ ...state, assignments: best }, planningOptions)
  let success = !planningIssues.some(issue => issue.severity === 'error')
  const assignments = success ? [...originalOutside, ...best.filter(item => activeDates.has(item.date))]
    .sort((a, b) => a.date.localeCompare(b.date) || a.employeeId.localeCompare(b.employeeId) || a.shiftId.localeCompare(b.shiftId))
    : state.assignments.map(item => ({ ...item }))
  const boundaryPreview = success ? best.filter(item => item.shiftId !== 'off' && futureCells.has(`${item.employeeId}\0${item.date}`)).map(item => ({ ...item, locked: false })) : []
  const previewIssues = success ? validateBoundaryPreview({ ...state, assignments }, boundaryPreview, context.referenceDate).filter(issue => issue.type === 'boundary-coverage' || issue.type === 'overstaffed') : []
  if (previewIssues.length) success = false
  const issues = [...planningIssues, ...previewIssues, ...boundaryWarnings(state, options)]
  return { assignments: success ? assignments : state.assignments.map(item => ({ ...item })), issues, success, boundaryPreview: success ? boundaryPreview : [], boundaryContext: context }
}

/** Validate native/worker provisional evidence independently from returned
 * context. The caller must first verify that saved out-of-month cells were
 * preserved. A preview may fill only unknown future cells; absent cells are
 * provisional rest, never an assertion about a saved adjacent month. */
export function validateBoundaryPreview(state: PlannerState, preview: unknown, referenceDate?: string): Issue[] {
  const context = getWeekBoundaryContext(state, { referenceDate })
  const invalid = (message: string): Issue[] => [{ id: 'boundary-preview-invalid', type: 'boundary-preview', severity: 'error', message, target: 'calendar' }]
  if (!context) return invalid('跨月预排计算日期无效。')
  const allowedCells = new Set(context.weeks.flatMap(week => week.employees.flatMap(employee => employee.unknownFutureDates.map(date => `${employee.employeeId}\0${date}`))))
  if (preview === undefined && !allowedCells.size) preview = []
  if (!Array.isArray(preview)) return invalid('求解结果缺少跨月临时预排数据，无法核对完整自然周。')
  const seen = new Set<string>()
  for (const assignment of preview) {
    if (!assignment || typeof assignment !== 'object' || assignment.shiftId === 'off' || assignment.locked !== false) return invalid('跨月预排只能包含未锁定的临时工作班次。')
    const cell = `${assignment.employeeId}\0${assignment.date}`
    if (!allowedCells.has(cell) || seen.has(cell)) return invalid('跨月预排包含重复记录、已知排班或不可改写的历史日期。')
    seen.add(cell)
  }
  const combined = { ...state, assignments: [...state.assignments, ...preview] }
  const issues = validateSchedule(combined, { referenceDate, planning: true, boundaryState: state, includeBoundaryWarnings: false })
  // Ordinary validation checks selected-month staffing. Provisional days also
  // must satisfy daily demand, fixed caps, and qualifications independently.
  const dates = context.weeks.flatMap(week => week.outsideDates.filter(date => date >= context.referenceDate))
  for (const date of dates) for (const shift of state.shifts) {
    const count = new Set(combined.assignments.filter(item => item.date === date && item.shiftId === shift.id).map(item => item.employeeId)).size
    if (count < shift.required) issues.push({ id: `boundary-coverage-${date}-${shift.id}`, type: 'boundary-coverage', severity: 'warning', date,
      message: `${date} 相邻月份未来安排的${shift.name}缺 ${shift.required - count} 人；请核对该月已确认安排与人数要求，已有记录不会自动改写。` })
    if (shift.staffingMode === 'fixed' && count > shift.required) issues.push({ id: `boundary-overstaffed-${date}-${shift.id}`, type: 'overstaffed', severity: 'error', date,
      message: `${date} 相邻月份未来安排的${shift.name}超过固定人数 ${shift.required} 人；请核对该月已确认安排，已有记录不会自动改写。` })
  }
  return issues
}
