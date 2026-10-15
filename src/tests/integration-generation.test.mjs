import test from 'node:test'
import assert from 'node:assert/strict'
import { createIntegrationHandler, IntegrationError } from '../integrationData.ts'
import { parseBackup } from '../storage.ts'
import { createPayrollConfig } from '../payroll.ts'

const allPermissions = { members: true, shifts: true, rules: true, assignments: true }
const oldTime = '2020-01-01T00:00:00.000Z'
const assignment = (date = '2026-10-15', employeeId = 'e1', shiftId = 'day', locked = false) => ({ employeeId, date, shiftId, locked })
const fixture = () => ({
  version: 1, teamName: '外部自动排班测试', month: '2026-10',
  employees: ['e1', 'e2'].map(id => ({ id, name: id, role: '', group: '', color: '#123456', minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 48, eligibleShiftIds: ['day'], unavailableDates: [] })),
  shifts: [{ id: 'day', name: '白班', shortName: '白', start: '09:00', end: '17:00', color: '#123456', required: 0 }],
  rules: { minRestHours: 11, maxConsecutiveDays: 5 }, assignments: [],
})
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function response(request, overrides = {}) {
  return { protocolVersion: 1, requestId: request.requestId, engine: 'ortools-cp-sat', status: 'FEASIBLE', assignments: structuredClone(request.state.assignments), issues: [], stats: { wallTimeSeconds: 0.25, shortageCount: 0, optimal: false }, message: '可行', ...overrides }
}
function setup(initial = fixture()) {
  let state = parseBackup(JSON.stringify(initial)), permissions = { ...allPermissions }, busy = false, epoch = 0
  let saveError, releaseError, acquireError, onApply
  const calls = [], acquisitions = [], releases = [], sources = [], waiters = new Map()
  let held = 0, saves = 0
  const adapter = {
    acquire(request, source) {
      if (acquireError) throw acquireError
      const capturedEpoch = epoch
      held++
      acquisitions.push({ request, source })
      return {
        assertCurrent() { if (epoch !== capturedEpoch) throw new IntegrationError('生成任务的状态已失效', 409) },
        release(outcome, error) {
          held--
          releases.push({ outcome, error })
          if (releaseError) throw releaseError
        },
      }
    },
    solve(request, signal) {
      const gate = deferred(), call = { request, signal, ...gate }
      calls.push(call)
      waiters.get(calls.length - 1)?.resolve(call)
      return gate.promise
    },
  }
  const handle = createIntegrationHandler(() => state, (next, source) => {
    onApply?.(next, source)
    if (saveError) throw saveError
    state = next; saves++; sources.push(source)
  }, () => busy, () => permissions, adapter)
  const read = (source = 'mcp') => handle('get_state', {}, source)
  return {
    handle, read, calls, acquisitions, releases, sources,
    state: () => state, saves: () => saves, held: () => held,
    edit: change => { change(state) },
    replace: next => { state = next },
    setPermissions: next => { permissions = next },
    setBusy: value => { busy = value },
    invalidateLease: () => { epoch++ },
    failSave: error => { saveError = error },
    failRelease: error => { releaseError = error },
    failAcquire: error => { acquireError = error },
    onApply: callback => { onApply = callback },
    generate(args = {}, source = 'mcp', context) {
      const input = { revision: read(source).revision, ...args }
      return Promise.resolve().then(() => handle('generate_schedule', input, source, context))
    },
    nextSolve(index = 0) {
      if (calls[index]) return Promise.resolve(calls[index])
      if (!waiters.has(index)) waiters.set(index, deferred())
      return waiters.get(index).promise
    },
  }
}
async function finish(app, overrides = {}, args = {}, source = 'mcp', context) {
  const index = app.calls.length, pending = app.generate(args, source, context)
  const call = await app.nextSolve(index)
  call.resolve(response(call.request, overrides))
  return pending
}
const statusIs = status => error => error instanceof IntegrationError && error.status === status

