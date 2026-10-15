import test from 'node:test'
import assert from 'node:assert/strict'
import { configurationFields, latestConfigurationChange, withChangeProvenance, markSchedulesCurrent, parseDataProvenance, MAX_PROVENANCE_BYTES } from '../dataProvenance.ts'
import { backupJSON, parseBackup, loadSaved, saveLocal, STORAGE_KEY } from '../storage.ts'
import { createPayrollConfig } from '../payroll.ts'

const firstTime = '2026-10-15T12:00:00.000Z'
const secondTime = '2026-10-15T12:01:00.000Z'
const thirdTime = '2026-10-15T12:02:00.000Z'
function fixture() {
  return {
    version: 1, teamName: '测试团队', month: '2026-10',
    employees: ['e1', 'e2'].map(id => ({ id, name: id, role: '店员', group: '', color: '#123456', minHoursPerMonth: null, minHoursPerWeek: 0, maxHoursPerWeek: 48, eligibleShiftIds: ['day'], unavailableDates: [] })),
    shifts: [{ id: 'day', name: '白班', shortName: '白', start: '09:00', end: '17:00', color: '#123456', required: 1, normalAllowance: 20 }],
    rules: { minRestHours: 11, maxConsecutiveDays: 5, weekdayWeights: { days: [6, 7], percent: 40 }, separationGroups: [{ id: 'sg1', name: '互斥组', employeeIds: ['e1', 'e2'], shiftIds: [] }], nonConsecutiveShifts: [{ id: 'nc1', shiftId: 'day' }], weeklyShiftLimits: [{ id: 'wl1', shiftId: 'day', maxPerWeek: 3 }] },
    calendar: { '2026-10-01': 'statutory' }, monthlyReferenceHours: { '2026-10': 160 },
    payroll: createPayrollConfig().payroll, assignments: [],
  }
}
function changed(state, update, source, at) {
  const next = structuredClone(state)
  update(next)
  return withChangeProvenance(state, next, source, at)
}
const stamp = (source, at) => ({ source, at })

test('card summaries show the newest saved change even when older backups only contain field stamps', () => {
  const provenance = { fields: {
    'employees.e1.name': stamp('manual', firstTime),
    'employees.e1.role': stamp('http', thirdTime),
    'employees.e1.group': stamp('mcp', secondTime),
    'employees.e1': stamp('manual', firstTime),
  } }
  assert.deepEqual(latestConfigurationChange(provenance, ['employees.e1']), stamp('http', thirdTime))
  delete provenance.fields['employees.e1']
  assert.deepEqual(latestConfigurationChange(provenance, ['employees.e1']), stamp('http', thirdTime))
})

test('card summaries remain empty for untracked cards and exclude sibling IDs and unrelated rule sections', () => {
  const provenance = { fields: {
    'employees.e10.name': stamp('mcp', thirdTime),
    employees: stamp('mcp', thirdTime),
    'rules.minRestHours': stamp('manual', firstTime),
    'rules.maxConsecutiveDays': stamp('http', secondTime),
    'rules.weekdayWeights.percent': stamp('mcp', thirdTime),
  } }
  assert.equal(latestConfigurationChange(undefined, ['employees.e1']), undefined)
  assert.equal(latestConfigurationChange(provenance, ['employees.e1']), undefined)
  assert.equal(latestConfigurationChange(provenance, []), undefined)
  assert.equal(latestConfigurationChange(provenance, ['']), undefined)
  assert.deepEqual(latestConfigurationChange(provenance, ['rules.minRestHours', 'rules.maxConsecutiveDays']), stamp('http', secondTime))
})

test('card summaries retain restore-default and removed-rule history without changing stored field records', () => {
  const tracked = changed(fixture(), next => { delete next.rules.weekdayWeights; delete next.rules.weeklyShiftLimits }, 'http', secondTime)
  const before = structuredClone(tracked.provenance)
  assert.deepEqual(latestConfigurationChange(tracked.provenance, ['rules.weekdayWeights']), stamp('http', secondTime))
  assert.deepEqual(latestConfigurationChange(tracked.provenance, ['rules.weeklyShiftLimits']), stamp('http', secondTime))
  assert.deepEqual(JSON.parse(JSON.stringify(tracked.provenance)), JSON.parse(JSON.stringify(before)))
})

test('configuration fields use stable entity IDs and atomic value arrays', () => {
  const state = fixture()
  state.payroll.employeeSalaries.e1 = 7200
  state.payroll.dateShiftMultipliers = { '2026-10-01': { day: 2 } }
  const fields = configurationFields(state)
  assert.equal(fields['employees.e1.name'], 'e1')
  assert.deepEqual(fields['employees.e1.eligibleShiftIds'], ['day'])
  assert.deepEqual(fields['rules.weekdayWeights.days'], [6, 7])
  assert.equal(fields['rules.weekdayWeights.percent'], 40)
  assert.deepEqual(fields['rules.separationGroups.sg1.employeeIds'], ['e1', 'e2'])
  assert.equal(fields['rules.nonConsecutiveShifts.nc1.shiftId'], 'day')
  assert.equal(fields['rules.weeklyShiftLimits.wl1.maxPerWeek'], 3)
  assert.equal(fields['calendar.2026-10-01'], 'statutory')
  assert.equal(fields['monthlyReferenceHours.2026-10'], 160)
  assert.equal(fields['payroll.employeeSalaries.e1'], 7200)
  assert.equal(fields['payroll.dateShiftMultipliers.2026-10-01.day'], 2)
  assert.ok(!Object.keys(fields).some(path => /(^|\.)(id|version|month|assignments|provenance)(\.|$)/.test(path)))
  assert.ok(!Object.keys(fields).some(path => /\.0(\.|$)/.test(path)))
})

