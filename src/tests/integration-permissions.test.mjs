import test from 'node:test'
import assert from 'node:assert/strict'
import { createIntegrationHandler } from '../integrationData.ts'
import { createPayrollConfig } from '../payroll.ts'
import { DEFAULT_INTEGRATION_PERMISSIONS, INTEGRATION_PERMISSIONS_STORAGE_KEY, loadIntegrationPermissions, setIntegrationPermission } from '../integrationPermissions.ts'

const allPermissions = { members: true, shifts: true, rules: true, assignments: true }
const employee = id => ({ id, name: id, role: '', group: '', color: '#123456', minHoursPerWeek: 0, maxHoursPerWeek: 48, eligibleShiftIds: ['day'], unavailableDates: [] })
const fixture = () => ({ version: 1, teamName: '测试', month: '2026-10', employees: [employee('e1'), employee('e2')], shifts: [{ id: 'day', name: '白班', shortName: '白', start: '09:00', end: '17:00', color: '#123456', required: 1 }], assignments: [], rules: { minRestHours: 11, maxConsecutiveDays: 5 } })
function setup(initial = fixture(), initialPermissions) {
  let state = initial, permissions = initialPermissions, saves = 0, failSave = false
  const sources = []
  const apply = (next, source) => { if (failSave) throw new Error('磁盘写入失败'); saves++; state = next; sources.push(source) }
  const handle = initialPermissions === undefined
    ? createIntegrationHandler(() => state, apply, () => false)
    : createIntegrationHandler(() => state, apply, () => false, () => permissions)
  return { handle, state: () => state, saves: () => saves, sources, permissions: next => { permissions = next }, failSave: value => { failSave = value } }
}
const read = (app, source = 'mcp') => app.handle('get_state', {}, source)
function edit(app, change, source = 'mcp') {
  const next = read(app, source)
  change(next.state)
  return app.handle('replace_state', next, source)
}
function deniedWithoutSave(app, change, pattern, source = 'mcp') {
  const before = read(app), saves = app.saves()
  assert.throws(() => edit(app, change, source), error => error.status === 403 && pattern.test(error.message))
  assert.deepEqual(read(app), before)
  assert.equal(app.saves(), saves)
}

test('default permissions allow member add, update and delete, but reject every other data category', () => {
  const app = setup()
  assert.deepEqual(DEFAULT_INTEGRATION_PERMISSIONS, { members: true, shifts: false, rules: false, assignments: false })
  edit(app, state => state.employees.push(employee('e3')))
  edit(app, state => { state.employees[0].name = 'AI 修改' })
  edit(app, state => { state.employees = state.employees.filter(item => item.id !== 'e3') })
  assert.equal(app.state().employees[0].name, 'AI 修改')
  assert.equal(app.saves(), 3)
  deniedWithoutSave(app, state => { state.shifts[0].name = '禁止改班次' }, /班次/)
  deniedWithoutSave(app, state => { state.rules.minRestHours = 12 }, /排班规则/)
  deniedWithoutSave(app, state => { state.monthlyReferenceHours = { '2026-10': 160 } }, /排班规则/)
  deniedWithoutSave(app, state => { state.calendar = { '2026-10-15': 'restday' } }, /排班规则/)
  deniedWithoutSave(app, state => { state.assignments = [{ employeeId: 'e1', date: '2026-10-15', shiftId: 'day', locked: false }] }, /排班结果/)
})

test('direct assignment writes and replacement writes share live permissions for MCP and HTTP', () => {
  for (const source of ['mcp', 'http']) {
    const app = setup(fixture(), { ...DEFAULT_INTEGRATION_PERMISSIONS })
    const before = read(app, source)
    const args = { revision: before.revision, employeeId: 'e1', date: '2026-10-15', shiftId: 'day' }
    assert.throws(() => app.handle('set_assignment', args, source), { status: 403 })
    assert.equal(app.saves(), 0)
    app.permissions({ ...DEFAULT_INTEGRATION_PERMISSIONS, assignments: true })
    app.handle('set_assignment', args, source)
    assert.equal(app.state().assignments.length, 1)
    assert.deepEqual(app.sources, [source])
    const current = read(app, source)
    app.permissions({ ...DEFAULT_INTEGRATION_PERMISSIONS })
    assert.throws(() => app.handle('set_assignment', { revision: current.revision, employeeId: 'e1', date: '2026-10-15', remove: true }, source), { status: 403 })
    deniedWithoutSave(app, state => { state.assignments = [] }, /排班结果/, source)
    deniedWithoutSave(app, state => { state.shifts[0].required = 2 }, /班次/, source)
  }
})