test('generate_schedule validates its narrow arguments before taking a lease or running the solver', async () => {
  const app = setup(), before = app.read()
  const invalid = [
    { revision: undefined }, { revision: null }, { revision: 1 },
    ...['2026-1', '2026-00', '2026-13', '1899-12', '2201-01', '2026-10-01', null, 202610].map(month => ({ month })),
    ...[0, -1, 61, Infinity, NaN, '15', null].map(timeLimitSeconds => ({ timeLimitSeconds })),
    ...['state', 'seed', 'options', 'allowPartial', 'source'].map(key => ({ [key]: key === 'state' ? fixture() : true })),
  ]
  for (const args of invalid) await assert.rejects(app.generate(args), statusIs(400), JSON.stringify(args))
  await assert.rejects(app.generate({ revision: 'old-revision' }), statusIs(409))
  assert.equal(app.calls.length, 0)
  assert.equal(app.acquisitions.length, 0)
  assert.deepEqual(app.read(), before)
})

test('generation requires assignment permission, an idle application and a desktop adapter', async () => {
  const app = setup()
  app.setPermissions({ ...allPermissions, assignments: false })
  await assert.rejects(app.generate(), statusIs(403))
  app.setPermissions({ ...allPermissions })
  app.setBusy(true)
  await assert.rejects(app.generate(), statusIs(409))
  assert.equal(app.calls.length, 0)
  assert.equal(app.acquisitions.length, 0)
  const state = fixture()
  const handle = createIntegrationHandler(() => state, () => assert.fail('cannot save without solver'), () => false, () => allPermissions)
  const { revision } = handle('get_state', {}, 'mcp')
  await assert.rejects(async () => handle('generate_schedule', { revision }, 'mcp'), statusIs(503))
})

test('generation accepts month and time-limit boundaries and defaults to current month and 15 seconds', async () => {
  for (const args of [{}, { month: '1900-01', timeLimitSeconds: 1 }, { month: '2200-12', timeLimitSeconds: 60 }]) {
    const app = setup()
    const result = await finish(app, {}, args)
    assert.equal(result.success, true)
    assert.equal(result.month, args.month ?? '2026-10')
    assert.equal(app.calls[0].request.options.timeLimitSeconds, args.timeLimitSeconds ?? 15)
    assert.equal(app.calls[0].request.options.allowPartial, false)
    assert.equal(app.state().month, '2026-10', 'generating a different month does not navigate the calendar')
  }
})