test('each edited field records its own source while parent summaries show the latest edit', () => {
  const original = fixture()
  const manual = changed(original, next => { next.employees[0].name = '手动姓名' }, 'manual', firstTime)
  const external = changed(manual, next => { next.employees[0].maxHoursPerWeek = 40 }, 'mcp', secondTime)
  const http = changed(external, next => { next.employees[1].role = '外部岗位' }, 'http', thirdTime)
  assert.deepEqual(http.provenance.fields['employees.e1.name'], stamp('manual', firstTime))
  assert.deepEqual(http.provenance.fields['employees.e1.maxHoursPerWeek'], stamp('mcp', secondTime))
  assert.deepEqual(http.provenance.fields['employees.e1'], stamp('mcp', secondTime))
  assert.deepEqual(http.provenance.fields['employees.e2.role'], stamp('http', thirdTime))
  assert.deepEqual(http.provenance.fields.employees, stamp('http', thirdTime))
  assert.equal(http.provenance.fields['employees.e1.color'], undefined)
  assert.equal(original.provenance, undefined)
})

test('no-op saves, navigation and entity reordering do not invent configuration history', () => {
  const old = fixture()
  const reordered = structuredClone(old)
  reordered.employees.reverse()
  reordered.month = '2026-11'
  reordered.assignments.push({ employeeId: 'e1', date: '2026-10-15', shiftId: 'day', locked: false })
  const withAssignments = withChangeProvenance(old, reordered, 'mcp', firstTime)
  assert.deepEqual(Object.keys(withAssignments.provenance.fields), [])
  assert.equal(withAssignments.provenance.pendingExternalChange, undefined)
  assert.deepEqual(withAssignments.provenance.scheduleUpdates['2026-10'], stamp('mcp', firstTime))
  const recorded = changed(old, next => { next.rules.weeklyShiftLimits[0].maxPerWeek = 4 }, 'http', firstTime)
  const untouched = withChangeProvenance(recorded, structuredClone(recorded), 'manual', secondTime)
  assert.deepEqual(untouched.provenance, recorded.provenance)
  const sameValues = changed(recorded, next => { next.rules.weekdayWeights.days = [...next.rules.weekdayWeights.days] }, 'mcp', secondTime)
  assert.deepEqual(sameValues.provenance, recorded.provenance)
})

test('submitted provenance cannot erase, overwrite or fabricate trusted local records', () => {
  const original = changed(fixture(), next => { next.employees[0].name = '本人修改' }, 'manual', firstTime)
  const proposed = structuredClone(original)
  proposed.employees[0].maxHoursPerWeek = 32
  proposed.provenance = { fields: { 'employees.e1.name': stamp('http', thirdTime), teamName: stamp('manual', thirdTime) }, pendingExternalChange: { source: 'http', at: thirdTime, categories: ['津贴'] } }
  const applied = withChangeProvenance(original, proposed, 'mcp', secondTime)
  assert.deepEqual(applied.provenance.fields['employees.e1.name'], stamp('manual', firstTime))
  assert.deepEqual(applied.provenance.fields['employees.e1.maxHoursPerWeek'], stamp('mcp', secondTime))
  assert.equal(applied.provenance.fields.teamName, undefined)
  assert.deepEqual(applied.provenance.pendingExternalChange, { source: 'mcp', at: secondTime, categories: ['成员'] })
  const clean = fixture(), forged = structuredClone(clean)
  forged.provenance = proposed.provenance
  assert.equal(withChangeProvenance(clean, forged, 'mcp', firstTime).provenance, undefined)
})

test('deleting fields and entities cleans obsolete stamps and records surviving category summaries', () => {
  let state = changed(fixture(), next => { next.employees[1].role = '后来删除'; next.rules.weeklyShiftLimits[0].maxPerWeek = 4 }, 'mcp', firstTime)
  state = changed(state, next => { next.employees.pop(); next.rules.separationGroups = []; delete next.rules.weeklyShiftLimits }, 'manual', secondTime)
  assert.ok(!Object.keys(state.provenance.fields).some(path => path === 'employees.e2' || path.startsWith('employees.e2.') || path.startsWith('rules.weeklyShiftLimits.')))
  assert.deepEqual(state.provenance.fields['rules.weeklyShiftLimits'], stamp('manual', secondTime))
  assert.deepEqual(state.provenance.fields.employees, stamp('manual', secondTime))
  assert.deepEqual(state.provenance.fields.rules, stamp('manual', secondTime))
  assert.deepEqual(state.provenance.pendingExternalChange, { source: 'mcp', at: firstTime, categories: ['成员', '排班规则'] })
  assert.doesNotThrow(() => backupJSON(state))
})

