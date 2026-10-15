import test from 'node:test'
import assert from 'node:assert/strict'
import { clearScheduleCoverage, isScheduleDateKnown, markScheduleCoverageComplete, pruneScheduleCoverage } from '../scheduleCoverage.ts'
import { backupJSON, loadSaved, parseBackup, saveLocal } from '../storage.ts'
import { configurationFields, withChangeProvenance } from '../dataProvenance.ts'

const firstTime = '2026-10-15T12:00:00.000Z'
const secondTime = '2026-10-15T12:01:00.000Z'
const plain = value => JSON.parse(JSON.stringify(value))
function fixture() {
  return {
    version: 1, teamName: '完整性测试', month: '2026-10',
    employees: ['a', 'b'].map(id => ({ id, name: id, role: '', group: '', color: '#123456', minHoursPerWeek: 0, maxHoursPerWeek: 48, eligibleShiftIds: ['day'], unavailableDates: [] })),
    shifts: [{ id: 'day', name: '白班', shortName: '白', start: '08:00', end: '16:00', color: '#123456', required: 0 }],
    rules: { minRestHours: 11, maxConsecutiveDays: 5 },
    assignments: [
      { employeeId: 'a', date: '2026-09-30', shiftId: 'day', locked: true },
      { employeeId: 'b', date: '2026-09-30', shiftId: 'off', locked: false },
    ],
  }
}

test('legacy work and off records confirm only their own dates, never a whole month', () => {
  const state = parseBackup(backupJSON(fixture()))
  assert.equal(Object.hasOwn(state, 'scheduleCoverage'), false)
  assert.equal(isScheduleDateKnown(state, 'a', '2026-09-30'), true)
  assert.equal(isScheduleDateKnown(state, 'b', '2026-09-30'), true)
  for (const [id, date] of [['a', '2026-09-29'], ['b', '2026-10-01'], ['missing', '2026-09-30'], ['a', '2026-02-30']]) {
    assert.equal(isScheduleDateKnown(state, id, date), false)
  }
})

test('completed months confirm blanks for current members and retain all-rest months after backup and restart', t => {
  const before = fixture()
  before.assignments = []
  const original = structuredClone(before)
  const completed = markScheduleCoverageComplete(before, ['2026-09', '2026-10'])
  assert.deepEqual(plain(completed.scheduleCoverage), {
    '2026-09': { employeeIds: ['a', 'b'] }, '2026-10': { employeeIds: ['a', 'b'] },
  })
  for (const id of ['a', 'b']) for (const date of ['2026-09-01', '2026-09-30', '2026-10-01', '2026-10-31']) {
    assert.equal(isScheduleDateKnown(completed, id, date), true)
  }
  assert.equal(isScheduleDateKnown(completed, 'a', '2026-11-01'), false)
  assert.strictEqual(markScheduleCoverageComplete(completed, ['2026-10', '2026-10']), completed)
  assert.deepEqual(parseBackup(backupJSON(completed)), completed)
  const memory = new Map(), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) } })
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage })
  saveLocal(completed)
  assert.deepEqual(loadSaved(), completed)
  assert.deepEqual(before, original)
})

test('added members stay unknown until their month is completed again, and reordering does not change coverage', () => {
  const completed = markScheduleCoverageComplete(fixture(), ['2026-09'])
  const expanded = { ...completed, employees: [...completed.employees, { ...completed.employees[0], id: 'c', name: 'c' }] }
  assert.equal(isScheduleDateKnown(expanded, 'a', '2026-09-29'), true)
  assert.equal(isScheduleDateKnown(expanded, 'c', '2026-09-29'), false)
  const refreshed = markScheduleCoverageComplete(expanded, ['2026-09'])
  assert.equal(isScheduleDateKnown(refreshed, 'c', '2026-09-29'), true)
  assert.deepEqual(completed.scheduleCoverage['2026-09'].employeeIds, ['a', 'b'])
  const reordered = { ...refreshed, employees: [...refreshed.employees].reverse() }
  assert.strictEqual(markScheduleCoverageComplete(reordered, ['2026-09']), reordered)
})