test('the request uses saved configuration and native identity, while a successful save preserves defaults, avatars and other-month order', async () => {
  const initial = fixture()
  Object.assign(initial, createPayrollConfig())
  initial.calendar = { '2026-11-02': 'restday' }
  initial.monthlyReferenceHours = { '2026-10': 160, '2026-11': 8 }
  initial.employees[0].minHoursPerMonth = null
  initial.employees[0].avatar = 'data:image/jpeg;base64,/9j//9k='
  initial.employees[1].avatar = null
  initial.shifts[0].normalAllowance = 12.5
  initial.rules.weeklyShiftLimits = [{ id: 'weekly-day', shiftId: 'day', maxPerWeek: 4 }]
  initial.assignments = [assignment('2026-12-05', 'e2', 'off'), assignment('2026-11-01'), assignment('2026-09-01', 'e1', 'off'), assignment('2026-10-11', 'e2', 'off')]
  const app = setup(initial), before = structuredClone(app.state()), controller = new AbortController()
  let claimed = false
  app.onApply((_next, source) => {
    assert.equal(claimed, true)
    assert.equal(app.held(), 1, 'lease remains held during persistence')
    assert.equal(source, 'http')
  })
  const earliest = Date.now()
  const pending = app.generate({ month: '2026-11', timeLimitSeconds: 30 }, 'http', {
    requestId: 'native-request-73', signal: controller.signal,
    claimCommit: async () => { claimed = true },
  })
  const call = await app.nextSolve()
  assert.equal(call.request.requestId, 'native-request-73')
  assert.equal(call.signal, controller.signal)
  assert.equal(call.request.state.month, '2026-11')
  assert.equal(call.request.state.employees[0].minHoursPerMonth, 8)
  assert.ok(call.request.state.employees.every(employee => !Object.hasOwn(employee, 'avatar')))
  for (const key of ['shifts', 'rules', 'calendar', 'monthlyReferenceHours', 'payroll']) assert.deepEqual(call.request.state[key], before[key])
  assert.deepEqual(call.request.state.assignments, before.assignments)
  const otherMonths = before.assignments.filter(item => !item.date.startsWith('2026-11-'))
  call.resolve(response(call.request, { assignments: [...otherMonths].reverse().concat(assignment('2026-11-02')) }))
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(result.saved, true)
  assert.equal(result.month, '2026-11')
  assert.equal(result.status, 'FEASIBLE')
  assert.deepEqual(result.stats, { wallTimeSeconds: 0.25, shortageCount: 0, optimal: false })
  assert.deepEqual(app.state().assignments.filter(item => !item.date.startsWith('2026-11-')), otherMonths)
  assert.deepEqual(app.state().assignments.filter(item => item.date.startsWith('2026-11-')), [assignment('2026-11-02')])
  for (const key of Object.keys(before).filter(key => !['assignments', 'provenance'].includes(key))) assert.deepEqual(JSON.parse(JSON.stringify(app.state()[key])), before[key], key)
  assert.equal(result.generatedAt, app.state().provenance.scheduleUpdates['2026-11'].at)
  assert.equal(app.state().provenance.scheduleUpdates['2026-11'].source, 'http')
  assert.ok(Date.parse(result.generatedAt) >= earliest && Date.parse(result.generatedAt) <= Date.now())
  assert.deepEqual(result.state, app.read().state)
  assert.equal(result.revision, app.read().revision)
  assert.deepEqual(app.sources, ['http'])
  assert.equal(app.held(), 0)
  assert.equal(app.releases.length, 1)
})

test('successful identical assignments still update generation time and clear only the generated month invalidation', async () => {
  const initial = fixture()
  initial.assignments = [assignment('2026-09-10'), assignment()]
  initial.provenance = {
    fields: { 'employees.e1.name': { source: 'manual', at: oldTime } },
    pendingExternalChange: { source: 'mcp', at: oldTime, categories: ['成员'] },
    scheduleUpdates: { '2026-09': { source: 'http', at: oldTime }, '2026-10': { source: 'http', at: oldTime } },
    invalidatedSchedules: { '2026-09': { source: 'manual', at: oldTime }, '2026-10': { source: 'mcp', at: oldTime } },
  }
  const app = setup(initial), before = app.read()
  const result = await finish(app)
  assert.equal(result.success, true)
  assert.equal(app.saves(), 1)
  assert.deepEqual(app.state().assignments, before.state.assignments)
  assert.notEqual(result.revision, before.revision)
  assert.notEqual(result.generatedAt, oldTime)
  assert.equal(app.state().provenance.scheduleUpdates['2026-10'].source, 'mcp')
  assert.equal(app.state().provenance.invalidatedSchedules?.['2026-10'], undefined)
  for (const key of ['fields', 'pendingExternalChange']) assert.deepEqual(app.state().provenance[key], before.state.provenance[key])
  assert.deepEqual(app.state().provenance.scheduleUpdates['2026-09'], before.state.provenance.scheduleUpdates['2026-09'])
  assert.deepEqual(app.state().provenance.invalidatedSchedules['2026-09'], before.state.provenance.invalidatedSchedules['2026-09'])
})

