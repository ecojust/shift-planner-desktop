import test from 'node:test'
import assert from 'node:assert/strict'
import { checkDesktopResult } from '../DesktopSolver.ts'

function fixture(allowPartial = true) {
  return { protocolVersion: 1, requestId: 'test-request', options: { timeLimitSeconds: 5, allowPartial, seed: 1 }, state: {
    version: 1, teamName: '本地测试', month: '2026-10',
    employees: [{ id: 'e1', name: '小林', role: '员工', group: '一组', color: '#abc', maxHoursPerWeek: 40, eligibleShiftIds: ['day'], unavailableDates: ['2026-10-02'] }],
    shifts: [{ id: 'day', name: '早班', shortName: '早', start: '08:00', end: '16:00', color: '#abc', required: 1 }],
    rules: { minRestHours: 11, maxConsecutiveDays: 5, balanceWeekends: true }, assignments: [],
  } }
}
function result(request, fields = {}) {
  return { protocolVersion: 1, requestId: request.requestId, engine: 'ortools-cp-sat', status: 'FEASIBLE', assignments: [], issues: [], stats: { wallTimeSeconds: 1, shortageCount: 31, optimal: false }, message: '', ...fields }
}

test('UNKNOWN is not described as proven infeasible and cannot overwrite an existing roster', () => {
  const request = fixture()
  const decision = checkDesktopResult(request, result(request, { status: 'UNKNOWN' }))
  assert.equal(decision.success, false)
  assert.equal(decision.assignments, undefined)
  assert.match(decision.message, /不代表无解/)
})
test('infeasible and error statuses never supply replacement assignments', () => {
  const request = fixture()
  for (const status of ['INFEASIBLE', 'MODEL_INVALID', 'ERROR', 'CANCELLED']) {
    const decision = checkDesktopResult(request, result(request, { status }))
    assert.equal(decision.success, false)
    assert.equal(decision.assignments, undefined)
  }
})
test('response request identity and engine must match', () => {
  const request = fixture()
  for (const change of [{ requestId: 'stale' }, { protocolVersion: 2 }, { engine: 'browser' }]) assert.equal(checkDesktopResult(request, result(request, change)).success, false)
})
test('a solver success still gets independently checked for leave violations', () => {
  const request = fixture()
  const response = result(request, { assignments: [{ employeeId: 'e1', date: '2026-10-02', shiftId: 'day', locked: false }] })
  assert.equal(checkDesktopResult(request, response).success, false)
  assert.match(checkDesktopResult(request, response).message, /请假/)
})
test('short staffing can only be accepted when explicitly allowed', () => {
  const strict = fixture(false), partial = fixture(true)
  assert.equal(checkDesktopResult(strict, result(strict)).success, false)
  const decision = checkDesktopResult(partial, result(partial))
  assert.equal(decision.success, true)
  assert.match(decision.message, /31 个班次存在缺编/)
  assert.match(decision.message, /尚未证明最优/)
})
test('locked days off and other months must remain intact', () => {
  const request = fixture()
  request.state.assignments.push({ employeeId: 'e1', date: '2026-10-03', shiftId: 'off', locked: true })
  request.state.assignments.push({ employeeId: 'e1', date: '2026-09-28', shiftId: 'day', locked: false })
  assert.equal(checkDesktopResult(request, result(request)).success, false)
  const unchanged = result(request, { assignments: structuredClone(request.state.assignments) })
  assert.equal(checkDesktopResult(request, unchanged).success, true)
  unchanged.assignments.push({ employeeId: 'e1', date: '2026-11-03', shiftId: 'day', locked: false })
  assert.equal(checkDesktopResult(request, unchanged).success, false)
})
test('malformed native assignments are rejected without exceptions', () => {
  const request = fixture()
  for (const assignments of [null, [null], [{ employeeId: 'e1' }]]) assert.equal(checkDesktopResult(request, result(request, { assignments })).success, false)
})

test('progress events must belong to the currently active request and use a known phase', async () => {
  const { matchingSolverPhase } = await import('../DesktopSolver.ts')
  for (const phase of ['starting', 'loading', 'reading', 'solving', 'finishing']) assert.equal(matchingSolverPhase({ requestId: 'current', phase }, 'current'), phase)
  assert.equal(matchingSolverPhase({ requestId: 'old', phase: 'solving' }, 'current'), null)
  assert.equal(matchingSolverPhase({ requestId: 'current', phase: 'solving' }, null), null)
  assert.equal(matchingSolverPhase({ requestId: 'current', phase: 'imagined-progress' }, 'current'), null)
  assert.equal(matchingSolverPhase({ requestId: 'current', phase: '__proto__' }, 'current'), null)
  assert.equal(matchingSolverPhase(null, 'current'), null)
})
test('startup, search, exit and legacy timeouts explain the correct stage without declaring infeasibility', async () => {
  const { formatSolverError } = await import('../DesktopSolver.ts')
  for (const [code, phrase] of [['STARTUP_TIMEOUT', '尚未开始排班搜索'], ['SOLVE_TIMEOUT', '不能证明规则无解'], ['EXIT_TIMEOUT', '返回或退出'], ['TIMEOUT', '没有报告具体阶段']]) {
    const failure = formatSolverError(`${code}: 超时，原排班未被替换。`)
    assert.match(failure.message, new RegExp(phrase))
    assert.equal(failure.code, code)
    assert.equal(failure.message.match(/原排班未改变/g)?.length, 1)
    assert.doesNotMatch(failure.message, /原排班未被替换|。。/)
  }
})
test('native error objects and strings are formatted once with one preservation message', async () => {
  const { formatSolverError } = await import('../DesktopSolver.ts')
  const structured = formatSolverError({ code: 'STARTUP_TIMEOUT', message: 'loading 原排班未改变。' })
  assert.match(structured.message, /启动或组件加载超时/)
  const generic = formatSolverError(new Error('PROCESS_EXIT: 缺少动态库。原排班未被替换。原排班未改变。'))
  assert.match(generic.message, /缺少动态库/)
  assert.equal(generic.message.match(/原排班/g)?.length, 1)
  assert.doesNotMatch(generic.message, /。。/)
  const checking = formatSolverError('STARTUP_TIMEOUT: check failed', 'startup')
  assert.doesNotMatch(checking.message, /原排班/)
  assert.equal(checking.diagnostic, true)
})
test('backend status prose cannot duplicate preservation text in the final result', () => {
  const request = fixture()
  const checked = checkDesktopResult(request, result(request, { status: 'UNKNOWN', message: '搜索未完成。原排班未被替换。' }))
  assert.equal(checked.message.match(/原排班/g)?.length, 1)
  assert.doesNotMatch(checked.message, /。。/)
})

test('startup diagnostics identify the actual reported startup phase', async () => {
  const { formatSolverError } = await import('../DesktopSolver.ts')
  for (const [phase, clue] of [['starting', '组件解压或系统检查'], ['loading', '依赖加载'], ['reading', '数据读取']]) {
    const failure = formatSolverError(`STARTUP_TIMEOUT: 等待超时（阶段 ${phase}）；原排班未被替换。`)
    assert.match(failure.message, new RegExp(clue))
    assert.match(failure.message, /尚未开始排班搜索/)
  }
})
test('valid results survive a host exit-cleanup timeout with a precise notice', () => {
  const request = fixture()
  const checked = checkDesktopResult(request, result(request, { hostDiagnostics: { exitTimedOut: true, phase: 'finishing', code: 'EXIT_TIMEOUT' } }))
  assert.equal(checked.success, true)
  assert.match(checked.message, /有效结果已保存/)
  assert.match(checked.message, /退出清理超时/)
})
