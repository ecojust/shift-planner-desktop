import test from 'node:test'
import assert from 'node:assert/strict'
import { reorderVisibleEmployees } from '../employeeOrder.ts'
import { configurationFields, withChangeProvenance } from '../dataProvenance.ts'
import { backupJSON, loadSaved, parseBackup, saveLocal } from '../storage.ts'
import { createPayrollConfig } from '../payroll.ts'

const ids = employees => employees.map(employee => employee.id)
const rows = (...values) => values.map(id => ({ id, name: `成员 ${id}` }))
const firstTime = '2026-10-15T12:00:00.000Z'
const secondTime = '2026-10-15T12:01:00.000Z'
const thirdTime = '2026-10-15T12:02:00.000Z'
const reorderTime = '2026-10-15T12:03:00.000Z'

function fixture() {
  return {
    version: 1, teamName: '测试团队', month: '2026-10',
    employees: rows('e1', 'e2', 'e3', 'e4', 'e5').map(employee => ({
      ...employee, role: '店员', group: '', color: '#123456',
      minHoursPerWeek: 0, maxHoursPerWeek: 48, eligibleShiftIds: ['day'], unavailableDates: [],
    })),
    shifts: [{ id: 'day', name: '白班', shortName: '白', start: '09:00', end: '17:00', color: '#123456', required: 1 }],
    rules: { minRestHours: 11, maxConsecutiveDays: 5 },
    payroll: createPayrollConfig().payroll,
    assignments: [
      { employeeId: 'e1', date: '2026-10-15', shiftId: 'day', locked: true },
      { employeeId: 'e2', date: '2026-11-01', shiftId: 'off', locked: false },
    ],
  }
}

function trackedFixture() {
  const initial = fixture()
  let state = withChangeProvenance({ ...initial, assignments: [] }, initial, 'mcp', firstTime)
  state = withChangeProvenance(state, {
    ...state, employees: state.employees.map(employee => employee.id === 'e1' ? { ...employee, name: '手动姓名' } : employee),
  }, 'manual', firstTime)
  state = withChangeProvenance(state, {
    ...state, employees: state.employees.map(employee => employee.id === 'e2' ? { ...employee, role: 'MCP 岗位' } : employee),
  }, 'mcp', secondTime)
  return withChangeProvenance(state, { ...state, rules: { ...state.rules, minRestHours: 12 } }, 'http', thirdTime)
}

test('moves first and last members to either side of the opposite end', () => {
  const employees = rows('a', 'b', 'c', 'd')
  const cases = [
    ['a', 'd', 'after', ['b', 'c', 'd', 'a']],
    ['d', 'a', 'before', ['d', 'a', 'b', 'c']],
    ['a', 'd', 'before', ['b', 'c', 'a', 'd']],
    ['d', 'a', 'after', ['a', 'd', 'b', 'c']],
  ]
  for (const [source, target, position, expected] of cases) {
    const reordered = reorderVisibleEmployees(employees, ids(employees), source, target, position)
    assert.deepEqual(ids(reordered), expected, `${source} ${position} ${target}`)
    assert.notStrictEqual(reordered, employees)
    for (const employee of reordered) assert.strictEqual(employee, employees.find(original => original.id === employee.id))
  }
  assert.deepEqual(ids(employees), ['a', 'b', 'c', 'd'])
})

test('inserts between middle members in either direction', () => {
  const employees = rows('a', 'b', 'c', 'd', 'e')
  assert.deepEqual(ids(reorderVisibleEmployees(employees, ids(employees), 'b', 'd', 'before')), ['a', 'c', 'b', 'd', 'e'])
  assert.deepEqual(ids(reorderVisibleEmployees(employees, ids(employees), 'd', 'b', 'after')), ['a', 'b', 'd', 'c', 'e'])
})

test('filtered moves preserve every hidden slot and object reference without mutating frozen inputs', () => {
  const employees = Object.freeze(rows('hidden-start', 'a', 'hidden-middle', 'b', 'c', 'hidden-end', 'd', 'hidden-last').map(Object.freeze))
  const visible = Object.freeze(['a', 'b', 'c', 'd'])
  const original = [...employees]
  const cases = [
    ['d', 'a', 'before', ['hidden-start', 'd', 'hidden-middle', 'a', 'b', 'hidden-end', 'c', 'hidden-last']],
    ['a', 'd', 'after', ['hidden-start', 'b', 'hidden-middle', 'c', 'd', 'hidden-end', 'a', 'hidden-last']],
  ]
  for (const [source, target, position, expected] of cases) {
    const reordered = reorderVisibleEmployees(employees, visible, source, target, position)
    assert.deepEqual(ids(reordered), expected)
    for (const index of [0, 2, 5, 7]) assert.strictEqual(reordered[index], employees[index])
    for (const employee of reordered) assert.strictEqual(employee, original.find(value => value.id === employee.id))
  }
  assert.deepEqual(employees, original)
  assert.deepEqual(visible, ['a', 'b', 'c', 'd'])
})

