import test from 'node:test'
import assert from 'node:assert/strict'
import { withSolverGuidance, diagnosticActionLabel, boundaryWeekNotices, openingWeekNotice } from '../solverGuidance.ts'

test('backend quantitative guidance and destination survive the presentation layer', () => {
  const issue = { id: 'x', type: 'weekly-min-hours', severity: 'error', employeeId: 'e1', date: '2026-10-05', message: '最低 40 小时，可用 32 小时。', suggestion: '请在 10 月 7 日补充一个 8 小时班位。', target: 'shifts', shiftId: 'day' }
  assert.deepEqual(withSolverGuidance([issue]), [issue])
  assert.equal(diagnosticActionLabel(issue), '查看班次设置')
})
test('browser candidate issues get a relevant adjustment route without changing their evidence', () => {
  const issue = { id: 'x', type: 'rest', severity: 'error', date: '2026-10-05', message: '候选安排间休息不足。' }
  const [guided] = withSolverGuidance([issue])
  assert.equal(guided.message, issue.message)
  assert.equal(guided.target, 'calendar')
  assert.equal(diagnosticActionLabel(guided), '查看对应日期')
  assert.equal(issue.target, undefined)
  assert.equal(diagnosticActionLabel({ ...issue, type: 'unknown-new-code' }), '')
})

function boundaryState(overrides = {}) {
  return { month: '2026-10', employees: [{ id: 'a' }, { id: 'b' }], assignments: [], ...overrides }
}
const kinds = week => week.items.map(item => item.kind)

test('boundary guidance distinguishes unknown history from future planning at both ends', () => {
  const state = boundaryState()
  const before = structuredClone(state)
  const notices = boundaryWeekNotices(state, '2026-10-15')
  assert.deepEqual(notices.map(({ edge, weekStart, weekEnd }) => ({ edge, weekStart, weekEnd })), [
    { edge: 'start', weekStart: '2026-09-28', weekEnd: '2026-10-04' },
    { edge: 'end', weekStart: '2026-10-26', weekEnd: '2026-11-01' },
  ])
  assert.deepEqual(kinds(notices[0]), ['unknown'])
  assert.match(notices[0].items[0].description, /2 位成员.*空白不视为休息/)
  assert.deepEqual(kinds(notices[1]), ['preview'])
  assert.match(notices[1].items[0].description, /不保存到相邻月份/)
  assert.deepEqual(state, before, 'presentation must not create coverage or fictional assignments')
})

test('one explicit off cell is known without asserting completeness for its colleague or other days', () => {
  const notices = boundaryWeekNotices(boundaryState({ assignments: [{ employeeId: 'a', date: '2026-09-28', shiftId: 'off' }] }), '2026-10-15')
  assert.deepEqual(kinds(notices[0]), ['known', 'unknown'])
  assert.equal(notices[0].items[0].label, '已计入上月排班')
  assert.match(notices[0].items[1].description, /2 位成员/)
  const unrelated = boundaryWeekNotices(boundaryState({ assignments: [{ employeeId: 'a', date: '2026-09-01', shiftId: 'off' }] }), '2026-10-15')
  assert.deepEqual(kinds(unrelated[0]), ['unknown'], 'an earlier record does not make the boundary history complete')
})

test('complete member coverage can establish rest with zero assignments and is symmetric', () => {
  const notices = boundaryWeekNotices(boundaryState({ scheduleCoverage: {
    '2026-09': { employeeIds: ['a', 'b'] }, '2026-11': { employeeIds: ['a', 'b'] },
  } }), '2026-10-15')
  assert.deepEqual(notices.map(kinds), [['known'], ['known']])
  assert.equal(notices[1].items[0].label, '已计入下月排班')
})

test('coverage is per member and invalidated saved records remain visible', () => {
  const notices = boundaryWeekNotices(boundaryState({
    scheduleCoverage: { '2026-09': { employeeIds: ['a'] } },
    provenance: { fields: {}, invalidatedSchedules: { '2026-09': { source: 'manual', at: '2026-10-01T00:00:00Z' } } },
  }), '2026-10-15')
  assert.deepEqual(kinds(notices[0]), ['known', 'invalid', 'unknown'])
  assert.match(notices[0].items[1].description, /仍按原记录/)
  assert.match(notices[0].items[2].description, /1 位成员/)
})

test('a boundary may contain both unknown past and unplanned future without turning today into history', () => {
  const notices = boundaryWeekNotices(boundaryState(), '2026-09-30')
  assert.deepEqual(kinds(notices[0]), ['unknown', 'preview'])
  const allFuture = boundaryWeekNotices(boundaryState(), '2026-09-28')
  assert.deepEqual(kinds(allFuture[0]), ['preview'])
  assert.deepEqual(kinds(allFuture[1]), ['preview'])
})

test('invalid inputs and a month aligned to whole natural weeks do not invent boundary notices', () => {
  assert.deepEqual(boundaryWeekNotices(boundaryState({ month: '2026-13' }), '2026-10-15'), [])
  assert.deepEqual(boundaryWeekNotices(boundaryState(), 'not-a-date'), [])
  assert.deepEqual(boundaryWeekNotices(boundaryState({ employees: [] }), '2026-10-15'), [])
  assert.deepEqual(boundaryWeekNotices(boundaryState({ month: '2027-02' }), '2026-10-15'), [])
  assert.equal(openingWeekNotice(boundaryState({ month: '2027-02' }), '2026-10-15'), null)
})

test('legacy notice callers get symmetric guidance and boundary warnings preserve backend evidence', () => {
  const notice = openingWeekNotice(boundaryState(), '2026-10-15')
  assert.match(notice.summary, /月初周：历史待核对/)
  assert.match(notice.summary, /月末周：未来未排/)
  const issues = ['boundary-history-incomplete', 'history-incomplete', 'boundary-future-unconfirmed'].map(type => ({ id: type, type, severity: 'warning', message: '原始诊断' }))
  for (const issue of withSolverGuidance(issues)) {
    assert.equal(issue.severity, 'warning')
    assert.equal(issue.message, '原始诊断')
    assert.equal(issue.target, 'calendar')
    assert.ok(issue.suggestion)
  }
})
