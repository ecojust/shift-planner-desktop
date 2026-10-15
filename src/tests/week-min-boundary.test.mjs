import test from 'node:test'
import assert from 'node:assert/strict'
import { generateSchedule, validateSchedule, validateBoundaryPreview } from '../scheduler.ts'
import { getWeekBoundaryContext, getPreviousWeekContext, isBoundaryCellKnown } from '../weekBoundary.ts'

const shift = (id, start, end) => ({ id, name: id, shortName: id.slice(0, 1), start, end, color: '#abc', required: 0 })
const day = shift('day', '08:00', '16:00')
const seven = shift('seven', '08:00', '15:00')
const five = shift('five', '08:00', '13:00')
const night = shift('night', '22:00', '06:00')
const assignment = (date, shiftId = 'day', employeeId = 'a', locked = false) => ({ employeeId, date, shiftId, locked })
const history = (dates, shiftId = 'day') => dates.map(date => assignment(date, shiftId))
const previousDates = [26, 27, 28, 29, 30].map(day => `2026-10-${day}`)
const nextDates = [1, 2, 3, 4, 5].map(day => `2026-12-0${day}`)
const fixture = (extra = {}) => ({ version: 1, teamName: '双向完整自然周', month: '2026-11', employees: [{ id: 'a', name: '跨月成员', role: '', group: '', color: '#abc', minHoursPerWeek: 40, maxHoursPerWeek: 40, eligibleShiftIds: ['day'], unavailableDates: [] }], shifts: [day], rules: { minRestHours: 0, maxConsecutiveDays: 7 }, assignments: [], ...extra })
const employee = (state, fields) => { Object.assign(state.employees[0], fields); return state }
const coverage = (...months) => Object.fromEntries(months.map(month => [month, { employeeIds: ['a'] }]))
const minimumAt = (state, date = '2026-11-01', referenceDate = '2026-12-15') => validateSchedule(state, { referenceDate }).find(issue => issue.type === 'weekly-min-hours' && issue.date === date)
const generate = (state, referenceDate = '2026-12-15') => generateSchedule(state, 20, undefined, { referenceDate })
const blocking = issues => issues.filter(issue => issue.severity === 'error' || issue.type === 'boundary-coverage')

test('a sparse record identifies only its member and day; explicit complete-month metadata identifies blanks as rest', () => {
  const state = fixture({ assignments: [assignment('2026-10-26')] })
  state.employees.push({ ...state.employees[0], id: 'b' })
  assert.equal(isBoundaryCellKnown(state, 'a', '2026-10-26'), true)
  assert.equal(isBoundaryCellKnown(state, 'a', '2026-10-27'), false)
  assert.equal(isBoundaryCellKnown(state, 'b', '2026-10-26'), false)
  assert.equal(getPreviousWeekContext(state), null)
  state.scheduleCoverage = coverage('2026-10')
  assert.equal(isBoundaryCellKnown(state, 'a', '2026-10-27'), true)
  assert.equal(isBoundaryCellKnown(state, 'b', '2026-10-27'), false)
  state.scheduleCoverage['2026-10'].employeeIds.push('b')
  assert.equal(getPreviousWeekContext(state).historyDates.length, 6)
})

test('the boundary context is symmetric and distinguishes historical and future unknown cells using the frozen civil date', () => {
  const context = getWeekBoundaryContext(fixture(), { referenceDate: '2026-11-01' })
  assert.equal(context.startDate, '2026-10-26')
  assert.equal(context.endDate, '2026-12-06')
  assert.equal(context.weeks[0].employees[0].unknownPastDates.length, 6)
  assert.equal(context.weeks.at(-1).employees[0].unknownFutureDates.length, 6)
  assert.equal(context.incompleteHistory.length, 1)
  assert.equal(getWeekBoundaryContext(fixture(), { referenceDate: '2026-02-30' }), null)
})

test('complete previous-month history requires the whole-week remainder; a sparse history does not invent missing rest days', () => {
  const state = employee(fixture({ shifts: [seven, five], assignments: history(previousDates, 'seven') }), { eligibleShiftIds: ['seven', 'five'] })
  assert.equal(minimumAt(state), undefined, '35 known hours already meet the six-known-day prorated target')
  state.scheduleCoverage = coverage('2026-10')
  const unmet = minimumAt(state)
  assert.match(unmet.message, /实际工时 35 小时/)
  assert.match(unmet.message, /周最低工时 40 小时/)
  state.assignments.push(assignment('2026-11-01', 'five'))
  assert.equal(minimumAt(state), undefined)
})

test('complete next-month history symmetrically requires a remaining five hours on the last Monday', () => {
  const state = employee(fixture({ shifts: [seven, five], assignments: history(nextDates, 'seven'), scheduleCoverage: coverage('2026-12') }), { eligibleShiftIds: ['seven', 'five'] })
  assert.match(minimumAt(state, '2026-11-30').message, /实际工时 35 小时/)
  state.assignments.push(assignment('2026-11-30', 'five'))
  assert.equal(minimumAt(state, '2026-11-30'), undefined)
})

