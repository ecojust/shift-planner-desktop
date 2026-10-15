import test from 'node:test'
import assert from 'node:assert/strict'
import { isAvatarData, MAX_AVATAR_LENGTH } from '../avatarData.ts'
import { backupJSON, parseBackup, MAX_BACKUP_BYTES } from '../storage.ts'
import { createSolverRequest, solverDebugJSON } from '../solverDebug.ts'

// The data boundary validates transport/magic bytes; actual image decoding and
// thumbnail quality are exercised by the real-browser upload acceptance suite.
const localJpeg = payload => 'data:image/jpeg;base64,' + Buffer.from([255, 216, 255, 224, ...payload, 255, 217]).toString('base64')
const avatar = localJpeg([0, 2, 0, 3])
function fixture() {
  return {
    version: 1, month: '2026-10', teamName: '头像存储测试',
    employees: [{ id: 'a', name: '甲', role: '', group: '', color: '#123456', minHoursPerWeek: 40, maxHoursPerWeek: 48, eligibleShiftIds: ['day'], unavailableDates: [], avatar }],
    shifts: [{ id: 'day', name: '早班', shortName: '早', start: '08:00', end: '16:00', color: '#123456', required: 0 }],
    rules: { minRestHours: 11, maxConsecutiveDays: 5 }, assignments: [],
  }
}

test('avatars persist through backup; explicit removal and old missing fields remain distinct', () => {
  const state = fixture(), before = structuredClone(state)
  assert.deepEqual(parseBackup(backupJSON(state)), before)
  assert.deepEqual(state, before)
  state.employees[0].avatar = null
  assert.equal(parseBackup(backupJSON(state)).employees[0].avatar, null)
  delete state.employees[0].avatar
  assert.equal(Object.hasOwn(parseBackup(backupJSON(state)).employees[0], 'avatar'), false)
})

test('untrusted avatar data rejects remote URLs, SVG, invalid base64 and oversized content', () => {
  assert.equal(isAvatarData(avatar), true)
  for (const value of ['', 'https://example.com/avatar.jpg', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,iVBORw0KGgo=', 'data:image/jpeg;base64,SGVsbG8=', 'data:image/jpeg;base64,/9j/AAAA', 'data:image/jpeg;base64,/9j\n//9k=', localJpeg(new Array(MAX_AVATAR_LENGTH).fill(1)), 1, false, {}, []]) {
    assert.equal(isAvatarData(value), false, String(value).slice(0, 80))
    const state = fixture(); state.employees[0].avatar = value
    assert.throws(() => parseBackup(JSON.stringify(state)), /员工头像/)
  }
})

test('a maximum-sized team can back up bounded thumbnails plus the full month roster', () => {
  const state = fixture()
  const largeAvatar = localJpeg(new Array(6000).fill(3))
  assert.ok(largeAvatar.length <= MAX_AVATAR_LENGTH)
  state.employees = Array.from({ length: 200 }, (_, i) => ({ ...state.employees[0], id: `employee_${i}`, name: `员工${i}`, avatar: largeAvatar }))
  state.assignments = state.employees.flatMap(employee => Array.from({ length: 31 }, (_, i) => ({ employeeId: employee.id, date: `2026-10-${String(i + 1).padStart(2, '0')}`, shiftId: 'day', locked: false })))
  const json = backupJSON(state)
  assert.ok(Buffer.byteLength(json) < MAX_BACKUP_BYTES)
  assert.deepEqual(parseBackup(json), state)
})

test('worker/native requests and solver-debug omit avatars without mutating the document', () => {
  const state = fixture(), before = structuredClone(state)
  const request = createSolverRequest(state, { seed: 1, allowPartial: false, timeLimitSeconds: 5 }, 'avatar-free')
  const expected = structuredClone(before.employees[0]); delete expected.avatar
  assert.deepEqual(request.state.employees[0], expected)
  assert.deepEqual(state, before)
  const json = solverDebugJSON(request, { originalState: state })
  assert.doesNotMatch(json, /data:image|"avatar"/)
  assert.deepEqual(JSON.parse(json).state.rules, state.rules)
  assert.equal(parseBackup(backupJSON(state)).employees[0].avatar, avatar)
})
