import test from 'node:test'
import assert from 'node:assert/strict'
import { datesOfMonth, shiftHours, validateSchedule, generateSchedule } from '../scheduler.ts'
import { makeDefaultState } from '../defaults.ts'
import { weightedWeeks } from '../weekday-weights.ts'

const morning = { id: 'morning', name: '早班', shortName: '早', start: '08:00', end: '16:00', color: '#fff', required: 1 }
const night = { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#eee', required: 0 }
const employee = (id = 'a', extra = {}) => ({ id, name: id, role: '员工', group: '一组', color: '#fff', maxHoursPerWeek: 40, eligibleShiftIds: ['morning', 'night'], unavailableDates: [], ...extra })
const assignment = (date, shiftId = 'morning', locked = false, employeeId = 'a') => ({ employeeId, date, shiftId, locked })
const state = (extra = {}) => ({ version: 1, teamName: '测试', month: '2026-10', employees: [employee()], shifts: [{ ...morning }, { ...night }], rules: { minRestHours: 11, maxConsecutiveDays: 5 }, assignments: [], ...extra })
const types = value => validateSchedule(value).map(issue => issue.type)

test('calendar and overnight durations are deterministic civil dates', () => {
  assert.equal(datesOfMonth('2024-02').length, 29)
  assert.equal(datesOfMonth('2025-02').length, 28)
  assert.equal(datesOfMonth('2026-13').length, 0)
  assert.equal(datesOfMonth('2026-1').length, 0)
  assert.equal(shiftHours(night), 8)
  assert.equal(shiftHours({ ...night, start: '23:30', end: '00:15' }), 0.75)
  assert.equal(shiftHours({ ...night, start: '25:00' }), 0)
})

test('default demo retains its full roster and reports new reference minimum deficits honestly', () => {
  const value = makeDefaultState('2026-10')
  assert.equal(value.employees.length, 12)
  assert.equal(value.assignments.length, 31 * 5)
  assert.ok(value.employees.every(employee => employee.minHoursPerMonth === null))
  const initialIssues = validateSchedule(value)
  assert.ok(initialIssues.some(issue => issue.type === 'monthly-min-hours'))
  assert.ok(initialIssues.every(issue => issue.type === 'monthly-min-hours'))
  const rejected = generateSchedule(value, 41)
  assert.equal(rejected.success, false)
  assert.deepEqual(rejected.assignments, value.assignments)
  // The unchanged demonstration is feasible under its original, zero-minimum rules.
  value.employees.forEach(employee => { employee.minHoursPerMonth = 0 })
  assert.deepEqual(validateSchedule(value), [])
  const generated = generateSchedule(value, 41)
  assert.equal(generated.success, true)
  assert.deepEqual(generated, generateSchedule(value, 41))
  assert.deepEqual(generated.issues, [])
  for (const item of generated.assignments) {
    assert.equal(generated.assignments.filter(other => other.date === item.date && other.employeeId === item.employeeId).length, 1)
  }
})

test('night to morning and cross-month rest violations are detected', () => {
  const value = state({ assignments: [assignment('2026-09-30', 'night'), assignment('2026-10-01')] })
  assert.ok(types(value).includes('rest'))
  const result = generateSchedule(state({ assignments: [assignment('2026-09-30', 'night')] }))
  assert.ok(result.assignments.some(item => item.date === '2026-09-30'))
  assert.ok(!result.assignments.some(item => item.date === '2026-10-01'))
  assert.ok(!result.issues.some(issue => issue.severity === 'error'))
})

test('Monday-Sunday weekly hours include previous-month assignments', () => {
  const fixed = ['2026-09-28', '2026-09-29', '2026-09-30'].map(date => assignment(date))
  const value = state({ employees: [employee('a', { maxHoursPerWeek: 24 })], assignments: fixed })
  const result = generateSchedule(value)
  assert.deepEqual(result.assignments.filter(item => item.date < '2026-10-01'), fixed)
  assert.ok(!result.assignments.some(item => item.date >= '2026-10-01' && item.date <= '2026-10-04'))
  assert.ok(types({ ...value, assignments: [...fixed, assignment('2026-10-01')] }).includes('weekly-hours'))
})

test('Sunday night hours are split between both calendar weeks', () => {
  const value = state({ employees: [employee('a', { maxHoursPerWeek: 8 })], assignments: [assignment('2026-10-04', 'night'), assignment('2026-10-06')] })
  const issue = validateSchedule(value).find(item => item.type === 'weekly-hours')
  assert.equal(issue?.date, '2026-10-05')
  assert.match(issue.message, /14 小时/)
})

test('locked rest is retained and prevents any work on that date', () => {
  const fixed = assignment('2026-10-02', 'off', true)
  const result = generateSchedule(state({ assignments: [fixed] }))
  assert.deepEqual(result.assignments.filter(item => item.date === fixed.date), [fixed])
  assert.ok(result.issues.some(issue => issue.type === 'coverage' && issue.date === fixed.date))
})

test('future-month work prevents a continuous run at the month boundary', () => {
  const future = [1, 2, 3, 4, 5].map(day => assignment(`2026-11-0${day}`))
  const value = state({ assignments: future })
  const result = generateSchedule(value)
  assert.deepEqual(result.assignments.filter(item => item.date.startsWith('2026-11')), future)
  assert.ok(!result.assignments.some(item => item.date === '2026-10-31'))
  assert.ok(!result.issues.some(issue => issue.type === 'consecutive-days'))
  assert.ok(types({ ...value, assignments: [assignment('2026-10-31'), ...future] }).includes('consecutive-days'))
})

test('leave and qualifications are hard constraints, including night entering leave', () => {
  const value = state({ employees: [employee('a', { eligibleShiftIds: ['night'], unavailableDates: ['2026-10-02'] })], shifts: [{ ...morning }, { ...night, required: 1 }] })
  const result = generateSchedule(value)
  assert.ok(result.assignments.every(item => item.shiftId === 'night'))
  assert.ok(!result.assignments.some(item => ['2026-10-01', '2026-10-02'].includes(item.date)))
  assert.ok(!result.issues.some(issue => issue.severity === 'error'))
  assert.ok(types({ ...value, assignments: [assignment('2026-10-01', 'night')] }).includes('unavailable'))
})

test('invalid and surplus locked work is reported instead of deleted', () => {
  const locked = [assignment('2026-10-01', 'morning', true), assignment('2026-10-01', 'night', true), assignment('2026-10-02', 'missing', true)]
  const value = state({ employees: [employee('a', { eligibleShiftIds: ['morning'], unavailableDates: ['2026-10-01'] })], assignments: locked })
  const result = generateSchedule(value)
  for (const item of locked) assert.ok(result.assignments.some(other => JSON.stringify(other) === JSON.stringify(item)))
  for (const type of ['duplicate', 'qualification', 'unavailable', 'unknown-shift', 'overstaffed']) assert.ok(result.issues.some(issue => issue.type === type), type)
})

test('impossible staffing leaves explicit shortages without relaxing rules or mutating input', () => {
  const value = state({ employees: [employee('a', { maxHoursPerWeek: 8 })], shifts: [{ ...morning, required: 3 }] })
  value.employees[0].eligibleShiftIds = ['morning']
  const original = JSON.stringify(value)
  const result = generateSchedule(value)
  assert.equal(JSON.stringify(value), original)
  assert.ok(result.issues.some(issue => issue.type === 'coverage'))
  assert.ok(!result.issues.some(issue => issue.severity === 'error'))
  assert.ok(result.assignments.length <= 5)
})

test('malformed config returns issues and preserves assignments', () => {
  const value = state({ month: '2026-99', assignments: [assignment('2026-10-01')] })
  const result = generateSchedule(value)
  assert.deepEqual(result.assignments, value.assignments)
  assert.ok(result.issues.some(issue => issue.type === 'configuration'))
})

test('duplicate copies of one person do not satisfy a two-person requirement', () => {
  const value = state({ shifts: [{ ...morning, required: 2 }, { ...night }], assignments: [assignment('2026-10-01'), assignment('2026-10-01')] })
  const issues = validateSchedule(value)
  assert.ok(issues.some(issue => issue.type === 'duplicate'))
  assert.ok(issues.some(issue => issue.type === 'coverage' && issue.date === '2026-10-01' && issue.message.includes('缺 1 人')))
})

const separation = (employeeIds, shiftIds = [], id = 'separation-1') => ({ id, name: `分开值班 ${id}`, employeeIds, shiftIds })
const flexibleEmployee = id => employee(id, { maxHoursPerWeek: 168 })
const separationState = extra => state({
  employees: ['a', 'b', 'c'].map(flexibleEmployee),
  shifts: [{ ...morning, required: 2 }, { ...night }],
  rules: { minRestHours: 11, maxConsecutiveDays: 31, separationGroups: [separation(['a', 'b'])] },
  ...extra,
})

test('separated employees never share a shift and a third employee fills the second seat', () => {
  const value = separationState()
  const result = generateSchedule(value)
  assert.deepEqual(result.issues, [])
  for (const date of datesOfMonth(value.month)) {
    const ids = result.assignments.filter(item => item.date === date).map(item => item.employeeId)
    assert.equal(ids.length, 2)
    assert.ok(ids.includes('c'))
    assert.ok(!(ids.includes('a') && ids.includes('b')))
  }
})

test('separation permits different shifts on the same date and the same shift on different dates', () => {
  const value = separationState({ assignments: [assignment('2026-10-01', 'morning', false, 'a'), assignment('2026-10-01', 'night', false, 'b'), assignment('2026-10-02', 'morning', false, 'b')] })
  assert.ok(!types(value).includes('separation'))
})

test('separation shift scope applies only to the selected shift IDs', () => {
  const value = separationState({ rules: { minRestHours: 11, maxConsecutiveDays: 31, separationGroups: [separation(['a', 'b'], ['night'])] }, assignments: [assignment('2026-10-01', 'morning', false, 'a'), assignment('2026-10-01', 'morning', false, 'b')] })
  assert.ok(!types(value).includes('separation'))
  value.assignments.push(assignment('2026-10-02', 'night', true, 'a'), assignment('2026-10-02', 'night', true, 'b'))
  const issues = validateSchedule(value).filter(issue => issue.type === 'separation')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].date, '2026-10-02')
})