test('known complete adjacent months are fixed while browser generation meets both remaining weekly minimums', () => {
  const state = employee(fixture({ shifts: [seven, five], assignments: [...history(previousDates, 'seven'), ...history(nextDates, 'seven')], scheduleCoverage: coverage('2026-10', '2026-12') }), { eligibleShiftIds: ['seven', 'five'] })
  const before = structuredClone(state)
  const generated = generate(state)
  assert.equal(generated.success, true)
  assert.equal(generated.assignments.find(item => item.date === '2026-11-01')?.shiftId, 'five')
  assert.equal(generated.assignments.find(item => item.date === '2026-11-30')?.shiftId, 'five')
  assert.deepEqual(generated.boundaryPreview, [])
  assert.deepEqual(generated.assignments.filter(item => !item.date.startsWith('2026-11')), before.assignments)
  assert.deepEqual(generated.issues, [])
  assert.deepEqual(state, before)
})

test('future unknown boundary cells are provisionally planned as full weeks, but only the selected month is saved', () => {
  const state = fixture()
  const before = structuredClone(state)
  const generated = generate(state, '2026-10-15')
  assert.equal(generated.success, true)
  assert.ok(generated.boundaryPreview.some(item => item.date.startsWith('2026-10')))
  assert.ok(generated.boundaryPreview.some(item => item.date.startsWith('2026-12')))
  assert.ok(generated.assignments.every(item => item.date.startsWith('2026-11')))
  assert.equal(generated.boundaryContext.referenceDate, '2026-10-15')
  assert.deepEqual(validateBoundaryPreview({ ...state, assignments: generated.assignments }, generated.boundaryPreview, '2026-10-15'), [])
  assert.equal(generated.issues.filter(issue => issue.type === 'boundary-future-unconfirmed').length, 2)
  assert.deepEqual(state, before)
})

test('a saved month projection stays pending when the complete future week legitimately carries the remaining minimum', () => {
  const state = fixture()
  const generated = generate(state, '2026-11-01')
  const formal = { ...state, assignments: generated.assignments.filter(item => item.date !== '2026-11-30') }
  const preview = history(nextDates)
  assert.deepEqual(validateBoundaryPreview(formal, preview, '2026-11-01'), [])
  const savedIssues = validateSchedule(formal, { referenceDate: '2026-11-01' })
  assert.ok(!savedIssues.some(issue => issue.type === 'weekly-min-hours' && issue.date === '2026-11-30'))
  assert.ok(savedIssues.some(issue => issue.type === 'boundary-future-unconfirmed' && issue.date === '2026-11-30'))
  assert.ok(validateBoundaryPreview(formal, preview.slice(0, 4), '2026-11-01').some(issue => issue.type === 'weekly-min-hours'))
})

test('past unknown cells are never invented and incomplete history remains a visible warning', () => {
  const state = fixture()
  const generated = generate(state)
  assert.equal(generated.success, true)
  assert.deepEqual(generated.boundaryPreview, [])
  assert.ok(generated.assignments.every(item => item.date.startsWith('2026-11')))
  assert.equal(generated.issues.filter(issue => issue.type === 'boundary-history-incomplete').length, 2)
  assert.equal(generated.assignments.filter(item => item.date === '2026-11-01').length, 1)
  assert.equal(generated.assignments.filter(item => item.date === '2026-11-30').length, 1)
})

test('future availability is necessary evidence; unavailable adjacent dates cannot masquerade as a feasible complete week', () => {
  const state = employee(fixture(), { unavailableDates: [1, 2, 3, 4, 5, 6].map(day => `2026-12-0${day}`) })
  const generated = generate(state, '2026-11-01')
  assert.equal(generated.success, false)
  assert.deepEqual(generated.assignments, state.assignments)
  assert.ok(generated.issues.some(issue => issue.type === 'weekly-min-hours' && issue.date === '2026-11-30'))
})

test('future daily staffing shortages invalidate provisional feasibility even when personal weekly minimums are zero', () => {
  const state = employee(fixture({ shifts: [{ ...day, required: 1 }] }), { minHoursPerWeek: 0, maxHoursPerWeek: 168, unavailableDates: ['2026-12-01'] })
  const generated = generate(state, '2026-11-01')
  assert.equal(generated.success, false)
  assert.ok(generated.issues.some(issue => issue.type === 'boundary-coverage' && issue.date === '2026-12-01'))
})

test('confirmed future blanks and excess fixed staff are checked without rewriting the adjacent month', () => {
  const knownRest = employee(fixture({ shifts: [{ ...day, required: 1 }], scheduleCoverage: coverage('2026-12') }), { minHoursPerWeek: 0, maxHoursPerWeek: 168 })
  const missing = generate(knownRest, '2026-11-01')
  assert.equal(missing.success, false)
  assert.ok(missing.issues.some(issue => issue.type === 'boundary-coverage'))
  assert.deepEqual(missing.assignments, knownRest.assignments)
  const over = employee(fixture({ shifts: [{ ...day, staffingMode: 'fixed', required: 0 }], assignments: [assignment('2026-12-01')] }), { minHoursPerWeek: 0 })
  const counts = []
  const excess = generateSchedule(over, 20, count => counts.push(count), { referenceDate: '2026-11-01' })
  assert.equal(excess.success, false)
  assert.ok(excess.issues.some(issue => issue.type === 'overstaffed'))
  assert.deepEqual(counts, [], 'A rejected fixed future roster is not counted as a feasible solution')
  assert.deepEqual(validateBoundaryPreview(over, undefined, '2026-12-15'), [], 'Past staffing is retained historical context')
})

