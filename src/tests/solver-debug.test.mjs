import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive } from 'vue'
import { createSolverRequest, solverDebugJSON, solverDebugFileName } from '../solverDebug.ts'

function fixture() {
  return {
    version: 1, month: '2026-10', teamName: '测试排班',
    monthlyReferenceHours: { '2026-10': 160 }, calendar: { '2026-10-01': 'workday' },
    employees: [
      { id: 'a', name: '小林', role: '', group: '', color: '#123456', minHoursPerMonth: null, minHoursPerWeek: 40, maxHoursPerWeek: 56, eligibleShiftIds: ['early', 'night'], unavailableDates: ['2026-10-12'] },
      { id: 'b', name: '小张', role: '', group: '', color: '#654321', minHoursPerMonth: 80, maxHoursPerWeek: 40, eligibleShiftIds: ['early'], unavailableDates: [] },
    ],
    shifts: [
      { id: 'early', name: '早班', shortName: '早', start: '08:00', end: '16:00', color: '#abcdef', required: 1, staffingMode: 'minimum', normalAllowance: 20 },
      { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#abcdef', required: 1, staffingMode: 'fixed', normalAllowance: 50 },
    ],
    rules: { minRestHours: 11, maxConsecutiveDays: 5, weekdayWeights: { days: [1, 6], percent: 40 }, separationGroups: [{ id: 'g', name: '错开值班', employeeIds: ['a', 'b'], shiftIds: ['early'] }] },
    assignments: [
      { employeeId: 'a', date: '2026-09-30', shiftId: 'night', locked: false },
      { employeeId: 'b', date: '2026-10-02', shiftId: 'off', locked: true },
      { employeeId: 'a', date: '2026-10-03', shiftId: 'early', locked: false },
      { employeeId: 'a', date: '2026-11-01', shiftId: 'early', locked: true },
    ],
  }
}
const options = () => ({ timeLimitSeconds: 15, allowPartial: false, seed: 12345 })

test('rules JSON is a complete solver request with resolved defaults and cross-month context', () => {
  const original = fixture(), before = structuredClone(original), solverOptions = options()
  const request = createSolverRequest(original, solverOptions, 'export-test')
  assert.deepEqual(original, before)
  assert.equal(original.employees[0].minHoursPerMonth, null)
  assert.deepEqual(request.state.employees.map(employee => employee.minHoursPerWeek), [40, 0])
  assert.ok(request.state.employees.every(employee => !Object.hasOwn(employee, 'minHoursPerMonth')))
  assert.equal(Object.hasOwn(request.state, 'monthlyReferenceHours'), false)
  const exported = JSON.parse(solverDebugJSON(request, { buildVersion: '2026.1014.1200', exportedAt: '2026-10-14T04:00:00.000Z', source: 'current', runtime: 'desktop', originalState: original }))
  assert.equal(exported.protocolVersion, 1)
  assert.equal(exported.requestId, 'export-test')
  assert.deepEqual(exported.state, request.state)
  assert.deepEqual(exported.options, solverOptions)
  assert.deepEqual(exported.state.assignments, original.assignments)
  assert.deepEqual(exported.state.rules, original.rules)
  assert.deepEqual(exported.state.shifts, original.shifts)
  assert.deepEqual(exported.debug.originalHourDefaults, [{ employeeId: 'a', minHoursPerWeek: 40 }, { employeeId: 'b' }])
  assert.equal(exported.debug.buildVersion, '2026.1014.1200')
  assert.equal(exported.debug.exportedAt, '2026-10-14T04:00:00.000Z')
  assert.equal(exported.debug.runtime, 'desktop')
  assert.equal(exported.debug.originalState, undefined, 'do not duplicate the full roster in metadata')
})

test('snapshot is detached in both directions, including reactive Vue objects and nested rules', () => {
  const state = reactive(fixture()), selectedOptions = reactive(options())
  const request = createSolverRequest(state, selectedOptions, 'attempt-one')
  state.employees[0].eligibleShiftIds.length = 0
  state.assignments[0].shiftId = 'off'
  state.rules.weekdayWeights.days.push(7)
  state.rules.separationGroups[0].employeeIds.length = 0
  state.monthlyReferenceHours['2026-10'] = 176
  selectedOptions.seed = 54321
  assert.deepEqual(request.state.employees[0].eligibleShiftIds, ['early', 'night'])
  assert.equal(request.state.assignments[0].shiftId, 'night')
  assert.deepEqual(request.state.rules.weekdayWeights.days, [1, 6])
  assert.deepEqual(request.state.rules.separationGroups[0].employeeIds, ['a', 'b'])
  assert.equal(request.options.seed, 12345)
  assert.equal(request.state.employees[0].minHoursPerWeek, 40)
  request.state.employees[1].name = 'request-only'
  assert.equal(state.employees[1].name, '小张')
})

test('exporting a cached attempt never resolves its hours again or alters its options', () => {
  const state = fixture(), request = createSolverRequest(state, options(), 'last-attempt')
  const before = structuredClone(request)
  state.month = '2026-11'
  state.monthlyReferenceHours['2026-10'] = 200
  state.rules.minRestHours = 0
  const result = JSON.parse(solverDebugJSON(request, { source: 'attempt' }))
  assert.deepEqual(request, before)
  assert.deepEqual(result.state, before.state)
  assert.deepEqual(result.options, before.options)
  assert.equal(result.debug.source, 'attempt')
  assert.equal(result.state.month, '2026-10')
  assert.equal(result.state.employees[0].minHoursPerWeek, 40)
})

test('old monthly defaults never reappear in requests or exports and explicit weekly zero remains zero', () => {
  for (const minimum of [null, 744, 10000, NaN, Infinity]) {
    const state = fixture()
    state.employees[0].minHoursPerMonth = minimum
    state.employees[0].minHoursPerWeek = 0
    state.monthlyReferenceHours['2026-10'] = Infinity
    const request = createSolverRequest(state, options(), 'weekly-only')
    assert.deepEqual(request.state.employees.map(employee => employee.minHoursPerWeek), [0, 0])
    const exported = solverDebugJSON(request, { originalState: state })
    assert.doesNotMatch(exported, /minHoursPerMonth|monthlyReferenceHours/)
    assert.equal(state.employees[0].minHoursPerMonth, minimum)
  }
})

test('cached legacy requests export only current constraints without modifying the original attempt', () => {
  const request = { protocolVersion: 1, requestId: 'old-attempt', state: fixture(), options: options() }
  const before = structuredClone(request)
  const result = JSON.parse(solverDebugJSON(request, { source: 'attempt', originalState: request.state }))
  assert.doesNotMatch(JSON.stringify(result), /minHoursPerMonth|monthlyReferenceHours/)
  assert.deepEqual(request, before)
  assert.deepEqual(result.options, before.options)
  assert.equal(result.state.employees[1].minHoursPerWeek, undefined, 'export does not resolve the cached weekly value again')
  assert.deepEqual(result.state.assignments, before.state.assignments)
})

test('invalid numbers and oversized JSON cannot silently produce a changed solver request', () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    const state = fixture()
    state.employees[0].minHoursPerWeek = invalid
    assert.throws(() => createSolverRequest(state, options(), 'invalid'), /无效数字/)
  }
  const request = createSolverRequest(fixture(), options(), 'large')
  assert.throws(() => solverDebugJSON(request, { buildVersion: '字'.repeat(3 * 1024 * 1024) }), /8 MiB/)
  assert.equal(request.requestId, 'large')
})

test('file names distinguish current settings from the attempted request and remove path syntax', () => {
  const request = createSolverRequest(fixture(), options(), 'abc-123')
  assert.equal(solverDebugFileName(request), '排班规则-2026-10-当前设置-abc-123.json')
  assert.equal(solverDebugFileName(request, 'attempt'), '排班规则-2026-10-本次求解-abc-123.json')
  request.requestId = '../../bad\\path:with*characters'
  assert.doesNotMatch(solverDebugFileName(request), /[\\/:*]/)
})
