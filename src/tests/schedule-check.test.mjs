import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker as NodeWorker } from 'node:worker_threads'
import { once } from 'node:events'
import { checkSchedule, classifyScheduleIssues, scheduleCheckSnapshot } from '../scheduleCheck.ts'
import { createScheduleCheckRunner } from '../scheduleCheckRunner.ts'
import { schedulingReferenceDate } from '../weekBoundary.ts'

const referenceDate = '2026-10-15'
const state = (month = '2026-10') => ({
  version: 1, teamName: '独立检查', month,
  employees: [{ id: 'a', name: '成员甲', role: '员工', group: '', color: '#fff', avatar: 'data:image/jpeg;base64,photo', minHoursPerWeek: 0, maxHoursPerWeek: 40, eligibleShiftIds: ['day', 'night'], unavailableDates: [] }],
  shifts: [
    { id: 'day', name: '白班', shortName: '白', start: '08:00', end: '16:00', color: '#fff', required: 0 },
    { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#ddd', required: 0 },
  ],
  rules: { minRestHours: 11, maxConsecutiveDays: 5 }, assignments: [],
  scheduleCoverage: Object.fromEntries(['2026-09', '2026-10', '2026-11', '2026-12'].map(month => [month, { employeeIds: ['a'] }])),
})
const assignment = (date, shiftId = 'day') => ({ employeeId: 'a', date, shiftId, locked: false })
const warning = type => ({ id: type, type, severity: 'warning', message: type })
const tick = () => new Promise(resolve => queueMicrotask(resolve))

function fakeWorker() {
  return {
    onmessage: null, onerror: null, onmessageerror: null,
    messages: [], terminated: false,
    postMessage(message) { this.messages.push(message) },
    terminate() { this.terminated = true },
    reply(result, overrides = {}) {
      const request = this.messages.at(-1)
      this.onmessage?.({ data: { requestId: request.requestId, month: request.month, result, ...overrides } })
    },
  }
}

function setup(options = {}) {
  const events = [], workers = []
  const runner = createScheduleCheckRunner({
    createWorker: () => { const worker = fakeWorker(); workers.push(worker); return worker },
    onChange: event => events.push(event), ...options,
  })
  return { runner, events, workers }
}

test('saved roster validation distinguishes compliant, broken rules and missing neighbouring data', () => {
  const valid = state()
  const before = JSON.stringify(valid)
  const result = checkSchedule(valid, { referenceDate })
  assert.equal(result.status, 'compliant')
  assert.equal(result.month, valid.month)
  assert.deepEqual(result.issues, [])
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)))
  assert.equal(JSON.stringify(valid), before)

  const unknown = state()
  delete unknown.scheduleCoverage['2026-11']
  const pending = checkSchedule(unknown, { referenceDate })
  assert.equal(pending.status, 'pending')
  assert.ok(pending.issues.some(issue => issue.type === 'boundary-future-unconfirmed'))

  const broken = state()
  broken.assignments = [assignment('2026-09-30', 'night'), assignment('2026-10-01')]
  const failed = checkSchedule(broken, { referenceDate })
  assert.equal(failed.status, 'noncompliant')
  assert.ok(failed.issues.some(issue => issue.type === 'rest'))
})

test('staffing shortages are noncompliant, including warning-only coverage', () => {
  const value = state()
  value.shifts[0].required = 1
  const result = checkSchedule(value, { referenceDate })
  assert.ok(result.issues.length > 0)
  assert.ok(result.issues.every(issue => issue.severity === 'warning'))
  assert.equal(result.status, 'noncompliant')
  for (const type of ['coverage', 'boundary-coverage']) {
    assert.equal(classifyScheduleIssues([warning(type)]), 'noncompliant')
    assert.equal(classifyScheduleIssues([warning('boundary-history-incomplete'), warning(type)]), 'noncompliant')
  }
  assert.equal(classifyScheduleIssues([warning('boundary-history-incomplete')]), 'pending')
})

