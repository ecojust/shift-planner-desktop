import test from 'node:test'
import assert from 'node:assert/strict'
import { calculatePayroll, createPayrollConfig, payrollRows } from '../payroll.ts'

function fixture(month = '2026-10') {
  return { version: 1, teamName: '测试', month,
    employees: [{ id: 'a', name: '员工', role: '店员', group: '一组', color: '#fff', maxHoursPerWeek: 40, eligibleShiftIds: ['day','night','long'], unavailableDates: [] }],
    shifts: [{ id: 'day', name: '日班', start: '08:00', end: '16:00' }, { id: 'night', name: '夜班', start: '22:00', end: '06:00' }, { id: 'long', name: '长班', start: '08:00', end: '18:00' }],
    rules: { minRestHours: 11, maxConsecutiveDays: 5, balanceWeekends: true }, assignments: [] }
}
function add(state, date, shiftId = 'day', employeeId = 'a') { state.assignments.push({ employeeId, date, shiftId, locked: false }) }
function normal(state, shiftId = 'night', amount = 50) { state.shifts.find(shift => shift.id === shiftId).normalAllowance = amount }

// Fixed money per assigned shift is independent of salary, calendar and duration.
test('a configured shift pays its fixed amount once without any wage or multiplier calculation', () => {
  const state = fixture(); normal(state, 'day', 50); add(state, '2026-10-01')
  const result = calculatePayroll(state)
  assert.equal(result.rows[0].normalAllowance, 50)
  assert.equal(result.rows[0].customAllowance, 0)
  assert.equal(result.rows[0].statutoryAllowance, 0)
  assert.equal(result.rows[0].restdayAllowance, 0)
  assert.equal(result.rows[0].ordinaryAllowance, 0)
  assert.equal(result.totalAllowance, 50)
  assert.equal(result.dailyRows[0].totalAllowance, 50)
  assert.equal(result.rows[0].totalHours, 8)
})

test('short and long versions of a shift earn the same fixed allowance', () => {
  const state = fixture(); normal(state, 'day'); normal(state, 'long'); add(state, '2026-10-09'); add(state, '2026-10-10', 'long')
  state.shifts.find(shift => shift.id === 'day').end = '08:01'
  const result = calculatePayroll(state)
  assert.deepEqual(result.dailyRows.map(day => day.totalAllowance), [50, 50])
  assert.equal(result.totalAllowance, 100)
  assert.equal(result.rows[0].totalHours, 10.02)
})

test('the same shift assigned to multiple employees pays each employee the fixed amount', () => {
  const state = fixture(); normal(state, 'day', 40.15)
  state.employees.push({ ...state.employees[0], id: 'b', name: '另一员工' })
  add(state, '2026-10-01'); add(state, '2026-10-01', 'day', 'b')
  const result = calculatePayroll(state)
  assert.deepEqual(result.rows.map(row => row.totalAllowance), [40.15, 40.15])
  assert.equal(result.totalAllowance, 80.3)
})

test('historic salary, date multipliers including zero, compensation and calendar classification have no effect', () => {
  const state = fixture(); normal(state, 'day'); normal(state, 'long'); add(state, '2026-10-01'); add(state, '2026-10-04'); add(state, '2026-10-10', 'long')
  const cfg = createPayrollConfig(), before = calculatePayroll(state, cfg)
  cfg.payroll.monthlySalary = 1000000; cfg.payroll.employeeSalaries.a = 17400
  cfg.payroll.monthlyWorkdays = 0; cfg.payroll.hoursPerDay = 0
  cfg.payroll.statutoryMultiplier = 10; cfg.payroll.restdayMultiplier = 9; cfg.payroll.ordinaryMultiplier = 8
  cfg.payroll.restdayCompensated = true
  cfg.payroll.dateShiftMultipliers = { '2026-10-01': { day: 3 }, '2026-10-04': { day: 0 }, '2026-10-10': { long: 0.1 } }
  cfg.calendar = { '2026-10-01': 'workday', '2026-10-04': 'statutory' }
  const after = calculatePayroll(state, cfg)
  assert.deepEqual(after.rows, before.rows)
  assert.deepEqual(after.dailyRows, before.dailyRows)
  assert.equal(after.totalAllowance, 150)
})

test('canceled date-fixed-allowance draft data is also ignored', () => {
  const state = fixture(); normal(state, 'day'); add(state, '2026-10-01')
  const cfg = createPayrollConfig()
  cfg.payroll.dateShiftAllowances = { '2026-10-01': { day: 300 } }
  assert.equal(calculatePayroll(state, cfg).totalAllowance, 50)
})

