import test from 'node:test'
import assert from 'node:assert/strict'
import { unzipSync, strFromU8 } from 'fflate'
import { backupJSON, parseBackup, scheduleCSV, scheduleXLSX } from '../storage.ts'

function fixture() {
  return {
    version: 1, teamName: '桥西门店', month: '2028-02',
    employees: [{ id: 'e1', name: '小林', role: '店员', group: '一组', color: '#28a', maxHoursPerWeek: 40, eligibleShiftIds: ['early', 'night'], unavailableDates: ['2028-02-03'] }],
    shifts: [{ id: 'early', name: '早班', shortName: '早', start: '08:00', end: '16:00', color: '#339966', required: 1 }, { id: 'night', name: '晚班', shortName: '晚', start: '22:00', end: '06:00', color: '#8899aa', required: 0 }],
    rules: { minRestHours: 11, maxConsecutiveDays: 5, balanceWeekends: true },
    assignments: [{ employeeId: 'e1', date: '2028-01-31', shiftId: 'night', locked: true }, { employeeId: 'e1', date: '2028-02-01', shiftId: 'early', locked: false }, { employeeId: 'e1', date: '2028-02-02', shiftId: 'night', locked: false }, { employeeId: 'e1', date: '2028-02-04', shiftId: 'off', locked: true }],
  }
}
function rejected(change) {
  const data = fixture(); change(data)
  assert.throws(() => parseBackup(JSON.stringify(data)), /备份格式错误/)
}