test('check snapshot detaches all rule and history data while excluding only avatars', () => {
  const original = state()
  original.assignments.push(assignment('2026-09-30', 'night'))
  original.rules.weeklyShiftLimits = [{ id: 'limit', shiftId: 'night', maxPerWeek: 1 }]
  original.rules.separationGroups = [{ id: 'group', name: '互斥', employeeIds: ['a'], shiftIds: [] }]
  const snapshot = scheduleCheckSnapshot(original)
  const expected = structuredClone(original)
  delete expected.employees[0].avatar
  assert.deepEqual(snapshot, expected)
  snapshot.assignments[0].locked = true
  snapshot.employees[0].unavailableDates.push('2026-10-02')
  snapshot.rules.weeklyShiftLimits[0].maxPerWeek = 2
  snapshot.scheduleCoverage['2026-09'].employeeIds.length = 0
  assert.equal(original.assignments[0].locked, false)
  assert.deepEqual(original.employees[0].unavailableDates, [])
  assert.equal(original.rules.weeklyShiftLimits[0].maxPerWeek, 1)
  assert.deepEqual(original.scheduleCoverage['2026-09'].employeeIds, ['a'])
  original.employees[0].maxHoursPerWeek = NaN
  assert.throws(() => scheduleCheckSnapshot(original), /无效数字/)
})

test('runner publishes loading immediately and sends a detached snapshot with frozen reference date', async t => {
  const { runner, workers, events } = setup()
  t.after(() => runner.dispose())
  const original = state()
  runner.start(original)
  assert.deepEqual(events, [{ status: 'checking', month: '2026-10' }])
  assert.equal(workers.length, 0)
  original.rules.minRestHours = 0
  await tick()
  const [worker] = workers
  const request = worker.messages[0]
  assert.equal(request.referenceDate, schedulingReferenceDate())
  assert.equal(request.state.rules.minRestHours, 11)
  assert.equal(request.state.employees[0].avatar, undefined)
  worker.reply(checkSchedule(request.state, { referenceDate: request.referenceDate }))
  assert.equal(events.at(-1).status, 'ready')
  assert.equal(events.at(-1).result.status, 'compliant')
  assert.equal(worker.terminated, true)
})

test('changing month cancels previous CPU work and rejects its already queued result', async t => {
  const { runner, workers, events } = setup()
  t.after(() => runner.dispose())
  runner.start(state())
  await tick()
  const oldWorker = workers[0], oldMessage = oldWorker.onmessage, oldRequest = oldWorker.messages[0]
  runner.start(state('2026-11'))
  await tick()
  assert.equal(oldWorker.terminated, true)
  oldMessage({ data: { requestId: oldRequest.requestId, month: '2026-10', result: checkSchedule(oldRequest.state, { referenceDate }) } })
  assert.deepEqual(events.map(event => event.status), ['checking', 'checking'])
  workers[1].reply(checkSchedule(workers[1].messages[0].state, { referenceDate }))
  assert.equal(events.at(-1).month, '2026-11')
  assert.equal(events.at(-1).status, 'ready')
})

test('a newer check in the same month also rejects stale results and mismatched response months', async t => {
  const { runner, workers, events } = setup()
  t.after(() => runner.dispose())
  runner.start(state())
  await tick()
  const staleHandler = workers[0].onmessage, staleRequest = workers[0].messages[0]
  const current = state()
  current.shifts[0].required = 1
  runner.start(current)
  await tick()
  const worker = workers[1], request = worker.messages[0]
  assert.notEqual(request.requestId, staleRequest.requestId)
  staleHandler({ data: { requestId: staleRequest.requestId, month: staleRequest.month, result: checkSchedule(staleRequest.state, { referenceDate }) } })
  worker.reply(checkSchedule(request.state, { referenceDate }), { requestId: staleRequest.requestId })
  worker.reply(checkSchedule(request.state, { referenceDate }), { month: '2026-11' })
  assert.equal(events.filter(event => event.status === 'ready').length, 0)
  worker.reply(checkSchedule(request.state, { referenceDate }))
  assert.equal(events.at(-1).result.status, 'noncompliant')
})

test('synchronous replacement before posting creates only the latest worker', async t => {
  const { runner, workers, events } = setup()
  t.after(() => runner.dispose())
  runner.start(state())
  runner.start(state('2026-11'))
  await tick()
  assert.equal(workers.length, 1)
  assert.equal(workers[0].messages[0].month, '2026-11')
  assert.deepEqual(events.map(event => event.status), ['checking', 'checking'])
})

test('cancel and dispose prevent pending work and delayed callbacks from changing UI', async () => {
  const { runner, workers, events } = setup()
  runner.start(state())
  runner.cancel()
  await tick()
  assert.equal(workers.length, 0)
  runner.start(state())
  await tick()
  const request = workers[0].messages[0], handler = workers[0].onmessage
  runner.dispose()
  handler({ data: { requestId: request.requestId, month: request.month, result: checkSchedule(request.state, { referenceDate }) } })
  runner.start(state('2026-11'))
  assert.equal(workers[0].terminated, true)
  assert.deepEqual(events.map(event => event.status), ['checking', 'checking'])
})

