import test from 'node:test'
import assert from 'node:assert/strict'
import { checkDesktopResult, formatUserIssue, formatUserMessage } from '../DesktopSolver.ts'
import { datesOfMonth, generateSchedule } from '../scheduler.ts'

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
    const rawIssue = { id: 'native-error', type: status === 'MODEL_INVALID' ? 'model-invalid' : 'solver-error', severity: 'error', message: 'ValueError: Python traceback at /Users/test/solver/engine.py:71', suggestion: 'OR-Tools solution_info: invalid constraint #12' }
    const response = result(request, { status, issues: [rawIssue], message: 'OR-Tools CP-SAT solution_info: invalid constraint #12' })
    const snapshot = structuredClone(response)
    const decision = checkDesktopResult(request, response)
    assert.equal(decision.success, false)
    assert.equal(decision.assignments, undefined)
    assert.doesNotMatch(JSON.stringify([decision.message, decision.issues]), /ValueError|Python|traceback|Users|OR-Tools|CP-SAT|solution_info|constraint #12/)
    assert.match(decision.issues[0].suggestion, /导出本次规则/)
    assert.deepEqual(response, snapshot, 'raw diagnostics remain available to debug exports')
  }
})
test('infeasibility retains specific native evidence and adjustment route without stacking generic lists', () => {
  const request = fixture()
  const evidence = { id: 'coverage-day', type: 'coverage-capacity', severity: 'error', date: '2026-10-02', shiftId: 'day', message: '2026-10-02 早班需要 1 人，可用 0 人。', suggestion: '小林当天请假，请补充可上早班的成员。', target: 'team' }
  const decision = checkDesktopResult(request, result(request, { status: 'INFEASIBLE', issues: [evidence], message: '已证明无解。原排班未修改。' }))
  assert.deepEqual(decision.issues, [evidence])
  assert.equal(decision.assignments, undefined)
  assert.equal(decision.message.match(/原排班/g)?.length, 1)
  assert.doesNotMatch(decision.message, /月\/周最低工时|周最高工时、锁定安排/)
})
test('legacy blanket infeasibility is reported as unlocalized and offers replay, never as exact diagnosis', () => {
  const request = fixture()
  const decision = checkDesktopResult(request, result(request, { status: 'INFEASIBLE', issues: [{ id: 'infeasible', type: 'infeasible', severity: 'error', message: '现有人员、班次人数设置与硬规则存在冲突。' }], message: '请检查所有硬性规则。原排班未改变。' }))
  assert.match(decision.message, /尚未定位具体冲突/)
  assert.match(decision.message, /导出本次规则/)
  assert.deepEqual(decision.issues, [])
})
test('an exhausted diagnosis budget keeps infeasibility proof without claiming a located conflict', () => {
  const request = fixture()
  const issue = { id: 'diagnosis-incomplete', type: 'diagnosis-incomplete', severity: 'error', message: '求解器已证明无解，但限时冲突分析尚未完成。', suggestion: '导出本次规则进一步复现。', target: 'rules' }
  const decision = checkDesktopResult(request, result(request, { status: 'INFEASIBLE', issues: [issue] }))
  assert.match(decision.message, /已确认.*无可行解.*尚未定位具体冲突/)
  assert.doesNotMatch(decision.message, /逐项调整/)
  assert.deepEqual(decision.issues, [{ ...issue, message: '已确认无解，但限时冲突分析尚未完成。', suggestion: '导出本次规则进一步排查。' }])
  assert.match(issue.message, /求解器已证明/, 'display formatting must not mutate the original diagnosis')
  assert.deepEqual(formatUserIssue(decision.issues[0]), decision.issues[0], 'formatting a display copy again is harmless')
  assert.equal(decision.assignments, undefined)
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
  assert.match(decision.message, /排班已生成/)
})

function fixedStaffingFixture(allowPartial = false, required = 1) {
  const request = fixture(allowPartial)
  request.state.shifts[0] = { ...request.state.shifts[0], required, staffingMode: 'fixed' }
  request.state.employees = ['e1', 'e2'].map(id => ({ ...request.state.employees[0], id, name: id, unavailableDates: [], maxHoursPerWeek: 168 }))
  request.state.rules = { minRestHours: 0, maxConsecutiveDays: 31 }
  return request
}
function exactFixedRoster(request) {
  return request.state.shifts[0].required === 0 ? [] : datesOfMonth(request.state.month).map(date => ({ employeeId: 'e1', date, shiftId: 'day', locked: false }))
}

