import test from 'node:test'
import assert from 'node:assert/strict'
import { createHttpApiDocs } from '../httpApiDocs.ts'
import { createIntegrationHandler } from '../integrationData.ts'
import { generateSchedule } from '../scheduler.ts'

const base = 'http://127.0.0.1:54321'
const token = 'test-http-token'
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
function fixture() {
  return {
    version: 1, teamName: '接口示例验证', month: '2026-10',
    employees: ['e1', 'e2'].map(id => ({ id, name: id, role: '', group: '', color: '#123456', minHoursPerWeek: 0, maxHoursPerWeek: 48, eligibleShiftIds: ['day'], unavailableDates: [] })),
    shifts: [{ id: 'day', name: '白班', shortName: '白', start: '09:00', end: '17:00', color: '#123456', required: 1 }],
    assignments: [{ employeeId: 'e2', date: '2026-09-30', shiftId: 'day', locked: true }],
    rules: { minRestHours: 11, maxConsecutiveDays: 5 },
    calendar: { '2026-10-01': 'statutory' }, monthlyReferenceHours: { '2026-10': 160 },
  }
}
function app(allowAssignments = false, generation) {
  let state = fixture(), saves = 0
  const requests = []
  let beforeWrite = () => {}
  const handle = createIntegrationHandler(() => state, next => { state = next; saves++ }, () => false,
    () => ({ members: true, shifts: false, rules: false, assignments: allowAssignments }), generation)
  const fetch = async (url, options) => {
    assert.ok(url.startsWith(base + '/api/'))
    assert.equal(options.headers.Authorization, `Bearer ${token}`)
    const method = options.method ?? 'GET'
    const path = url.slice(base.length)
    requests.push({ method, path })
    if (options.body) {
      assert.equal(options.headers['Content-Type'], 'application/json')
      beforeWrite()
    }
    const route = ({ 'GET /api/state': 'get_state', 'PUT /api/state': 'replace_state', 'POST /api/assignments': 'set_assignment', 'POST /api/schedules/generate': 'generate_schedule' })[`${method} ${path}`]
    assert.ok(route, 'sample must call an implemented route')
    try {
      const result = await handle(route, options.body ? JSON.parse(options.body) : {}, 'http')
      return { ok: true, status: 200, json: async () => structuredClone(result) }
    } catch (error) {
      return { ok: false, status: error.status ?? 400, json: async () => ({ error: error.message }) }
    }
  }
  return { state: () => state, fetch, requests, saves: () => saves, snapshot: () => handle('get_state', {}, 'http'), beforeWrite: value => { beforeWrite = value } }
}
function example(id, resolvePlaceholders = true) {
  let code = createHttpApiDocs(base + '/', token).find(doc => doc.id === id).example
  if (resolvePlaceholders) code = code.replace("'REPLACE_EMPLOYEE_ID'", "'e1'").replace("'REPLACE_YYYY_MM_DD'", "'2026-10-15'")
  return new AsyncFunction('fetch', 'console', code)
}
const silent = { log() {} }

test('copied full-document update example changes only the intended member and preserves all other data', async () => {
  const current = app(), before = current.snapshot().state
  await example('put-state')(current.fetch, silent)
  const { provenance, ...saved } = current.state()
  before.employees[0].role = '值班主管'
  assert.deepEqual(saved, before)
  assert.equal(provenance.fields['employees.e1.role'].source, 'http')
  assert.equal(current.saves(), 1)
  assert.deepEqual(current.requests, [{ method: 'GET', path: '/api/state' }, { method: 'PUT', path: '/api/state' }])
})

test('copied assignment example uses a current revision and respects assignment permission', async () => {
  const denied = app()
  await assert.rejects(example('set-assignment')(denied.fetch, silent), /HTTP 403/)
  assert.equal(denied.saves(), 0)
  const allowed = app(true)
  await example('set-assignment')(allowed.fetch, silent)
  assert.deepEqual(allowed.state().assignments, [...fixture().assignments, { employeeId: 'e1', date: '2026-10-15', shiftId: 'off', locked: false }])
  assert.equal(allowed.state().provenance.scheduleUpdates['2026-10'].source, 'http')
})