test('timeout stops the worker, exposes a retryable error, and allows a later successful check', async t => {
  let timedOut
  const timeout = new Promise(resolve => { timedOut = resolve })
  const events = []
  const { runner, workers } = setup({ timeoutMs: 10, onChange: event => { events.push(event); if (event.status === 'error') timedOut() } })
  t.after(() => runner.dispose())
  runner.start(state())
  await timeout
  assert.equal(workers[0].terminated, true)
  assert.match(events.at(-1).message, /超时.*重试/)
  runner.start(state())
  await tick()
  workers[1].reply(checkSchedule(workers[1].messages[0].state, { referenceDate }))
  assert.equal(events.at(-1).status, 'ready')
})

test('worker construction and posting failures do not silently validate on the main thread', async t => {
  for (const failure of ['create', 'post']) {
    const worker = fakeWorker()
    worker.postMessage = () => { throw new Error('cannot post') }
    const events = []
    const runner = createScheduleCheckRunner({
      createWorker: () => { if (failure === 'create') throw new Error('no worker'); return worker },
      onChange: event => events.push(event),
    })
    t.after(() => runner.dispose())
    runner.start(state())
    await tick()
    assert.deepEqual(events.map(event => event.status), ['checking', 'error'])
    assert.match(events.at(-1).message, /无法启动.*重试/)
    if (failure === 'post') assert.equal(worker.terminated, true)
  }
})

test('worker runtime, message decoding and reported validation errors terminate the active run', async t => {
  for (const failure of ['runtime', 'message', 'reported']) {
    const { runner, workers, events } = setup()
    t.after(() => runner.dispose())
    runner.start(state())
    await tick()
    const worker = workers[0]
    if (failure === 'runtime') worker.onerror({ preventDefault() {} })
    if (failure === 'message') worker.onmessageerror({})
    if (failure === 'reported') worker.reply(undefined, { error: '规则数据无效，请重试。' })
    assert.equal(events.at(-1).status, 'error')
    assert.equal(worker.terminated, true)
  }
})

test('malformed or contradictory worker results fail instead of showing compliance', async t => {
  for (const result of [null, { month: '2026-11', status: 'compliant', issues: [], checkedAt: new Date().toISOString() },
    { month: '2026-10', status: 'compliant', issues: [warning('coverage')], checkedAt: new Date().toISOString() }]) {
    const { runner, workers, events } = setup()
    t.after(() => runner.dispose())
    runner.start(state())
    await tick()
    workers[0].reply(result)
    assert.equal(events.at(-1).status, 'error')
    assert.match(events.at(-1).message, /无效结果/)
  }
})

test('snapshot errors remain visible and do not create a background worker', async t => {
  const { runner, workers, events } = setup()
  t.after(() => runner.dispose())
  const invalid = state()
  invalid.shifts[0].required = Infinity
  runner.start(invalid)
  await tick()
  assert.equal(workers.length, 0)
  assert.equal(events.at(-1).status, 'error')
  assert.match(events.at(-1).message, /无效数字/)
})

test('real worker entry returns saved-roster checks and preserves request/month correlation', async t => {
  const workerEntry = new URL('../schedule-check.worker.ts', import.meta.url).href
  const bootstrap = `import { parentPort } from 'node:worker_threads';
    globalThis.self = { postMessage: message => parentPort.postMessage(message) };
    await import(${JSON.stringify(workerEntry)});
    parentPort.on('message', data => self.onmessage({ data }));
    parentPort.postMessage({ ready: true });`
  const worker = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`))
  t.after(() => worker.terminate())
  assert.deepEqual((await once(worker, 'message'))[0], { ready: true })
  const value = state()
  value.assignments = [assignment('2026-09-30', 'night'), assignment('2026-10-01')]
  worker.postMessage({ requestId: 'actual-worker', month: value.month, referenceDate, state: value })
  const response = (await once(worker, 'message'))[0]
  assert.equal(response.requestId, 'actual-worker')
  assert.equal(response.month, value.month)
  assert.equal(response.result.status, 'noncompliant')
  assert.ok(response.result.issues.some(issue => issue.type === 'rest'))
  worker.postMessage({ requestId: 'wrong-month', month: '2026-11', referenceDate, state: value })
  const failure = (await once(worker, 'message'))[0]
  assert.equal(failure.requestId, 'wrong-month')
  assert.match(failure.error, /月份.*不一致/)
})
