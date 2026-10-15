import test from 'node:test'
import assert from 'node:assert/strict'
import { generateSchedule, validateSchedule } from '../scheduler.ts'
import { checkDesktopResult } from '../DesktopSolver.ts'

const shift = (id, start, end) => ({ id, name: id, shortName: id.slice(0, 1), start, end, color: '#abc', required: 0 })
const day = shift('day', '08:00', '16:00')
const seven = shift('seven', '08:00', '15:00')
const five = shift('five', '08:00', '13:00')
const night = shift('night', '22:00', '06:00')
const assignment = (date, shiftId = 'day', locked = false) => ({ employeeId: 'a', date, shiftId, locked })
const history = (dates, shiftId = 'day') => dates.map(date => assignment(date, shiftId))
const previousDates = [26, 27, 28, 29, 30].map(day => `2026-10-${day}`)
const fixture = (extra = {}) => ({ version: 1, teamName: '跨月周最低', month: '2026-11', employees: [{ id: 'a', name: '跨月成员', role: '', group: '', color: '#abc', minHoursPerMonth: 0, minHoursPerWeek: 40, maxHoursPerWeek: 40, eligibleShiftIds: ['day'], unavailableDates: [] }], shifts: [day], rules: { minRestHours: 0, maxConsecutiveDays: 7 }, assignments: [], ...extra })
const employee = (state, fields) => { Object.assign(state.employees[0], fields); return state }
const minimumAt = (state, date = '2026-11-01') => validateSchedule(state).find(issue => issue.type === 'weekly-min-hours' && issue.date === date)
const requestFor = state => ({ protocolVersion: 1, requestId: 'boundary-minimum', state, options: { allowPartial: true, timeLimitSeconds: 5, seed: 20 } })
const responseFor = (request, assignments) => ({ protocolVersion: 1, requestId: request.requestId, engine: 'ortools-cp-sat', status: 'FEASIBLE', assignments, issues: [], stats: { wallTimeSeconds: .1, shortageCount: 0, optimal: false }, message: '' })

test('November Sunday needs no extra work after forty known prior-month hours, including unlocked history', () => {
  const state = fixture({ assignments: history(previousDates) })
  assert.equal(minimumAt(state), undefined)
  const before = structuredClone(state)
  const generated = generateSchedule(state, 20)
  assert.equal(generated.success, true)
  assert.deepEqual(generated.issues, [])
  assert.ok(!generated.assignments.some(item => item.date === '2026-11-01'))
  assert.deepEqual(generated.assignments.filter(item => item.date.startsWith('2026-10')), before.assignments)
  assert.deepEqual(state, before)
  const request = requestFor(state)
  assert.equal(checkDesktopResult(request, responseFor(request, generated.assignments)).success, true)
})

test('thirty-five known hours leave five hours on a one-day boundary, rather than a rounded 5.72-hour demand', () => {
  const state = employee(fixture({ shifts: [seven, five], assignments: history(previousDates, 'seven') }), { eligibleShiftIds: ['seven', 'five'] })
  const unmet = minimumAt(state)
  assert.match(unmet.message, /周最低工时 5 小时/)
  assert.match(unmet.message, /月外已知工时 35 小时/)
  state.assignments.push(assignment('2026-11-01', 'five'))
  assert.equal(minimumAt(state), undefined)
  state.assignments.pop()
  const generated = generateSchedule(state, 20)
  assert.equal(generated.success, true)
  assert.equal(generated.assignments.find(item => item.date === '2026-11-01')?.shiftId, 'five')
  assert.deepEqual(generated.issues, [])
})

test('without known outside history the original prorated minimum remains, rounded up to minutes', () => {
  const almost = shift('almost', '08:00', '13:42')
  const exact = shift('exact', '08:00', '13:43')
  const state = employee(fixture({ shifts: [almost, exact], assignments: [assignment('2026-11-01', 'almost')] }), { eligibleShiftIds: ['almost', 'exact'] })
  assert.match(minimumAt(state).message, /周最低工时 5\.72 小时/)
  state.assignments[0].shiftId = 'exact'
  assert.equal(minimumAt(state), undefined)
  state.assignments.push(assignment('2026-10-19', 'exact'))
  state.assignments[0].shiftId = 'almost'
  assert.ok(minimumAt(state), 'Distant prior weeks provide no credit')
})