test('overlapping separation groups are all enforced', () => {
  const value = separationState({ employees: ['a', 'b', 'c', 'd'].map(flexibleEmployee), rules: { minRestHours: 11, maxConsecutiveDays: 31, separationGroups: [separation(['a', 'b']), separation(['b', 'c'], [], 'separation-2'), separation(['c', 'd'], [], 'separation-3')] } })
  const result = generateSchedule(value)
  assert.deepEqual(result.issues, [])
  for (const date of datesOfMonth(value.month)) {
    const ids = result.assignments.filter(item => item.date === date).map(item => item.employeeId)
    assert.equal(ids.length, 2)
    for (const group of value.rules.separationGroups) assert.ok(ids.filter(id => group.employeeIds.includes(id)).length <= 1)
  }
})

test('conflicting locked employees are preserved and produce an explicit separation error', () => {
  const locked = [assignment('2026-10-01', 'morning', true, 'a'), assignment('2026-10-01', 'morning', true, 'b')]
  const result = generateSchedule(separationState({ assignments: locked }))
  assert.deepEqual(result.assignments.filter(item => item.date === '2026-10-01'), locked)
  assert.ok(result.issues.some(issue => issue.type === 'separation' && issue.severity === 'error' && issue.date === '2026-10-01'))
})

test('impossible separated staffing leaves shortages without permitting incompatible coworkers', () => {
  const result = generateSchedule(separationState({ employees: ['a', 'b'].map(flexibleEmployee) }))
  assert.ok(result.issues.some(issue => issue.type === 'coverage'))
  assert.ok(!result.issues.some(issue => issue.severity === 'error'))
  assert.equal(result.assignments.length, 31)
})