test('backup roundtrip preserves cross-month assignments and locked days off', () => {
  const state = fixture()
  assert.deepEqual(parseBackup(backupJSON(state)), state)
  assert.deepEqual(parseBackup('\uFEFF' + JSON.stringify(state)), state)
})
test('dates are real calendar dates including leap years', () => {
  const state = fixture(); state.employees[0].unavailableDates.push('2028-02-29')
  assert.doesNotThrow(() => parseBackup(JSON.stringify(state)))
  rejected(s => s.employees[0].unavailableDates.push('2027-02-29'))
  rejected(s => s.assignments[0].date = '2028-04-31')
  rejected(s => s.month = '2028-13')
})
test('rejects unsafe or malformed imported configuration', () => {
  rejected(s => s.employees[0].color = 'url(https://evil.invalid)')
  rejected(s => s.shifts[0].start = '24:00')
  rejected(s => s.shifts[0].end = s.shifts[0].start)
  rejected(s => s.shifts[0].required = 1.5)
  rejected(s => s.rules.minRestHours = null)
  rejected(s => s.rules.maxConsecutiveDays = 0)
  rejected(s => s.rules.balanceWeekends = 'true')
  rejected(s => s.employees[0].maxHoursPerWeek = -1)
  rejected(s => s.employees[0].name = 'A\nB')
  assert.throws(() => parseBackup('{"version":1'), /JSON/)
  assert.throws(() => parseBackup(' '.repeat(2 * 1024 * 1024 + 1)), /2 MB/)
  assert.throws(() => backupJSON({ ...fixture(), rules: { minRestHours: NaN } }), /备份格式错误/)
})
test('rejects duplicate and dangling entity references', () => {
  rejected(s => s.employees.push(s.employees[0]))
  rejected(s => s.shifts.push(s.shifts[0]))
  rejected(s => s.employees[0].eligibleShiftIds.push('missing'))
  rejected(s => s.assignments[0].employeeId = 'missing')
  rejected(s => s.assignments[0].shiftId = 'missing')
  rejected(s => s.assignments.push({ ...s.assignments[1], shiftId: 'off', locked: true }))
  rejected(s => s.shifts[0].id = 'off')
})
test('unlocked explicit rest is valid and survives storage until regeneration', () => {
  const state = fixture()
  state.assignments[3].locked = false
  assert.deepEqual(parseBackup(backupJSON(state)), state)
})
test('separation groups persist all-shift and selected-shift rules and validate references', () => {
  const state = fixture()
  state.employees.push({ ...state.employees[0], id: 'e2', name: '小周' })
  state.rules.separationGroups = [{ id: 'sg1', name: '错开搭班', employeeIds: ['e1', 'e2'], shiftIds: [] }]
  assert.deepEqual(parseBackup(backupJSON(state)), state)
  state.rules.separationGroups[0].shiftIds = ['early']
  assert.deepEqual(parseBackup(backupJSON(state)), state)
  for (const change of [
    s => s.rules.separationGroups[0].employeeIds = ['e1'],
    s => s.rules.separationGroups[0].employeeIds = ['e1', 'e1'],
    s => s.rules.separationGroups[0].employeeIds = ['e1', 'missing'],
    s => s.rules.separationGroups[0].shiftIds = ['missing'],
    s => s.rules.separationGroups[0].shiftIds = ['early', 'early'],
    s => s.rules.separationGroups.push(s.rules.separationGroups[0]),
    s => s.rules.separationGroups[0].name = '',
  ]) {
    const broken = structuredClone(state); change(broken)
    assert.throws(() => parseBackup(JSON.stringify(broken)), /备份格式错误/)
  }
})
test('CSV includes all dates, true shift hours, leave and formula injection protection', () => {
  const state = fixture()
  state.employees[0].name = ' =HYPERLINK("https://evil.invalid")'
  state.employees[0].role = '+1+1'
  const csv = scheduleCSV(state)
  assert.ok(csv.startsWith('\uFEFF'))
  assert.match(csv, /2028-02-29/)
  assert.doesNotMatch(csv, /2028-02-30/)
  assert.match(csv, /"' =HYPERLINK\(""https:\/\/evil.invalid""\)"/)
  assert.match(csv, /"'\+1\+1"/)
  assert.match(csv, /"早班","晚班","请假","休息"/)
  assert.ok(csv.endsWith(',"16"\r\n'))
})
test('XLSX is a real three-sheet workbook and renders hostile names only as escaped text', () => {
  const state = fixture()
  state.employees[0].name = '=2+3<"&'
  const file = scheduleXLSX(state, { payrollRows: [['员工', '津贴'], [state.employees[0].name, 256.25]] })
  assert.equal(String.fromCharCode(...file.slice(0, 2)), 'PK')
  const entries = unzipSync(file)
  assert.equal(Object.keys(entries).length, 8)
  assert.match(strFromU8(entries['[Content_Types].xml']), /spreadsheetml.sheet.main/)
  assert.match(strFromU8(entries['xl/workbook.xml']), /排班表.*班次说明.*津贴明细/)
  const main = strFromU8(entries['xl/worksheets/sheet1.xml'])
  assert.match(main, /t="inlineStr"><is><t xml:space="preserve">=2\+3&lt;&quot;&amp;/)
  assert.doesNotMatch(main, /<f[ >]/)
  assert.match(main, /<v>16<\/v>/)
  assert.match(strFromU8(entries['xl/worksheets/sheet3.xml']), /<v>256.25<\/v>/)
  assert.throws(() => scheduleXLSX(state, { payrollRows: [['津贴'], [NaN]] }), /有限数字/)
})
test('payroll and calendar survive backup with safe numeric and reference validation', () => {
  const state = fixture()
  state.payroll = { monthlySalary: 5000, monthlyWorkdays: 21.75, hoursPerDay: 8, statutoryMultiplier: 3, restdayMultiplier: 2, ordinaryMultiplier: 1.5, restdayCompensated: false, employeeSalaries: { e1: 5500 } }
  state.calendar = { '2028-02-01': 'statutory', '2028-02-05': 'workday' }
  const decoded = parseBackup(backupJSON(state))
  assert.deepEqual(JSON.parse(JSON.stringify(decoded)), state)
  const file = unzipSync(scheduleXLSX(state))
  assert.match(strFromU8(file['xl/worksheets/sheet1.xml']), /2028-02-01（法定节假日·手动）/)
  assert.match(strFromU8(file['xl/worksheets/sheet1.xml']), /2028-02-05（工作日·手动）/)
  for (const change of [
    s => s.payroll.hoursPerDay = 0,
    s => s.payroll.monthlyWorkdays = 0,
    s => s.payroll.monthlySalary = 1e100,
    s => s.payroll.statutoryMultiplier = -3,
    s => s.payroll.employeeSalaries = { unknown: 5000 },
    s => s.calendar['2028-02-30'] = 'statutory',
    s => s.calendar['2028-02-03'] = 'holiday',
  ]) {
    const broken = structuredClone(state); change(broken)
    assert.throws(() => parseBackup(JSON.stringify(broken)), /备份格式错误/)
  }
})
test('CSV and Excel date headers share built-in holidays, adjusted workdays and manual overrides', () => {
  const state = fixture()
  state.month = '2026-10'
  const csv = scheduleCSV(state)
  const excel = strFromU8(unzipSync(scheduleXLSX(state))['xl/worksheets/sheet1.xml'])
  for (const output of [csv, excel]) {
    assert.match(output, /2026-10-01（国庆节·法定）/)
    assert.match(output, /2026-10-10（调休上班）/)
    assert.match(output, /2026-10-17（休息日）/)
    assert.match(output, /2026-10-08（工作日）/)
  }
  state.calendar = { '2026-10-01': 'workday' }
  assert.match(scheduleCSV(state), /2026-10-01（工作日·手动）/)
  state.month = '2028-02'
  assert.match(scheduleCSV(state), /2028-02-01（工作日·待核对）/)
})