test('prior-month overnight carry-in is completed in-month work and is not also outside credit', () => {
  const state = employee(fixture({ shifts: [day, night], assignments: [assignment('2026-10-31', 'night')] }), { eligibleShiftIds: ['day', 'night'] })
  const november = minimumAt(state)
  assert.match(november.message, /实际工时 6 小时/)
  assert.match(november.message, /月外已知工时 2 小时/)
  assert.match(november.message, /周最低工时 38 小时/, 'Known October history requires a full forty-hour week, not a prorated Sunday')
  state.employees[0].minHoursPerWeek = 8
  assert.equal(minimumAt(state), undefined, 'The same night contributes two outside plus six inside hours exactly once')
  state.employees[0].minHoursPerWeek = 9
  assert.ok(minimumAt(state), 'Eight total hours cannot satisfy a nine-hour complete-week minimum')
  // Viewed from October, only Saturday's two hours are in the month; the
  // outgoing six hours may reduce the target only once this shift is locked.
  state.month = '2026-10'
  state.employees[0].minHoursPerWeek = 10
  const october = minimumAt(state, '2026-10-26')
  assert.match(october.message, /实际工时 2 小时/)
  assert.match(october.message, /周最低工时 8\.58 小时/)
  state.assignments[0].locked = true
  const locked = minimumAt(state, '2026-10-26')
  assert.match(locked.message, /周最低工时 4 小时/)
  assert.match(locked.message, /月外已知工时 6 小时/)
})

test('following-month retained work can satisfy the final natural week but does not affect prior weeks', () => {
  const state = fixture({ assignments: history([1, 2, 3, 4, 5].map(day => `2026-12-0${day}`)) })
  assert.equal(minimumAt(state, '2026-11-30'), undefined)
  assert.ok(minimumAt(state, '2026-11-23'))
  const generated = generateSchedule(state, 20)
  assert.equal(generated.success, true)
  assert.ok(!generated.assignments.some(item => item.date === '2026-11-30'))
  assert.deepEqual(generated.assignments.filter(item => item.date.startsWith('2026-12')), state.assignments)
})

test('an unlocked outgoing night cannot lower its own boundary target; locked outgoing hours are known context', () => {
  const state = employee(fixture({ shifts: [night], assignments: [assignment('2026-11-30', 'night')] }), { eligibleShiftIds: ['night'], minHoursPerWeek: 7, maxHoursPerWeek: 40 })
  assert.equal(minimumAt(state, '2026-11-30'), undefined, 'Two in-month hours meet the unchanged one-hour prorated target')
  state.employees[0].minHoursPerWeek = 14
  assert.equal(minimumAt(state, '2026-11-30'), undefined, 'Two in-month hours meet the unchanged two-hour prorated target')
  // A high outside tail would fake feasibility if it were dynamically counted.
  state.shifts[0] = shift('night', '23:00', '23:59')
  state.assignments[0].locked = false
  assert.match(minimumAt(state, '2026-11-30').message, /周最低工时 2 小时/)
  state.shifts[0] = shift('night', '23:00', '22:00')
  assert.match(minimumAt(state, '2026-11-30').message, /周最低工时 2 小时/)
  state.assignments[0].locked = true
  assert.equal(minimumAt(state, '2026-11-30'), undefined, 'The locked 22-hour December tail already covers the full minimum')
})

test('boundary credits preserve full-week maximums while retired monthly minimums are ignored', () => {
  const state = employee(fixture({ assignments: history(previousDates) }), { minHoursPerMonth: 8 })
  assert.equal(minimumAt(state), undefined)
  assert.ok(!validateSchedule(state).some(issue => issue.type === 'monthly-min-hours'))
  state.assignments.push(assignment('2026-11-01'))
  assert.ok(validateSchedule(state).some(issue => issue.type === 'weekly-hours'))
})

test('actual remaining boundary minimum is still hard and failure preserves the existing roster', () => {
  const state = employee(fixture({ shifts: [seven, five], assignments: history(previousDates, 'seven') }), { eligibleShiftIds: ['seven', 'five'], unavailableDates: ['2026-11-01'] })
  const before = structuredClone(state)
  const generated = generateSchedule(state, 20)
  assert.equal(generated.success, false)
  assert.deepEqual(generated.assignments, before.assignments)
  assert.ok(generated.issues.some(issue => issue.type === 'weekly-min-hours' && issue.date === '2026-11-01'))
  assert.deepEqual(state, before)
})