const minimumIssues = value => validateSchedule(value).filter(issue => ['monthly-min-hours', 'weekly-min-hours'].includes(issue.type))

test('monthly minimum counts actual in-month hours, including carried nights and excluding outgoing hours', () => {
  const value = state({ employees: [employee('a', { minHoursPerMonth: 8 })], assignments: [assignment('2026-09-30', 'night'), assignment('2026-10-31', 'night')] })
  assert.deepEqual(minimumIssues(value), []) // 6 hours carried in + 2 before November.
  value.employees[0].minHoursPerMonth = 8.001
  const issue = minimumIssues(value)[0]
  assert.equal(issue.type, 'monthly-min-hours')
  assert.match(issue.message, /实际工时 8 小时/)
  assert.match(issue.message, /8\.02 小时/)
  assert.equal(issue.employeeId, 'a')
  assert.equal(issue.date, '2026-10-01')
})

test('null monthly minimum follows the selected month reference; missing legacy values and explicit zero stay disabled', () => {
  const value = state({ monthlyReferenceHours: { '2026-10': 16, '2026-11': 24 }, employees: [employee('a', { minHoursPerMonth: null })], assignments: [assignment('2026-10-01')] })
  assert.match(minimumIssues(value)[0].message, /月最低工时 16 小时/)
  value.employees[0].minHoursPerMonth = 0
  assert.deepEqual(minimumIssues(value), [])
  delete value.employees[0].minHoursPerMonth
  assert.deepEqual(minimumIssues(value), [])
})

