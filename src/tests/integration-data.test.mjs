import test from 'node:test'
import assert from 'node:assert/strict'
import { createIntegrationHandler, IntegrationError } from '../integrationData.ts'
import { validateSchedule } from '../scheduler.ts'

const fixture = () => ({ version: 1, teamName: '测试', month: '2026-10', employees: [{ id: 'e1', name: '成员', role: '', group: '', color: '#123456', minHoursPerWeek: 0, maxHoursPerWeek: 48, eligibleShiftIds: ['day'], unavailableDates: [] }], shifts: [{ id: 'day', name: '白班', shortName: '白', start: '09:00', end: '17:00', color: '#123456', required: 1 }], assignments: [], rules: { minRestHours: 11, maxConsecutiveDays: 5 } })
const allPermissions = { members: true, shifts: true, rules: true, assignments: true }
function setup(initial = fixture(), source = 'mcp') {
  let state = initial, busy = false, failSave = false, permissions = { ...allPermissions }
  let saves = 0
  const rawHandle = createIntegrationHandler(() => state, next => { if (failSave) throw new Error('磁盘写入失败'); saves++; state = next }, () => busy,
    () => permissions)
  const handle = (method, args) => rawHandle(method, args, source)
  return { handle, state: () => state, saves: () => saves, busy: value => { busy = value }, failSave: value => { failSave = value }, permissions: value => { permissions = value } }
}

test('integrations read live app data and reject stale revisions after local or external edits', () => {
  const app = setup()
  const first = app.handle('get_state')
  assert.equal(app.handle('get_state').revision, first.revision)
  app.state().employees[0].name = '本地修改'
  const second = app.handle('get_state')
  assert.notEqual(second.revision, first.revision)
  assert.equal(second.state.employees[0].name, '本地修改')
  assert.throws(() => app.handle('replace_state', { revision: first.revision, state: first.state }), e => e instanceof IntegrationError && e.status === 409)
  second.state.employees[0].name = '外部修改'
  const third = app.handle('replace_state', second)
  assert.equal(app.state().employees[0].name, '外部修改')
  assert.equal(app.saves(), 1)
  assert.notEqual(third.revision, second.revision)
  assert.throws(() => app.handle('replace_state', second), { status: 409 })
})

test('invalid documents and persistence failures preserve the original application data', () => {
  const app = setup()
  const before = app.handle('get_state')
  assert.throws(() => app.handle('replace_state', { revision: before.revision, state: {} }), /备份格式错误/)
  assert.deepEqual(app.handle('get_state'), before)
  const next = structuredClone(before)
  next.state.employees[0].name = '不应保存'
  app.failSave(true)
  assert.throws(() => app.handle('replace_state', next), /磁盘写入失败/)
  assert.deepEqual(app.handle('get_state'), before)
  assert.equal(app.saves(), 0)
})

test('busy editor blocks writes but supports read and validation', () => {
  const app = setup()
  const before = app.handle('get_state')
  app.busy(true)
  assert.deepEqual(app.handle('get_state'), before)
  assert.ok(Array.isArray(app.handle('validate_schedule').issues))
  assert.throws(() => app.handle('replace_state', before), { status: 409 })
  app.busy(false)
  assert.equal(app.handle('replace_state', before).state.teamName, '测试')
})

test('assignment operations validate dates and references and require explicit unlocking', () => {
  const app = setup()
  let current = app.handle('get_state')
  for (const args of [{ date: '2026-02-30' }, { employeeId: 'missing' }, { shiftId: 'missing' }, { locked: 'true' }]) {
    assert.throws(() => app.handle('set_assignment', { revision: current.revision, employeeId: 'e1', date: '2026-10-15', shiftId: 'day', ...args }))
    assert.deepEqual(app.handle('get_state'), current)
  }
  current = app.handle('set_assignment', { revision: current.revision, employeeId: 'e1', date: '2026-10-15', shiftId: 'day', locked: true })
  assert.equal(current.state.assignments.length, 1)
  assert.throws(() => app.handle('set_assignment', { revision: current.revision, employeeId: 'e1', date: '2026-10-15', remove: true }), /锁定/)
  current = app.handle('set_assignment', { revision: current.revision, employeeId: 'e1', date: '2026-10-15', shiftId: 'off', unlock: true })
  assert.equal(current.state.assignments[0].shiftId, 'off')
  current = app.handle('set_assignment', { revision: current.revision, employeeId: 'e1', date: '2026-10-15', remove: true })
  assert.equal(current.state.assignments.length, 0)
})