test('empty optional collection removal retains reset summary without changing its timestamp', () => {
  const removed = changed(fixture(), next => { next.rules.weeklyShiftLimits = [] }, 'mcp', firstTime)
  const absent = changed(removed, next => { delete next.rules.weeklyShiftLimits }, 'manual', secondTime)
  assert.deepEqual(absent.provenance.fields['rules.weeklyShiftLimits'], stamp('mcp', firstTime))
  assert.deepEqual(absent.provenance.fields.rules, stamp('mcp', firstTime))
  assert.doesNotThrow(() => backupJSON(absent))
})

test('restore-default edits retain exact field sources across backup, save and restart', () => {
  const configured = fixture()
  configured.employees[0].avatar = 'data:image/jpeg;base64,' + Buffer.from([255, 216, 255, 224, 1, 2, 3, 255, 217]).toString('base64')
  configured.shifts[0].staffingMode = 'fixed'
  const reset = changed(configured, next => {
    delete next.employees[0].avatar
    delete next.shifts[0].staffingMode
    delete next.shifts[0].normalAllowance
    delete next.rules.weekdayWeights
    delete next.rules.separationGroups
    delete next.rules.nonConsecutiveShifts
    delete next.rules.weeklyShiftLimits
    delete next.calendar
    delete next.monthlyReferenceHours
  }, 'http', firstTime)
  for (const path of ['employees.e1.avatar', 'shifts.day.staffingMode', 'shifts.day.normalAllowance', 'rules.weekdayWeights', 'rules.separationGroups', 'rules.nonConsecutiveShifts', 'rules.weeklyShiftLimits', 'calendar.2026-10-01', 'monthlyReferenceHours.2026-10']) {
    assert.deepEqual(reset.provenance.fields[path], stamp('http', firstTime), path)
  }
  assert.ok(!Object.keys(reset.provenance.fields).some(path => path.startsWith('rules.weekdayWeights.') || path.startsWith('rules.separationGroups.') || path.startsWith('rules.nonConsecutiveShifts.') || path.startsWith('rules.weeklyShiftLimits.')))
  assert.deepEqual(parseBackup(backupJSON(reset)).provenance, reset.provenance)
  const savedStorage = globalThis.localStorage, memory = new Map()
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) }
  try {
    saveLocal(reset)
    const restarted = loadSaved()
    assert.deepEqual(restarted.provenance, reset.provenance)
    assert.deepEqual(withChangeProvenance(restarted, structuredClone(restarted), 'manual', secondTime).provenance, reset.provenance)
    const edited = changed(restarted, next => { next.teamName = '其他手动编辑' }, 'manual', secondTime)
    assert.deepEqual(edited.provenance.fields['shifts.day.normalAllowance'], stamp('http', firstTime))
    assert.deepEqual(edited.provenance.fields['rules.weekdayWeights'], stamp('http', firstTime))
  } finally {
    if (savedStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = savedStorage
  }
})

test('reset markers are removed when their employee or shift entity is deleted', () => {
  const configured = fixture()
  configured.employees[0].avatar = null
  configured.shifts[0].staffingMode = 'fixed'
  const reset = changed(configured, next => { delete next.employees[0].avatar; delete next.shifts[0].staffingMode; delete next.shifts[0].normalAllowance }, 'mcp', firstTime)
  const removed = changed(reset, next => {
    next.employees.shift()
    next.shifts = []
    next.employees.forEach(employee => { employee.eligibleShiftIds = [] })
    next.rules.separationGroups = []
    next.rules.nonConsecutiveShifts = []
    next.rules.weeklyShiftLimits = []
  }, 'manual', secondTime)
  assert.ok(!Object.keys(removed.provenance.fields).some(path => path === 'employees.e1' || path.startsWith('employees.e1.') || path === 'shifts.day' || path.startsWith('shifts.day.')))
  assert.deepEqual(removed.provenance.fields.employees, stamp('manual', secondTime))
  assert.deepEqual(removed.provenance.fields.shifts, stamp('manual', secondTime))
  assert.doesNotThrow(() => backupJSON(removed))
})

test('persisted reset markers permit only known options, real dates, months and existing entities', () => {
  for (const path of ['calendar.2026-02-30', 'calendar.0000-01-01', 'calendar.2026-2-01', 'monthlyReferenceHours.2026-13', 'monthlyReferenceHours.0000-01', 'employees.missing.avatar', 'shifts.missing.staffingMode', 'shifts.missing.normalAllowance', 'rules.weekdayWeights.days', 'rules.weekdayWeights.percent', 'rules.separationGroups.missing', 'rules.nonConsecutiveShifts.missing.shiftId', 'rules.weeklyShiftLimits.missing.maxPerWeek']) {
    const state = fixture()
    delete state.rules.weekdayWeights
    state.provenance = { fields: { [path]: stamp('mcp', firstTime) } }
    assert.throws(() => parseBackup(JSON.stringify(state)), /配置修改来源字段路径无效/, path)
  }
  const state = fixture()
  state.provenance = { fields: { 'calendar.2028-02-29': stamp('mcp', firstTime), 'monthlyReferenceHours.2028-02': stamp('manual', secondTime) } }
  assert.deepEqual(parseBackup(backupJSON(state)).provenance.fields, Object.assign(Object.create(null), state.provenance.fields))
})