test('every Monday-Sunday week intersecting the month is checked, including empty and partial weeks', () => {
  const issues = minimumIssues(state({ employees: [employee('a', { minHoursPerWeek: 40 })] }))
  assert.equal(issues.length, 5)
  assert.deepEqual(issues.map(issue => issue.date), ['2026-10-01', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'])
  assert.match(issues[0].message, /本月 4 天/)
  assert.match(issues[0].message, /22\.87 小时/)
  assert.match(issues.at(-1).message, /本月 6 天/)
  assert.match(issues.at(-1).message, /34\.3 小时/)
  assert.ok(issues.every(issue => issue.severity === 'error'))
})

test('prorated weekly minimum is rounded up to one minute instead of down to a fractional hour', () => {
  const short = { ...morning, id: 'short', name: '短班', end: '14:52', required: 0 }
  const value = state({ employees: [employee('a', { minHoursPerWeek: 40, eligibleShiftIds: ['morning', 'short'] })], shifts: [morning, short], assignments: [assignment('2026-10-01'), assignment('2026-10-02'), assignment('2026-10-03', 'short')] })
  assert.ok(!minimumIssues(value).some(issue => issue.date === '2026-10-01')) // 1372 minutes >= ceil(2400 * 4 / 7).
  value.shifts[1] = { ...short, end: '14:51' }
  assert.ok(minimumIssues(value).some(issue => issue.date === '2026-10-01'))
})

test('previous-month hours do not satisfy the in-month weekly minimum, except their in-month overnight tail', () => {
  const value = state({ employees: [employee('a', { minHoursPerWeek: 7 })], assignments: [assignment('2026-09-28'), assignment('2026-09-29'), assignment('2026-09-30', 'night')] })
  assert.ok(!minimumIssues(value).some(issue => issue.date === '2026-10-01')) // 6 carried hours meets 4-hour target.
  value.employees[0].minHoursPerWeek = 14
  const issue = minimumIssues(value).find(issue => issue.date === '2026-10-01')
  assert.match(issue.message, /实际工时 6 小时/)
  assert.match(issue.message, /周最低工时 8 小时/)
  value.employees[0].maxHoursPerWeek = 24
  value.assignments.push(assignment('2026-10-02'))
  assert.ok(types(value).includes('weekly-hours')) // All full-week history still counts toward the maximum.
})

test('Sunday night contributes only its actual hours to each weekly minimum', () => {
  const value = state({ employees: [employee('a', { minHoursPerWeek: 7 })], assignments: [assignment('2026-10-04', 'night')] })
  const issues = minimumIssues(value)
  assert.match(issues.find(issue => issue.date === '2026-10-01').message, /实际工时 2 小时/)
  assert.match(issues.find(issue => issue.date === '2026-10-05').message, /实际工时 6 小时/)
})

test('minimum configuration rejects negatives, nonfinite values, excessive bounds and weekly minimum above maximum', () => {
  for (const extra of [{ minHoursPerMonth: -1 }, { minHoursPerMonth: NaN }, { minHoursPerMonth: 745 }, { minHoursPerWeek: -1 }, { minHoursPerWeek: Infinity }, { minHoursPerWeek: 169 }, { minHoursPerWeek: 41 }, { minHoursPerWeek: null }]) {
    const value = state({ employees: [employee('a', extra)], assignments: [assignment('2026-10-01')] })
    assert.ok(types(value).includes('configuration'), JSON.stringify(extra))
    const generated = generateSchedule(value)
    assert.equal(generated.success, false)
    assert.deepEqual(generated.assignments, value.assignments)
  }
})

test('heuristic gives minimum deficits priority while keeping weekly caps and staff coverage', () => {
  const value = state({ employees: [employee('a', { minHoursPerMonth: 160, minHoursPerWeek: 24 }), employee('b', { minHoursPerMonth: 40 })] })
  const original = JSON.stringify(value)
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, true)
  assert.deepEqual(generated.issues, [])
  assert.equal(generated.assignments.length, 31)
  assert.equal(JSON.stringify(value), original)
  assert.deepEqual(generated, generateSchedule(value, 42))
})

test('unmet monthly or weekly minimum never replaces the original schedule or relaxes demand', () => {
  for (const minimum of [{ minHoursPerMonth: 32 }, { minHoursPerWeek: 40 }]) {
    const original = [assignment('2026-10-02', 'off', true), assignment('2026-09-30', 'night')]
    const value = state({ employees: [employee('a', minimum)], shifts: [{ ...morning, required: 0 }, night], assignments: original })
    const result = generateSchedule(value)
    assert.equal(result.success, false)
    assert.deepEqual(result.assignments, original)
    assert.notEqual(result.assignments, original)
    assert.ok(result.issues.some(issue => ['monthly-min-hours', 'weekly-min-hours'].includes(issue.type)))
    assert.ok(!result.issues.some(issue => issue.type === 'overstaffed'))
  }
})

test('generation includes carried night hours when satisfying a monthly minimum without new work', () => {
  const value = state({ employees: [employee('a', { minHoursPerMonth: 6 })], shifts: [{ ...morning, required: 0 }, night], assignments: [assignment('2026-09-30', 'night')] })
  const result = generateSchedule(value)
  assert.equal(result.success, true)
  assert.deepEqual(result.assignments, value.assignments)
  assert.deepEqual(result.issues, [])
})

test('minimum rounding agrees with decimal solver arithmetic for tiny positive numbers and exact decimal minutes', () => {
  const tiny = state({ employees: [employee('a', { minHoursPerMonth: 1e-12, minHoursPerWeek: 1e-12 })] })
  const issues = minimumIssues(tiny)
  assert.equal(issues.length, 6) // One minute still required for month and each of five weeks.
  assert.ok(issues.every(issue => /0\.02 小时/.test(issue.message)))
  const decimal = state({ employees: [employee('a', { minHoursPerMonth: 2.05, maxHoursPerWeek: 2.05 })], shifts: [{ ...morning, end: '10:03' }], assignments: [assignment('2026-10-01')] })
  assert.deepEqual(minimumIssues(decimal), [])
  assert.ok(!types(decimal).includes('weekly-hours')) // 2.05 hours means exactly 123 minutes.
})

test('duplicate or overlapping manual assignments cannot inflate actual monthly or weekly minimum hours', () => {
  const value = state({ employees: [employee('a', { minHoursPerMonth: 16, minHoursPerWeek: 28 })], assignments: [assignment('2026-10-01'), assignment('2026-10-01')] })
  const issues = minimumIssues(value)
  assert.match(issues.find(issue => issue.type === 'monthly-min-hours').message, /实际工时 8 小时/)
  assert.match(issues.find(issue => issue.type === 'weekly-min-hours' && issue.date === '2026-10-01').message, /实际工时 8 小时/)
})

test('an invalid month with a reference-linked minimum reports configuration errors without throwing', () => {
  const value = state({ month: '2026-99', employees: [employee('a', { minHoursPerMonth: null })] })
  assert.ok(types(value).includes('configuration'))
  assert.equal(generateSchedule(value).success, false)
})

const weightState = (extra = {}) => state({
  employees: ['a', 'b', 'c', 'd'].map(flexibleEmployee),
  rules: { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: { days: [6, 7], percent: 40 } },
  ...extra,
})

test('weekday weights replace fixed daily demand with exact weekly team quotas and even group distribution', () => {
  const value = weightState()
  const result = generateSchedule(value, 42)
  assert.equal(result.success, true)
  assert.deepEqual(result.issues, [])
  assert.equal(result.assignments.length, 32) // Partial-week ceiling keeps its share, not a renormalized 31.
  for (const week of weightedWeeks(value)) {
    const weekItems = result.assignments.filter(item => week.dates.includes(item.date))
    assert.equal(weekItems.length, week.totalTarget)
    assert.equal(weekItems.filter(item => week.selectedDates.includes(item.date)).length, week.selectedTarget)
    assert.equal(weekItems.filter(item => week.otherDates.includes(item.date)).length, week.otherTarget)
    for (const dates of [week.selectedDates, week.otherDates]) {
      const counts = dates.map(date => weekItems.filter(item => item.date === date).length)
      if (counts.length) assert.ok(Math.max(...counts) - Math.min(...counts) <= 1)
    }
  }
  const weeks = weightedWeeks(value)
  assert.equal(weeks[0].selectedTarget, 3)
  assert.equal(weeks[0].otherTarget, 2) // ceil(4 remaining weekday seats × 2/5), not redistributed.
  assert.equal(weeks.at(-1).selectedTarget, 2) // Only Saturday is in October: ceil(3 × 1/2).
  assert.equal(weeks.at(-1).otherTarget, 4)
  assert.deepEqual(result, generateSchedule(value, 42))
})

test('weighted weekly totals allow multiple employees of one shift on a day instead of capping it at old daily demand', () => {
  const value = weightState({
    employees: Array.from({ length: 9 }, (_, index) => flexibleEmployee(String(index))),
    shifts: [{ ...morning }, { ...night, required: 1 }],
    rules: { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: { days: [6, 7], percent: 100 } },
  })
  const result = generateSchedule(value)
  assert.equal(result.success, true)
  assert.deepEqual(result.issues, [])
  assert.ok(result.assignments.every(item => [0, 6].includes(new Date(`${item.date}T00:00:00Z`).getUTCDay())))
  const week = result.assignments.filter(item => item.date >= '2026-10-05' && item.date <= '2026-10-11')
  assert.equal(week.length, 14)
  assert.equal(week.filter(item => item.shiftId === 'morning').length, 7)
  assert.equal(week.filter(item => item.shiftId === 'night').length, 7)
  assert.ok(week.some(item => week.filter(other => other.date === item.date && other.shiftId === item.shiftId).length > 1))
})

test('rounding applies once to the team and shift budgets use a stable largest-remainder split', () => {
  const value = weightState({
    employees: Array.from({ length: 6 }, (_, index) => flexibleEmployee(String(index))),
    shifts: [{ ...morning }, { ...night, required: 1 }],
    rules: { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: { days: [6, 7], percent: 30 } },
  })
  const weeks = weightedWeeks(value)
  assert.equal(weeks[1].selectedTarget, 5) // ceil(14 × 30%), not 2 × ceil(7 × 30%) = 6.
  assert.equal(weeks[0].totalTarget, 9) // First partial week: 5 selected + ceil(9 × 2/5).
  assert.deepEqual({ ...weeks[0].shiftTargets }, { morning: 5, night: 4 })
  const result = generateSchedule(value)
  assert.equal(result.success, true)
  assert.deepEqual(result.issues, [])
})

test('feasible locked extra seats determine which selected date receives the rounding remainder', () => {
  const locked = [assignment('2026-10-10', 'morning', true, 'a'), assignment('2026-10-10', 'morning', true, 'b')]
  const value = weightState({ assignments: locked })
  const result = generateSchedule(value)
  assert.equal(result.success, true)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.assignments.filter(item => item.date === '2026-10-10'), locked)
  assert.equal(result.assignments.filter(item => item.date === '2026-10-11').length, 1)
})

