import test from 'node:test'
import assert from 'node:assert/strict'
import { datesOfMonth, generateSchedule, validateSchedule } from '../scheduler.ts'
import { checkDesktopResult } from '../DesktopSolver.ts'

const shifts = [
  { id: 'day', name: '早班', shortName: '早', start: '08:00', end: '16:00', color: '#abc', required: 0 },
  { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#def', required: 0 },
]
const employee = (id = 'a', extra = {}) => ({ id, name: id === 'a' ? '小林' : id, role: '员工', group: '一组', color: '#abc', minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 168, eligibleShiftIds: ['day', 'night'], unavailableDates: [], ...extra })
const assignment = (date, shiftId = 'day', employeeId = 'a', locked = false) => ({ date, shiftId, employeeId, locked })
const noAdjacent = shiftId => ({ id: `nonconsecutive-${shiftId}`, shiftId })
const weekly = (shiftId, maxPerWeek) => ({ id: `weekly-${shiftId}`, shiftId, maxPerWeek })
const fixture = (rules = {}, extra = {}) => ({ version: 1, teamName: '规则回归', month: '2026-10', employees: [employee()], shifts: structuredClone(shifts), rules: { minRestHours: 0, maxConsecutiveDays: 366, ...rules }, assignments: [], ...extra })
const ruleIssues = state => validateSchedule(state).filter(issue => ['consecutive-shift', 'weekly-shift-limit'].includes(issue.type))

test('consecutive selected shifts report the member, two dates, shift and adjustment route', () => {
  const state = fixture({ nonConsecutiveShifts: [noAdjacent('night')] }, { assignments: [assignment('2026-10-01', 'night'), assignment('2026-10-02', 'night')] })
  const [issue] = ruleIssues(state)
  assert.equal(issue.type, 'consecutive-shift')
  assert.equal(issue.employeeId, 'a')
  assert.equal(issue.date, '2026-10-02')
  assert.equal(issue.shiftId, 'night')
  assert.equal(issue.target, 'rules')
  assert.match(issue.message, /小林.*2026-10-01.*2026-10-02.*夜班/)
  assert.match(issue.suggestion, /其他可上班次或休息/)
})

test('no adjacency applies per member and selected shift; an off day or different shift breaks the pair', () => {
  const state = fixture({ nonConsecutiveShifts: [noAdjacent('night')] }, { employees: [employee(), employee('b')], assignments: [
    assignment('2026-10-01', 'night'), assignment('2026-10-02', 'night', 'b'), assignment('2026-10-02', 'off'),
    assignment('2026-10-03', 'night'), assignment('2026-10-04', 'day'), assignment('2026-10-05', 'night'),
    assignment('2026-10-06', 'day'), assignment('2026-10-07', 'day'),
  ] })
  assert.deepEqual(ruleIssues(state), [])
})

test('multiple no-adjacency rules each apply and missing legacy rules stay unrestricted', () => {
  const assignments = [assignment('2026-10-01'), assignment('2026-10-02'), assignment('2026-10-04', 'night'), assignment('2026-10-05', 'night')]
  assert.deepEqual(ruleIssues(fixture({}, { assignments })), [])
  const state = fixture({ nonConsecutiveShifts: [noAdjacent('day'), noAdjacent('night')] }, { assignments })
  assert.deepEqual(ruleIssues(state).map(issue => issue.shiftId), ['day', 'night'])
})

test('no adjacency checks previous and following month neighbors, including unlocked retained work', () => {
  const state = fixture({ nonConsecutiveShifts: [noAdjacent('day')] }, { assignments: [
    assignment('2026-09-30'), assignment('2026-10-01'), assignment('2026-10-31'), assignment('2026-11-01'),
  ] })
  const issues = ruleIssues(state)
  assert.equal(issues.length, 2)
  assert.deepEqual(issues.map(issue => issue.date), ['2026-10-01', '2026-10-31'])
})

test('new no-adjacency rules do not retroactively reject pairs entirely outside the selected month', () => {
  const state = fixture({ nonConsecutiveShifts: [noAdjacent('day')] }, { assignments: [
    assignment('2026-01-01'), assignment('2026-01-02'), assignment('2026-09-29'), assignment('2026-09-30'), assignment('2026-11-01'), assignment('2026-11-02'),
  ] })
  assert.deepEqual(ruleIssues(state), [])
})

test('weekly shift caps count starts separately for every member and every selected shift', () => {
  const state = fixture({ weeklyShiftLimits: [weekly('day', 2), weekly('night', 1)] }, { employees: [employee(), employee('b')], assignments: [
    assignment('2026-10-05'), assignment('2026-10-06'), assignment('2026-10-07'),
    assignment('2026-10-08', 'night'), assignment('2026-10-09', 'night'), assignment('2026-10-05', 'day', 'b'),
  ] })
  const issues = ruleIssues(state)
  assert.equal(issues.length, 2)
  assert.deepEqual(issues.map(issue => [issue.employeeId, issue.shiftId, issue.target]), [['a', 'day', 'rules'], ['a', 'night', 'rules']])
  assert.match(issues[0].message, /2026-10-05 至 2026-10-11.*早班 3 次.*最多 2 次/)
  assert.match(issues[0].suggestion, /至少减少 1 次早班/)
})

test('a Sunday overnight start counts only in Sunday’s week; Monday starts a fresh allowance', () => {
  const state = fixture({ weeklyShiftLimits: [weekly('night', 1)] }, { assignments: [assignment('2026-10-04', 'night'), assignment('2026-10-05', 'night')] })
  assert.deepEqual(ruleIssues(state), [])
  state.assignments.push(assignment('2026-10-11', 'night'))
  assert.equal(ruleIssues(state).length, 1)
  assert.match(ruleIssues(state)[0].message, /2026-10-05 至 2026-10-11.*夜班 2 次/)
})

test('partial weeks use the full cap and count previous/following month starts even when unlocked', () => {
  const state = fixture({ weeklyShiftLimits: [weekly('night', 2)] }, { assignments: [
    assignment('2026-09-28', 'night'), assignment('2026-10-01', 'night'),
    assignment('2026-10-26', 'night'), assignment('2026-11-01', 'night'),
  ] })
  assert.deepEqual(ruleIssues(state), [], 'first week is not prorated to 2 × 4/7')
  state.assignments.push(assignment('2026-10-04', 'night'), assignment('2026-10-31', 'night'))
  const issues = ruleIssues(state)
  assert.equal(issues.length, 2)
  assert.ok(issues.every(issue => /含跨月已知排班 1 次/.test(issue.message)))
  assert.deepEqual(issues.map(issue => issue.date), ['2026-10-01', '2026-10-26'])
})

test('a cap already exceeded by known boundary-week starts is reported even with no in-month assignments', () => {
  const state = fixture({ weeklyShiftLimits: [weekly('day', 1)] }, { assignments: [assignment('2026-09-28'), assignment('2026-09-29')] })
  const [issue] = ruleIssues(state)
  assert.equal(issue.date, '2026-10-01')
  assert.match(issue.message, /2026-09-28 至 2026-10-04.*含跨月已知排班 2 次/)
})

test('weekly caps ignore distant history, including a previous Sunday night spilling hours into the first active week', () => {
  const state = fixture({ weeklyShiftLimits: [weekly('night', 1)] }, { assignments: [
    assignment('2026-09-26', 'night'), assignment('2026-09-27', 'night'), assignment('2026-10-01', 'night'),
    assignment('2026-11-02', 'night'), assignment('2026-11-03', 'night'),
  ] })
  assert.deepEqual(ruleIssues(state), [])
})

test('weekly cap zero forbids the selected shift and cap seven permits all seven start dates', () => {
  const state = fixture({ weeklyShiftLimits: [weekly('day', 0)] }, { assignments: [assignment('2026-10-05')] })
  assert.equal(ruleIssues(state).length, 1)
  state.rules.weeklyShiftLimits[0].maxPerWeek = 7
  state.assignments = [5, 6, 7, 8, 9, 10, 11].map(day => assignment(`2026-10-${String(day).padStart(2, '0')}`))
  assert.deepEqual(ruleIssues(state), [])
})

test('duplicate assignments remain duplicate errors without inflating weekly start counts', () => {
  const state = fixture({ weeklyShiftLimits: [weekly('day', 1)] }, { assignments: [assignment('2026-10-05'), assignment('2026-10-05')] })
  assert.ok(validateSchedule(state).some(issue => issue.type === 'duplicate'))
  assert.deepEqual(ruleIssues(state), [])
})

test('browser generation enforces multiple shift rules while covering every date and leaves its input unchanged', () => {
  const state = fixture({ nonConsecutiveShifts: [noAdjacent('day'), noAdjacent('night')], weeklyShiftLimits: [weekly('day', 2), weekly('night', 2)] }, {
    employees: ['a', 'b', 'c', 'd'].map(id => employee(id)), shifts: shifts.map(shift => ({ ...shift, required: 1 })),
  })
  const before = structuredClone(state)
  const result = generateSchedule(state, 317)
  assert.equal(result.success, true)
  assert.deepEqual(result.issues, [])
  assert.equal(result.assignments.length, datesOfMonth(state.month).length * 2)
  assert.deepEqual(validateSchedule({ ...state, assignments: result.assignments }), [])
  assert.deepEqual(state, before)
})

test('browser candidates honor both adjacent month boundaries and preserve known assignments', () => {
  const state = fixture({ nonConsecutiveShifts: [noAdjacent('day')] }, {
    shifts: [{ ...shifts[0], required: 1 }], employees: [employee('a', { eligibleShiftIds: ['day'] })],
    assignments: [assignment('2026-09-30'), assignment('2026-11-01')],
  })
  const result = generateSchedule(state, 70)
  assert.ok(result.assignments.some(item => item.date === '2026-09-30'))
  assert.ok(result.assignments.some(item => item.date === '2026-11-01'))
  assert.ok(!result.assignments.some(item => item.date === '2026-10-01' || item.date === '2026-10-31'))
  assert.ok(result.issues.some(issue => issue.type === 'coverage'))
  assert.deepEqual(ruleIssues({ ...state, assignments: result.assignments }), [])
})

test('browser candidates count known starts across month boundaries for weekly limits', () => {
  const state = fixture({ weeklyShiftLimits: [weekly('night', 1)] }, {
    shifts: [{ ...shifts[1], required: 1 }], employees: [employee('a', { eligibleShiftIds: ['night'] })],
    assignments: [assignment('2026-09-30', 'night'), assignment('2026-11-01', 'night')],
  })
  const result = generateSchedule(state, 70)
  assert.ok(!result.assignments.some(item => item.date >= '2026-10-01' && item.date <= '2026-10-04'))
  assert.ok(!result.assignments.some(item => item.date >= '2026-10-26' && item.date <= '2026-10-31'))
  assert.ok(result.issues.some(issue => issue.type === 'coverage'))
  assert.deepEqual(ruleIssues({ ...state, assignments: result.assignments }), [])
  assert.deepEqual(result.assignments.filter(item => !item.date.startsWith(state.month)), state.assignments)
})

test('browser zero caps produce coverage shortages without relaxing the cap', () => {
  const state = fixture({ weeklyShiftLimits: [weekly('day', 0)] }, { shifts: [{ ...shifts[0], required: 1 }], employees: [employee('a', { eligibleShiftIds: ['day'] })] })
  const result = generateSchedule(state)
  assert.deepEqual(result.assignments, [])
  assert.equal(result.issues.filter(issue => issue.type === 'coverage').length, 31)
  assert.ok(!result.issues.some(issue => issue.severity === 'error'))
})

test('conflicting locked shift rules or unreachable monthly minimums preserve the full original schedule', () => {
  const cases = [
    fixture({ nonConsecutiveShifts: [noAdjacent('day')] }, { assignments: [assignment('2026-10-01', 'day', 'a', true), assignment('2026-10-02', 'day', 'a', true), assignment('2026-10-12')] }),
    fixture({ weeklyShiftLimits: [weekly('day', 1)] }, { assignments: [assignment('2026-10-05', 'day', 'a', true), assignment('2026-10-06', 'day', 'a', true), assignment('2026-10-12')] }),
    fixture({ weeklyShiftLimits: [weekly('day', 0), weekly('night', 0)] }, { employees: [employee('a', { minHoursPerMonth: 8 })], assignments: [assignment('2026-10-12')] }),
  ]
  for (const state of cases) {
    const before = structuredClone(state)
    const result = generateSchedule(state)
    assert.equal(result.success, false)
    assert.deepEqual(result.assignments, before.assignments)
    assert.deepEqual(state, before)
  }
})

test('invalid shift-rule lists are rejected without throwing or replacing existing assignments', () => {
  const malformed = [null, {}, 'night', [null], [7], [[]], [{ id: '', shiftId: 'day' }], [{ id: 'bad id', shiftId: 'day' }], [{ id: 'a'.repeat(65), shiftId: 'day' }], [{ id: 'bad-shift', shiftId: 'missing' }], [{ id: 'a', shiftId: 'day' }, { id: 'a', shiftId: 'night' }], [{ id: 'a', shiftId: 'day' }, { id: 'b', shiftId: 'day' }], Array.from({ length: 25 }, (_, index) => ({ id: `r${index}`, shiftId: 'day' }))]
  for (const key of ['nonConsecutiveShifts', 'weeklyShiftLimits']) {
    for (const value of malformed) {
      const state = fixture({ [key]: value }, { assignments: [assignment('2026-10-05')] })
      const result = generateSchedule(state)
      assert.equal(result.success, false, `${key}: ${JSON.stringify(value)}`)
      assert.ok(result.issues.some(issue => issue.type === 'configuration'))
      assert.deepEqual(result.assignments, state.assignments)
    }
  }
  for (const maxPerWeek of [-1, 8, 0.5, '2', null, undefined, true, NaN, Infinity]) {
    const result = generateSchedule(fixture({ weeklyShiftLimits: [weekly('day', maxPerWeek)] }))
    assert.equal(result.success, false, `${String(maxPerWeek)} must not be silently coerced`)
    assert.ok(result.issues.some(issue => issue.type === 'configuration'))
  }
})

test('independent native-result validation rejects forged success that violates either new hard rule, even allowing shortages', () => {
  const cases = [
    fixture({ nonConsecutiveShifts: [noAdjacent('day')] }),
    fixture({ weeklyShiftLimits: [weekly('day', 1)] }),
  ]
  for (const state of cases) for (const allowPartial of [false, true]) {
    const request = { protocolVersion: 1, requestId: 'new-rule-validation', state, options: { allowPartial, timeLimitSeconds: 5, seed: 1 } }
    const response = { protocolVersion: 1, requestId: request.requestId, engine: 'ortools-cp-sat', status: 'OPTIMAL', assignments: [assignment('2026-10-05'), assignment('2026-10-06')], issues: [], stats: { wallTimeSeconds: 0.1, shortageCount: 0, optimal: true }, message: '成功' }
    const checked = checkDesktopResult(request, response)
    assert.equal(checked.success, false)
    assert.equal(checked.assignments, undefined)
    assert.ok(checked.issues.some(issue => ['consecutive-shift', 'weekly-shift-limit'].includes(issue.type)))
    assert.deepEqual(state.assignments, [])
  }
})

test('native-result validation accepts a cap-compliant schedule across Sunday overnight and Monday', () => {
  const state = fixture({ weeklyShiftLimits: [weekly('night', 1)] })
  const request = { protocolVersion: 1, requestId: 'native-start-week', state, options: { allowPartial: false, timeLimitSeconds: 5, seed: 1 } }
  const assignments = [assignment('2026-10-04', 'night'), assignment('2026-10-05', 'night')]
  const response = { protocolVersion: 1, requestId: request.requestId, engine: 'ortools-cp-sat', status: 'FEASIBLE', assignments, issues: [], stats: { wallTimeSeconds: 0.1, shortageCount: 0, optimal: false }, message: '' }
  const checked = checkDesktopResult(request, response)
  assert.equal(checked.success, true)
  assert.deepEqual(checked.assignments, assignments)
  assert.deepEqual(checked.issues, [])
})
