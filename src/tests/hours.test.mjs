import test from 'node:test'
import assert from 'node:assert/strict'
import { hoursToMinutes, monthlyHoursByEmployee, resolveHoursState } from '../hours.ts'

const employee = minimum => ({ id: 'e', name: '测试', role: '', group: '', color: '#abc', minHoursPerMonth: minimum, maxHoursPerWeek: 40, eligibleShiftIds: [], unavailableDates: [] })
const state = (extra = {}) => ({ version: 1, month: '2026-10', teamName: '测试', employees: [employee(null)], shifts: [], rules: { minRestHours: 11, maxConsecutiveDays: 5, balanceWeekends: true }, assignments: [], ...extra })

test('solver resolution drops retired monthly data without deriving a weekly minimum', () => {
  const data = state({ employees: [employee(null), { ...employee(744), id: 'custom', minHoursPerWeek: 0 }, { ...employee(0), id: 'weekly', minHoursPerWeek: 24 }, { ...employee(undefined), id: 'legacy' }], monthlyReferenceHours: { '2026-10': 160 } })
  const before = structuredClone(data)
  const resolved = resolveHoursState(data)
  assert.ok(resolved.employees.every(employee => !Object.hasOwn(employee, 'minHoursPerMonth')))
  assert.equal(Object.hasOwn(resolved, 'monthlyReferenceHours'), false)
  assert.deepEqual(resolved.employees.map(employee => employee.minHoursPerWeek), [0, 0, 24, 0])
  assert.deepEqual(data, before)
  assert.notEqual(resolved.employees[0], data.employees[0])
})

test('retired monthly data cannot affect resolution even with obsolete invalid values', () => {
  for (const minimum of [null, 744, 9999, -1, NaN, Infinity, '160']) {
    const data = state({ employees: [employee(minimum)], monthlyReferenceHours: { '2026-10': Infinity } })
    const resolved = resolveHoursState(data)
    assert.equal(resolved.employees[0].minHoursPerWeek, 0)
    assert.equal(Object.hasOwn(resolved.employees[0], 'minHoursPerMonth'), false)
    assert.equal(Object.hasOwn(resolved, 'monthlyReferenceHours'), false)
  }
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