test('weighted quota or group imbalance never overwrites a locked incompatible roster', () => {
  const locked = ['a', 'b', 'c'].map(id => assignment('2026-10-10', 'morning', true, id))
  const value = weightState({ assignments: locked })
  const result = generateSchedule(value)
  assert.equal(result.success, false)
  assert.deepEqual(result.assignments, locked)
  assert.ok(result.issues.some(issue => issue.type.startsWith('weekday-') && issue.severity === 'error'))
  assert.ok(result.issues.filter(issue => issue.type.startsWith('weekday-')).every(issue => !!issue.date))
})

test('weighted shortages are hard errors even if an ordinary partial schedule could be produced', () => {
  const value = weightState({ employees: [flexibleEmployee('a')], assignments: [assignment('2026-10-01', 'off', true)] })
  const result = generateSchedule(value)
  assert.equal(result.success, false)
  assert.deepEqual(result.assignments, value.assignments)
  assert.ok(result.issues.some(issue => issue.type === 'weekday-quota'))
})

test('manual redistribution is checked against group and shift totals, not fixed day-by-shift demand', () => {
  const value = weightState()
  const generated = generateSchedule(value)
  const assignments = generated.assignments.map(item => ({ ...item }))
  const moved = assignments.find(item => item.date === '2026-10-10' || item.date === '2026-10-11')
  moved.date = '2026-10-06'
  const issues = validateSchedule({ ...value, assignments })
  assert.ok(issues.some(issue => issue.type === 'weekday-quota' && issue.date === '2026-10-05'))
  assert.ok(!issues.some(issue => issue.type === 'weekday-shift-quota'))
})