const invalidatedAt = '2026-10-01T00:00:00.000Z'
const invalidation = () => ({ source: 'manual', at: invalidatedAt })
function fullMonth(month) {
  const [year, value] = month.split('-').map(Number)
  const days = new Date(Date.UTC(year, value, 0)).getUTCDate()
  return Array.from({ length: days }, (_, index) => ({ employeeId: index % 2 ? 'e2' : 'e1', date: `${month}-${String(index + 1).padStart(2, '0')}`, shiftId: 'day', locked: false }))
}
function staleSchedule(months = ['2026-10'], complete = false) {
  const state = fixture()
  state.employees = ['e1', 'e2'].map(id => ({ ...state.employees[0], id, name: id, minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 168 }))
  state.rules = { minRestHours: 0, maxConsecutiveDays: 31 }
  state.assignments = months.flatMap(month => complete ? fullMonth(month) : fullMonth(month).slice(0, 1))
  state.provenance = { fields: {}, invalidatedSchedules: Object.fromEntries(months.map(month => [month, invalidation()])) }
  return state
}
function replace(app, update) {
  const request = app.handle('get_state')
  update(request.state)
  return app.handle('replace_state', request)
}

test('MCP and HTTP full valid replacements restore an invalidated month but partial coverage does not', () => {
  for (const source of ['mcp', 'http']) {
    const app = setup(staleSchedule(), source)
    let result = replace(app, next => {
      next.assignments = fullMonth('2026-10').slice(0, 2)
      next.provenance = { fields: {}, invalidatedSchedules: {} }
    })
    const partialIssues = validateSchedule(result.state)
    assert.ok(partialIssues.some(issue => issue.type === 'coverage'))
    assert.ok(!partialIssues.some(issue => issue.severity === 'error'))
    assert.deepEqual(result.state.provenance.invalidatedSchedules['2026-10'], invalidation())
    result = replace(app, next => { next.assignments = fullMonth('2026-10') })
    assert.ok(!validateSchedule(result.state).some(issue => issue.severity === 'error' || issue.type === 'coverage'))
    assert.equal(result.state.provenance.invalidatedSchedules?.['2026-10'], undefined)
    assert.equal(result.state.provenance.scheduleUpdates['2026-10'].source, source)
    assert.equal(app.saves(), 2)
  }
})

test('whole-document replacement validates changed months separately and preserves untouched invalidation', () => {
  for (const source of ['mcp', 'http']) {
    const app = setup(staleSchedule(['2026-10', '2026-11', '2026-12']), source)
    const result = replace(app, next => {
      next.assignments = [...fullMonth('2026-10'), ...fullMonth('2026-11').slice(0, 2), ...next.assignments.filter(item => item.date.startsWith('2026-12-'))]
    })
    assert.equal(result.state.provenance.invalidatedSchedules?.['2026-10'], undefined)
    assert.deepEqual(result.state.provenance.invalidatedSchedules['2026-11'], invalidation())
    assert.deepEqual(result.state.provenance.invalidatedSchedules['2026-12'], invalidation())
    assert.equal(result.state.provenance.scheduleUpdates['2026-10'].source, source)
    assert.equal(result.state.provenance.scheduleUpdates['2026-11'].source, source)
    assert.equal(result.state.provenance.scheduleUpdates['2026-12'], undefined)
    const nextMonth = replace(app, next => {
      next.assignments = [...next.assignments.filter(item => !item.date.startsWith('2026-11-')), ...fullMonth('2026-11')]
    })
    assert.equal(nextMonth.state.provenance.invalidatedSchedules?.['2026-11'], undefined)
    assert.deepEqual(nextMonth.state.provenance.invalidatedSchedules['2026-12'], invalidation())
  }
})

test('full coverage with a scheduling error remains invalidated', () => {
  for (const source of ['mcp', 'http']) {
    const initial = staleSchedule()
    initial.employees[0].unavailableDates = ['2026-10-01']
    const app = setup(initial, source)
    const result = replace(app, next => { next.assignments = fullMonth('2026-10') })
    const issues = validateSchedule(result.state)
    assert.ok(issues.some(issue => issue.type === 'unavailable' && issue.severity === 'error'))
    assert.ok(!issues.some(issue => issue.type === 'coverage'))
    assert.deepEqual(result.state.provenance.invalidatedSchedules['2026-10'], invalidation())
  }
})