test('employee removal prunes only deleted IDs without relying on assignment presence or mutating old metadata', () => {
  const completed = markScheduleCoverageComplete(fixture(), ['2026-09', '2026-10'])
  Object.freeze(completed.scheduleCoverage['2026-09'].employeeIds)
  Object.freeze(completed.scheduleCoverage['2026-10'].employeeIds)
  Object.freeze(completed.scheduleCoverage)
  const removed = { ...completed, employees: [completed.employees[0]], assignments: [completed.assignments[0]] }
  const pruned = pruneScheduleCoverage(removed)
  assert.deepEqual(parseBackup(backupJSON(removed)), pruned, 'saving directly after deletion normalizes dangling coverage IDs')
  assert.deepEqual(plain(pruned.scheduleCoverage), { '2026-09': { employeeIds: ['a'] }, '2026-10': { employeeIds: ['a'] } })
  assert.equal(isScheduleDateKnown(pruned, 'a', '2026-10-15'), true, 'a complete all-rest month must survive')
  assert.equal(isScheduleDateKnown(pruned, 'b', '2026-09-30'), false)
  assert.strictEqual(pruneScheduleCoverage(pruned), pruned)
  assert.deepEqual(completed.scheduleCoverage['2026-09'].employeeIds, ['a', 'b'])
  const empty = pruneScheduleCoverage({ ...pruned, employees: [], assignments: [] })
  assert.equal(Object.hasOwn(empty, 'scheduleCoverage'), false)
  assert.doesNotThrow(() => backupJSON(pruned))
})

test('clearing selected months revokes blank-date knowledge while preserving other months and explicit records', () => {
  const completed = markScheduleCoverageComplete(fixture(), ['2026-09', '2026-10'])
  assert.strictEqual(clearScheduleCoverage(completed, ['2025-01']), completed)
  const cleared = clearScheduleCoverage(completed, ['2026-09'])
  assert.equal(isScheduleDateKnown(cleared, 'a', '2026-09-29'), false)
  assert.equal(isScheduleDateKnown(cleared, 'a', '2026-09-30'), true, 'the caller separately deletes the month assignments')
  assert.equal(isScheduleDateKnown(cleared, 'b', '2026-10-15'), true)
  assert.strictEqual(cleared.assignments, completed.assignments)
  assert.equal(Object.hasOwn(clearScheduleCoverage(cleared, ['2026-10']), 'scheduleCoverage'), false)
  assert.deepEqual(completed.scheduleCoverage['2026-09'].employeeIds, ['a', 'b'])
})

test('coverage changes are metadata, preserving configuration stamps, invalidations, updates and assignments', () => {
  const before = fixture()
  before.provenance = {
    fields: { 'employees.a.name': { source: 'manual', at: firstTime } },
    pendingExternalChange: { source: 'mcp', at: firstTime, categories: ['成员'] },
    invalidatedSchedules: { '2026-09': { source: 'http', at: firstTime } },
    scheduleUpdates: { '2026-09': { source: 'mcp', at: firstTime } },
  }
  const completed = markScheduleCoverageComplete(before, ['2026-09', '2026-10'])
  assert.strictEqual(completed.provenance, before.provenance)
  assert.deepEqual(configurationFields(completed), configurationFields(before))
  for (const source of ['manual', 'mcp', 'http']) {
    const tracked = withChangeProvenance(before, completed, source, secondTime)
    assert.deepEqual(plain(tracked.provenance), before.provenance)
    assert.deepEqual(tracked.assignments, before.assignments)
    const fresh = fixture(), freshComplete = markScheduleCoverageComplete(fresh, ['2026-09'])
    assert.equal(withChangeProvenance(fresh, freshComplete, source, secondTime).provenance, undefined)
  }
  const forgedField = { ...completed, provenance: { fields: { 'scheduleCoverage.2026-09': { source: 'manual', at: firstTime } } } }
  assert.throws(() => backupJSON(forgedField), /配置修改来源字段路径无效/)
})