test('external categories accumulate until acknowledged and later manual edits preserve the notice', () => {
  const mcp = changed(fixture(), next => { next.rules.minRestHours = 12; next.shifts[0].normalAllowance = 35 }, 'mcp', firstTime)
  const http = changed(mcp, next => { next.calendar['2026-10-02'] = 'workday'; next.employees[0].name = '外部姓名' }, 'http', secondTime)
  assert.deepEqual(http.provenance.pendingExternalChange, { source: 'http', at: secondTime, categories: ['成员', '排班规则', '日期设置', '津贴'] })
  const manual = changed(http, next => { next.teamName = '新团队名称' }, 'manual', thirdTime)
  assert.deepEqual(manual.provenance.pendingExternalChange, http.provenance.pendingExternalChange)
  assert.deepEqual(manual.provenance.fields.teamName, stamp('manual', thirdTime))
})

test('legacy backups remain untracked and metadata survives export, local saving and restart', () => {
  const old = fixture()
  assert.equal(parseBackup(backupJSON(old)).provenance, undefined)
  const tracked = changed(old, next => { next.rules.weekdayWeights.percent = 50; next.payroll.monthlySalary = 7200 }, 'http', firstTime)
  const restored = parseBackup(backupJSON(tracked))
  assert.deepEqual(restored.provenance, tracked.provenance)
  const savedStorage = globalThis.localStorage
  const memory = new Map()
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) }
  try {
    saveLocal(tracked)
    assert.ok(memory.has(STORAGE_KEY))
    assert.deepEqual(loadSaved().provenance, tracked.provenance)
  } finally {
    if (savedStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = savedStorage
  }
})

test('metadata validation rejects unsafe paths, invalid times, sources and oversized records', () => {
  for (const provenance of [
    null, [], { fields: null },
    { fields: { teamName: { source: 'ai', at: firstTime } } },
    { fields: { teamName: { source: 'manual', at: '2026-02-30T12:00:00.000Z' } } },
    { fields: { teamName: { source: 'manual', at: '2026-10-15' } } },
    { fields: { teamName: { source: 'manual', at: firstTime, extra: true } } },
    { fields: { 'employees.missing.name': stamp('mcp', firstTime) } },
    { fields: { assignments: stamp('mcp', firstTime) } },
    { fields: { 'rules.__proto__.polluted': stamp('mcp', firstTime) } },
    { fields: JSON.parse('{"__proto__":{"source":"mcp","at":"2026-10-15T12:00:00.000Z"}}') },
    { fields: {}, pendingExternalChange: { source: 'manual', at: firstTime, categories: ['成员'] } },
    { fields: {}, pendingExternalChange: { source: 'mcp', at: firstTime, categories: ['不存在'] } },
    { fields: {}, pendingExternalChange: { source: 'mcp', at: firstTime, categories: ['成员', '成员'] } },
    { fields: {}, pendingExternalChange: { source: 'mcp', at: firstTime, categories: [] } },
  ]) {
    const state = fixture(); state.provenance = provenance
    assert.throws(() => parseBackup(JSON.stringify(state)), /配置修改来源/)
  }
  assert.equal({}.polluted, undefined)
  assert.throws(() => parseDataProvenance({ fields: { teamName: { source: 'manual', at: 'x'.repeat(MAX_PROVENANCE_BYTES) } } }, fixture()), /超过 4 MB/)
})

test('constructor-like entity IDs stay harmless flat keys throughout tracking and backup', () => {
  const state = fixture()
  state.employees[0].id = '__proto__'
  state.rules.separationGroups[0].employeeIds[0] = '__proto__'
  const tracked = changed(state, next => { next.employees[0].name = '安全字段' }, 'mcp', firstTime)
  const restored = parseBackup(backupJSON(tracked))
  assert.deepEqual(restored.provenance.fields['employees.__proto__.name'], stamp('mcp', firstTime))
  assert.equal(Object.getPrototypeOf(restored.provenance.fields), null)
  assert.equal({}.polluted, undefined)
})

const assignment = (date, employeeId = 'e1', shiftId = 'day', locked = false) => ({ employeeId, date, shiftId, locked })

test('external schedule timestamps track only changed assignment months and the accepted source', () => {
  const initial = changed(fixture(), next => {
    next.assignments = [assignment('2026-09-30'), assignment('2026-10-15'), assignment('2026-11-01')]
  }, 'mcp', firstTime)
  assert.deepEqual(Object.keys(initial.provenance.scheduleUpdates).sort(), ['2026-09', '2026-10', '2026-11'])
  const updated = changed(initial, next => {
    next.month = '2026-12'
    next.assignments[0].locked = true
    next.assignments[1].shiftId = 'off'
  }, 'http', secondTime)
  assert.deepEqual(updated.provenance.scheduleUpdates['2026-09'], stamp('http', secondTime))
  assert.deepEqual(updated.provenance.scheduleUpdates['2026-10'], stamp('http', secondTime))
  assert.deepEqual(updated.provenance.scheduleUpdates['2026-11'], stamp('mcp', firstTime))
  assert.equal(updated.provenance.scheduleUpdates['2026-12'], undefined)
  assert.deepEqual(Object.keys(updated.provenance.fields), [])
  assert.equal(updated.provenance.pendingExternalChange, undefined)
  assert.deepEqual(initial.provenance.scheduleUpdates['2026-10'], stamp('mcp', firstTime))
})

