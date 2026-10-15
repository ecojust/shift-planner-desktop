import test from 'node:test'
import assert from 'node:assert/strict'
import { createIntegrationHandler, IntegrationError } from '../integrationData.ts'

const fixture = () => ({ version: 1, teamName: '测试', month: '2026-10', employees: [{ id: 'e1', name: '成员', role: '', group: '', color: '#123456', minHoursPerWeek: 0, maxHoursPerWeek: 48, eligibleShiftIds: ['day'], unavailableDates: [] }], shifts: [{ id: 'day', name: '白班', shortName: '白', start: '09:00', end: '17:00', color: '#123456', required: 1 }], assignments: [], rules: { minRestHours: 11, maxConsecutiveDays: 5 } })
function setup() {
  let state = fixture(), busy = false, failSave = false
  let saves = 0
  const handle = createIntegrationHandler(() => state, next => { if (failSave) throw new Error('磁盘写入失败'); saves++; state = next }, () => busy)
  return { handle, state: () => state, saves: () => saves, busy: value => { busy = value }, failSave: value => { failSave = value } }
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
