import test from 'node:test'
import assert from 'node:assert/strict'
import { datesOfMonth, shiftHours, validateSchedule, generateSchedule } from '../scheduler.ts'
import { makeDefaultState } from '../defaults.ts'
import { weightedWeeks, findWeightedWeek } from '../weekday-weights.ts'

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

test('default demo has only weekly limits and regenerates its valid daily coverage', () => {
  const value = makeDefaultState('2026-10')
  assert.equal(value.employees.length, 12)
  assert.equal(value.assignments.length, 31 * 5)
  assert.ok(value.employees.every(employee => !Object.hasOwn(employee, 'minHoursPerMonth') && employee.minHoursPerWeek === 0))
  assert.deepEqual(validateSchedule(value), [])
  const generated = generateSchedule(value, 41)
  assert.equal(generated.success, true)
  assert.equal(generated.assignments.length, value.assignments.length)
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
  for (const type of ['duplicate', 'qualification', 'unavailable', 'unknown-shift']) assert.ok(result.issues.some(issue => issue.type === type), type)
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

test('browser progress counts the first complete roster without changing the result', () => {
  const value = state({ employees: ['a', 'b', 'c'].map(id => employee(id, { eligibleShiftIds: ['morning'] })), shifts: [{ ...morning }] })
  const counts = []
  let finished = false
  const result = generateSchedule(value, 42, count => {
    assert.equal(finished, false)
    counts.push(count)
  })
  finished = true
  assert.deepEqual(result.issues, [])
  assert.deepEqual(counts, [1])
  assert.deepEqual(result, generateSchedule(value, 42))
  assert.deepEqual(result, generateSchedule(value, 42, () => { throw new Error('progress sink unavailable') }))
})

test('browser progress excludes incomplete attempts and invalid configurations', () => {
  const counts = []
  const missing = state({ employees: [employee('a', { maxHoursPerWeek: 8, eligibleShiftIds: ['morning'] })], shifts: [{ ...morning, required: 3 }] })
  const result = generateSchedule(missing, 42, count => counts.push(count))
  assert.ok(result.issues.some(issue => issue.type === 'coverage'))
  generateSchedule(state({ month: '2026-99' }), 42, count => counts.push(count))
  assert.deepEqual(counts, [])
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

const minimumIssues = value => validateSchedule(value).filter(issue => issue.type === 'weekly-min-hours')

test('retired monthly minimums never validate or add work when weekly minimums are disabled', () => {
  for (const minimum of [null, 0, 744, 9999, -1, NaN, Infinity]) {
    const value = state({ monthlyReferenceHours: { '2026-10': 744 }, employees: [employee('a', { minHoursPerMonth: minimum, minHoursPerWeek: 0 })], shifts: [{ ...morning, required: 0 }, night] })
    assert.deepEqual(validateSchedule(value), [])
    const result = generateSchedule(value, 42)
    assert.equal(result.success, true)
    assert.deepEqual(result.assignments, [])
    assert.deepEqual(result.issues, [])
  }
})

test('legacy monthly values do not change weekly minimums, candidate scoring, or weighted targets', () => {
  for (const rules of [{ minRestHours: 11, maxConsecutiveDays: 5 }, { minRestHours: 11, maxConsecutiveDays: 5, weekdayWeights: { days: [6, 7], percent: 40 } }]) {
    const baseline = state({ employees: ['a', 'b', 'c', 'd'].map(id => employee(id, { minHoursPerWeek: 24 })), rules })
    const old = structuredClone(baseline)
    old.monthlyReferenceHours = { '2026-10': 744 }
    old.employees.forEach((employee, index) => { employee.minHoursPerMonth = index % 2 ? null : 744 })
    assert.deepEqual(validateSchedule(old), validateSchedule(baseline))
    const generated = generateSchedule(baseline, 42)
    assert.equal(generated.success, true)
    assert.deepEqual(generateSchedule(old, 42), generated)
  }
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

test('known previous-month hours reduce the boundary target without double counting their overnight carry-in', () => {
  const value = state({ employees: [employee('a', { minHoursPerWeek: 7 })], assignments: [assignment('2026-09-28'), assignment('2026-09-29'), assignment('2026-09-30', 'night')] })
  assert.ok(!minimumIssues(value).some(issue => issue.date === '2026-10-01')) // 6 carried hours meets 4-hour target.
  value.employees[0].minHoursPerWeek = 14
  assert.ok(!minimumIssues(value).some(issue => issue.date === '2026-10-01')) // 18 known outside hours already attain the full-week minimum.
  value.employees[0].minHoursPerWeek = 26
  const issue = minimumIssues(value).find(issue => issue.date === '2026-10-01')
  assert.match(issue.message, /实际工时 6 小时/)
  assert.match(issue.message, /周最低工时 8 小时/)
  assert.match(issue.message, /月外已知工时 18 小时/)
  value.employees[0].minHoursPerWeek = 14
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
  for (const extra of [{ minHoursPerWeek: -1 }, { minHoursPerWeek: Infinity }, { minHoursPerWeek: 169 }, { minHoursPerWeek: 41 }, { minHoursPerWeek: null }]) {
    const value = state({ employees: [employee('a', extra)], assignments: [assignment('2026-10-01')] })
    assert.ok(types(value).includes('configuration'), JSON.stringify(extra))
    const generated = generateSchedule(value)
    assert.equal(generated.success, false)
    assert.deepEqual(generated.assignments, value.assignments)
  }
})

test('heuristic gives minimum deficits priority while keeping weekly caps and staff coverage', () => {
  const value = state({ employees: [employee('a', { minHoursPerWeek: 24 }), employee('b')] })
  const original = JSON.stringify(value)
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, true)
  assert.deepEqual(generated.issues, [])
  assert.equal(generated.assignments.length, 31)
  assert.equal(JSON.stringify(value), original)
  assert.deepEqual(generated, generateSchedule(value, 42))
})

test('unmet weekly minimum retains the original when no eligible extra work is possible', () => {
  const original = [assignment('2026-10-02', 'off', true), assignment('2026-09-30', 'night')]
  const value = state({ employees: [employee('a', { minHoursPerWeek: 40, eligibleShiftIds: [] })], shifts: [{ ...morning, required: 0 }, night], assignments: original })
  const result = generateSchedule(value)
  assert.equal(result.success, false)
  assert.deepEqual(result.assignments, original)
  assert.notEqual(result.assignments, original)
  assert.ok(result.issues.some(issue => issue.type === 'weekly-min-hours'))
  assert.ok(!result.issues.some(issue => issue.type === 'overstaffed'))
})

test('retired monthly minimums never add work and carried night assignments remain intact', () => {
  const value = state({ employees: [employee('a', { minHoursPerMonth: 744 })], shifts: [{ ...morning, required: 0 }, night], assignments: [assignment('2026-09-30', 'night')] })
  const result = generateSchedule(value)
  assert.equal(result.success, true)
  assert.deepEqual(result.assignments, value.assignments)
  assert.deepEqual(result.issues, [])
})

test('minimum rounding agrees with decimal solver arithmetic for tiny positive numbers and exact decimal minutes', () => {
  const tiny = state({ employees: [employee('a', { minHoursPerWeek: 1e-12 })] })
  const issues = minimumIssues(tiny)
  assert.equal(issues.length, 5) // One minute remains required for each of five weeks.
  assert.ok(issues.every(issue => /0\.02 小时/.test(issue.message)))
  const decimal = state({ employees: [employee('a', { minHoursPerWeek: 2.05, maxHoursPerWeek: 2.05 })], shifts: [{ ...morning, end: '10:03' }], assignments: ['2026-10-01', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'].map(date => assignment(date)) })
  assert.deepEqual(minimumIssues(decimal), [])
  assert.ok(!types(decimal).includes('weekly-hours')) // 2.05 hours means exactly 123 minutes.
})

test('duplicate or overlapping manual assignments cannot inflate actual weekly minimum hours', () => {
  const value = state({ employees: [employee('a', { minHoursPerWeek: 28 })], assignments: [assignment('2026-10-01'), assignment('2026-10-01')] })
  const issues = minimumIssues(value)
  assert.match(issues.find(issue => issue.type === 'weekly-min-hours' && issue.date === '2026-10-01').message, /实际工时 8 小时/)
})

test('an invalid month with legacy monthly data reports configuration errors without throwing', () => {
  const value = state({ month: '2026-99', employees: [employee('a', { minHoursPerMonth: null })] })
  assert.ok(types(value).includes('configuration'))
  assert.equal(generateSchedule(value).success, false)
})

const weightState = (extra = {}) => state({
  employees: ['a', 'b', 'c', 'd'].map(flexibleEmployee),
  rules: { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: { days: [6, 7], percent: 40 } },
  ...extra,
})

test('weekday weights use actual totals while preserving each daily shift minimum', () => {
  const value = weightState()
  const result = generateSchedule(value, 42)
  assert.equal(result.success, true)
  assert.deepEqual(result.issues, [])
  assert.ok(result.assignments.length > 31)
  for (const date of datesOfMonth(value.month)) assert.ok(result.assignments.some(item => item.date === date && item.shiftId === 'morning'))
  for (const week of weightedWeeks(value)) {
    const weekItems = result.assignments.filter(item => week.dates.includes(item.date))
    const selected = weekItems.filter(item => week.selectedDates.includes(item.date)).length
    const others = weekItems.length - selected
    assert.ok(findWeightedWeek(value, week, selected, others))
    if (week.dates.length === 7) assert.equal(selected, Math.ceil(weekItems.length * 40 / 100))
    for (const dates of [week.selectedDates, week.otherDates]) {
      const counts = dates.map(date => weekItems.filter(item => item.date === date).length)
      if (counts.length) assert.ok(Math.max(...counts) - Math.min(...counts) <= 1)
    }
  }
  assert.deepEqual(result, generateSchedule(value, 42))
})

test('daily minimum coverage is checked even when a 100 percent weekend ratio leaves weekdays empty', () => {
  const value = weightState({
    employees: Array.from({ length: 9 }, (_, index) => flexibleEmployee(String(index))),
    shifts: [{ ...morning }, { ...night, required: 1 }],
    rules: { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: { days: [6, 7], percent: 100 } },
  })
  const result = generateSchedule(value)
  assert.ok(result.issues.some(issue => issue.type === 'coverage' && issue.date === '2026-10-05'))
  assert.ok(!result.issues.some(issue => issue.type === 'overstaffed'))
})

test('weight rounding applies once to the actual team total without per-shift upper quotas', () => {
  const value = weightState({
    employees: Array.from({ length: 6 }, (_, index) => flexibleEmployee(String(index))),
    shifts: [{ ...morning }, { ...night, required: 1 }],
    rules: { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: { days: [6, 7], percent: 30 } },
  })
  const example = weightedWeeks(value, 14)
  assert.equal(example[1].selectedTarget, 5)
  assert.equal(example[0].totalTarget, 9)
  assert.equal(example[0].shiftTargets, undefined)
  const result = generateSchedule(value)
  assert.equal(result.success, true)
  assert.deepEqual(result.issues, [])
  for (const date of datesOfMonth(value.month)) for (const shift of value.shifts) {
    assert.ok(result.assignments.filter(item => item.date === date && item.shiftId === shift.id).length >= shift.required)
  }
})

test('locked staffing above the daily floor is retained and the weighted budget can grow', () => {
  const locked = ['a', 'b', 'c'].map(id => assignment('2026-10-10', 'morning', true, id))
  const value = weightState({ assignments: locked })
  const result = generateSchedule(value)
  assert.equal(result.success, true)
  assert.deepEqual(result.issues, [])
  for (const item of locked) assert.ok(result.assignments.some(other => JSON.stringify(other) === JSON.stringify(item)))
  const saturday = result.assignments.filter(item => item.date === '2026-10-10').length
  const sunday = result.assignments.filter(item => item.date === '2026-10-11').length
  assert.ok(Math.abs(saturday - sunday) <= 1)
})

test('weighted group imbalance never replaces a locked incompatible roster', () => {
  const locked = [
    ...['a', 'b', 'c', 'd'].map(id => assignment('2026-10-10', 'morning', true, id)),
    ...['a', 'b', 'c', 'd'].map(id => assignment('2026-10-11', 'off', true, id)),
  ]
  const value = weightState({ assignments: locked })
  const result = generateSchedule(value)
  assert.equal(result.success, false)
  assert.deepEqual(result.assignments, locked)
  assert.ok(result.issues.some(issue => issue.type === 'weekday-balance'))
})

test('weighted shortages preserve the original if the attempted quota itself cannot be satisfied', () => {
  const value = weightState({ employees: [flexibleEmployee('a')], assignments: [assignment('2026-10-01', 'off', true)] })
  const result = generateSchedule(value)
  assert.equal(result.success, false)
  assert.deepEqual(result.assignments, value.assignments)
  assert.ok(result.issues.some(issue => issue.type === 'weekday-quota'))
})

test('manual redistribution is checked against actual group totals', () => {
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
  const value = weightState({ month: '2026-11', shifts: [{ ...morning, required: 0 }, night], rules: { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: { days: [6, 7], percent: 100 } } })
  const result = generateSchedule(value)
  assert.equal(result.success, true)
  assert.deepEqual(result.issues, [])
  assert.ok(!result.assignments.some(item => item.date === '2026-11-30')) // Monday alone has no redistributed weekend budget.
})


test('zero daily minimum permits additional assignments needed for positive employee minimums', () => {
  const value = state({ employees: [employee('a', { minHoursPerWeek: 7 })], shifts: [{ ...morning, required: 0 }, night] })
  const result = generateSchedule(value)
  assert.equal(result.success, true)
  assert.equal(result.assignments.length, 5)
  assert.deepEqual(result.issues, [])
})

test('surplus manual or locked staff meet the daily minimum without overstaffing warnings', () => {
  const value = state({ employees: ['a', 'b', 'c'].map(flexibleEmployee), assignments: ['a', 'b', 'c'].map(id => assignment('2026-10-01', 'morning', true, id)) })
  const issues = validateSchedule(value)
  assert.ok(!issues.some(issue => issue.type === 'overstaffed'))
  assert.ok(!issues.some(issue => issue.type === 'coverage' && issue.date === '2026-10-01'))
})

for (const seed of [1010, 42, 12345]) {
  test(`12-person three-shift roster meets daily coverage and 40-hour weekly minimums, seed ${seed}`, () => {
    const late = { ...morning, id: 'late', name: '晚班', shortName: '晚', start: '14:00', end: '22:00' }
    const value = state({
      employees: Array.from({ length: 12 }, (_, index) => employee(`member-${index}`, {
        minHoursPerWeek: 40,
        maxHoursPerWeek: 56,
        eligibleShiftIds: ['morning', 'late', 'night'],
      })),
      shifts: [{ ...morning, required: 1 }, late, { ...night, required: 1 }],
      rules: { minRestHours: 11, maxConsecutiveDays: 5 },
    })
    const before = JSON.stringify(value)
    const generated = generateSchedule(value, seed)
    assert.equal(generated.success, true)
    assert.deepEqual(generated.issues, [])
    assert.deepEqual(validateSchedule({ ...value, assignments: generated.assignments }), [])
    assert.equal(JSON.stringify(value), before)
    assert.ok(generated.assignments.length > 31 * 3, 'extra staffing must be allowed beyond daily minimums')
    for (const date of datesOfMonth(value.month)) for (const shift of value.shifts) {
      const people = new Set(generated.assignments.filter(item => item.date === date && item.shiftId === shift.id).map(item => item.employeeId))
      assert.ok(people.size >= shift.required, `${date} ${shift.id} needs at least ${shift.required} people`)
    }
    assert.equal(new Set(generated.assignments.map(item => `${item.employeeId}|${item.date}`)).size, generated.assignments.length)
  })
}

test('missing staffing mode keeps minimum semantics and explicit minimum permits surplus', () => {
  const original = state({ employees: ['a', 'b', 'c'].map(flexibleEmployee), assignments: ['a', 'b', 'c'].map(id => assignment('2026-10-01', 'morning', true, id)) })
  const minimum = structuredClone(original)
  minimum.shifts.forEach(shift => { shift.staffingMode = 'minimum' })
  assert.deepEqual(validateSchedule(minimum), validateSchedule(original))
  assert.deepEqual(generateSchedule(minimum, 42), generateSchedule(original, 42))
  assert.ok(!validateSchedule(minimum).some(issue => issue.type === 'overstaffed'))
})

test('fixed staffing validates exact headcount and reports shortages as coverage warnings', () => {
  const value = state({ employees: ['a', 'b', 'c'].map(id => employee(id, { maxHoursPerWeek: 168, eligibleShiftIds: ['morning'] })), shifts: [{ ...morning, staffingMode: 'fixed', required: 2 }], assignments: [assignment('2026-10-01', 'morning', false, 'a'), assignment('2026-10-01', 'morning', false, 'b')] })
  assert.ok(!validateSchedule(value).some(issue => issue.date === '2026-10-01'))
  const shortage = validateSchedule(value).find(issue => issue.type === 'coverage')
  assert.equal(shortage.severity, 'warning')
  assert.match(shortage.message, /每日固定 2/)
  value.assignments.push(assignment('2026-10-01', 'morning', false, 'c'))
  const excess = validateSchedule(value).find(issue => issue.type === 'overstaffed')
  assert.equal(excess.severity, 'error')
  assert.equal(excess.date, '2026-10-01')
  assert.match(excess.message, /超出固定人数 1 人/)
})

test('locked fixed overstaffing in the selected month is never silently replaced', () => {
  const original = ['a', 'b'].map(id => assignment('2026-10-01', 'morning', true, id))
  const value = state({ employees: ['a', 'b'].map(id => employee(id, { maxHoursPerWeek: 168, eligibleShiftIds: ['morning'] })), shifts: [{ ...morning, staffingMode: 'fixed' }], assignments: original })
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, false)
  assert.deepEqual(generated.assignments, original)
  assert.notEqual(generated.assignments, original)
  assert.ok(generated.issues.some(issue => issue.type === 'overstaffed' && issue.date === '2026-10-01' && issue.severity === 'error'))
})

test('current fixed staffing does not retroactively cap preserved out-of-month history', () => {
  const original = ['a', 'b'].map(id => assignment('2026-09-30', 'morning', true, id))
  const value = state({ employees: ['a', 'b'].map(id => employee(id, { maxHoursPerWeek: 168, eligibleShiftIds: ['morning'] })), shifts: [{ ...morning, staffingMode: 'fixed' }], assignments: original })
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, true)
  assert.deepEqual(generated.issues, [])
  assert.deepEqual(generated.assignments.filter(item => item.date === '2026-09-30'), original)
  for (const date of datesOfMonth(value.month)) assert.equal(generated.assignments.filter(item => item.date === date && item.shiftId === 'morning').length, 1)
  value.employees[0].maxHoursPerWeek = 8
  value.assignments.push(assignment('2026-10-01', 'morning', false, 'a'))
  assert.ok(validateSchedule(value).some(issue => issue.type === 'weekly-hours'), 'historical work still counts toward weekly caps')
  assert.ok(!validateSchedule(value).some(issue => issue.type === 'overstaffed'))
})

test('fixed zero prohibits assignments while minimum zero can supply employee hours', () => {
  const value = state({ employees: [employee('a', { minHoursPerWeek: 7 })], shifts: [{ ...morning, staffingMode: 'fixed', required: 0 }, { ...night, staffingMode: 'minimum', required: 0 }] })
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, true)
  assert.deepEqual(generated.issues, [])
  assert.ok(generated.assignments.length > 0)
  assert.ok(generated.assignments.every(item => item.shiftId === 'night'))
  value.assignments = [assignment('2026-10-01', 'morning')]
  assert.ok(validateSchedule(value).some(issue => issue.type === 'overstaffed'))
})

test('fixed capacity cannot be exceeded to satisfy otherwise impossible employee minimums', () => {
  const original = [assignment('2026-10-01', 'off', true, 'a')]
  const value = state({
    employees: ['a', 'b', 'c'].map(id => employee(id, { minHoursPerWeek: 40, maxHoursPerWeek: 56, eligibleShiftIds: ['morning'] })),
    shifts: [{ ...morning, staffingMode: 'fixed', required: 1 }],
    assignments: original,
  })
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, false)
  assert.deepEqual(generated.assignments, original)
  assert.ok(generated.issues.some(issue => issue.type === 'weekly-min-hours'))
  assert.ok(!generated.issues.some(issue => issue.type === 'overstaffed'), 'heuristic must not exceed fixed counts while trying to fill hours')
})

test('mixed fixed and minimum staffing adds needed work only to uncapped shifts', () => {
  const value = state({
    employees: ['a', 'b', 'c', 'd'].map(id => employee(id, { minHoursPerWeek: 32, maxHoursPerWeek: 56 })),
    shifts: [{ ...morning, staffingMode: 'fixed', required: 1 }, { ...night, staffingMode: 'minimum', required: 1 }],
  })
  const generated = generateSchedule(value, 1010)
  assert.equal(generated.success, true)
  assert.deepEqual(generated.issues, [])
  let grew = false
  for (const date of datesOfMonth(value.month)) {
    assert.equal(generated.assignments.filter(item => item.date === date && item.shiftId === 'morning').length, 1)
    const count = generated.assignments.filter(item => item.date === date && item.shiftId === 'night').length
    assert.ok(count >= 1)
    if (count > 1) grew = true
  }
  assert.ok(grew)
})

test('dynamic weekday weights respect fixed shift upper limits alongside expandable minimum shifts', () => {
  const value = weightState({ shifts: [{ ...morning, staffingMode: 'fixed', required: 1 }, { ...night, staffingMode: 'minimum', required: 0 }] })
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, true)
  assert.deepEqual(generated.issues, [])
  assert.ok(generated.assignments.some(item => item.shiftId === 'night'))
  for (const date of datesOfMonth(value.month)) assert.equal(generated.assignments.filter(item => item.date === date && item.shiftId === 'morning').length, 1)
})

test('all-fixed staffing refuses weighted quotas that would require surplus workers', () => {
  const value = weightState({ shifts: [{ ...morning, staffingMode: 'fixed', required: 1 }, { ...night, staffingMode: 'fixed', required: 0 }] })
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, false)
  assert.deepEqual(generated.assignments, value.assignments)
  assert.ok(generated.issues.some(issue => issue.type.startsWith('weekday-')))
  assert.ok(!generated.issues.some(issue => issue.type === 'overstaffed'))
})

test('staffing mode rejects unknown values without mutating the existing roster', () => {
  for (const mode of [null, '', 'exact', 'Minimum', false, 1, {}, []]) {
    const value = state({ shifts: [{ ...morning, staffingMode: mode }], employees: [employee('a', { eligibleShiftIds: ['morning'] })], assignments: [assignment('2026-10-01')] })
    assert.ok(validateSchedule(value).some(issue => issue.type === 'configuration' && /人数模式/.test(issue.message)))
    const generated = generateSchedule(value)
    assert.equal(generated.success, false)
    assert.deepEqual(generated.assignments, value.assignments)
  }
})

function carriedMinimumState(extra = {}) {
  return state({
    employees: [employee('a', { minHoursPerMonth: 0, minHoursPerWeek: 40, maxHoursPerWeek: 40, eligibleShiftIds: ['morning'] })],
    shifts: [{ ...morning, required: 0 }], rules: { minRestHours: 0, maxConsecutiveDays: 31 },
    assignments: [assignment('2026-09-28')], ...extra,
  })
}

test('known prior-month underwork raises the first-week minimum instead of accepting only the prorated share', () => {
  const value = carriedMinimumState({ assignments: ['2026-09-28', '2026-10-01', '2026-10-02', '2026-10-03'].map(date => assignment(date)) })
  const issue = minimumIssues(value).find(item => item.date === '2026-10-01')
  assert.ok(issue, '32 combined hours must not satisfy a 40-hour complete natural week')
  assert.match(issue.message, /实际工时 24 小时.*周最低工时 32 小时/)
  assert.match(issue.message, /合并上月.*月外已知工时 8 小时/)
  value.assignments.push(assignment('2026-10-04'))
  assert.ok(!minimumIssues(value).some(item => item.date === '2026-10-01'))
})

test('browser generation fills the complete first-week deficit while preserving all unlocked history', () => {
  const value = carriedMinimumState(), before = structuredClone(value)
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, true)
  const combined = generated.assignments.filter(item => item.employeeId === 'a' && item.shiftId !== 'off' && item.date >= '2026-09-28' && item.date <= '2026-10-04')
  assert.equal(combined.length * 8, 40, 'independent whole-week arithmetic must reach 40 without exceeding the cap')
  assert.deepEqual(generated.assignments.filter(item => !item.date.startsWith('2026-10-')), before.assignments)
  assert.deepEqual(value, before)
  assert.deepEqual(validateSchedule({ ...value, assignments: generated.assignments }), [])
})

test('a single earlier previous-month rest record makes the first week complete for every current member', () => {
  const value = carriedMinimumState({
    employees: ['a', 'b'].map(id => employee(id, { minHoursPerMonth: 0, minHoursPerWeek: 28, maxHoursPerWeek: 40, eligibleShiftIds: ['morning'] })),
    assignments: [assignment('2026-09-03', 'off')],
  })
  const firstIssues = minimumIssues(value).filter(item => item.date === '2026-10-01')
  assert.equal(firstIssues.length, 2)
  assert.ok(firstIssues.every(item => /周最低工时 28 小时/.test(item.message)))
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, true)
  for (const id of ['a', 'b']) {
    const firstHours = generated.assignments.filter(item => item.employeeId === id && item.shiftId !== 'off' && item.date >= '2026-10-01' && item.date <= '2026-10-04').length * 8
    assert.ok(firstHours >= 28 && firstHours <= 40, `${id}: zero previous hours still require the full minimum`)
  }
  assert.deepEqual(generated.assignments.filter(item => !item.date.startsWith('2026-10-')), value.assignments)
})