test('solver non-success is a structured unsaved outcome with diagnostics, and releases the lock for a retry', async () => {
  for (const status of ['INFEASIBLE', 'UNKNOWN', 'MODEL_INVALID', 'ERROR']) {
    const app = setup(), before = app.read()
    const result = await finish(app, { status, assignments: [assignment()], issues: [{ id: 'conflict', type: 'coverage-capacity', severity: 'error', message: '当天没有可用成员' }] })
    assert.equal(result.success, false, status)
    assert.equal(result.saved, false)
    assert.equal(result.status, status)
    assert.equal(result.month, '2026-10')
    assert.equal(result.revision, before.revision)
    assert.equal(result.state, undefined)
    assert.equal(result.generatedAt, undefined)
    assert.ok(result.message.length > 0)
    assert.equal(result.issues[0].id, 'conflict')
    assert.deepEqual(result.stats, { wallTimeSeconds: 0.25, shortageCount: 0, optimal: false })
    assert.deepEqual(app.read(), before)
    assert.equal(app.saves(), 0)
    assert.equal(app.held(), 0)
    assert.equal(app.releases.length, 1)
    assert.equal((await finish(app)).success, true)
  }
})

test('successful native claims still undergo real independent rule, lock and other-month validation', async () => {
  const cases = [
    ['leave violation', state => { state.employees[0].unavailableDates = ['2026-10-15'] }, () => [assignment()]],
    ['weekly hours', state => { state.employees[0].maxHoursPerWeek = 4 }, () => [assignment()]],
    ['short staffing', state => { state.shifts[0].required = 1 }, () => []],
    ['locked day off removed', state => { state.assignments = [assignment('2026-10-15', 'e1', 'off', true)] }, () => []],
    ['locked day off changed', state => { state.assignments = [assignment('2026-10-15', 'e1', 'off', true)] }, () => [assignment()]],
    ['lock forged', () => {}, () => [assignment('2026-10-15', 'e1', 'day', true)]],
    ['history removed', state => { state.assignments = [assignment('2026-09-15')] }, () => []],
    ['history changed', state => { state.assignments = [assignment('2026-09-15')] }, () => [assignment('2026-09-15', 'e1', 'off')]],
    ['history added', () => {}, () => [assignment('2026-09-15')]],
    ['malformed assignments', () => {}, () => [{ employeeId: 'e1' }]],
  ]
  for (const [name, change, assignments] of cases) {
    const initial = fixture(); change(initial)
    const app = setup(initial), before = app.read()
    const result = await finish(app, { assignments: assignments(), issues: [], stats: { wallTimeSeconds: 0, shortageCount: 0, optimal: true } })
    assert.equal(result.success, false, name)
    assert.equal(result.saved, false, name)
    assert.ok(result.message.length > 0, name)
    assert.deepEqual(app.read(), before, name)
    assert.equal(app.saves(), 0, name)
    assert.equal(app.held(), 0, name)
  }
})

test('forged request identity, engine or protocol cannot turn a native response into a saved schedule', async () => {
  for (const change of [{ requestId: 'another-request' }, { engine: 'browser' }, { protocolVersion: 2 }]) {
    const app = setup(), before = app.read()
    const result = await finish(app, change)
    assert.equal(result.success, false)
    assert.equal(result.saved, false)
    assert.deepEqual(app.read(), before)
    assert.equal(app.saves(), 0)
    assert.equal(app.held(), 0)
  }
})

test('an active generation blocks other writes and generation, but permits synchronous reads and validation', async () => {
  const app = setup(), pending = app.generate(), call = await app.nextSolve()
  const current = app.read()
  assert.equal(typeof current.then, 'undefined')
  const validation = app.handle('validate_schedule', {}, 'http')
  assert.equal(typeof validation.then, 'undefined')
  assert.equal(validation.revision, current.revision)
  assert.throws(() => app.handle('replace_state', current, 'http'), statusIs(409))
  assert.throws(() => app.handle('set_assignment', { revision: current.revision, employeeId: 'e1', date: '2026-10-15', shiftId: 'day' }, 'mcp'), statusIs(409))
  await assert.rejects(app.generate(), statusIs(409))
  assert.equal(app.acquisitions.length, 1)
  assert.equal(app.calls.length, 1)
  call.resolve(response(call.request))
  assert.equal((await pending).success, true)
  assert.equal(app.held(), 0)
})