test('permission changes apply to already-read documents and independent grants do not imply member access', () => {
  const app = setup(fixture(), { ...allPermissions })
  const pending = read(app)
  pending.state.employees[0].name = '已撤销权限'
  app.permissions({ ...allPermissions, members: false })
  assert.throws(() => app.handle('replace_state', pending, 'mcp'), error => error.status === 403 && /成员/.test(error.message))
  assert.equal(app.saves(), 0)
  edit(app, state => { state.shifts[0].name = '新班次'; state.rules.minRestHours = 12; state.calendar = { '2026-10-15': 'restday' }; state.monthlyReferenceHours = { '2026-10': 160 } }, 'http')
  assert.equal(app.saves(), 1)
  assert.deepEqual(app.sources, ['http'])
})

test('member deletion cannot silently delete associated assignments or separation rules', () => {
  const initial = fixture()
  initial.assignments = [{ employeeId: 'e1', date: '2026-10-15', shiftId: 'day', locked: true }]
  initial.rules.separationGroups = [{ id: 'g1', name: '互斥', employeeIds: ['e1', 'e2'], shiftIds: [] }]
  const app = setup(initial, { ...DEFAULT_INTEGRATION_PERMISSIONS })
  const removeMember = state => { state.employees = state.employees.filter(item => item.id !== 'e1'); state.assignments = []; state.rules.separationGroups = [] }
  deniedWithoutSave(app, removeMember, /排班结果.*排班规则|排班规则.*排班结果/)
  app.permissions({ ...DEFAULT_INTEGRATION_PERMISSIONS, assignments: true })
  deniedWithoutSave(app, removeMember, /排班规则/)
  app.permissions({ ...allPermissions })
  edit(app, removeMember)
  assert.equal(app.state().employees.length, 1)
  assert.equal(app.state().assignments.length, 0)
  assert.equal(app.saves(), 1)
})

test('whole-document replacement rejects unrelated fields and cannot grant its own permissions', () => {
  const app = setup(fixture(), { ...allPermissions })
  for (const [key, value] of [['teamName', '新团队'], ['month', '2026-11'], ['payroll', createPayrollConfig().payroll], ['permissions', allPermissions], ['integrationPermissions', allPermissions]]) {
    deniedWithoutSave(app, state => { state.employees[0].name = '不能部分保存'; state[key] = value }, new RegExp(key))
  }
  assert.throws(() => edit(app, state => { state.version = 2 }))
  assert.equal(app.saves(), 0)
})

test('read-only documents can round-trip without a write, revision change, or provenance update', () => {
  const app = setup(fixture(), { members: false, shifts: false, rules: false, assignments: false })
  const before = read(app)
  const shuffled = Object.fromEntries(Object.entries(before.state).reverse())
  const result = app.handle('replace_state', { revision: before.revision, state: shuffled }, 'mcp')
  assert.deepEqual(result, before)
  assert.equal(app.saves(), 0)
  const deletion = app.handle('set_assignment', { revision: before.revision, employeeId: 'e1', date: '2026-10-15', remove: true }, 'http')
  assert.deepEqual(deletion, before)
  assert.equal(app.saves(), 0)
})

test('setting the same assignment preserves list order and does not require write access', () => {
  const initial = fixture()
  initial.assignments = [
    { employeeId: 'e1', date: '2026-10-15', shiftId: 'day', locked: false },
    { employeeId: 'e2', date: '2026-10-15', shiftId: 'day', locked: false },
  ]
  const app = setup(initial)
  const before = read(app)
  assert.deepEqual(app.handle('set_assignment', { revision: before.revision, employeeId: 'e1', date: '2026-10-15', shiftId: 'day' }, 'mcp'), before)
  assert.equal(app.saves(), 0)
})

test('trusted bridge source is mandatory and caller arguments cannot forge it', () => {
  const app = setup()
  const before = read(app)
  before.state.employees[0].name = '伪造来源'
  for (const source of [undefined, null, '', 'manual', 'MCP', {}, 1]) {
    assert.throws(() => app.handle('replace_state', { ...before, source: 'mcp' }, source), { status: 403 })
    assert.throws(() => app.handle('get_state', { source: 'mcp' }, source), { status: 403 })
  }
  app.handle('replace_state', { ...before, source: 'manual' }, 'http')
  assert.deepEqual(app.sources, ['http'])
})