test('overnight shifts pay only on their start date and show zero on the carried work day', () => {
  const state = fixture(); normal(state); add(state, '2026-10-03', 'night')
  const result = calculatePayroll(state)
  assert.equal(result.totalAllowance, 50)
  assert.deepEqual(result.dailyRows.map(row => [row.date, row.totalHours, row.totalAllowance]), [
    ['2026-10-03', 2, 50], ['2026-10-04', 6, 0],
  ])
  assert.deepEqual(result.dailyRows[1].carriedShiftIds, ['night'])
  assert.deepEqual(result.dailyRows[1].sources, [{ shiftId: 'night', assignmentDate: '2026-10-03', hours: 6 }])
})

test('a month includes the whole allowance for each shift starting in it, without prorating or repeating night work', () => {
  const state = fixture(); normal(state); add(state, '2026-09-30', 'night'); add(state, '2026-10-31', 'night')
  const october = calculatePayroll(state)
  assert.equal(october.rows[0].totalHours, 8)
  assert.equal(october.totalAllowance, 50)
  assert.deepEqual(october.dailyRows.map(row => [row.date, row.totalHours, row.totalAllowance]), [
    ['2026-10-01', 6, 0], ['2026-10-31', 2, 50],
  ])
  state.month = '2026-11'
  const november = calculatePayroll(state)
  assert.equal(november.rows[0].totalHours, 6)
  assert.equal(november.totalAllowance, 0)
  state.month = '2026-09'
  const september = calculatePayroll(state)
  assert.equal(september.rows[0].totalHours, 2)
  assert.equal(september.totalAllowance, 50)
})

test('carried work in an unknown-calendar year creates no allowance or holiday warning', () => {
  const state = fixture('2027-01'); normal(state); add(state, '2026-12-31', 'night')
  const result = calculatePayroll(state)
  assert.equal(result.rows[0].totalHours, 6)
  assert.equal(result.totalAllowance, 0)
  assert.doesNotMatch(result.warnings.join(' '), /未覆盖|历史年份|待核对|法定/)
})

test('duplicate employee-date-shift records never multiply hours or fixed allowances', () => {
  const state = fixture(); normal(state, 'day', 40.15); add(state, '2026-10-01'); add(state, '2026-10-01')
  const result = calculatePayroll(state)
  assert.equal(result.rows[0].totalHours, 8)
  assert.equal(result.totalAllowance, 40.15)
  assert.match(result.warnings.join(' '), /重复班次/)
})

test('different assigned shifts receive separate fixed amounts even if their hours overlap entirely', () => {
  const state = fixture(); normal(state, 'day', 50); normal(state, 'long', 30)
  state.shifts.find(shift => shift.id === 'long').end = '16:00'
  add(state, '2026-10-01', 'long'); add(state, '2026-10-01')
  const result = calculatePayroll(state)
  assert.equal(result.rows[0].totalHours, 8)
  assert.equal(result.totalAllowance, 80)
  assert.match(result.warnings.join(' '), /重叠班次/)
  assert.match(result.warnings.join(' '), /固定津贴分别计算/)
  state.assignments.reverse()
  const reversed = calculatePayroll(state)
  assert.deepEqual(reversed.dailyRows, result.dailyRows)
  assert.deepEqual(reversed.rows, result.rows)
})

test('the next assigned shift earns its allowance even if all its hours overlap a preceding overnight shift', () => {
  const state = fixture(); normal(state); normal(state, 'day', 20)
  Object.assign(state.shifts.find(shift => shift.id === 'day'), { start: '04:00', end: '05:00' })
  add(state, '2026-10-03', 'night'); add(state, '2026-10-04', 'day')
  const result = calculatePayroll(state)
  assert.equal(result.rows[0].totalHours, 8)
  assert.equal(result.rows[0].normalAllowance, 70)
  assert.equal(result.dailyRows[1].totalAllowance, 20)
})

test('an invalid time is warned and excluded from hours without changing the assigned fixed amount', () => {
  const state = fixture(); normal(state, 'day', 50); add(state, '2026-10-01')
  state.shifts.find(shift => shift.id === 'day').start = 'invalid'
  const result = calculatePayroll(state)
  assert.equal(result.rows[0].totalHours, 0)
  assert.equal(result.totalAllowance, 50)
  assert.match(result.warnings.join(' '), /未计入工时；固定津贴仍按该排班记录计算/)
})