test('configuration and assignment changes in the same replacement stay invalidated even when valid', () => {
  for (const source of ['mcp', 'http']) {
    for (const editConfiguration of [
      next => { next.employees[0].name = '新的成员名' },
      next => { next.shifts[0].normalAllowance = 25 },
      next => { next.rules.minRestHours = 1 },
      next => { next.calendar = { '2026-10-01': 'workday' } },
      next => { next.monthlyReferenceHours = { '2026-10': 168 } },
    ]) {
      const app = setup(staleSchedule(), source)
      const result = replace(app, next => { next.assignments = fullMonth('2026-10'); editConfiguration(next) })
      assert.ok(!validateSchedule(result.state).some(issue => issue.severity === 'error' || issue.type === 'coverage'))
      assert.equal(result.state.provenance.invalidatedSchedules['2026-10'].source, source)
      assert.notEqual(result.state.provenance.invalidatedSchedules['2026-10'].at, invalidatedAt)
    }
  }
})

test('single assignment writes never acknowledge a month even when they finish its coverage', () => {
  for (const source of ['mcp', 'http']) {
    const initial = staleSchedule()
    initial.assignments = fullMonth('2026-10').slice(0, -1)
    const app = setup(initial, source), current = app.handle('get_state')
    const last = fullMonth('2026-10').at(-1)
    const completed = app.handle('set_assignment', { revision: current.revision, ...last })
    assert.ok(!validateSchedule(completed.state).some(issue => issue.severity === 'error' || issue.type === 'coverage'))
    assert.deepEqual(completed.state.provenance.invalidatedSchedules['2026-10'], invalidation())
    assert.deepEqual(app.handle('replace_state', completed), completed)
    assert.equal(app.saves(), 1)
    const rescheduled = replace(app, next => { next.assignments.at(-1).locked = true })
    assert.equal(rescheduled.state.provenance.invalidatedSchedules?.['2026-10'], undefined)
  }
})

test('no-op submissions, array reorder and forged provenance cannot clear invalidation', () => {
  for (const source of ['mcp', 'http']) {
    const app = setup(staleSchedule(['2026-10'], true), source)
    const before = app.handle('get_state'), forged = structuredClone(before)
    forged.state.provenance = { fields: {}, invalidatedSchedules: {}, scheduleUpdates: { '2026-10': { source: 'http', at: '2099-01-01T00:00:00.000Z' } } }
    assert.deepEqual(app.handle('replace_state', forged), before)
    assert.equal(app.saves(), 0)
    const reordered = replace(app, next => {
      next.employees.reverse()
      next.assignments = next.assignments.toReversed().map(item => ({ locked: item.locked, shiftId: item.shiftId, date: item.date, employeeId: item.employeeId }))
      next.provenance = { fields: { malicious: true }, invalidatedSchedules: {} }
    })
    assert.deepEqual(reordered.state.provenance.invalidatedSchedules['2026-10'], invalidation())
    assert.equal(reordered.state.provenance.scheduleUpdates, undefined)
    // A genuine changed, valid result can acknowledge history even if entity lists were reordered.
    const actualChange = replace(app, next => { next.assignments[0].locked = true; next.employees.reverse() })
    assert.equal(actualChange.state.provenance.invalidatedSchedules?.['2026-10'], undefined)
  }
})

test('stale revisions, denied writes and persistence failure cannot partially acknowledge invalidation', () => {
  for (const source of ['mcp', 'http']) {
    for (const failure of ['revision', 'permission', 'busy', 'save']) {
      const app = setup(staleSchedule(), source)
      const request = app.handle('get_state')
      request.state.assignments = fullMonth('2026-10')
      request.state.provenance = { fields: {}, invalidatedSchedules: {} }
      if (failure === 'revision') request.revision = 'stale-revision'
      if (failure === 'permission') app.permissions({ ...allPermissions, assignments: false })
      if (failure === 'busy') app.busy(true)
      if (failure === 'save') app.failSave(true)
      const before = app.handle('get_state')
      const expected = failure === 'permission' ? { status: 403 } : failure === 'save' ? /磁盘写入失败/ : { status: 409 }
      assert.throws(() => app.handle('replace_state', request), expected)
      assert.deepEqual(app.handle('get_state'), before)
      assert.deepEqual(app.state().provenance.invalidatedSchedules['2026-10'], invalidation())
      assert.equal(app.saves(), 0)
    }
  }
})