test('schedule no-ops ignore assignment array and object key ordering', () => {
  const initial = changed(fixture(), next => {
    next.assignments = [assignment('2026-10-15'), assignment('2026-10-16', 'e2', 'off', true)]
  }, 'mcp', firstTime)
  const reordered = changed(initial, next => {
    next.assignments = next.assignments.toReversed().map(item => ({ locked: item.locked, shiftId: item.shiftId, date: item.date, employeeId: item.employeeId }))
  }, 'http', secondTime)
  assert.deepEqual(reordered.provenance, initial.provenance)
  assert.deepEqual(withChangeProvenance(reordered, structuredClone(reordered), 'mcp', thirdTime).provenance, initial.provenance)
})

test('configuration edits and manual assignment edits never change external schedule update times', () => {
  const initial = changed(fixture(), next => { next.assignments = [assignment('2026-10-15')] }, 'http', firstTime)
  const configOnly = changed(initial, next => { next.rules.minRestHours = 12 }, 'mcp', secondTime)
  assert.deepEqual(configOnly.provenance.scheduleUpdates, initial.provenance.scheduleUpdates)
  assert.deepEqual(configOnly.provenance.fields['rules.minRestHours'], stamp('mcp', secondTime))
  const manual = changed(configOnly, next => { next.assignments = [assignment('2026-11-01', 'e2', 'off', true)] }, 'manual', thirdTime)
  assert.deepEqual(manual.provenance.scheduleUpdates, initial.provenance.scheduleUpdates)
  assert.equal(manual.provenance.scheduleUpdates['2026-11'], undefined)
  const watcherSnapshot = { ...manual, assignments: [] }
  assert.deepEqual(withChangeProvenance(watcherSnapshot, manual, 'manual', thirdTime).provenance.scheduleUpdates, initial.provenance.scheduleUpdates)
  const untracked = fixture()
  untracked.assignments = [assignment('2026-10-15')]
  assert.equal(withChangeProvenance({ ...untracked, assignments: [] }, untracked, 'manual', thirdTime).provenance, undefined)
  assert.equal(changed(fixture(), next => { next.rules.minRestHours = 12 }, 'mcp', firstTime).provenance.scheduleUpdates, undefined)
})

test('deletion, clearing, employee replacement and cross-month moves update affected schedule months', () => {
  const initial = changed(fixture(), next => {
    next.assignments = [assignment('2026-09-30'), assignment('2026-10-15'), assignment('2026-11-01')]
  }, 'mcp', firstTime)
  const deleted = changed(initial, next => { next.assignments.splice(1, 1) }, 'http', secondTime)
  assert.deepEqual(deleted.provenance.scheduleUpdates['2026-10'], stamp('http', secondTime))
  assert.deepEqual(deleted.provenance.scheduleUpdates['2026-09'], stamp('mcp', firstTime))
  const cleared = changed(deleted, next => { next.assignments = [] }, 'mcp', thirdTime)
  assert.deepEqual(cleared.provenance.scheduleUpdates['2026-09'], stamp('mcp', thirdTime))
  assert.deepEqual(cleared.provenance.scheduleUpdates['2026-11'], stamp('mcp', thirdTime))
  assert.deepEqual(cleared.provenance.scheduleUpdates['2026-10'], stamp('http', secondTime))
  const moved = changed(initial, next => { next.assignments[1].date = '2026-12-15'; next.assignments[0].employeeId = 'e2' }, 'http', secondTime)
  for (const month of ['2026-09', '2026-10', '2026-12']) assert.deepEqual(moved.provenance.scheduleUpdates[month], stamp('http', secondTime))
  assert.deepEqual(moved.provenance.scheduleUpdates['2026-11'], stamp('mcp', firstTime))
})

test('submitted schedule update metadata cannot spoof, clear or invent acceptance times', () => {
  const initial = changed(fixture(), next => { next.assignments = [assignment('2026-09-30'), assignment('2026-10-15')] }, 'mcp', firstTime)
  const forged = structuredClone(initial)
  forged.provenance = { fields: {}, scheduleUpdates: { '2026-09': stamp('http', thirdTime), '2099-01': stamp('mcp', thirdTime) } }
  assert.deepEqual(withChangeProvenance(initial, forged, 'http', secondTime).provenance.scheduleUpdates, initial.provenance.scheduleUpdates)
  forged.assignments[1].locked = true
  const applied = withChangeProvenance(initial, forged, 'http', secondTime)
  assert.deepEqual(applied.provenance.scheduleUpdates['2026-09'], stamp('mcp', firstTime))
  assert.deepEqual(applied.provenance.scheduleUpdates['2026-10'], stamp('http', secondTime))
  assert.equal(applied.provenance.scheduleUpdates['2099-01'], undefined)
  const noHistory = fixture(), fakeOnly = structuredClone(noHistory)
  fakeOnly.provenance = forged.provenance
  assert.equal(withChangeProvenance(noHistory, fakeOnly, 'mcp', secondTime).provenance, undefined)
})