test('infeasible complete first-week minimum retains the original rather than accepting a prorated solution', () => {
  const value = carriedMinimumState({ assignments: [assignment('2026-09-30', 'off'), assignment('2026-10-02')] })
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, false, 'four remaining eight-hour days cannot meet a 40-hour week from zero history')
  assert.deepEqual(generated.assignments, value.assignments)
  assert.ok(generated.issues.some(item => item.type === 'weekly-min-hours' && item.date === '2026-10-01' && /周最低工时 40 小时/.test(item.message)))
})

test('a Sunday month start with 32 historical hours needs eight more hours instead of a six-hour partial success', () => {
  const history = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map(date => assignment(date))
  const value = carriedMinimumState({ month: '2026-11', shifts: [{ ...morning, required: 0 }, { ...morning, id: 'short', name: '短班', end: '14:00', required: 0 }],
    employees: [employee('a', { minHoursPerMonth: 0, minHoursPerWeek: 40, maxHoursPerWeek: 40, eligibleShiftIds: ['morning', 'short'] })],
    assignments: [...history, assignment('2026-11-01', 'short', true)],
  })
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, false)
  assert.deepEqual(generated.assignments, value.assignments)
  assert.ok(generated.issues.some(item => item.type === 'weekly-min-hours' && item.date === '2026-11-01' && /实际工时 6 小时.*周最低工时 8 小时/.test(item.message)))
  value.assignments.at(-1).shiftId = 'morning'
  const recovered = generateSchedule(value, 42)
  assert.equal(recovered.success, true)
  assert.equal(recovered.assignments.filter(item => item.date >= '2026-10-26' && item.date <= '2026-11-01' && item.shiftId !== 'off').length * 8, 40)
})