test('preview verification rejects missing, duplicate, locked, historical, known, and underworked evidence', () => {
  const state = fixture()
  const generated = generate(state, '2026-11-01')
  const candidate = { ...state, assignments: generated.assignments }
  assert.equal(generated.success, true)
  assert.ok(blocking(validateBoundaryPreview(candidate, undefined, '2026-11-01')).length)
  assert.ok(blocking(validateBoundaryPreview(candidate, [], '2026-11-01')).length)
  const first = generated.boundaryPreview[0]
  assert.ok(blocking(validateBoundaryPreview(candidate, [...generated.boundaryPreview, first], '2026-11-01')).length)
  assert.ok(blocking(validateBoundaryPreview(candidate, [{ ...first, locked: true }], '2026-11-01')).length)
  assert.ok(blocking(validateBoundaryPreview(candidate, [assignment('2026-10-26')], '2026-11-01')).length)
  assert.ok(blocking(validateBoundaryPreview({ ...candidate, scheduleCoverage: coverage('2026-12') }, generated.boundaryPreview, '2026-11-01')).length)
  assert.deepEqual(validateBoundaryPreview(candidate, generated.boundaryPreview, '2026-11-01'), [])
})

test('an explicit empty preview is valid evidence for zero demand, while unknown history still stays unknown', () => {
  const state = employee(fixture(), { minHoursPerWeek: 0 })
  assert.deepEqual(validateBoundaryPreview(state, [], '2026-11-01'), [])
  assert.deepEqual(validateBoundaryPreview(state, undefined, '2026-12-15'), [])
})

test('known adjacent work keeps full weekly upper bounds on both sides of the selected month', () => {
  const state = fixture({ assignments: [...history(previousDates), assignment('2026-11-01'), assignment('2026-11-30'), ...history(nextDates)] })
  const caps = validateSchedule(state, { referenceDate: '2026-11-01' }).filter(issue => issue.type === 'weekly-hours')
  assert.equal(caps.length, 2)
  assert.ok(caps.some(issue => issue.date === '2026-10-26'))
  assert.ok(caps.some(issue => issue.date === '2026-11-30'))
})

test('overnight work is counted exactly once across month and week boundaries, regardless of lock state', () => {
  const state = employee(fixture({ shifts: [night], assignments: [assignment('2026-10-31', 'night')], scheduleCoverage: coverage('2026-10') }), { eligibleShiftIds: ['night'], minHoursPerWeek: 8 })
  assert.equal(minimumAt(state), undefined)
  state.employees[0].minHoursPerWeek = 9
  assert.match(minimumAt(state).message, /实际工时 8 小时/)
  state.assignments[0].locked = true
  assert.match(minimumAt(state).message, /实际工时 8 小时/)
  state.month = '2026-10'
  state.employees[0].minHoursPerWeek = 8
  assert.equal(minimumAt(state, '2026-10-26'), undefined)
})

test('a provisional Sunday night must respect the next Monday rest interval and next-week actual hours', () => {
  const state = employee(fixture({ shifts: [day, night], assignments: [assignment('2026-12-07')], rules: { minRestHours: 8, maxConsecutiveDays: 7 } }), { eligibleShiftIds: ['day', 'night'], minHoursPerWeek: 0, maxHoursPerWeek: 8 })
  const issues = validateBoundaryPreview(state, [assignment('2026-12-06', 'night')], '2026-11-01')
  assert.ok(issues.some(issue => issue.type === 'rest'))
  assert.ok(issues.some(issue => issue.type === 'weekly-hours' && issue.date === '2026-12-07'))
})

test('unrelated distant invalid records do not make the selected-month model infeasible or get rewritten', () => {
  const distant = [assignment('2025-01-01'), assignment('2025-01-01')]
  const state = employee(fixture({ assignments: distant }), { minHoursPerWeek: 0 })
  const generated = generate(state)
  assert.equal(generated.success, true)
  assert.equal(blocking(generated.issues).length, 0)
  assert.deepEqual(generated.assignments, distant)
})

test('calendar boundaries include year changes and leap days without depending on host timezone', () => {
  const january = getWeekBoundaryContext(fixture({ month: '2027-01' }), { referenceDate: '2027-01-01' })
  assert.equal(january.startDate, '2026-12-28')
  assert.equal(january.endDate, '2027-01-31')
  const february = getWeekBoundaryContext(fixture({ month: '2028-02' }), { referenceDate: '2028-02-01' })
  assert.equal(february.startDate, '2028-01-31')
  assert.equal(february.endDate, '2028-03-05')
  assert.ok(february.weeks.some(week => week.monthDates.includes('2028-02-29')))
})