test('state changes, permission revocation, ABA lease invalidation and service stop during solve prevent commit', async () => {
  const cases = [
    ['configuration changed', app => app.edit(state => { state.employees[0].name = '本地修改' })],
    ['active month changed', app => app.edit(state => { state.month = '2026-11' })],
    ['permission revoked', app => app.setPermissions({ ...allPermissions, assignments: false })],
    ['document ABA', app => { const original = structuredClone(app.state()); app.edit(state => { state.employees[0].name = '临时修改' }); app.invalidateLease(); app.replace(original) }],
    ['permission ABA', app => { app.setPermissions({ ...allPermissions, assignments: false }); app.invalidateLease(); app.setPermissions({ ...allPermissions }) }],
  ]
  for (const [name, change] of cases) {
    const app = setup(), pending = app.generate(), call = await app.nextSolve()
    change(app)
    const before = app.read()
    call.resolve(response(call.request, { assignments: [assignment()] }))
    await assert.rejects(pending, error => error instanceof IntegrationError && [403, 409].includes(error.status), name)
    assert.deepEqual(app.read(), before, name)
    assert.equal(app.saves(), 0, name)
    assert.equal(app.held(), 0, name)
    assert.equal(app.releases.length, 1, name)
  }
  const app = setup(), stopped = new IntegrationError('服务已停止', 409)
  let active = true, claims = 0
  const pending = app.generate({}, 'mcp', { assertActive() { if (!active) throw stopped }, claimCommit: async () => { claims++ } })
  const call = await app.nextSolve()
  active = false
  call.resolve(response(call.request))
  await assert.rejects(pending, error => error === stopped)
  assert.equal(claims, 0)
  assert.equal(app.saves(), 0)
  assert.equal(app.held(), 0)
})

test('cancelled request signals are honored before solve and after an otherwise valid solve', async () => {
  for (const preaborted of [true, false]) for (const explicitReason of [true, false]) {
    const app = setup(), controller = new AbortController(), reason = explicitReason ? new IntegrationError('请求已取消', 409) : undefined
    if (preaborted) controller.abort(reason)
    const pending = app.generate({}, 'mcp', { signal: controller.signal })
    if (!preaborted) {
      const call = await app.nextSolve()
      assert.equal(call.signal, controller.signal)
      controller.abort(reason)
      call.resolve(response(call.request))
    }
    await assert.rejects(pending, explicitReason ? error => error === reason : statusIs(409))
    assert.equal(app.saves(), 0)
    assert.equal(app.calls.length, preaborted ? 0 : 1)
    assert.equal(app.held(), 0)
  }
})

test('the generation lease covers asynchronous commit claiming, including reads and write exclusion', async () => {
  const app = setup(), gate = deferred(), entered = deferred()
  const pending = app.generate({}, 'mcp', { claimCommit() { entered.resolve(); return gate.promise } })
  const call = await app.nextSolve()
  call.resolve(response(call.request))
  await entered.promise
  assert.equal(app.held(), 1)
  assert.equal(app.saves(), 0)
  assert.equal(app.releases.length, 0)
  const before = app.read()
  assert.equal(app.handle('validate_schedule', {}, 'http').revision, before.revision)
  assert.throws(() => app.handle('replace_state', before, 'http'), statusIs(409))
  await assert.rejects(app.generate(), statusIs(409))
  gate.resolve()
  assert.equal((await pending).success, true)
  assert.equal(app.saves(), 1)
  assert.equal(app.held(), 0)
})

