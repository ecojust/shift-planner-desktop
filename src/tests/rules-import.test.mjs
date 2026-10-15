import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRulesImport } from '../rulesImport.ts'
import { createSolverRequest, solverDebugJSON } from '../solverDebug.ts'
import { backupJSON, parseBackup, MAX_BACKUP_BYTES } from '../storage.ts'
import { minimumMonthHours } from '../hours.ts'
import { createPayrollConfig } from '../payroll.ts'

function fixture() {
  return {
    version: 1, month: '2026-10', teamName: '规则往返测试',
    monthlyReferenceHours: { '2026-10': 160, '2026-11': 176 },
    calendar: { '2026-10-01': 'workday', '2026-10-06': 'restday' },
    payroll: createPayrollConfig().payroll,
    employees: [
      { id: 'a', name: '小林', role: '', group: '', color: '#123456', minHoursPerMonth: null, minHoursPerWeek: 40, maxHoursPerWeek: 56, eligibleShiftIds: ['early', 'night'], unavailableDates: ['2026-10-12'] },
      { id: 'b', name: '小张', role: '', group: '', color: '#654321', minHoursPerMonth: 80, minHoursPerWeek: 16, maxHoursPerWeek: 40, eligibleShiftIds: ['early'], unavailableDates: [] },
      { id: 'c', name: '老数据成员', role: '', group: '', color: '#345678', maxHoursPerWeek: 48, eligibleShiftIds: ['early'], unavailableDates: [] },
    ],
    shifts: [
      { id: 'early', name: '早班', shortName: '早', start: '08:00', end: '16:00', color: '#abcdef', required: 1, staffingMode: 'minimum', normalAllowance: 20 },
      { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#abcdef', required: 1, staffingMode: 'fixed', normalAllowance: 50 },
    ],
    rules: {
      minRestHours: 11, maxConsecutiveDays: 5, weekdayWeights: { days: [1, 6], percent: 40 },
      separationGroups: [{ id: 'g', name: '错开值班', employeeIds: ['a', 'b'], shiftIds: ['early'] }],
      nonConsecutiveShifts: [{ id: 'n', shiftId: 'night' }],
      weeklyShiftLimits: [{ id: 'w', shiftId: 'night', maxPerWeek: 2 }],
    },
    assignments: [
      { employeeId: 'a', date: '2026-09-30', shiftId: 'night', locked: false },
      { employeeId: 'b', date: '2026-10-02', shiftId: 'off', locked: true },
      { employeeId: 'a', date: '2026-10-03', shiftId: 'early', locked: false },
      { employeeId: 'a', date: '2026-11-01', shiftId: 'early', locked: true },
    ],
  }
}

function exported(state = fixture(), source = 'current', timeLimitSeconds = 15) {
  const request = createSolverRequest(state, { timeLimitSeconds, allowPartial: false, seed: 12345 }, 'rules-roundtrip')
  return solverDebugJSON(request, { originalState: state, source })
}
function edited(change) {
  const payload = JSON.parse(exported())
  change(payload)
  return JSON.stringify(payload)
}

test('current exported rules import the complete document, cross-month assignments and rule references', () => {
  const original = fixture(), before = structuredClone(original)
  const result = parseRulesImport(exported(original))
  const expected = structuredClone(original)
  expected.employees[2].minHoursPerMonth = 0
  expected.employees[2].minHoursPerWeek = 0
  assert.deepEqual(result.document, parseBackup(backupJSON(expected)))
  assert.equal(result.source, 'current')
  assert.equal(result.timeLimitSeconds, 15)
  assert.deepEqual(original, before)
  result.document.rules.separationGroups[0].employeeIds.pop()
  result.document.assignments[0].shiftId = 'off'
  assert.deepEqual(original, before, 'imported nested state is detached')
})

test('failed-attempt export restores the captured attempt instead of subsequently edited live settings', () => {
  const state = fixture(), attempted = structuredClone(state)
  const request = createSolverRequest(state, { timeLimitSeconds: 60, allowPartial: false, seed: 72 }, 'failed-attempt')
  state.month = '2026-11'
  state.employees[0].name = 'later edit'
  state.rules.minRestHours = 0
  const result = parseRulesImport(solverDebugJSON(request, { originalState: attempted, source: 'attempt' }))
  assert.equal(result.source, 'attempt')
  assert.equal(result.timeLimitSeconds, 60)
  assert.equal(result.document.month, '2026-10')
  assert.equal(result.document.employees[0].name, '小林')
  assert.equal(result.document.rules.minRestHours, 11)
  assert.equal(result.document.employees[0].minHoursPerMonth, null)
})

test('following-reference null, explicit minima and legacy missing zero retain their semantics after saving', () => {
  const imported = parseRulesImport(exported()).document
  const saved = parseBackup(backupJSON(imported))
  saved.monthlyReferenceHours['2026-10'] = 208
  assert.deepEqual(saved.employees.map(employee => minimumMonthHours(saved, employee)), [208, 80, 0])
  assert.deepEqual(saved.employees.map(employee => employee.minHoursPerWeek), [40, 16, 0])
  assert.equal(saved.employees[0].minHoursPerMonth, null)
  assert.equal(saved.employees[2].minHoursPerMonth, 0)
})

test('original automatic monthly defaults resolve with the exported calendar before being restored', () => {
  const state = fixture()
  delete state.monthlyReferenceHours
  const payload = JSON.parse(exported(state))
  assert.ok(payload.state.employees[0].minHoursPerMonth > 0)
  const result = parseRulesImport(JSON.stringify(payload))
  assert.equal(result.document.employees[0].minHoursPerMonth, null)
  assert.equal(minimumMonthHours(result.document, result.document.employees[0]), payload.state.employees[0].minHoursPerMonth)
})

test('old requests without debug metadata keep their resolved hours and optional payroll/calendar remain absent', () => {
  const state = fixture()
  delete state.calendar
  delete state.payroll
  const payload = createSolverRequest(state, { timeLimitSeconds: 30, allowPartial: false, seed: 8 }, 'old-export')
  const result = parseRulesImport(JSON.stringify(payload))
  assert.equal(result.source, 'unknown')
  assert.equal(result.timeLimitSeconds, 30)
  assert.equal(result.document.employees[0].minHoursPerMonth, 160)
  assert.equal(result.document.calendar, undefined)
  assert.equal(result.document.payroll, undefined)
  const debugWithoutDefaults = JSON.parse(exported())
  delete debugWithoutDefaults.debug.originalHourDefaults
  assert.equal(parseRulesImport(JSON.stringify(debugWithoutDefaults)).document.employees[0].minHoursPerMonth, 160)
})

test('historical provenance is discarded, including malformed or forged source and schedule metadata', () => {
  const result = parseRulesImport(edited(payload => {
    payload.state.provenance = {
      fields: { '/employees/a/name': { source: 'mcp', at: 'bad timestamp' } },
      scheduleUpdates: { '2026-10': { source: 'http', at: '2099-01-01T00:00:00Z' } },
      pendingExternalChange: 'forged',
    }
  }))
  assert.equal(result.document.provenance, undefined)
  assert.equal(Object.hasOwn(result.document, 'provenance'), false)
})

test('only representable wait durations are restored and solver-only options are never returned', () => {
  for (const seconds of [5, 15, 30, 60]) assert.equal(parseRulesImport(exported(fixture(), 'current', seconds)).timeLimitSeconds, seconds)
  const result = parseRulesImport(exported(fixture(), 'current', 120))
  assert.equal(Object.hasOwn(result, 'timeLimitSeconds'), false)
  assert.equal(result.seed, undefined)
  assert.equal(result.allowPartial, undefined)
  assert.equal(parseRulesImport(edited(payload => { delete payload.options })).timeLimitSeconds, undefined)
  for (const value of [null, [], '15']) assert.throws(() => parseRulesImport(edited(payload => { payload.options = value })), /options必须是对象/)
  for (const value of [null, '15', -1, 0]) assert.throws(() => parseRulesImport(edited(payload => { payload.options.timeLimitSeconds = value })), /求解时限必须为正数/)
})

test('backup files and standalone constraints are rejected with an appropriate import destination', () => {
  assert.throws(() => parseRulesImport(backupJSON(fixture())), /完整备份.*导入备份/)
  assert.throws(() => parseRulesImport(JSON.stringify(fixture().rules)), /导出规则/)
  for (const value of [null, [], 1]) assert.throws(() => parseRulesImport(JSON.stringify(value)), /必须是对象/)
  assert.throws(() => parseRulesImport('{broken'), /无法读取 JSON/)
})

test('unsupported protocol/debug versions and malformed state are rejected', () => {
  for (const value of [undefined, 0, 2, '1']) assert.throws(() => parseRulesImport(edited(payload => { payload.protocolVersion = value })), /协议版本/)
  for (const value of [undefined, 2, '1']) assert.throws(() => parseRulesImport(edited(payload => { payload.debug.formatVersion = value })), /导出格式版本/)
  for (const value of [undefined, 'another-format']) assert.throws(() => parseRulesImport(edited(payload => { payload.debug.format = value })), /导出格式版本/)
  assert.throws(() => parseRulesImport(edited(payload => { payload.debug.source = 'foreign' })), /导出来源/)
  assert.throws(() => parseRulesImport(edited(payload => { payload.debug = [] })), /debug必须是对象/)
  for (const value of [undefined, null, [], 'state']) assert.throws(() => parseRulesImport(edited(payload => { payload.state = value })), /state必须是对象/)
  assert.throws(() => parseRulesImport(edited(payload => { payload.state.version = 2 })), /备份版本/)
})

test('business validation rejects invalid references, dates, duplicates and numeric ranges atomically', () => {
  const cases = [
    [payload => { payload.state.employees[0].eligibleShiftIds = ['missing'] }, /不存在的班次/],
    [payload => { payload.state.rules.separationGroups[0].employeeIds = ['a', 'missing'] }, /不存在的员工/],
    [payload => { payload.state.rules.weeklyShiftLimits[0].maxPerWeek = 8 }, /超出范围/],
    [payload => { payload.state.assignments.push(payload.state.assignments[0]) }, /多条排班/],
    [payload => { payload.state.assignments[0].date = '2026-02-30' }, /日期不存在/],
    [payload => { payload.state.employees[0].minHoursPerMonth = -1 }, /超出范围/],
  ]
  for (const [change, expected] of cases) assert.throws(() => parseRulesImport(edited(change)), expected)
})

test('original-hour metadata must cover each real member exactly once', () => {
  for (const value of [null, {}, [], 'defaults']) assert.throws(() => parseRulesImport(edited(payload => { payload.debug.originalHourDefaults = value })), /成员一一对应/)
  assert.throws(() => parseRulesImport(edited(payload => { payload.debug.originalHourDefaults[1] = payload.debug.originalHourDefaults[0] })), /重复成员/)
  for (const employeeId of ['missing', '__proto__', 42]) assert.throws(() => parseRulesImport(edited(payload => { payload.debug.originalHourDefaults[0].employeeId = employeeId })), /不存在的成员/)
  assert.throws(() => parseRulesImport(edited(payload => { payload.debug.originalHourDefaults[0] = [] })), /必须是对象/)
  const reordered = parseRulesImport(edited(payload => { payload.debug.originalHourDefaults.reverse() }))
  assert.equal(reordered.document.employees[0].minHoursPerMonth, null, 'metadata is joined by stable employee ID')
})

test('invalid or inconsistent original minima cannot override an otherwise valid request', () => {
  for (const value of [-1, 745, '160', {}, []]) assert.throws(() => parseRulesImport(edited(payload => { payload.debug.originalHourDefaults[0].minHoursPerMonth = value })), /原始每月最低工时/)
  for (const value of [-1, 169, null, '40', {}]) assert.throws(() => parseRulesImport(edited(payload => { payload.debug.originalHourDefaults[0].minHoursPerWeek = value })), /原始每周最低工时/)
  assert.throws(() => parseRulesImport(edited(payload => { payload.debug.originalHourDefaults[0].minHoursPerWeek = 57 })), /最低工时不能超过最高工时/)
  assert.throws(() => parseRulesImport(edited(payload => { payload.debug.originalHourDefaults[1].minHoursPerMonth = 81 })), /不一致/)
  assert.throws(() => parseRulesImport(edited(payload => { payload.debug.originalHourDefaults[0].minHoursPerWeek = 39 })), /不一致/)
  assert.throws(() => parseRulesImport(edited(payload => { payload.state.monthlyReferenceHours['2026-10'] = 161 })), /不一致/)
})

test('UTF-8 byte limits include the BOM and reject oversized multibyte files before parsing', () => {
  const json = exported()
  assert.equal(parseRulesImport('\uFEFF' + json).document.month, '2026-10')
  const bytes = new TextEncoder().encode(json).length
  const exact = json + ' '.repeat(MAX_BACKUP_BYTES - bytes)
  assert.equal(parseRulesImport(exact).document.month, '2026-10')
  assert.throws(() => parseRulesImport('\uFEFF' + exact), /8 MiB/)
  const large = edited(payload => { payload.debug.buildVersion = '字'.repeat(3 * 1024 * 1024) })
  assert.ok(large.length < MAX_BACKUP_BYTES)
  assert.throws(() => parseRulesImport(large), /8 MiB/)
})
