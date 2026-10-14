import test from 'node:test'
import assert from 'node:assert/strict'
import { unzipSync, strFromU8 } from 'fflate'
import { backupJSON, parseBackup, saveLocal, loadSaved } from '../storage.ts'
import { scheduleXLSX } from '../storage.ts'
import { createSolverRequest, solverDebugJSON } from '../solverDebug.ts'
import { withSolverGuidance } from '../solverGuidance.ts'

function fixture() {
  return {
    version: 1, teamName: '规则测试', month: '2026-10',
    employees: [{ id: 'e1', name: '甲', role: '', group: '', color: '#345678', minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 56, eligibleShiftIds: ['early', 'night'], unavailableDates: [] }],
    shifts: [
      { id: 'early', name: '早班', shortName: '早', start: '08:00', end: '16:00', color: '#345678', required: 0 },
      { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#345678', required: 0 },
    ],
    rules: {
      minRestHours: 11, maxConsecutiveDays: 5,
      nonConsecutiveShifts: [{ id: 'gap_early', shiftId: 'early' }, { id: 'gap_night', shiftId: 'night' }],
      weeklyShiftLimits: [{ id: 'cap_early', shiftId: 'early', maxPerWeek: 7 }, { id: 'cap_night', shiftId: 'night', maxPerWeek: 0 }],
    },
    assignments: [{ employeeId: 'e1', date: '2026-09-30', shiftId: 'night', locked: false }, { employeeId: 'e1', date: '2026-11-01', shiftId: 'early', locked: false }],
  }
}

test('multiple shift rules roundtrip without mutation and old backups remain unchanged', () => {
  const state = fixture(), before = structuredClone(state)
  const restored = parseBackup(backupJSON(state))
  assert.deepEqual(restored, before)
  restored.rules.nonConsecutiveShifts[0].shiftId = 'night'
  restored.rules.weeklyShiftLimits[1].maxPerWeek = 3
  assert.deepEqual(state, before)
  delete state.rules.nonConsecutiveShifts
  delete state.rules.weeklyShiftLimits
  assert.deepEqual(parseBackup(backupJSON(state)), state)
  for (const field of ['nonConsecutiveShifts', 'weeklyShiftLimits']) assert.equal(Object.hasOwn(parseBackup(backupJSON(state)).rules, field), false)
})

test('local save and restore persist new rules including zero and seven', t => {
  const store = new Map()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) } })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage })
  assert.equal(loadSaved(), null)
  saveLocal(fixture())
  assert.deepEqual(loadSaved(), fixture())
})

for (const field of ['nonConsecutiveShifts', 'weeklyShiftLimits']) {
  test(`${field}: rejects malformed lists, duplicate IDs, duplicate shifts and unknown references`, () => {
    const mutations = [
      state => { state.rules[field] = null },
      state => { state.rules[field] = {} },
      state => { state.rules[field] = [null] },
      state => { state.rules[field][0].id = '' },
      state => { state.rules[field][0].id = 'bad space' },
      state => { state.rules[field][0].id = 'x'.repeat(65) },
      state => { state.rules[field][0].id = '\n' },
      state => { state.rules[field][0].id = state.rules[field][1].id },
      state => { state.rules[field][0].shiftId = state.rules[field][1].shiftId },
      state => { state.rules[field][0].shiftId = 'missing' },
      state => { state.rules[field][0].shiftId = 'off' },
      state => { state.rules[field] = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, shiftId: 'night', maxPerWeek: 2 })) },
    ]
    for (const mutate of mutations) {
      const state = fixture(); mutate(state)
      assert.throws(() => parseBackup(JSON.stringify(state)), /备份格式错误/)
    }
  })
}

test('weekly caps require finite integers from zero through seven', () => {
  for (const cap of [undefined, null, true, false, '2', -1, 8, 2.5, NaN, Infinity]) {
    const state = fixture()
    state.rules.weeklyShiftLimits[0].maxPerWeek = cap
    assert.throws(() => parseBackup(JSON.stringify(state)), /每周最多班次/)
  }
})

test('twenty-four rules are accepted and unknown row properties are discarded', () => {
  const state = fixture()
  state.shifts = Array.from({ length: 24 }, (_, i) => ({ ...state.shifts[0], id: `s${i}` }))
  state.employees[0].eligibleShiftIds = state.shifts.map(shift => shift.id)
  state.assignments = []
  state.rules.nonConsecutiveShifts = state.shifts.map((shift, i) => ({ id: `r${i}`, shiftId: shift.id, ignored: 'extra' }))
  state.rules.weeklyShiftLimits = state.shifts.map((shift, i) => ({ id: `r${i}`, shiftId: shift.id, maxPerWeek: 2, ignored: 'extra' }))
  const restored = parseBackup(backupJSON(state))
  for (const field of ['nonConsecutiveShifts', 'weeklyShiftLimits']) {
    assert.equal(restored.rules[field].length, 24)
    assert.ok(restored.rules[field].every(rule => !Object.hasOwn(rule, 'ignored')))
  }
})

test('debug JSON retains a detached snapshot of new rules and boundary assignments', () => {
  const state = fixture(), original = structuredClone(state)
  const request = createSolverRequest(state, { seed: 42, allowPartial: false, timeLimitSeconds: 5 }, 'shift-rules')
  state.rules.weeklyShiftLimits[0].maxPerWeek = 1
  state.rules.nonConsecutiveShifts.length = 0
  const replay = JSON.parse(solverDebugJSON(request, { source: 'attempt' }))
  assert.deepEqual(replay.state.rules, original.rules)
  assert.deepEqual(replay.state.assignments, original.assignments)
  assert.equal(replay.options.seed, 42)
})

test('Excel lists both shift rules and their start-date / natural-week semantics', () => {
  const state = fixture()
  state.shifts[0].name = '=bad<text>&'
  const xml = strFromU8(unzipSync(scheduleXLSX(state))['xl/worksheets/sheet2.xml'])
  assert.match(xml, /班次不相连/)
  assert.match(xml, /周班次限制/)
  assert.match(xml, /不足一周不折算/)
  assert.match(xml, /开始日期/)
  assert.match(xml, /=bad&lt;text&gt;&amp;/)
  assert.doesNotMatch(xml, /<f[ >]/)
})

test('new rule failures receive rules navigation without replacing more specific guidance', () => {
  const issues = ['consecutive-shift', 'weekly-shift-limit'].map(type => ({ id: type, type, severity: 'error', message: '冲突' }))
  for (const issue of withSolverGuidance(issues)) {
    assert.equal(issue.target, 'rules')
    assert.ok(issue.suggestion.length > 10)
  }
  assert.equal(withSolverGuidance([{ ...issues[0], suggestion: '具体指导' }])[0].suggestion, '具体指导')
})