test('external provenance is ignored while real history survives reads and unchanged fields', () => {
  const initial = fixture()
  const original = { source: 'manual', at: '2026-10-15T00:00:00.000Z' }
  initial.provenance = { fields: { 'employees.e1.name': { ...original }, 'employees.e2.name': { ...original } } }
  const app = setup(initial)
  assert.deepEqual(read(app).state.provenance.fields['employees.e1.name'], original)
  const next = read(app)
  next.state.provenance = { fields: { 'not.a.real.path': { source: 'attacker', at: 'yesterday' } }, pendingExternalChange: 'forged' }
  assert.deepEqual(app.handle('replace_state', next, 'mcp'), read(app))
  assert.equal(app.saves(), 0)
  next.state.employees[0].name = '真正的 HTTP 修改'
  const result = app.handle('replace_state', { ...next, source: 'manual' }, 'http')
  assert.equal(result.state.provenance.fields['employees.e1.name'].source, 'http')
  assert.notEqual(result.state.provenance.fields['employees.e1.name'].at, original.at)
  assert.deepEqual(result.state.provenance.fields['employees.e2.name'], original)
  assert.equal(result.state.provenance.pendingExternalChange.source, 'http')
  assert.deepEqual(result.state.provenance.pendingExternalChange.categories, ['成员'])
})

test('authorized removals prune deleted entities and retain the source of restored defaults', () => {
  const initial = fixture()
  initial.employees[0].avatar = null
  initial.rules.nonConsecutiveShifts = [{ id: 'r1', shiftId: 'day' }]
  const stamp = { source: 'manual', at: '2026-10-15T00:00:00.000Z' }
  initial.provenance = { fields: { 'employees.e2.name': stamp, 'employees.e1.avatar': stamp, 'rules.nonConsecutiveShifts.r1.shiftId': stamp } }
  const app = setup(initial, { ...allPermissions })
  const afterMember = edit(app, state => { state.employees = state.employees.filter(item => item.id !== 'e2') })
  assert.equal(afterMember.state.provenance.fields['employees.e2.name'], undefined)
  const afterField = edit(app, state => { delete state.employees[0].avatar })
  assert.equal(afterField.state.provenance.fields['employees.e1.avatar'].source, 'mcp')
  const afterRule = edit(app, state => { state.rules.nonConsecutiveShifts = [] })
  assert.equal(afterRule.state.provenance.fields['rules.nonConsecutiveShifts.r1.shiftId'], undefined)
  assert.equal(afterRule.state.provenance.fields['rules.nonConsecutiveShifts'].source, 'mcp')
  assert.equal(app.saves(), 3)
})

test('rejected combined edits leave actual provenance and data unchanged', () => {
  const initial = fixture()
  initial.provenance = { fields: { 'employees.e1.name': { source: 'manual', at: '2026-10-15T00:00:00.000Z' } } }
  const app = setup(initial)
  deniedWithoutSave(app, state => { state.employees[0].name = '不能部分写入'; state.rules.minRestHours = 12; state.provenance = {} }, /排班规则/)
  assert.equal(app.state().provenance.fields['employees.e1.name'].source, 'manual')
})

function assertScheduleStamp(stamp, source, earliest, latest) {
  assert.equal(stamp.source, source)
  const time = Date.parse(stamp.at)
  assert.equal(new Date(time).toISOString(), stamp.at)
  assert.ok(time >= earliest && time <= latest, `${stamp.at} should be within the write operation`)
}

test('successful assignment tools record transport and time for only the affected months', () => {
  const initial = fixture()
  const untouched = { source: 'mcp', at: '2020-01-01T00:00:00.000Z' }
  initial.provenance = { fields: {}, scheduleUpdates: { '2026-10': untouched } }
  const app = setup(initial, { ...allPermissions })
  const before = read(app)
  let earliest = Date.now()
  const inserted = app.handle('set_assignment', { revision: before.revision, employeeId: 'e1', date: '2026-09-30', shiftId: 'day' }, 'mcp')
  assertScheduleStamp(inserted.state.provenance.scheduleUpdates['2026-09'], 'mcp', earliest, Date.now())
  assert.deepEqual(inserted.state.provenance.scheduleUpdates['2026-10'], untouched)
  assert.deepEqual(Object.keys(inserted.state.provenance.scheduleUpdates).sort(), ['2026-09', '2026-10'])

  earliest = Date.now()
  const moved = edit(app, state => { state.assignments[0].date = '2026-11-01' }, 'http')
  assertScheduleStamp(moved.state.provenance.scheduleUpdates['2026-09'], 'http', earliest, Date.now())
  assertScheduleStamp(moved.state.provenance.scheduleUpdates['2026-11'], 'http', earliest, Date.now())
  assert.deepEqual(moved.state.provenance.scheduleUpdates['2026-10'], untouched)
  assert.deepEqual(app.sources, ['mcp', 'http'])
})