test('schedule update history validates months, external sources, timestamps and its size limit', () => {
  for (const updates of [
    null, [],
    { '0000-01': stamp('mcp', firstTime) }, { '2026-13': stamp('mcp', firstTime) }, { '2026-1': stamp('mcp', firstTime) },
    JSON.parse('{"__proto__":{"source":"mcp","at":"2026-10-15T12:00:00.000Z"}}'),
    { '2026-10': null }, { '2026-10': { source: 'manual', at: firstTime } }, { '2026-10': { source: 'MCP', at: firstTime } },
    { '2026-10': { source: 'http', at: '2026-02-30T12:00:00.000Z' } },
    { '2026-10': { source: 'http', at: '2026-10-15' } }, { '2026-10': { source: 'http', at: firstTime, forged: true } },
  ]) {
    const state = fixture()
    state.provenance = { fields: {}, scheduleUpdates: updates }
    assert.throws(() => parseBackup(JSON.stringify(state)), /配置修改来源/)
  }
  const state = fixture()
  state.provenance = { fields: {}, scheduleUpdates: Object.fromEntries(Array.from({ length: 1200 }, (_, index) => [`${2000 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`, stamp('mcp', firstTime)])) }
  assert.equal(Object.keys(parseBackup(backupJSON(state)).provenance.scheduleUpdates).length, 1200)
  state.provenance.scheduleUpdates['2100-01'] = stamp('http', secondTime)
  assert.throws(() => parseBackup(JSON.stringify(state)), /最多保存 1200 个月/)
})

test('schedule acceptance history survives backup and local restart independently of configuration notices', () => {
  const configured = changed(fixture(), next => { next.rules.minRestHours = 12 }, 'mcp', firstTime)
  const scheduled = changed(configured, next => { next.assignments = [assignment('2026-10-15')] }, 'http', secondTime)
  const state = changed(scheduled, next => { next.teamName = '手动名称' }, 'manual', thirdTime)
  assert.deepEqual(state.provenance.pendingExternalChange, { source: 'mcp', at: firstTime, categories: ['排班规则'] })
  assert.deepEqual(state.provenance.scheduleUpdates['2026-10'], stamp('http', secondTime))
  assert.deepEqual(parseBackup(backupJSON(state)).provenance, state.provenance)
  const savedStorage = globalThis.localStorage, memory = new Map()
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) }
  try {
    saveLocal(state)
    assert.deepEqual(loadSaved().provenance, state.provenance)
  } finally {
    if (savedStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = savedStorage
  }
  assert.equal(parseBackup(backupJSON(fixture())).provenance?.scheduleUpdates, undefined)
})

function scheduledFixture() {
  const state = fixture()
  state.assignments = [assignment('2026-10-15'), assignment('2026-11-01', 'e2', 'off', true)]
  return state
}

test('each scheduling configuration category invalidates every populated month with the trusted source and time', () => {
  const updates = [
    next => { next.employees[0].name = '修改成员' },
    next => { next.shifts[0].start = '08:00' },
    next => { next.rules.minRestHours = 12 },
    next => { next.calendar['2027-01-01'] = 'workday' },
    next => { next.monthlyReferenceHours['2027-01'] = 176 },
  ]
  for (const source of ['manual', 'mcp', 'http']) {
    for (const update of updates) {
      const before = scheduledFixture()
      const result = changed(before, next => { update(next); next.month = '2026-12' }, source, secondTime)
      assert.deepEqual(Object.keys(result.provenance.invalidatedSchedules).sort(), ['2026-10', '2026-11'])
      assert.deepEqual(result.provenance.invalidatedSchedules['2026-10'], stamp(source, secondTime))
      assert.deepEqual(result.provenance.invalidatedSchedules['2026-11'], stamp(source, secondTime), 'off-only months also contain a saved schedule')
      assert.equal(result.provenance.invalidatedSchedules['2026-12'], undefined, 'viewed empty month is not marked')
      assert.equal(result.provenance.invalidatedSchedules['2027-01'], undefined, 'calendar/reference entry alone is not a schedule')
      assert.equal(result.provenance.scheduleUpdates, undefined, 'configuration edits do not change external generation history')
      assert.equal(before.provenance, undefined)
    }
  }
})

test('team names, payroll, navigation, reordering and pure assignment changes never create invalidations', () => {
  const updates = [
    next => { next.teamName = '新团队名称' },
    next => { next.payroll.monthlySalary = 8000 },
    next => { next.month = '2026-12' },
    next => { next.employees.reverse(); next.assignments.reverse() },
    next => { next.assignments[0].locked = true },
    next => { next.assignments.push(assignment('2026-12-01')) },
    next => { next.provenance = { fields: {}, invalidatedSchedules: { '2026-10': stamp('mcp', firstTime) } } },
  ]
  for (const source of ['manual', 'mcp', 'http']) {
    for (const update of updates) {
      const result = changed(scheduledFixture(), update, source, secondTime)
      assert.equal(result.provenance?.invalidatedSchedules, undefined)
    }
  }
  assert.equal(changed(fixture(), next => { next.rules.minRestHours = 12 }, 'mcp', firstTime).provenance.invalidatedSchedules, undefined, 'configuration changes without assignments have nothing to invalidate')
})

