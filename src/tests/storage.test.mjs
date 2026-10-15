import test from 'node:test'
import assert from 'node:assert/strict'
import { unzipSync, strFromU8 } from 'fflate'
import { backupJSON, parseBackup, scheduleCSV, scheduleXLSX } from '../storage.ts'
import { createPayrollConfig, calculatePayroll } from '../payroll.ts'

function fixture() {
  return {
    version: 1, teamName: '桥西门店', month: '2028-02',
    employees: [{ id: 'e1', name: '小林', role: '店员', group: '一组', color: '#28a', minHoursPerWeek: 0, maxHoursPerWeek: 40, eligibleShiftIds: ['early', 'night'], unavailableDates: ['2028-02-03'] }],
    shifts: [{ id: 'early', name: '早班', shortName: '早', start: '08:00', end: '16:00', color: '#339966', required: 1 }, { id: 'night', name: '晚班', shortName: '晚', start: '22:00', end: '06:00', color: '#8899aa', required: 0 }],
    rules: { minRestHours: 11, maxConsecutiveDays: 5, balanceWeekends: true },
    assignments: [{ employeeId: 'e1', date: '2028-01-31', shiftId: 'night', locked: true }, { employeeId: 'e1', date: '2028-02-01', shiftId: 'early', locked: false }, { employeeId: 'e1', date: '2028-02-02', shiftId: 'night', locked: false }, { employeeId: 'e1', date: '2028-02-04', shiftId: 'off', locked: true }],
  }
}
function rejected(change) {
  const data = fixture(); change(data)
  assert.throws(() => parseBackup(JSON.stringify(data)), /备份格式错误/)
}
function weightedFixture() {
  const state = fixture()
  state.month = '2026-10'
  state.employees = ['e1', 'e2', 'e3'].map(id => ({ ...state.employees[0], id, name: id, maxHoursPerWeek: 168, unavailableDates: [] }))
  state.rules = { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: { days: [6, 7], percent: 40 } }
  state.assignments = Array.from({ length: 7 }, (_, index) => ({ employeeId: 'e1', date: `2026-10-${String(index + 5).padStart(2, '0')}`, shiftId: 'early', locked: false }))
  state.assignments.push(...['06', '10', '11'].map(day => ({ employeeId: 'e2', date: `2026-10-${day}`, shiftId: 'night', locked: false })))
  state.assignments.push({ employeeId: 'e3', date: '2026-10-05', shiftId: 'off', locked: true }, { employeeId: 'e3', date: '2026-09-30', shiftId: 'night', locked: true })
  return state
}
function explanationRows(state) {
  const sheet = strFromU8(unzipSync(scheduleXLSX(state))['xl/worksheets/sheet2.xml'])
  return [...sheet.matchAll(/<row\b[^>]*>(.*?)<\/row>/gs)].map(row => [...row[1].matchAll(/<c\b[^>]*>(.*?)<\/c>/gs)].map(cell => {
    const number = cell[1].match(/<v>(.*?)<\/v>/s)
    return number ? Number(number[1]) : cell[1].match(/<t\b[^>]*>(.*?)<\/t>/s)?.[1]
  }))
}
function exportedWeek(state, weekStart) {
  const row = explanationRows(state).find(row => row[0] === weekStart)
  assert.ok(row, `Missing exported week ${weekStart}`)
  return row
}