test('member-only edits, no-op assignments and rejected writes preserve the last successful schedule time', () => {
  const initial = fixture()
  initial.assignments = [{ employeeId: 'e1', date: '2026-10-15', shiftId: 'day', locked: false }]
  initial.provenance = { fields: {}, scheduleUpdates: { '2026-10': { source: 'http', at: '2020-01-01T00:00:00.000Z' } } }
  const app = setup(initial)
  const originalUpdates = read(app).state.provenance.scheduleUpdates
  edit(app, state => { state.employees[0].name = '仅更新成员资料' }, 'mcp')
  assert.deepEqual(read(app).state.provenance.scheduleUpdates, originalUpdates)

  const beforeNoop = read(app)
  assert.deepEqual(app.handle('set_assignment', { revision: beforeNoop.revision, employeeId: 'e1', date: '2026-10-15', shiftId: 'day' }, 'mcp'), beforeNoop)
  assert.deepEqual(app.handle('replace_state', beforeNoop, 'http'), beforeNoop)
  assert.equal(app.saves(), 1)
  assert.throws(() => app.handle('set_assignment', { revision: beforeNoop.revision, employeeId: 'e1', date: '2026-10-15', shiftId: 'off' }, 'mcp'), { status: 403 })
  deniedWithoutSave(app, state => { state.assignments = [] }, /排班结果/, 'http')
  assert.deepEqual(read(app).state.provenance.scheduleUpdates, originalUpdates)
})

test('replacement callers cannot forge or erase successful schedule update metadata', () => {
  const initial = fixture()
  initial.provenance = { fields: {}, scheduleUpdates: { '2026-09': { source: 'mcp', at: '2020-01-01T00:00:00.000Z' } } }
  const app = setup(initial, { ...allPermissions })
  const originalUpdates = read(app).state.provenance.scheduleUpdates
  edit(app, state => {
    state.employees[0].name = '成员编辑'
    state.provenance = { fields: {}, scheduleUpdates: { '2099-01': { source: 'manual', at: '伪造时间' } } }
  }, 'http')
  assert.deepEqual(read(app).state.provenance.scheduleUpdates, originalUpdates)

  const earliest = Date.now()
  const result = edit(app, state => {
    state.assignments = [{ employeeId: 'e1', date: '2026-10-15', shiftId: 'day', locked: false }]
    state.provenance = { fields: {}, scheduleUpdates: { '2026-10': { source: 'mcp', at: '2099-01-01T00:00:00.000Z' } } }
  }, 'http')
  assert.deepEqual(result.state.provenance.scheduleUpdates['2026-09'], originalUpdates['2026-09'])
  assertScheduleStamp(result.state.provenance.scheduleUpdates['2026-10'], 'http', earliest, Date.now())
  assert.equal(result.state.provenance.scheduleUpdates['2099-01'], undefined)
})

test('failed persistence never publishes a successful schedule timestamp or changes prior history', () => {
  for (const hadHistory of [false, true]) {
    const initial = fixture()
    if (hadHistory) initial.provenance = { fields: {}, scheduleUpdates: { '2026-10': { source: 'mcp', at: '2020-01-01T00:00:00.000Z' } } }
    const app = setup(initial, { ...allPermissions })
    const before = read(app)
    app.failSave(true)
    assert.throws(() => app.handle('set_assignment', { revision: before.revision, employeeId: 'e1', date: '2026-10-15', shiftId: 'day' }, 'http'), /磁盘写入失败/)
    assert.deepEqual(read(app), before)
    assert.equal(app.saves(), 0)
    assert.deepEqual(app.sources, [])
  }
})

test('permission settings persist independently and failed writes cannot change active grants', () => {
  const entries = new Map()
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) }
  let permissions = loadIntegrationPermissions(storage)
  permissions = setIntegrationPermission(permissions, 'shifts', true, storage)
  assert.deepEqual(loadIntegrationPermissions(storage), { ...DEFAULT_INTEGRATION_PERMISSIONS, shifts: true })
  assert.deepEqual([...entries.keys()], [INTEGRATION_PERMISSIONS_STORAGE_KEY])
  assert.throws(() => { permissions = setIntegrationPermission(permissions, 'rules', true, { ...storage, setItem: () => { throw new Error('磁盘写入失败') } }) }, /磁盘写入失败/)
  assert.equal(permissions.rules, false)
  assert.equal(loadIntegrationPermissions(storage).rules, false)
  for (const raw of ['not json', 'null', '[]', '{"members":true,"shifts":"true","rules":false,"assignments":false}', '{"assignments":true}']) {
    entries.set(INTEGRATION_PERMISSIONS_STORAGE_KEY, raw)
    assert.deepEqual(loadIntegrationPermissions(storage), DEFAULT_INTEGRATION_PERMISSIONS)
  }
  assert.throws(() => setIntegrationPermission(permissions, '__proto__', true, storage), /无效/)
  assert.throws(() => setIntegrationPermission(permissions, 'assignments', 'true', storage), /无效/)
})
