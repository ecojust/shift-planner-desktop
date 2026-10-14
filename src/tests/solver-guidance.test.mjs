import test from 'node:test'
import assert from 'node:assert/strict'
import { withSolverGuidance, diagnosticActionLabel } from '../solverGuidance.ts'

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