test('copying examples without replacing target placeholders cannot write data', async () => {
  for (const id of ['put-state', 'set-assignment']) {
    const current = app(true)
    await assert.rejects(example(id, false)(current.fetch, silent), /替换/)
    assert.equal(current.saves(), 0)
    assert.deepEqual(current.requests, [{ method: 'GET', path: '/api/state' }])
  }
})

test('write examples surface revision conflicts and locked assignments without automatic retries', async () => {
  const conflicting = app()
  conflicting.beforeWrite(() => { conflicting.state().employees[1].group = '新修改' })
  await assert.rejects(example('put-state')(conflicting.fetch, silent), /HTTP 409/)
  assert.equal(conflicting.saves(), 0)
  assert.equal(conflicting.state().employees[1].group, '新修改')
  assert.equal(conflicting.requests.length, 2)
  const locked = app(true)
  locked.state().assignments.push({ employeeId: 'e1', date: '2026-10-15', shiftId: 'day', locked: true })
  await assert.rejects(example('set-assignment')(locked.fetch, silent), /锁定/)
  assert.equal(locked.saves(), 0)
  assert.equal(locked.requests.length, 2)
})

function generationAdapter(fail = false) {
  const calls = []
  return {
    calls,
    acquire: () => ({ assertCurrent() {}, release() {} }),
    async solve(request) {
      calls.push(request)
      const result = fail ? undefined : generateSchedule(request.state)
      if (result) assert.equal(result.success, true)
      return { protocolVersion: 1, requestId: request.requestId, engine: 'ortools-cp-sat',
        status: fail ? 'INFEASIBLE' : 'FEASIBLE', issues: fail ? [{ id: 'no-room', type: 'weekly-hours', severity: 'error', message: '测试配置无解' }] : [],
        stats: { wallTimeSeconds: 0.1, shortageCount: 0, optimal: false }, message: fail ? '测试配置无解' : '已生成',
        ...(result ? { assignments: result.assignments } : {}) }
    },
  }
}

test('copied generation example reads the revision then generates the active month and records HTTP provenance', async () => {
  const adapter = generationAdapter(), current = app(true, adapter), before = current.snapshot().state
  const logs = []
  await example('generate-schedule')(current.fetch, { log: (...values) => logs.push(values), error: () => assert.fail('generation should succeed') })
  assert.equal(adapter.calls.length, 1)
  assert.equal(adapter.calls[0].state.month, before.month)
  assert.equal(adapter.calls[0].options.allowPartial, false)
  assert.equal(adapter.calls[0].options.timeLimitSeconds, 15)
  assert.equal(current.state().month, before.month)
  assert.deepEqual(current.state().employees, before.employees)
  assert.deepEqual(current.state().assignments.filter(item => !item.date.startsWith(before.month)), before.assignments)
  assert.equal(current.state().provenance.scheduleUpdates[before.month].source, 'http')
  assert.equal(current.saves(), 1)
  assert.equal(logs[0][0], before.month)
  assert.deepEqual(current.requests, [{ method: 'GET', path: '/api/state' }, { method: 'POST', path: '/api/schedules/generate' }])
})

test('generation example respects permission and reports unsuccessful solver results without changing or retrying data', async () => {
  const deniedAdapter = generationAdapter(), denied = app(false, deniedAdapter)
  await assert.rejects(example('generate-schedule')(denied.fetch, silent), /HTTP 403/)
  assert.equal(deniedAdapter.calls.length, 0)
  assert.equal(denied.saves(), 0)
  const adapter = generationAdapter(true), current = app(true, adapter), before = structuredClone(current.state()), errors = []
  await example('generate-schedule')(current.fetch, { log: () => assert.fail('failed generation must not report saved data'), error: (...values) => errors.push(values) })
  assert.equal(adapter.calls.length, 1)
  assert.equal(current.saves(), 0)
  assert.deepEqual(current.state(), before)
  assert.equal(errors.length, 1)
  assert.ok(errors[0][1].some(issue => issue.message === '测试配置无解'))
  assert.equal(current.requests.length, 2)
})
