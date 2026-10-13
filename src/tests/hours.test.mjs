import test from 'node:test'
import assert from 'node:assert/strict'
import { hoursToMinutes, minimumMonthHours, monthlyHoursReference, monthlyHoursByEmployee, resolveHoursState } from '../hours.ts'

const employee = minimum => ({ id: 'e', name: '测试', role: '', group: '', color: '#abc', minHoursPerMonth: minimum, maxHoursPerWeek: 40, eligibleShiftIds: [], unavailableDates: [] })
const state = (extra = {}) => ({ version: 1, month: '2026-10', teamName: '测试', employees: [employee(null)], shifts: [], rules: { minRestHours: 11, maxConsecutiveDays: 5, balanceWeekends: true }, assignments: [], ...extra })

test('October reference includes national holidays and the adjusted Saturday workday', () => {
  assert.deepEqual(monthlyHoursReference(state()), { hours: 144, suggestedHours: 144, workdays: 18, custom: false, verified: true })
  const overridden = monthlyHoursReference(state({ calendar: { '2026-10-01': 'workday', '2026-10-10': 'restday' } }))
  assert.equal(overridden.workdays, 18)
  assert.equal(monthlyHoursReference(state({ calendar: { '2026-10-01': 'workday' } })).hours, 152)
})

test('manual references are month-specific, zero is valid, and unsupported calendar years are estimates', () => {
  const data = state({ monthlyReferenceHours: { '2026-10': 0, '2026-11': 168 } })
  assert.equal(monthlyHoursReference(data).hours, 0)
  assert.equal(monthlyHoursReference(data).custom, true)
  data.month = '2026-11'
  assert.equal(monthlyHoursReference(data).hours, 168)
  data.month = '2028-02'
  assert.deepEqual(monthlyHoursReference(data), { hours: 168, suggestedHours: 168, workdays: 21, custom: false, verified: false })
  delete data.monthlyReferenceHours['2026-10']
  data.month = '2026-10'
  assert.equal(monthlyHoursReference(data).hours, 144)
})

test('calendar overrides can confirm every date of an otherwise unknown year', () => {
  const calendar = Object.fromEntries(Array.from({ length: 29 }, (_, i) => [`2028-02-${String(i + 1).padStart(2, '0')}`, 'restday']))
  calendar['2028-02-29'] = 'workday'
  assert.deepEqual(monthlyHoursReference(state({ month: '2028-02', calendar })), { hours: 8, suggestedHours: 8, workdays: 1, custom: false, verified: true })
})

test('solver resolution follows the current reference without mutating defaults or personal overrides', () => {
  const data = state({ employees: [employee(null), { ...employee(80), id: 'custom' }, { ...employee(0), id: 'disabled' }, { ...employee(undefined), id: 'legacy' }], monthlyReferenceHours: { '2026-10': 160 } })
  const before = JSON.stringify(data)
  const resolved = resolveHoursState(data)
  assert.deepEqual(resolved.employees.map(e => e.minHoursPerMonth), [160, 80, 0, 0])
  assert.ok(resolved.employees.every(e => e.minHoursPerWeek === 0))
  assert.equal(JSON.stringify(data), before)
  data.monthlyReferenceHours['2026-10'] = 176
  assert.equal(minimumMonthHours(data, data.employees[0]), 176)
  assert.equal(minimumMonthHours(data, data.employees[1]), 80)
  assert.equal(resolved.employees[0].minHoursPerMonth, 160)
})

test('decimal minute conversion matches strict lower/upper rounding including scientific notation', () => {
  for (const [hours, minimum, maximum] of [[2.05, 123, 123], [.1, 6, 6], [1.01, 61, 60], [1e-12, 1, 0], [0, 0, 0], [168, 10080, 10080], [744, 44640, 44640]]) {
    assert.equal(hoursToMinutes(hours, 'ceil'), minimum)
    assert.equal(hoursToMinutes(hours, 'floor'), maximum)
  }
  for (const invalid of [-1, NaN, Infinity, 745]) assert.ok(Number.isNaN(hoursToMinutes(invalid, 'ceil')))
})

test('visible monthly hours clip incoming/outgoing nights and never double-count overlaps', () => {
  const data = state({ shifts: [
    { id: 'night', start: '22:00', end: '06:00' }, { id: 'day', start: '08:00', end: '16:00' }, { id: 'overlap', start: '12:00', end: '18:00' },
  ], assignments: [
    { employeeId: 'e', date: '2026-09-30', shiftId: 'night' },
    { employeeId: 'e', date: '2026-10-31', shiftId: 'night' },
    { employeeId: 'e', date: '2026-10-02', shiftId: 'day' },
    { employeeId: 'e', date: '2026-10-02', shiftId: 'overlap' },
    { employeeId: 'e', date: '2026-10-02', shiftId: 'day' },
    { employeeId: 'e', date: '2026-11-01', shiftId: 'day' },
  ] })
  assert.equal(monthlyHoursByEmployee(data).get('e'), 18)
})