test('removed balanceWeekends flags have no effect on generation', () => {
  const value = state({ employees: ['a', 'b', 'c'].map(flexibleEmployee) })
  const on = generateSchedule({ ...value, rules: { ...value.rules, balanceWeekends: true } }, 7)
  const off = generateSchedule({ ...value, rules: { ...value.rules, balanceWeekends: false } }, 7)
  assert.deepEqual(on, off)
})

test('invalid weekday rules return configuration errors and retain the original schedule', () => {
  for (const rule of [{ days: [], percent: 40 }, { days: [0], percent: 40 }, { days: [6, 6], percent: 40 }, { days: [6, 7], percent: 40.5 }, { days: [6, 7], percent: 101 }, { days: [1, 2, 3, 4, 5, 6, 7], percent: 50 }]) {
    const value = weightState({ rules: { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: rule }, assignments: [assignment('2026-10-01')] })
    const result = generateSchedule(value)
    assert.equal(result.success, false)
    assert.deepEqual(result.assignments, value.assignments)
    assert.ok(result.issues.some(issue => issue.type === 'configuration'))
  }
})

test('a partial week without selected weekdays has zero quota at a 100 percent selected share', () => {
  const value = weightState({ month: '2026-11', rules: { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: { days: [6, 7], percent: 100 } } })
  const result = generateSchedule(value)
  assert.equal(result.success, true)
  assert.deepEqual(result.issues, [])
  assert.ok(!result.assignments.some(item => item.date === '2026-11-30')) // Monday alone has no redistributed weekend budget.
})