test('all commit guards run again after asynchronous claiming, so changes during the claim cannot be saved', async () => {
  for (const kind of ['state', 'lease', 'permission', 'context', 'abort']) {
    const app = setup(), claim = deferred(), entered = deferred(), controller = new AbortController()
    let active = true
    const pending = app.generate({}, 'mcp', {
      signal: controller.signal,
      assertActive() { if (!active) throw new IntegrationError('请求已过期', 409) },
      claimCommit() { entered.resolve(); return claim.promise },
    })
    const call = await app.nextSolve()
    call.resolve(response(call.request, { assignments: [assignment()] }))
    await entered.promise
    if (kind === 'state') app.edit(state => { state.rules.minRestHours = 12 })
    if (kind === 'lease') app.invalidateLease()
    if (kind === 'permission') app.setPermissions({ ...allPermissions, assignments: false })
    if (kind === 'context') active = false
    if (kind === 'abort') controller.abort(new IntegrationError('请求已取消', 409))
    const before = app.read()
    claim.resolve()
    await assert.rejects(pending, error => error instanceof IntegrationError && [403, 409].includes(error.status), kind)
    assert.deepEqual(app.read(), before, kind)
    assert.equal(app.saves(), 0, kind)
    assert.equal(app.held(), 0, kind)
    assert.equal(app.releases.length, 1, kind)
  }
})

test('a rejected commit claim releases the lease without saving and permits a fresh generation', async () => {
  const app = setup(), before = app.read(), failure = new IntegrationError('原生请求已超时', 409)
  const pending = app.generate({}, 'http', { claimCommit: async () => { throw failure } })
  const call = await app.nextSolve()
  call.resolve(response(call.request, { assignments: [assignment()] }))
  await assert.rejects(pending, error => error === failure)
  assert.deepEqual(app.read(), before)
  assert.equal(app.saves(), 0)
  assert.equal(app.held(), 0)
  assert.equal((await finish(app)).success, true)
})

test('solver rejection releases the lease, preserves the original error and permits retry', async () => {
  const app = setup(), before = app.read(), failure = new Error('原生求解进程退出')
  app.failRelease(new Error('清理回调失败'))
  const pending = app.generate(), call = await app.nextSolve()
  call.reject(failure)
  await assert.rejects(pending, error => error === failure)
  assert.deepEqual(app.read(), before)
  assert.equal(app.saves(), 0)
  assert.equal(app.held(), 0)
  app.failRelease(undefined)
  assert.equal((await finish(app)).success, true)
})

test('failed persistence never publishes assignments, generation time or an invalidation acknowledgement', async () => {
  const initial = fixture()
  initial.assignments = [assignment()]
  initial.provenance = { fields: {}, scheduleUpdates: { '2026-10': { source: 'http', at: oldTime } }, invalidatedSchedules: { '2026-10': { source: 'manual', at: oldTime } } }
  const app = setup(initial), before = app.read(), failure = new Error('磁盘写入失败')
  app.failSave(failure)
  const pending = app.generate(), call = await app.nextSolve()
  call.resolve(response(call.request, { assignments: [assignment('2026-10-16')] }))
  await assert.rejects(pending, error => error === failure)
  assert.deepEqual(app.read(), before)
  assert.equal(app.saves(), 0)
  assert.equal(app.held(), 0)
  assert.equal(app.releases.length, 1)
  app.failSave(undefined)
  assert.equal((await finish(app)).success, true)
})

test('a release callback error cannot change an already persisted success into failure or leave generation busy', async () => {
  const app = setup()
  app.failRelease(new Error('通知清理失败'))
  const result = await finish(app, { assignments: [assignment()] })
  assert.equal(result.success, true)
  assert.equal(result.saved, true)
  assert.equal(app.saves(), 1)
  assert.equal(app.held(), 0)
  assert.deepEqual(result.state, app.read().state)
  assert.equal((await finish(app)).success, true)
  assert.equal(app.saves(), 2)
})

test('failed lease acquisition and an already inactive request never start the solver or consume a lease', async () => {
  const app = setup(), failure = new IntegrationError('已有本地生成任务', 409)
  app.failAcquire(failure)
  await assert.rejects(app.generate(), error => error === failure)
  assert.equal(app.calls.length, 0)
  assert.equal(app.held(), 0)
  assert.equal(app.releases.length, 0)
  app.failAcquire(undefined)
  await assert.rejects(app.generate({}, 'mcp', { assertActive() { throw failure } }), error => error === failure)
  assert.equal(app.calls.length, 0)
  assert.equal(app.held(), 0)
  assert.equal(app.saves(), 0)
  assert.equal((await finish(app)).success, true)
})