test('coverage parser strictly rejects malformed months, member IDs, duplicates and unknown entry fields', () => {
  const bad = [null, [], 1, 'all',
    { '2026-13': { employeeIds: ['a'] } }, { '2026-1': { employeeIds: ['a'] } }, { '0000-01': { employeeIds: ['a'] } },
    { '2026-10': null }, { '2026-10': [] }, { '2026-10': {} },
    { '2026-10': { employeeIds: null } }, { '2026-10': { employeeIds: ['a', 'a'] } },
    { '2026-10': { employeeIds: [1] } },
    { '2026-10': { employeeIds: ['bad id'] } }, { '2026-10': { employeeIds: ['a'], complete: true } },
    { '2026-10': { employeeIds: Array(201).fill('a') } },
  ]
  for (const scheduleCoverage of bad) {
    const state = { ...fixture(), scheduleCoverage }
    assert.throws(() => parseBackup(JSON.stringify(state)), /备份格式错误/)
    assert.throws(() => backupJSON(state), /备份格式错误/)
  }
  assert.throws(() => markScheduleCoverageComplete(fixture(), ['0000-01']), /排班覆盖月份/)
  const deleted = { ...fixture(), scheduleCoverage: { '2026-09': { employeeIds: ['a', 'removed'] }, '2026-10': { employeeIds: ['removed'] } } }
  assert.deepEqual(plain(parseBackup(backupJSON(deleted)).scheduleCoverage), { '2026-09': { employeeIds: ['a'] } })
  assert.deepEqual(deleted.scheduleCoverage['2026-09'].employeeIds, ['a', 'removed'], 'normalization never mutates the input')
})

test('coverage preserves bounded 1200-month and 200-member metadata in detached backup objects', () => {
  const state = fixture()
  state.assignments = []
  state.employees = Array.from({ length: 200 }, (_, i) => ({ ...state.employees[0], id: `e_${i}`, name: `e_${i}` }))
  const months = Array.from({ length: 1200 }, (_, i) => `${String(2000 + Math.floor(i / 12))}-${String(i % 12 + 1).padStart(2, '0')}`)
  const completed = markScheduleCoverageComplete(state, months)
  const restored = parseBackup(backupJSON(completed))
  assert.equal(Object.keys(restored.scheduleCoverage).length, 1200)
  assert.equal(restored.scheduleCoverage['2000-01'].employeeIds.length, 200)
  restored.scheduleCoverage['2000-01'].employeeIds.pop()
  assert.equal(completed.scheduleCoverage['2000-01'].employeeIds.length, 200)
  assert.throws(() => markScheduleCoverageComplete(completed, ['2100-01']), /1200/)
  const oversized = { ...completed, scheduleCoverage: { ...completed.scheduleCoverage, '2100-01': { employeeIds: ['e_0'] } } }
  assert.throws(() => backupJSON(oversized), /1200/)
  const unusual = fixture()
  unusual.employees[0].id = 'constructor'
  unusual.assignments = []
  unusual.scheduleCoverage = { '0001-01': { employeeIds: ['constructor'] }, '9999-12': { employeeIds: [] } }
  assert.deepEqual(plain(parseBackup(backupJSON(unusual)).scheduleCoverage), { '0001-01': { employeeIds: ['constructor'] } })
})

test('all-rest complete months invalidate on configuration changes and retain existing history until cleared', () => {
  const before = markScheduleCoverageComplete({ ...fixture(), assignments: [] }, ['2026-09', '2026-10'])
  for (const source of ['manual', 'mcp', 'http']) {
    const edited = { ...before, rules: { ...before.rules, minRestHours: 12 } }
    const stale = withChangeProvenance(before, edited, source, firstTime)
    assert.deepEqual(plain(stale.provenance.invalidatedSchedules), {
      '2026-09': { source, at: firstTime }, '2026-10': { source, at: firstTime },
    })
    const noop = withChangeProvenance(stale, structuredClone(stale), 'manual', secondTime)
    assert.deepEqual(noop.provenance.invalidatedSchedules, stale.provenance.invalidatedSchedules)
    assert.deepEqual(plain(parseBackup(backupJSON(noop)).provenance), plain(stale.provenance))
    const cleared = withChangeProvenance(stale, clearScheduleCoverage(stale, ['2026-09']), 'manual', secondTime)
    assert.deepEqual(Object.keys(cleared.provenance.invalidatedSchedules), ['2026-10'])
  }
  const emptyCoverage = { ...before, scheduleCoverage: { '2026-09': { employeeIds: [] }, '2026-10': { employeeIds: ['removed'] } } }
  const edited = withChangeProvenance(emptyCoverage, { ...emptyCoverage, rules: { ...emptyCoverage.rules, minRestHours: 12 } }, 'manual', firstTime)
  assert.equal(edited.provenance.invalidatedSchedules, undefined, 'empty and deleted-member coverage cannot create a populated month')
})
