import test from 'node:test'
import assert from 'node:assert/strict'
import { datesOfMonth, shiftHours, validateSchedule, generateSchedule } from '../scheduler.ts'
import { makeDefaultState } from '../defaults.ts'

const morning = { id: 'morning', name: '早班', shortName: '早', start: '08:00', end: '16:00', color: '#fff', required: 1 }
const night = { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#eee', required: 0 }
const employee = (id = 'a', extra = {}) => ({ id, name: id, role: '员工', group: '一组', color: '#fff', maxHoursPerWeek: 40, eligibleShiftIds: ['morning', 'night'], unavailableDates: [], ...extra })
const assignment = (date, shiftId = 'morning', locked = false, employeeId = 'a') => ({ employeeId, date, shiftId, locked })
const state = (extra = {}) => ({ version: 1, teamName: '测试', month: '2026-10', employees: [employee()], shifts: [{ ...morning }, { ...night }], rules: { minRestHours: 11, maxConsecutiveDays: 5, balanceWeekends: true }, assignments: [], ...extra })
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

test('default demo fills the whole month without violating rules', () => {
  const value = makeDefaultState('2026-10')
  assert.equal(value.employees.length, 12)
  assert.equal(value.assignments.length, 31 * 5)
  assert.deepEqual(validateSchedule(value), [])
  const generated = generateSchedule(value, 41)
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
  rules: { minRestHours: 11, maxConsecutiveDays: 31, balanceWeekends: true, separationGroups: [separation(['a', 'b'])] },
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
  const value = separationState({ rules: { minRestHours: 11, maxConsecutiveDays: 31, balanceWeekends: true, separationGroups: [separation(['a', 'b'], ['night'])] }, assignments: [assignment('2026-10-01', 'morning', false, 'a'), assignment('2026-10-01', 'morning', false, 'b')] })
  assert.ok(!types(value).includes('separation'))
  value.assignments.push(assignment('2026-10-02', 'night', true, 'a'), assignment('2026-10-02', 'night', true, 'b'))
  const issues = validateSchedule(value).filter(issue => issue.type === 'separation')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].date, '2026-10-02')
})

test('overlapping separation groups are all enforced', () => {
  const value = separationState({ employees: ['a', 'b', 'c', 'd'].map(flexibleEmployee), rules: { minRestHours: 11, maxConsecutiveDays: 31, balanceWeekends: true, separationGroups: [separation(['a', 'b']), separation(['b', 'c'], [], 'separation-2'), separation(['c', 'd'], [], 'separation-3')] } })
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
