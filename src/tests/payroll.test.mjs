import test from 'node:test'
import assert from 'node:assert/strict'
import { dayInfo, calculatePayroll, createPayrollConfig, payrollRows } from '../payroll.ts'

function fixture(month = '2026-10') {
  return { version: 1, teamName: '测试', month,
    employees: [{ id: 'a', name: '员工', role: '店员', group: '一组', color: '#fff', maxHoursPerWeek: 40, eligibleShiftIds: ['day','night','long'], unavailableDates: [] }],
    shifts: [{ id: 'day', name: '日班', start: '08:00', end: '16:00' }, { id: 'night', name: '夜班', start: '22:00', end: '06:00' }, { id: 'long', name: '长班', start: '08:00', end: '18:00' }],
    rules: { minRestHours: 11, maxConsecutiveDays: 5, balanceWeekends: true }, assignments: [] }
}
function add(state, date, shiftId = 'day') { state.assignments.push({employeeId: 'a', date, shiftId, locked: false}) }
function config() { const value = createPayrollConfig(); value.payroll.monthlySalary = 17400; return value }
test('2026 has thirteen statutory dates, holiday days and adjusted workdays are distinct', () => {
  let total = 0
  for (let day = Date.UTC(2026,0,1); day < Date.UTC(2027,0,1); day += 86400000) if (dayInfo(new Date(day).toISOString().slice(0,10)).kind === 'statutory') total++
  assert.equal(total,13)
  for (const date of ['2026-01-04','2026-02-14','2026-02-28','2026-05-09','2026-09-20','2026-10-10']) assert.equal(dayInfo(date).kind,'workday')
  assert.equal(dayInfo('2026-02-16').kind,'statutory')
  assert.equal(dayInfo('2026-02-20').kind,'restday')
  assert.equal(dayInfo('2026-05-02').kind,'statutory')
  assert.equal(dayInfo('2026-05-04').kind,'restday')
  assert.equal(dayInfo('2026-04-06').kind,'restday')
})
test('unconfigured years are clearly unverified and manual day types take precedence', () => {
  assert.equal(dayInfo('2027-01-01').verified,false)
  assert.match(dayInfo('2027-01-01').label,/待核对/)
  assert.equal(dayInfo('2026-10-01',{'2026-10-01':'workday'}).kind,'workday')
  assert.equal(dayInfo('2026-02-31').verified,false)
})
test('statutory 3x is paid in full, restday 2x and working-day overtime 1.5x', () => {
  const state = fixture(); add(state,'2026-10-01'); add(state,'2026-10-04'); add(state,'2026-10-10','long')
  const result = calculatePayroll(state,config()), row = result.rows[0]
  assert.equal(row.hourlyRate,100)
  assert.equal(row.statutoryAllowance,2400)
  assert.equal(row.restdayAllowance,1600)
  assert.equal(row.ordinaryAllowance,300)
  assert.equal(row.ordinaryOvertimeHours,2)
  assert.equal(result.totalAllowance,4300)
})
test('overnight shift splits at midnight and statutory/restday do not double-count', () => {
  const state = fixture(); add(state,'2026-10-03','night')
  const row = calculatePayroll(state,config()).rows[0]
  assert.equal(row.statutoryHours,2); assert.equal(row.restdayHours,6)
  assert.equal(row.statutoryAllowance,600); assert.equal(row.restdayAllowance,1200)
  assert.equal(row.totalHours,8)
})
test('natural-month accounting includes prior-month tail and excludes next-month tail', () => {
  const state = fixture(); add(state,'2026-09-30','night'); add(state,'2026-10-31','night')
  const row = calculatePayroll(state,config()).rows[0]
  assert.equal(row.totalHours,8); assert.equal(row.statutoryHours,6); assert.equal(row.restdayHours,2)
})
test('restday compensation removes only restday payment, employee salary overrides base', () => {
  const state = fixture(); add(state,'2026-10-01'); add(state,'2026-10-04')
  const cfg = config(); cfg.payroll.restdayCompensated = true; cfg.payroll.employeeSalaries.a = 8700
  const row = calculatePayroll(state,cfg).rows[0]
  assert.equal(row.hourlyRate,50); assert.equal(row.statutoryAllowance,1200); assert.equal(row.restdayAllowance,0)
  assert.equal(row.restdayHours,8)
})
test('duplicate overlaps cannot inflate allowances and result exports numeric rows', () => {
  const state = fixture(); add(state,'2026-10-01'); add(state,'2026-10-01')
  const result = calculatePayroll(state,config())
  assert.equal(result.statutoryHours,8); assert.match(result.warnings.join(' '),/重叠/)
  assert.equal(payrollRows(result)[1][9],2400)
})
test('working-day carried overnight hours and new shift are aggregated before overtime', () => {
  const state = fixture(); add(state,'2026-10-08','night'); add(state,'2026-10-09','day')
  const row = calculatePayroll(state,config()).rows[0]
  assert.equal(row.totalHours,16); assert.equal(row.ordinaryOvertimeHours,6); assert.equal(row.ordinaryAllowance,900)
})
test('Spring Festival eve is paid at 3x but its ordinary holiday extension stays at 2x', () => {
  const state = fixture('2026-02'); add(state, '2026-02-16'); add(state, '2026-02-20'); add(state, '2026-02-28', 'long')
  const row = calculatePayroll(state, config()).rows[0]
  assert.equal(row.statutoryHours, 8); assert.equal(row.statutoryAllowance, 2400)
  assert.equal(row.restdayHours, 8); assert.equal(row.restdayAllowance, 1600)
  assert.equal(row.ordinaryOvertimeHours, 2); assert.equal(row.ordinaryAllowance, 300)
})
test('previous-year overnight tail uses the new year calendar without repeating the December hours', () => {
  const state = fixture('2026-01'); add(state, '2025-12-31', 'night')
  const january = calculatePayroll(state, config())
  assert.equal(january.rows[0].totalHours, 6)
  assert.equal(january.rows[0].statutoryHours, 6)
  assert.equal(january.totalAllowance, 1800)
  state.month = '2025-12'
  const december = calculatePayroll(state, config())
  assert.equal(december.rows[0].totalHours, 2)
  assert.equal(december.rows[0].statutoryHours, 0)
  assert.equal(december.totalAllowance, 0)
  assert.doesNotMatch(december.warnings.join(' '), /未覆盖|历史年份|待核对/)
})
test('future dates stay provisional until manually confirmed, including year-crossing payroll', () => {
  const state = fixture('2027-01'); add(state, '2026-12-31', 'night')
  const cfg = config()
  const preliminary = calculatePayroll(state, cfg)
  assert.match(preliminary.warnings.join(' '), /未覆盖/)
  assert.equal(preliminary.statutoryHours, 0)
  cfg.calendar['2027-01-01'] = 'statutory'
  const confirmed = calculatePayroll(state, cfg)
  assert.equal(confirmed.statutoryHours, 6)
  assert.equal(confirmed.totalAllowance, 1800)
})