test('independent native-result validation accepts reduced targets and rejects forged lower completion', () => {
  const state = employee(fixture({ shifts: [seven, five], assignments: history(previousDates, 'seven') }), { eligibleShiftIds: ['seven', 'five'] })
  const generated = generateSchedule(state, 20)
  assert.equal(generated.success, true)
  const request = requestFor(state)
  assert.equal(checkDesktopResult(request, responseFor(request, generated.assignments)).success, true)
  const forged = generated.assignments.filter(item => item.date !== '2026-11-01')
  const checked = checkDesktopResult(request, responseFor(request, forged))
  assert.equal(checked.success, false)
  assert.equal(checked.assignments, undefined)
  assert.ok(checked.issues.some(issue => issue.type === 'weekly-min-hours' && /周最低工时 5 小时/.test(issue.message)))
})

test('static boundary targets stay consistent in weighted candidate budgets and validation', () => {
  const state = fixture({ assignments: history(previousDates), rules: { minRestHours: 0, maxConsecutiveDays: 7, weekdayWeights: { days: [1, 2, 3, 4, 5], percent: 100 } } })
  const generated = generateSchedule(state, 20)
  assert.equal(generated.success, true)
  assert.deepEqual(generated.issues, [])
  assert.ok(!generated.assignments.some(item => item.date === '2026-11-01'))
  assert.deepEqual(validateSchedule({ ...state, assignments: generated.assignments }), [])
})

test('native results cannot invent a locked outgoing night to lower the original weekly target', () => {
  const outgoing = shift('outgoing', '23:00', '22:00')
  const state = employee(fixture(), { minHoursPerWeek: 14 })
  const generated = generateSchedule(state, 20)
  assert.equal(generated.success, true)
  state.shifts.push(outgoing)
  state.employees[0].eligibleShiftIds.push('outgoing')
  const request = requestFor(state)
  const forged = generated.assignments.filter(item => item.date !== '2026-11-30')
  forged.push(assignment('2026-11-30', 'outgoing', true))
  // As an explicitly user-locked manual schedule this has known outside
  // context. A generated response has no authority to create that context.
  assert.equal(minimumAt({ ...state, assignments: forged }, '2026-11-30'), undefined)
  const rejected = checkDesktopResult(request, responseFor(request, forged))
  assert.equal(rejected.success, false)
  assert.equal(rejected.assignments, undefined)
  assert.match(rejected.message, /新增.*锁定安排/)
  forged[forged.length - 1].locked = false
  const unlocked = checkDesktopResult(request, responseFor(request, forged))
  assert.equal(unlocked.success, false)
  assert.ok(unlocked.issues.some(issue => issue.type === 'weekly-min-hours' && issue.date === '2026-11-30'))
})

test('native validation retains original locked days off and legitimate locked outgoing nights', () => {
  const outgoing = shift('outgoing', '23:00', '22:00')
  const state = employee(fixture({ shifts: [day, outgoing], assignments: [assignment('2026-11-03', 'off', true), assignment('2026-11-30', 'outgoing', true)] }), { eligibleShiftIds: ['day', 'outgoing'], minHoursPerWeek: 14 })
  const assignments = [...state.assignments, ...history([1, 2, 4, 9, 10, 16, 17, 23, 24].map(day => `2026-11-${String(day).padStart(2, '0')}`))]
  assert.deepEqual(validateSchedule({ ...state, assignments }), [])
  const request = requestFor(state)
  assert.equal(checkDesktopResult(request, responseFor(request, assignments)).success, true)
  for (const expected of state.assignments) assert.ok(assignments.some(item => JSON.stringify(item) === JSON.stringify(expected)))
})

test('a one-hour overnight carry plus 36 outside hours still requires three more hours on Sunday', () => {
  const carry = shift('carry', '23:00', '01:00'), three = shift('three', '08:00', '11:00')
  const state = employee(fixture({ shifts: [day, seven, carry, three], assignments: [...history(previousDates, 'seven'), assignment('2026-10-31', 'carry')] }), { eligibleShiftIds: ['day', 'seven', 'carry', 'three'] })
  const issue = minimumAt(state)
  assert.match(issue.message, /实际工时 1 小时/)
  assert.match(issue.message, /周最低工时 4 小时/)
  assert.match(issue.message, /月外已知工时 36 小时/)
  const generated = generateSchedule(state, 20)
  assert.equal(generated.success, true)
  assert.equal(generated.assignments.find(item => item.date === '2026-11-01')?.shiftId, 'three')
  assert.deepEqual(generated.issues, [])
})