test('cross-year first-week generation carries the previous December and leaves its records untouched', () => {
  const value = carriedMinimumState({ month: '2027-01', assignments: ['2026-12-28', '2026-12-29'].map(date => assignment(date)) })
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, true)
  const firstWeek = generated.assignments.filter(item => item.date >= '2026-12-28' && item.date <= '2027-01-03' && item.shiftId !== 'off')
  assert.equal(firstWeek.length * 8, 40)
  assert.deepEqual(generated.assignments.filter(item => item.date.startsWith('2026-12-')), value.assignments)
})

test('carried night hours count once and the remaining complete-week minimum keeps minute precision', () => {
  const value = state({
    employees: [employee('a', { minHoursPerMonth: 0, minHoursPerWeek: 24.1, maxHoursPerWeek: 40 })],
    rules: { minRestHours: 0, maxConsecutiveDays: 31 },
    assignments: [assignment('2026-09-28'), assignment('2026-09-30', 'night'), assignment('2026-10-01')],
  })
  const issue = minimumIssues(value).find(item => item.date === '2026-10-01')
  assert.ok(issue, '10 outside hours plus 6 carried and 8 current hours are six minutes short')
  assert.match(issue.message, /实际工时 14 小时.*周最低工时 14\.1 小时/)
  assert.match(issue.message, /月外已知工时 10 小时/)
  value.shifts.push({ ...morning, id: 'extended', end: '16:06' })
  value.employees[0].eligibleShiftIds.push('extended')
  value.assignments.at(-1).shiftId = 'extended'
  assert.ok(!minimumIssues(value).some(item => item.date === '2026-10-01'))
})