test('new configuration edits replace invalidation timestamps while assignment edits and no-ops preserve them', () => {
  const invalid = changed(scheduledFixture(), next => { next.rules.minRestHours = 12 }, 'mcp', firstTime)
  const edited = changed(invalid, next => {
    next.assignments[0].locked = true
    next.assignments.push(assignment('2026-12-01'))
  }, 'http', secondTime)
  assert.deepEqual(edited.provenance.invalidatedSchedules, invalid.provenance.invalidatedSchedules)
  assert.equal(edited.provenance.invalidatedSchedules['2026-12'], undefined, 'a later assignment write does not inherit old invalidation')
  assert.deepEqual(edited.provenance.scheduleUpdates['2026-10'], stamp('http', secondTime))
  const noOp = withChangeProvenance(edited, structuredClone(edited), 'manual', thirdTime)
  assert.deepEqual(noOp.provenance.invalidatedSchedules, invalid.provenance.invalidatedSchedules)
  const reconfigured = changed(edited, next => { next.employees[0].maxHoursPerWeek = 40 }, 'manual', thirdTime)
  for (const month of ['2026-10', '2026-11', '2026-12']) assert.deepEqual(reconfigured.provenance.invalidatedSchedules[month], stamp('manual', thirdTime))
  assert.deepEqual(invalid.provenance.invalidatedSchedules['2026-10'], stamp('mcp', firstTime))
})

test('configuration watchers with intentionally empty previous assignments still mark and retain all current months', () => {
  const initial = scheduledFixture()
  const next = structuredClone(initial)
  next.rules.minRestHours = 12
  const marked = withChangeProvenance({ ...initial, assignments: [] }, next, 'manual', firstTime)
  assert.deepEqual(Object.keys(marked.provenance.invalidatedSchedules), ['2026-10', '2026-11'])
  const unchanged = withChangeProvenance({ ...marked, assignments: [] }, structuredClone(marked), 'manual', secondTime)
  assert.deepEqual(unchanged.provenance.invalidatedSchedules, marked.provenance.invalidatedSchedules)
  assert.equal(unchanged.provenance.scheduleUpdates, undefined)
})

test('invalidation records disappear only for months with no remaining assignments, including during pure clearing', () => {
  const initial = scheduledFixture()
  initial.assignments.push(assignment('2026-10-16', 'e2', 'off'))
  const invalid = changed(initial, next => { next.rules.minRestHours = 12 }, 'mcp', firstTime)
  const partlyCleared = changed(invalid, next => { next.assignments.shift() }, 'manual', secondTime)
  assert.deepEqual(partlyCleared.provenance.invalidatedSchedules, invalid.provenance.invalidatedSchedules, 'an off record keeps the month populated')
  const monthCleared = changed(partlyCleared, next => { next.assignments = next.assignments.filter(item => item.date.startsWith('2026-11')) }, 'http', secondTime)
  assert.deepEqual(Object.keys(monthCleared.provenance.invalidatedSchedules), ['2026-11'])
  assert.deepEqual(monthCleared.provenance.invalidatedSchedules['2026-11'], stamp('mcp', firstTime))
  const allCleared = changed(monthCleared, next => { next.assignments = [] }, 'manual', thirdTime)
  assert.equal(Object.hasOwn(allCleared.provenance, 'invalidatedSchedules'), false)
  assert.deepEqual(allCleared.provenance.fields, invalid.provenance.fields)
  assert.deepEqual(allCleared.provenance.pendingExternalChange, invalid.provenance.pendingExternalChange)
  assert.deepEqual(allCleared.provenance.scheduleUpdates, monthCleared.provenance.scheduleUpdates)
  const staleHistory = structuredClone(invalid)
  staleHistory.provenance.invalidatedSchedules['2020-01'] = stamp('http', secondTime)
  assert.equal(withChangeProvenance(staleHistory, structuredClone(staleHistory), 'manual', thirdTime).provenance.invalidatedSchedules['2020-01'], undefined, 'stale persisted months are pruned even on no-op calls')
})

test('submitted metadata cannot clear, forge or redate trusted schedule invalidations', () => {
  const invalid = changed(scheduledFixture(), next => { next.rules.minRestHours = 12 }, 'manual', firstTime)
  for (const history of [undefined, { fields: {} }, { fields: {}, invalidatedSchedules: { '2026-10': stamp('http', thirdTime), '2099-01': stamp('mcp', thirdTime) } }]) {
    const proposed = structuredClone(invalid)
    proposed.provenance = history
    const applied = withChangeProvenance(invalid, proposed, 'mcp', secondTime)
    assert.deepEqual(applied.provenance.invalidatedSchedules, invalid.provenance.invalidatedSchedules)
    proposed.employees[0].maxHoursPerWeek = 40
    const modified = withChangeProvenance(invalid, proposed, 'mcp', secondTime)
    assert.deepEqual(modified.provenance.invalidatedSchedules['2026-10'], stamp('mcp', secondTime))
    assert.deepEqual(modified.provenance.invalidatedSchedules['2026-11'], stamp('mcp', secondTime))
    assert.equal(modified.provenance.invalidatedSchedules['2099-01'], undefined)
  }
  const clean = scheduledFixture(), forged = structuredClone(clean)
  forged.provenance = invalid.provenance
  assert.equal(withChangeProvenance(clean, forged, 'http', secondTime).provenance, undefined)
})