test('unchanged orders return the original array, including adjacent visible members around a hidden row', () => {
  const empty = []
  assert.strictEqual(reorderVisibleEmployees(empty, [], 'a', 'b', 'before'), empty)
  const single = rows('a')
  assert.strictEqual(reorderVisibleEmployees(single, ['a'], 'a', 'a', 'after'), single)
  const employees = rows('a', 'hidden', 'b', 'c')
  for (const [visible, source, target, position] of [
    [[], 'a', 'b', 'after'],
    [['a'], 'a', 'a', 'before'],
    [['a', 'b', 'c'], 'b', 'b', 'after'],
    [['a', 'b', 'c'], 'a', 'b', 'before'],
    [['a', 'b', 'c'], 'b', 'a', 'after'],
  ]) assert.strictEqual(reorderVisibleEmployees(employees, visible, source, target, position), employees)
})

test('rejects stale, ambiguous and invalid drag inputs without changing the array', () => {
  const employees = rows('a', 'b', 'c', 'hidden')
  const cases = [
    [['a', 'b', 'c'], 'a', 'c', 'inside'],
    [['a', 'b', 'c'], 'a', 'c', undefined],
    [['a', 'b', 'b', 'c'], 'a', 'c', 'after'],
    [['a', 'missing', 'c'], 'a', 'c', 'after'],
    [['b', 'a', 'c'], 'a', 'c', 'after'],
    [['a', 'b', 'c'], 'hidden', 'c', 'before'],
    [['a', 'b', 'c'], 'a', 'hidden', 'after'],
    [['a', 'b', 'c'], 'missing', 'c', 'before'],
    [['a', 'b', 'c'], 'a', 'missing', 'after'],
  ]
  for (const [visible, source, target, position] of cases) {
    assert.strictEqual(reorderVisibleEmployees(employees, visible, source, target, position), employees)
  }
  const ambiguous = rows('a', 'hidden', 'b', 'hidden', 'c')
  assert.strictEqual(reorderVisibleEmployees(ambiguous, ['a', 'b', 'c'], 'a', 'c', 'after'), ambiguous)
  assert.deepEqual(ids(employees), ['a', 'b', 'c', 'hidden'])
})

test('saving reordered members preserves all sources, schedule history and assignments', () => {
  const previous = trackedFixture()
  const before = structuredClone(previous)
  const employees = reorderVisibleEmployees(previous.employees, ['e1', 'e3', 'e5'], 'e5', 'e1', 'before')
  const reordered = withChangeProvenance(previous, { ...previous, employees }, 'manual', reorderTime)
  assert.deepEqual(ids(reordered.employees), ['e5', 'e2', 'e1', 'e4', 'e3'])
  assert.deepEqual(configurationFields(reordered), configurationFields(previous))
  assert.deepEqual(reordered.provenance, previous.provenance)
  assert.deepEqual(reordered.provenance.fields['employees.e1.name'], { source: 'manual', at: firstTime })
  assert.deepEqual(reordered.provenance.fields['employees.e2.role'], { source: 'mcp', at: secondTime })
  assert.deepEqual(reordered.provenance.fields['rules.minRestHours'], { source: 'http', at: thirdTime })
  assert.deepEqual(Object.keys(reordered.provenance.invalidatedSchedules), ['2026-10', '2026-11'])
  assert.deepEqual(Object.keys(reordered.provenance.scheduleUpdates), ['2026-10', '2026-11'])
  assert.strictEqual(reordered.assignments, previous.assignments)
  assert.deepEqual(reordered.assignments, before.assignments)
  assert.deepEqual(JSON.parse(JSON.stringify(previous)), before)
})

test('reordering untracked data adds no provenance for any change source', () => {
  const previous = fixture()
  const employees = reorderVisibleEmployees(previous.employees, ids(previous.employees), 'e1', 'e5', 'after')
  for (const source of ['manual', 'mcp', 'http']) {
    const reordered = withChangeProvenance(previous, { ...previous, employees }, source, reorderTime)
    assert.deepEqual(ids(reordered.employees), ['e2', 'e3', 'e4', 'e5', 'e1'])
    assert.equal(Object.hasOwn(reordered, 'provenance'), false)
    assert.strictEqual(reordered.assignments, previous.assignments)
  }
})

test('reordered members retain their order and metadata after backup import and local restart', () => {
  const previous = trackedFixture()
  const employees = reorderVisibleEmployees(previous.employees, ids(previous.employees), 'e5', 'e2', 'before')
  const reordered = withChangeProvenance(previous, { ...previous, employees }, 'manual', reorderTime)
  const restored = parseBackup(backupJSON(reordered))
  assert.deepEqual(ids(restored.employees), ['e1', 'e5', 'e2', 'e3', 'e4'])
  assert.deepEqual(restored.provenance, previous.provenance)
  assert.deepEqual(restored.assignments, previous.assignments)
  const savedStorage = globalThis.localStorage
  const memory = new Map()
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) }
  try {
    saveLocal(reordered)
    const restarted = loadSaved()
    assert.deepEqual(ids(restarted.employees), ids(restored.employees))
    assert.deepEqual(restarted.provenance, previous.provenance)
    assert.deepEqual(restarted.assignments, previous.assignments)
  } finally {
    if (savedStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = savedStorage
  }
})