test('missing or zero normal allowance produces no implicit wage payment', () => {
  const state = fixture(); add(state, '2026-10-01'); add(state, '2026-10-09', 'long'); normal(state, 'long', 0)
  const result = calculatePayroll(state)
  assert.equal(result.rows[0].normalAllowance, 0)
  assert.equal(result.totalAllowance, 0)
  assert.equal(result.rows[0].totalHours, 18)
  assert.ok(result.dailyRows.every(row => row.totalAllowance === 0))
})

test('fixed cents add exactly by day, employee and team, including binary-sensitive decimal values', () => {
  const state = fixture(); normal(state, 'day', 40.15)
  state.employees.push({ ...state.employees[0], id: 'b', name: '另一员工' })
  for (let day = 1; day <= 31; day++) {
    const date = `2026-10-${String(day).padStart(2, '0')}`
    add(state, date); add(state, date, 'day', 'b')
  }
  const result = calculatePayroll(state)
  assert.equal(result.dailyRows.length, 62)
  assert.ok(result.dailyRows.every(day => day.totalAllowance === 40.15))
  assert.ok(result.rows.every(row => row.totalAllowance === 1244.65))
  assert.equal(result.totalAllowance, 2489.3)
  assert.equal(payrollRows(result).find(row => row[0] === '合计')[2], 2489.3)
  normal(state, 'day', 0.1)
  assert.equal(calculatePayroll(state).totalAllowance, 6.2)
})

test('export uses fixed numeric allowance columns and includes start dates in daily sources', () => {
  const state = fixture(); normal(state); add(state, '2026-10-03', 'night')
  const exported = payrollRows(calculatePayroll(state))
  assert.deepEqual(exported[0], ['员工', '本月工时', '额外津贴（固定元/人/班）'])
  assert.equal(exported[1][2], 50)
  const carried = exported.find(row => row[1] === '2026-10-04')
  assert.equal(carried[3], 0)
  assert.match(carried[4], /2026-10-03 night 6h/)
  assert.doesNotMatch(exported[0].join(' '), /工资|倍率|节假/)
})

test('invalid fixed values are rejected including scientific sub-cent amounts and values above the limit', () => {
  const state = fixture(); add(state, '2026-10-01')
  for (const amount of [-1, NaN, Infinity, 100000000.01]) {
    normal(state, 'day', amount)
    assert.throws(() => calculatePayroll(state), /普通津贴必须在/)
  }
  for (const amount of [1.005, 40.155, 1e-7]) {
    normal(state, 'day', amount)
    assert.throws(() => calculatePayroll(state), /最多保留两位小数/)
  }
  normal(state, 'day', 1e8)
  assert.equal(calculatePayroll(state).totalAllowance, 100000000)
})

test('off days, invalid dates and deleted shifts have no hours or allowance', () => {
  const state = fixture(); normal(state, 'day'); add(state, '2026-10-01', 'off'); add(state, '2026-10-02', 'deleted'); add(state, '2026-02-31')
  const result = calculatePayroll(state)
  assert.equal(result.rows[0].totalHours, 0)
  assert.equal(result.totalAllowance, 0)
  assert.deepEqual(result.dailyRows, [])
})

test('employee IDs resembling inherited object keys are normal recipients of fixed allowances', () => {
  const state = fixture(); normal(state, 'day'); state.employees[0].id = 'constructor'; add(state, '2026-10-01', 'day', 'constructor')
  const result = calculatePayroll(state)
  assert.equal(result.rows[0].totalAllowance, 50)
})

test('calculation does not mutate inputs and canceled configuration remains irrelevant', () => {
  const state = fixture(); normal(state, 'day'); add(state, '2026-10-04')
  const cfg = createPayrollConfig(); cfg.payroll.dateShiftMultipliers = { '2026-10-04': { day: 3 } }
  const original = JSON.stringify({ state, cfg })
  assert.equal(calculatePayroll(state, cfg).totalAllowance, 50)
  assert.equal(JSON.stringify({ state, cfg }), original)
})

test('early-year month boundaries do not report later-month conflicts or allowances', () => {
  const state = fixture('0099-10'); normal(state, 'day')
  add(state, '0099-11-01'); add(state, '0099-11-01')
  const result = calculatePayroll(state)
  assert.equal(result.totalAllowance, 0)
  assert.deepEqual(result.dailyRows, [])
  assert.doesNotMatch(result.warnings.join(' '), /重复班次/)
})