test('successful-generation acknowledgement clears only named months without mutating any existing history', () => {
  const external = changed(fixture(), next => { next.assignments = scheduledFixture().assignments }, 'http', firstTime)
  const invalid = changed(external, next => { next.rules.minRestHours = 12 }, 'mcp', secondTime)
  invalid.extraClientField = { preserved: true }
  const before = JSON.stringify(invalid)
  const current = markSchedulesCurrent(invalid, ['2026-10', '2026-10', '2099-01'])
  assert.notEqual(current, invalid)
  assert.deepEqual(Object.keys(current.provenance.invalidatedSchedules), ['2026-11'])
  assert.deepEqual(current.provenance.invalidatedSchedules['2026-11'], stamp('mcp', secondTime))
  assert.equal(current.assignments, invalid.assignments)
  assert.equal(current.extraClientField, invalid.extraClientField)
  assert.deepEqual(current.provenance.fields, invalid.provenance.fields)
  assert.deepEqual(current.provenance.pendingExternalChange, invalid.provenance.pendingExternalChange)
  assert.deepEqual(current.provenance.scheduleUpdates, invalid.provenance.scheduleUpdates)
  const allCurrent = markSchedulesCurrent(current, ['2026-11'])
  assert.equal(Object.hasOwn(allCurrent.provenance, 'invalidatedSchedules'), false)
  assert.deepEqual(allCurrent.provenance.scheduleUpdates, invalid.provenance.scheduleUpdates)
  assert.equal(JSON.stringify(invalid), before)
  assert.doesNotThrow(() => backupJSON(allCurrent))
})

test('acknowledgement returns the original document when no matching invalidation exists', () => {
  const clean = fixture()
  assert.equal(markSchedulesCurrent(clean, ['2026-10']), clean)
  assert.equal(clean.provenance, undefined)
  const empty = { ...clean, provenance: { fields: {}, invalidatedSchedules: {} } }
  assert.equal(markSchedulesCurrent(empty, ['2026-10']), empty)
  const invalid = changed(scheduledFixture(), next => { next.rules.minRestHours = 12 }, 'manual', firstTime)
  assert.equal(markSchedulesCurrent(invalid, []), invalid)
  assert.equal(markSchedulesCurrent(invalid, ['2026-12']), invalid)
  assert.equal(markSchedulesCurrent(invalid, ['__proto__', 'constructor']), invalid)
})

test('invalidation metadata survives backup and local restart together with external generation history', () => {
  const external = changed(fixture(), next => { next.assignments = scheduledFixture().assignments }, 'http', firstTime)
  const invalid = changed(external, next => { next.rules.minRestHours = 12 }, 'manual', secondTime)
  assert.deepEqual(parseBackup(backupJSON(invalid)).provenance, invalid.provenance)
  const savedStorage = globalThis.localStorage, memory = new Map()
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) }
  try {
    saveLocal(invalid)
    const restored = loadSaved()
    assert.deepEqual(restored.provenance, invalid.provenance)
    assert.deepEqual(withChangeProvenance(restored, structuredClone(restored), 'manual', thirdTime).provenance, invalid.provenance)
  } finally {
    if (savedStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = savedStorage
  }
  assert.equal(parseBackup(backupJSON(fixture())).provenance?.invalidatedSchedules, undefined)
  assert.equal(parseDataProvenance({ fields: {}, invalidatedSchedules: {} }, fixture()).invalidatedSchedules, undefined)
})

test('invalidated schedule metadata strictly validates month keys, stamps, sources, times and count', () => {
  for (const invalidated of [
    null, [], 'months',
    { '0000-01': stamp('mcp', firstTime) }, { '2026-13': stamp('mcp', firstTime) }, { '2026-1': stamp('mcp', firstTime) },
    JSON.parse('{"__proto__":{"source":"mcp","at":"2026-10-15T12:00:00.000Z"}}'),
    { '2026-10': null }, { '2026-10': [] }, { '2026-10': { source: 'ai', at: firstTime } }, { '2026-10': { source: 'MCP', at: firstTime } },
    { '2026-10': { source: 'http', at: '2026-02-30T12:00:00.000Z' } }, { '2026-10': { source: 'manual', at: '2026-10-15' } },
    { '2026-10': { source: 'manual', at: '2026-10-15T12:00:00Z' } },
    { '2026-10': { source: 'http', at: firstTime, forged: true } }, { '2026-10': { source: 'mcp' } },
  ]) {
    const state = fixture()
    state.provenance = { fields: {}, invalidatedSchedules: invalidated }
    assert.throws(() => parseBackup(JSON.stringify(state)), /配置修改来源/)
  }
  const state = fixture()
  state.provenance = { fields: {}, invalidatedSchedules: Object.fromEntries(Array.from({ length: 1200 }, (_, index) => [
    `${2000 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`,
    stamp(['manual', 'mcp', 'http'][index % 3], firstTime),
  ])) }
  const parsed = parseBackup(backupJSON(state)).provenance.invalidatedSchedules
  assert.equal(Object.keys(parsed).length, 1200)
  assert.equal(Object.getPrototypeOf(parsed), null)
  state.provenance.invalidatedSchedules['2100-01'] = stamp('http', secondTime)
  assert.throws(() => parseBackup(JSON.stringify(state)), /最多保存 1200 个月/)
})