test('backup roundtrip preserves cross-month assignments and locked days off', () => {
  const state = fixture()
  assert.deepEqual(parseBackup(backupJSON(state)), state)
  assert.deepEqual(parseBackup('\uFEFF' + JSON.stringify(state)), state)
})
test('legacy staffing modes remain omitted and export with minimum semantics', () => {
  const legacy = weightedFixture()
  const restored = parseBackup(backupJSON(legacy))
  assert.deepEqual(restored.shifts, legacy.shifts)
  assert.ok(restored.shifts.every(shift => !Object.hasOwn(shift, 'staffingMode')))
  const explicit = structuredClone(restored)
  explicit.shifts.forEach(shift => { shift.staffingMode = 'minimum' })
  assert.deepEqual(explanationRows(restored), explanationRows(explicit))
  assert.deepEqual(exportedWeek(restored, '2026-10-05').slice(3), [10, 4, 6, 10, 0, 0, '通过', 7, 3])
})
test('explicit minimum and fixed staffing modes survive complete JSON roundtrips', () => {
  const state = fixture()
  state.shifts[0].staffingMode = 'minimum'
  state.shifts[1].staffingMode = 'fixed'
  assert.deepEqual(JSON.parse(backupJSON(state)), state)
  assert.deepEqual(parseBackup(backupJSON(state)), state)
})
test('backups reject unknown, null and nonstring staffing modes on import and export', () => {
  for (const mode of [null, '', 'exact', 'MINIMUM', 'minimum ', 0, false, [], {}]) {
    const state = fixture()
    state.shifts[0].staffingMode = mode
    assert.throws(() => parseBackup(JSON.stringify(state)), /班次人数模式/)
    assert.throws(() => backupJSON(state), /班次人数模式/)
  }
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
  assert.throws(() => parseBackup(' '.repeat(8 * 1024 * 1024 + 1)), /8 MB/)
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
  assert.ok(csv.endsWith(',"22","0"\r\n')) // Includes six hours of January's final night.
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
  assert.match(main, /<v>22<\/v>/)
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

test('legacy backups default missing weekly minimums to zero without inventing monthly constraints', () => {
  const old = fixture()
  delete old.employees[0].minHoursPerMonth
  delete old.employees[0].minHoursPerWeek
  const migrated = parseBackup(JSON.stringify(old))
  assert.equal(Object.hasOwn(migrated.employees[0], 'minHoursPerMonth'), false)
  assert.equal(migrated.employees[0].minHoursPerWeek, 0)
  assert.equal(migrated.employees[0].maxHoursPerWeek, 40)
  assert.deepEqual(migrated.assignments, old.assignments)
  assert.deepEqual(parseBackup(backupJSON(migrated)), migrated)
})

test('retired monthly fields are discarded regardless of their old JSON values while weekly limits and saved data survive', () => {
  const monthlyValues = [undefined, null, 0, 80.5, 744, 1000000, -1, '160', false, [], { automatic: true }]
  const referenceValues = [undefined, null, 0, '160', false, [], { '2028-02': 160, '2028-03': 0 }, { '2028-13': 99999, invalid: null }]
  for (const minimum of [0, 24]) for (const minHoursPerMonth of monthlyValues) for (const monthlyReferenceHours of referenceValues) {
    const data = fixture()
    data.employees[0].minHoursPerWeek = minimum
    const expected = structuredClone(data)
    data.employees[0].minHoursPerMonth = minHoursPerMonth
    data.monthlyReferenceHours = monthlyReferenceHours
    const before = structuredClone(data)
    assert.deepEqual(parseBackup(JSON.stringify(data)), expected)
    assert.deepEqual(parseBackup(backupJSON(data)), expected)
    assert.deepEqual(data, before, 'migration must not mutate its source')
    assert.doesNotMatch(backupJSON(data), /minHoursPerMonth|monthlyReferenceHours/)
  }
})

test('weekly minimum validation remains strict, including minute-rounded inverted ranges', () => {
  for (const change of [
    s => s.employees[0].minHoursPerWeek = null,
    s => s.employees[0].minHoursPerWeek = '24',
    s => s.employees[0].minHoursPerWeek = -1,
    s => s.employees[0].minHoursPerWeek = 41,
    s => { s.employees[0].minHoursPerWeek = 1.001; s.employees[0].maxHoursPerWeek = 1.01 },
    s => { s.employees[0].minHoursPerWeek = 1e-12; s.employees[0].maxHoursPerWeek = 1e-11 },
  ]) rejected(change)
})

test('weekday weights survive backup, reject malformed rules, and export actual staffing to Excel', () => {
  const state = fixture()
  delete state.rules.balanceWeekends
  state.rules.weekdayWeights = { days: [1, 6], percent: 40 }
  assert.deepEqual(parseBackup(backupJSON(state)).rules, state.rules)
  const excel = strFromU8(unzipSync(scheduleXLSX(state))['xl/worksheets/sheet2.xml'])
  for (const label of ['人数模式', '每日人数', '每日最少', '上班权重', '本段实际班次', '选中星期实际班次', '其余星期实际班次', '匹配完整周基准', '班位缺口', '固定人数超额', '人数与权重检查', '40%']) assert.ok(excel.includes(label))
  assert.doesNotMatch(excel, /基准每日人数|周配额|选中星期配额|其余星期配额/)
  for (const bad of [null, {}, { days: [], percent: 40 }, { days: [1, 1], percent: 40 }, { days: [1], percent: 101 }, { days: [1], percent: 0.5 }, { days: [1, 2, 3, 4, 5, 6, 7], percent: 50 }]) {
    state.rules.weekdayWeights = bad
    assert.throws(() => parseBackup(JSON.stringify(state)), /备份格式错误/)
  }
})

test('Excel matches weighted actual totals with extra staff and optional shifts instead of fixed shift quotas', () => {
  assert.deepEqual(exportedWeek(weightedFixture(), '2026-10-05'), ['2026-10-05', '2026-10-05', '2026-10-11', 10, 4, 6, 10, 0, 0, '通过', 7, 3])
})

test('Excel partial weeks show their actual counts and a matching complete-week baseline', () => {
  const state = weightedFixture()
  state.assignments = ['01', '02', '03', '04'].map(day => ({ employeeId: 'e1', date: `2026-10-${day}`, shiftId: 'early', locked: false }))
  state.assignments.push(...['02', '03', '04'].map(day => ({ employeeId: 'e2', date: `2026-10-${day}`, shiftId: 'night', locked: false })))
  assert.deepEqual(exportedWeek(state, '2026-09-28'), ['2026-09-28', '2026-10-01', '2026-10-04', 7, 4, 3, 10, 0, 0, '通过', 4, 3])
})

function carriedWeightedFixture() {
  const state = weightedFixture()
  state.scheduleCoverage = { '2026-09': { employeeIds: state.employees.map(employee => employee.id) } }
  state.assignments = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']
    .map(date => ({ employeeId: 'e1', date, shiftId: 'early', locked: false }))
  state.assignments.push(...['2026-10-03', '2026-10-04'].map(date => ({ employeeId: 'e2', date, shiftId: 'night', locked: false })))
  return state
}

test('Excel checks actual whole-week weights with previous-month records while reporting only current-month work', () => {
  const state = carriedWeightedFixture(), before = structuredClone(state)
  // Whole week: 9 starts, weekend 4 = ceil(9 * 40%), weekdays one per day.
  assert.deepEqual(exportedWeek(state, '2026-09-28').slice(3), [6, 4, 2, 9, 0, 0, '通过', 4, 2])
  const history = explanationRows(state).find(row => row[0] === '跨月周历史')
  assert.equal(history[4], 0)
  assert.equal(history[6], 3)
  assert.match(history[2], /2026-09-28 至 2026-09-30/)
  assert.deepEqual(state, before, 'export never changes retained history')
})

test('Excel catches uneven previous-month weekdays even if complete-week group totals still match', () => {
  const state = carriedWeightedFixture()
  Object.assign(state.assignments[1], { employeeId: 'e2', date: '2026-09-28' })
  Object.assign(state.assignments[2], { employeeId: 'e3', date: '2026-09-28' })
  // Current month and both group totals are unchanged, but weekdays are 3,0,0,1,1.
  assert.deepEqual(exportedWeek(state, '2026-09-28').slice(3), [6, 4, 2, 9, 0, 0, '同组日期分布不均', 4, 2])
})

test('Excel minimum coverage checks each date and shift even when weighted totals match', () => {
  const state = weightedFixture()
  state.assignments.find(item => item.date === '2026-10-07' && item.shiftId === 'early').shiftId = 'night'
  assert.deepEqual(exportedWeek(state, '2026-10-05').slice(3), [10, 4, 6, 10, 1, 0, '最低覆盖不足', 6, 4])
})

test('Excel flags unmatched actual proportions despite complete minimum coverage', () => {
  const state = weightedFixture()
  state.assignments = state.assignments.filter(item => !(item.date === '2026-10-10' && item.shiftId === 'night'))
  assert.deepEqual(exportedWeek(state, '2026-10-05').slice(3), [9, 3, 6, '未匹配', 0, 0, '星期比例未匹配', 7, 2])
})

test('Excel independently flags uneven daily group distribution despite matched weekly totals', () => {
  const state = weightedFixture()
  const moved = state.assignments.find(item => item.date === '2026-10-07' && item.shiftId === 'early')
  Object.assign(moved, { employeeId: 'e3', date: '2026-10-06' })
  assert.deepEqual(exportedWeek(state, '2026-10-05').slice(3), [10, 4, 6, 10, 1, 0, '最低覆盖不足；同组日期分布不均', 7, 3])
})

test('Excel explains minimum and fixed daily staffing and their distinct zero semantics', () => {
  const state = fixture()
  state.shifts[0].staffingMode = 'minimum'
  state.shifts[1].staffingMode = 'fixed'
  const rows = explanationRows(state)
  assert.deepEqual(rows[0], ['班次', '简称', '开始时间', '结束时间', '人数模式', '每日人数', '单班工时', '固定班次津贴（元/人/班）'])
  assert.deepEqual(rows.find(row => row[0] === '早班'), ['早班', '早', '08:00', '16:00', '每日最少', 1, 8, 0])
  assert.deepEqual(rows.find(row => row[0] === '晚班'), ['晚班', '晚', '22:00', '06:00', '每日固定', 0, 8, 0])
  const explanation = rows.find(row => row[0] === '说明')[1]
  assert.match(explanation, /每日最少.*设为 0 仍可排班/)
  assert.match(explanation, /每日固定.*设为 0 不得安排/)
})

test('Excel accepts exact fixed staffing alongside additional minimum-zero shifts', () => {
  const state = weightedFixture()
  state.shifts[0].staffingMode = 'fixed'
  assert.deepEqual(exportedWeek(state, '2026-10-05').slice(3), [10, 4, 6, 10, 0, 0, '通过', 7, 3])
})

test('Excel flags fixed shortages and excess per date despite unchanged weekly shift totals and valid weights', () => {
  const state = weightedFixture()
  state.shifts[0].staffingMode = 'fixed'
  state.assignments.find(item => item.date === '2026-10-07' && item.shiftId === 'early').shiftId = 'night'
  state.assignments.find(item => item.date === '2026-10-06' && item.shiftId === 'night').shiftId = 'early'
  assert.deepEqual(exportedWeek(state, '2026-10-05').slice(3), [10, 4, 6, 10, 1, 1, '固定人数不足；固定人数超额', 7, 3])
})

test('Excel rejects scheduled fixed-zero shifts while allowing the same minimum-zero assignments', () => {
  const state = weightedFixture()
  state.shifts[1].staffingMode = 'minimum'
  assert.deepEqual(exportedWeek(state, '2026-10-05').slice(3), [10, 4, 6, 10, 0, 0, '通过', 7, 3])
  state.shifts[1].staffingMode = 'fixed'
  assert.deepEqual(exportedWeek(state, '2026-10-05').slice(3), [10, 4, 6, 10, 0, 3, '固定人数超额', 7, 3])
})

test('staffing modes preserve saved assignments and do not change actual shift allowances or CSV values', () => {
  const state = { ...fixture(), ...createPayrollConfig() }
  state.shifts[0].normalAllowance = 20
  state.shifts[1].normalAllowance = 50
  const csv = scheduleCSV(state)
  const excel = unzipSync(scheduleXLSX(state))
  for (const mode of ['minimum', 'fixed']) {
    const changed = structuredClone(state)
    changed.shifts.forEach(shift => { shift.staffingMode = mode })
    const restored = parseBackup(backupJSON(changed))
    assert.deepEqual(restored.assignments, state.assignments)
    assert.equal(calculatePayroll(restored, restored).totalAllowance, 70)
    assert.equal(scheduleCSV(restored), csv)
    const archive = unzipSync(scheduleXLSX(restored))
    for (const name of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml']) assert.deepEqual(archive[name], excel[name])
  }
})

test('fixed shift allowances roundtrip, with legacy zero defaults and ignored old multipliers', () => {
  const state = { ...fixture(), ...createPayrollConfig() }
  state.shifts[0].normalAllowance = 20.25
  state.shifts[1].normalAllowance = 0
  state.payroll.dateShiftMultipliers = { '2028-02-01': { early: 0, night: 3 }, '2028-03-01': { night: 1.5 } }
  assert.deepEqual(JSON.parse(backupJSON(state)), state)
  const old = fixture()
  assert.equal(calculatePayroll(parseBackup(backupJSON(old))).totalAllowance, 0)
  const restored = parseBackup(backupJSON(state))
  assert.equal(calculatePayroll(restored, restored).totalAllowance, 20.25)
  assert.equal(restored.payroll.dateShiftMultipliers['2028-02-01'].early, 0)
})

test('backup rejects invalid fixed money and retains exact two-decimal amounts', () => {
  const data = { ...fixture(), ...createPayrollConfig() }
  for (const amount of [-1, 1e8 + 0.01, 0.001, 1e-12, '50', null]) {
    data.shifts[0].normalAllowance = amount
    assert.throws(() => parseBackup(JSON.stringify(data)), /备份格式错误/)
  }
  data.shifts[0].normalAllowance = 0.29
  assert.equal(parseBackup(backupJSON(data)).shifts[0].normalAllowance, 0.29)
  data.payroll.dateShiftAllowances = { '2028-02-01': { early: 100 } }
  const restored = parseBackup(backupJSON(data))
  assert.equal(restored.payroll.dateShiftAllowances, undefined)
  assert.equal(calculatePayroll(restored, restored).totalAllowance, 0.29)
})

test('prototype-like valid shift IDs retain their fixed allowance', () => {
  const data = { ...fixture(), ...createPayrollConfig() }
  data.shifts[0].id = '__proto__'
  data.shifts[0].normalAllowance = 40.15
  data.employees[0].eligibleShiftIds[0] = '__proto__'
  data.assignments.find(a => a.shiftId === 'early').shiftId = '__proto__'
  const restored = parseBackup(backupJSON(data))
  assert.equal(restored.shifts[0].normalAllowance, 40.15)
  assert.equal(calculatePayroll(restored, restored).totalAllowance, 40.15)
})

test('real Excel and CSV include fixed daily allowances and numeric monthly totals', () => {
  const data = { ...fixture(), ...createPayrollConfig() }
  data.shifts[0].normalAllowance = 20
  data.shifts[1].normalAllowance = 50
  data.payroll.monthlySalary = 17400 // Salary and old multipliers must not affect fixed allowances.
  data.payroll.dateShiftMultipliers = { '2028-02-01': { early: 3, night: 2 } }
  const calculated = calculatePayroll(data, data)
  assert.equal(calculated.totalAllowance, 70)
  const csv = scheduleCSV(data)
  assert.ok(csv.includes('早班\n+¥20.00')) // Prior-month night carries six hours, without another allowance.
  assert.ok(csv.includes('晚班\n+¥50.00'))
  assert.ok(csv.endsWith(',"22","70"\r\n'))
  const archive = unzipSync(scheduleXLSX(data))
  const roster = strFromU8(archive['xl/worksheets/sheet1.xml'])
  const explanation = strFromU8(archive['xl/worksheets/sheet2.xml'])
  const detail = strFromU8(archive['xl/worksheets/sheet3.xml'])
  assert.match(roster, /额外津贴（元）/)
  assert.match(roster, /<c r="AH2" s="0"><v>70<\/v><\/c>/)
  assert.match(explanation, /固定班次津贴（元\/人\/班）/)
  assert.doesNotMatch(explanation, /手动倍率|加班日期/)
  assert.match(detail, /每日明细/)
  assert.match(detail, /<v>70<\/v>/)
  assert.match(strFromU8(archive['xl/styles.xml']), /wrapText="1"/)
})