test('forged native FEASIBLE output cannot exceed fixed staffing even when shortages are allowed', () => {
  for (const allowPartial of [false, true]) for (const required of [0, 1]) {
    const request = fixedStaffingFixture(allowPartial, required)
    const assignments = [...exactFixedRoster(request), { employeeId: required ? 'e2' : 'e1', date: '2026-10-01', shiftId: 'day', locked: false }]
    const checked = checkDesktopResult(request, result(request, {
      assignments, issues: [], stats: { wallTimeSeconds: 1, shortageCount: 0, optimal: false },
    }))
    assert.equal(checked.success, false, `fixed=${required}, allowPartial=${allowPartial}`)
    assert.equal(checked.assignments, undefined)
    assert.ok(checked.issues.some(issue => issue.type === 'overstaffed' && issue.severity === 'error' && issue.date === '2026-10-01'))
    assert.match(checked.message, /超出固定人数/)
    assert.deepEqual(request.state.assignments, [], 'checking a forged response must not write into the original state')
  }
})

test('a fixed-staffing shortage requires explicit allowPartial rather than trusting native shortage stats', () => {
  for (const allowPartial of [false, true]) {
    const request = fixedStaffingFixture(allowPartial)
    const assignments = exactFixedRoster(request).filter(item => item.date !== '2026-10-15')
    const checked = checkDesktopResult(request, result(request, {
      assignments, issues: [], stats: { wallTimeSeconds: 1, shortageCount: 0, optimal: false },
    }))
    assert.equal(checked.success, allowPartial)
    assert.deepEqual(checked.issues.map(issue => [issue.type, issue.severity]), [['coverage', 'warning']])
    if (allowPartial) {
      assert.deepEqual(checked.assignments, assignments)
      assert.match(checked.message, /1 个班次存在缺编/)
    } else {
      assert.equal(checked.assignments, undefined)
      assert.match(checked.message, /岗位缺口/)
    }
  }
})

test('independently valid exact fixed staffing is accepted including fixed zero', () => {
  for (const allowPartial of [false, true]) for (const required of [0, 1]) {
    const request = fixedStaffingFixture(allowPartial, required)
    const assignments = exactFixedRoster(request)
    const checked = checkDesktopResult(request, result(request, { assignments }))
    assert.equal(checked.success, true, `fixed=${required}, allowPartial=${allowPartial}`)
    assert.deepEqual(checked.issues, [])
    assert.deepEqual(checked.assignments, assignments)
    assert.match(checked.message, /所有岗位已覆盖/)
  }
})

test('preserved other-month staffing is not retroactively capped by the current fixed limit', () => {
  for (const allowPartial of [false, true]) {
    const request = fixedStaffingFixture(allowPartial)
    request.state.assignments = ['2026-09-28', '2026-11-03'].flatMap(date => ['e1', 'e2'].map(employeeId => ({ employeeId, date, shiftId: 'day', locked: employeeId === 'e2' })))
    const historical = structuredClone(request.state.assignments)
    const assignments = [...historical, ...exactFixedRoster(request)]
    const checked = checkDesktopResult(request, result(request, { assignments }))
    assert.equal(checked.success, true)
    assert.deepEqual(checked.issues, [])
    assert.deepEqual(checked.assignments, assignments)
    assert.deepEqual(request.state.assignments, historical)
    assert.equal(checked.assignments.filter(item => item.date === '2026-09-28').length, 2, 'two historical staff remain valid despite the current fixed one-person limit')
  }
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
  for (const [code, phrase] of [['STARTUP_TIMEOUT', '尚未开始生成排班'], ['SOLVE_TIMEOUT', '不能证明规则无解'], ['EXIT_TIMEOUT', '排班结果未能及时完成确认'], ['TIMEOUT', '无法据此判断规则是否无解']]) {
    const failure = formatSolverError(`${code}: 超时，原排班未被替换。`)
    assert.match(failure.message, new RegExp(phrase))
    assert.equal(failure.code, code)
    assert.equal(failure.message.match(/原排班未改变/g)?.length, 1)
    assert.doesNotMatch(failure.message, /原排班未被替换|。。|TIMEOUT|求解器|算法|组件|阶段/)
  }
})
test('native error objects and strings are formatted once with one preservation message', async () => {
  const { formatSolverError } = await import('../DesktopSolver.ts')
  const structured = formatSolverError({ code: 'STARTUP_TIMEOUT', message: 'loading 原排班未改变。' })
  assert.match(structured.message, /排班准备超时/)
  const generic = formatSolverError(new Error('PROCESS_EXIT: 缺少动态库。原排班未被替换。原排班未改变。'))
  assert.match(generic.message, /请重试.*导出本次规则/)
  assert.doesNotMatch(generic.message, /PROCESS_EXIT|动态库/)
  assert.equal(generic.message.match(/原排班/g)?.length, 1)
  assert.doesNotMatch(generic.message, /。。/)
  const checking = formatSolverError('STARTUP_TIMEOUT: check failed', 'startup')
  assert.doesNotMatch(checking.message, /原排班/)
  assert.equal(checking.diagnostic, true)
  for (const raw of ['unexpected library error at /usr/lib/test.dylib', { code: 'UNRECOGNIZED', message: 'C:\\Program Files\\App\\solver.exe' }]) {
    const unknown = formatSolverError(raw)
    assert.match(unknown.message, /请重试.*导出本次规则/)
    assert.doesNotMatch(unknown.message, /library|usr|dylib|UNRECOGNIZED|Program Files|solver.exe/)
  }
  const cancel = formatSolverError(new Error('Python ValueError: cancellation failed'), 'cancel')
  assert.match(cancel.message, /取消请求尚未完成.*当前结果不会写入排班表/)
  assert.doesNotMatch(cancel.message, /Python|ValueError/)
  const businessMessage = '小林 2026-10-02 早班需要 1 人，可用 0 人；月最低工时 144 小时。'
  assert.equal(formatUserMessage(businessMessage), businessMessage)
  assert.doesNotMatch(formatUserMessage('Traceback (most recent call last):\n  File "/Users/test/engine.py", line 71'), /Traceback|Users|engine.py/)
})
test('backend status prose cannot duplicate preservation text in the final result', () => {
  const request = fixture()
  const checked = checkDesktopResult(request, result(request, { status: 'UNKNOWN', message: '搜索未完成。OR-Tools CP-SAT UNKNOWN。原排班未被替换。' }))
  assert.equal(checked.message.match(/原排班/g)?.length, 1)
  assert.doesNotMatch(checked.message, /。。|OR-Tools|CP-SAT|UNKNOWN/)
  assert.match(checked.message, /不代表无解/)
})