function carriedWeightState(month = '2026-10', days = [6, 7], percent = 50) {
  return state({ month, employees: Array.from({ length: 8 }, (_, index) => employee(`e${index}`, { minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 168, eligibleShiftIds: ['morning'] })),
    shifts: [{ ...morning }], rules: { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: { days, percent } }, assignments: [] })
}
function assertCompleteWeightWeek(value, assignments, monday, percent, selectedDays) {
  const dates = Array.from({ length: 7 }, (_, index) => new Date(Date.parse(`${monday}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10))
  const count = date => assignments.filter(item => item.date === date && item.shiftId !== 'off').length
  const selected = dates.filter(date => selectedDays.includes(new Date(`${date}T00:00:00Z`).getUTCDay() || 7))
  const other = dates.filter(date => !selected.includes(date))
  const total = dates.reduce((sum, date) => sum + count(date), 0)
  assert.equal(selected.reduce((sum, date) => sum + count(date), 0), Math.ceil(total * percent / 100), 'ratio uses independently counted full-week actual work')
  for (const group of [selected, other]) {
    const counts = group.map(count)
    if (counts.length) assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `full-week group must balance: ${counts}`)
  }
  assert.deepEqual(assignments.filter(item => !item.date.startsWith(`${value.month}-`)), value.assignments.filter(item => !item.date.startsWith(`${value.month}-`)))
}

test('first-week weight validation counts history instead of accepting a fictitious partial-week witness', () => {
  const value = carriedWeightState()
  value.assignments = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map(date => assignment(date, 'morning', false, 'e0'))
  value.assignments.push(...['2026-10-03', '2026-10-04'].map(date => assignment(date, 'morning', false, 'e1')))
  const issue = validateSchedule(value).find(item => item.type === 'weekday-quota' && item.date === '2026-10-01')
  assert.ok(issue, 'nine actual starts require five selected starts, not four')
  assert.match(issue.message, /所选星期 4 人次、其余星期 5 人次.*已合并上月/)
})

test('browser weighted generation subtracts fixed history and balances each complete group across the boundary', () => {
  const value = carriedWeightState()
  value.assignments = ['2026-09-28', '2026-09-29', '2026-09-30'].flatMap(date => ['e0', 'e1'].map(id => assignment(date, 'morning', false, id)))
  const before = structuredClone(value)
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, true)
  assertCompleteWeightWeek(value, generated.assignments, '2026-09-28', 50, [6, 7])
  assert.deepEqual(value, before)
  assert.deepEqual(validateSchedule({ ...value, assignments: generated.assignments }), [])
})

test('a Sunday-only current fragment receives its actual remaining whole-week weight budget', () => {
  const value = carriedWeightState('2026-11', [7], 50)
  value.assignments = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'].map(date => assignment(date, 'morning', false, 'e0'))
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, true)
  const sunday = generated.assignments.filter(item => item.date === '2026-11-01' && item.shiftId !== 'off').length
  assert.ok(sunday === 6 || sunday === 7)
  assertCompleteWeightWeek(value, generated.assignments, '2026-10-26', 50, [7])
})

test('historical daily imbalance cannot be repaired by changing current dates or silently modifying history', () => {
  const value = carriedWeightState('2026-11', [7], 50)
  value.assignments = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'].map(date => assignment(date, 'morning', false, 'e0'))
  value.assignments.push(assignment('2026-10-26', 'morning', false, 'e1'))
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, false)
  assert.deepEqual(generated.assignments, value.assignments)
  assert.ok(generated.issues.some(item => item.type === 'weekday-balance' && item.date === '2026-11-01'))
})

test('known zero-work history constrains full-week balance without imposing today’s daily minimum on past days', () => {
  const value = carriedWeightState('2026-09', [1, 6], 16)
  value.assignments = [assignment('2026-08-05', 'off', false, 'e0')]
  const generated = generateSchedule(value, 42)
  assert.equal(generated.success, true)
  assertCompleteWeightWeek(value, generated.assignments, '2026-08-31', 16, [1, 6])
  assert.equal(generated.assignments.filter(item => item.date === '2026-08-31').length, 0)
  assert.ok(datesOfMonth('2026-09').every(date => generated.assignments.some(item => item.date === date && item.shiftId === 'morning')))
})