test('startup diagnostics retain the failure category without displaying internal phase names', async () => {
  const { formatSolverError } = await import('../DesktopSolver.ts')
  for (const phase of ['starting', 'loading', 'reading']) {
    const failure = formatSolverError(`STARTUP_TIMEOUT: 等待超时（阶段 ${phase}）；原排班未被替换。`)
    assert.equal(failure.code, 'STARTUP_TIMEOUT')
    assert.match(failure.message, /尚未开始生成排班/)
    assert.match(failure.message, /请重试/)
    assert.doesNotMatch(failure.message, /starting|loading|reading|阶段|运行时|依赖|算法/)
  }
})
test('valid results survive a host exit-cleanup timeout while retaining raw diagnostics privately', () => {
  const request = fixture()
  const response = result(request, { hostDiagnostics: { exitTimedOut: true, phase: 'finishing', code: 'EXIT_TIMEOUT' } })
  const checked = checkDesktopResult(request, response)
  assert.equal(checked.success, true)
  assert.match(checked.message, /排班已生成/)
  assert.equal(response.status, 'FEASIBLE')
  assert.doesNotMatch(checked.message, /进程|清理超时|EXIT_TIMEOUT|算法/)
  assert.deepEqual(response.hostDiagnostics, { exitTimedOut: true, phase: 'finishing', code: 'EXIT_TIMEOUT' })
})

test('native claimed success cannot bypass monthly or prorated weekly minimums, even with shortage allowed', () => {
  for (const field of ['minHoursPerMonth', 'minHoursPerWeek']) {
    const request = fixture(true)
    request.state.employees[0][field] = 8
    const checked = checkDesktopResult(request, result(request))
    assert.equal(checked.success, false)
    assert.equal(checked.assignments, undefined)
    assert.ok(checked.issues.some(issue => issue.type === (field === 'minHoursPerMonth' ? 'monthly-min-hours' : 'weekly-min-hours')))
  }
})

test('unresolved reference-based minimum is independently enforced against forged native output', () => {
  const request = fixture(true)
  request.state.employees[0].minHoursPerMonth = null
  request.state.monthlyReferenceHours = { '2026-10': 16 }
  const checked = checkDesktopResult(request, result(request, { assignments: [{ employeeId: 'e1', date: '2026-10-01', shiftId: 'day', locked: false }] }))
  assert.equal(checked.success, false)
  assert.match(checked.message, /月最低工时 16/)
})

test('native weekday quotas are independently checked even when partial staffing is allowed', () => {
  const request = fixture(true)
  request.state.month = '2027-02'
  request.state.rules = { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: { days: [1, 6], percent: 40 } }
  request.state.employees = Array.from({ length: 3 }, (_, i) => ({ ...request.state.employees[0], id: `e${i}`, unavailableDates: [], maxHoursPerWeek: 168 }))
  const generated = generateSchedule(request.state, 17)
  assert.equal(generated.success, true)
  assert.equal(checkDesktopResult(request, result(request, { assignments: generated.assignments })).success, true)
  for (const allowPartial of [false, true]) {
    request.options.allowPartial = allowPartial
    const checked = checkDesktopResult(request, result(request, { assignments: generated.assignments.slice(1) }))
    assert.equal(checked.success, false)
    assert.equal(checked.assignments, undefined)
    assert.ok(checked.issues.some(issue => issue.type === 'weekday-quota'))
  }
})
