import test from 'node:test'
import assert from 'node:assert/strict'
import { weightedWeeks, findWeightedWeek, weekdayWeightRuleError, weightedDayRange, weekdayWeightCapacity } from '../weekday-weights.ts'

function fixture(month = '2025-10', headcount = 12) {
  return { version: 1, teamName: '权重测试', month, rules: { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: { days: [1, 6], percent: 40 } }, shifts: [{ id: 'day', name: '白班', start: '08:00', end: '16:00', required: 5 }], employees: Array.from({ length: headcount }, (_, i) => ({ id: `e${i}`, maxHoursPerWeek: 168, eligibleShiftIds: ['day'], unavailableDates: [] })), assignments: [] }
}

test('explicit complete-week example applies one group ceil, without fixed shift quotas', () => {
  const state = fixture()
  const full = weightedWeeks(state, 42).find(w => w.dates.length === 7)
  assert.deepEqual([full.fullTotal, full.totalTarget, full.selectedTarget, full.otherTarget], [42, 42, 17, 25])
  assert.deepEqual(weightedDayRange(full, full.selectedDates[0]), [8, 9])
  assert.deepEqual(weightedDayRange(full, full.otherDates[0]), [5, 5])
  assert.deepEqual(weightedDayRange(full, '2000-01-01'), [0, 0])
  assert.equal(Object.hasOwn(full, 'shiftTargets'), false)
  assert.equal(weightedWeeks(state).find(w => w.dates.length === 7).fullTotal, 35, 'default is only a minimum-coverage example')
  assert.equal(weightedWeeks(state, 1000000).find(w => w.dates.length === 7).totalTarget, 1000000, 'preview may illustrate more than current capacity')
})

test('partial weeks retain absent weekdays shares instead of renormalizing to 100%', () => {
  const tuesday = weightedWeeks(fixture('2026-09'), 35)[0]
  assert.deepEqual(tuesday.dates, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'])
  assert.deepEqual([tuesday.selectedTarget, tuesday.otherTarget, tuesday.totalTarget], [7, 21, 28])
  const october = weightedWeeks(fixture(), 35)
  for (const partial of [october[0], october.at(-1)]) assert.deepEqual([partial.selectedTarget, partial.otherTarget, partial.totalTarget], [7, 17, 24])
  assert.equal(october.reduce((sum, w) => sum + w.totalTarget, 0), 153)
})

test('actual full-week totals can grow above minimum coverage without becoming a fixed cap', () => {
  const state = fixture()
  const week = weightedWeeks(state).find(w => w.dates.length === 7)
  assert.equal(findWeightedWeek(state, week, 17, 25)?.fullTotal, 42)
  assert.equal(findWeightedWeek(state, week, 20, 30)?.fullTotal, 50)
  assert.equal(findWeightedWeek(state, week, 18, 24), null, '42 actual shifts require ceil(42*40%)=17 selected')
  assert.equal(findWeightedWeek(state, week, 100, 150), null, 'must respect employees × 7 bound')
  assert.equal(findWeightedWeek(state, week, -1, 1), null)
  assert.equal(findWeightedWeek(state, week, 1.5, 1), null)
})

test('partial actual totals find a complete-week witness rather than use the partial sum as W', () => {
  const state = fixture('2026-09')
  const week = weightedWeeks(state)[0]
  const match = findWeightedWeek(state, week, 7, 21)
  assert.equal(match.fullTotal, 35)
  assert.equal(match.totalTarget, 28)
  assert.equal(findWeightedWeek(state, week, 7, 25), null)
  assert.equal(findWeightedWeek(state, week, 8, 24)?.fullTotal, 40)
})

test('zero minimum coverage still permits extra staff on optional shifts', () => {
  const state = fixture()
  state.shifts[0].required = 0
  const full = weightedWeeks(state).find(w => w.dates.length === 7)
  assert.equal(full.totalTarget, 0)
  assert.equal(findWeightedWeek(state, full, 6, 8)?.fullTotal, 14)
  assert.equal(weekdayWeightCapacity(state).maxPercent, 100, 'optional shifts contribute available headcount')
})

test('zero/100 weights and all-seven selection have explicit finite quotas', () => {
  const state = fixture('2026-06')
  state.rules.weekdayWeights = { days: [6, 7], percent: 100 }
  const last = weightedWeeks(state).at(-1)
  assert.equal(last.totalTarget, 0)
  assert.equal(findWeightedWeek(state, last, 0, 0)?.fullTotal, 0)
  assert.equal(findWeightedWeek(state, last, 0, 1), null)
  state.rules.weekdayWeights = { days: [1, 2, 3, 4, 5, 6, 7], percent: 100 }
  assert.equal(weightedWeeks(state).at(-1).totalTarget, 10)
  assert.equal(findWeightedWeek(state, weightedWeeks(state).at(-1), 10, 0)?.totalTarget, 10)
  state.rules.weekdayWeights = { days: [1, 6], percent: 0 }
  assert.ok(weightedWeeks(state).every(w => w.selectedTarget === 0))
})

test('invalid rules, months and example totals cannot produce silent fallback quotas', () => {
  for (const invalid of [null, false, {}, { days: [], percent: 40 }, { days: [1, 1], percent: 40 }, { days: [0], percent: 40 }, { days: [8], percent: 40 }, { days: [1], percent: '40' }, { days: [1], percent: 40.5 }, { days: [1], percent: -1 }, { days: [1], percent: 101 }, { days: [1, 2, 3, 4, 5, 6, 7], percent: 40 }]) {
    assert.ok(weekdayWeightRuleError(invalid))
    const state = fixture(); state.rules.weekdayWeights = invalid
    assert.deepEqual(weightedWeeks(state), [])
  }
  assert.equal(weekdayWeightRuleError(undefined), null)
  const state = fixture(); delete state.rules.weekdayWeights
  assert.deepEqual(weightedWeeks(state), [])
  for (const month of ['0000-01', '2026-00', '2026-13', '2026-1', '10000-01']) assert.deepEqual(weightedWeeks(fixture(month)), [])
  for (const amount of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.deepEqual(weightedWeeks(fixture(), amount), [])
})

test('dynamic capacity preserves daily minimum coverage and counts leave and locked rest', () => {
  const state = fixture('2025-10', 7)
  assert.equal(weekdayWeightCapacity(state).maxPercent, 35, '14 selected out of at least 39 complete-week assignments; no reduction of other days below five')
  state.employees[0].unavailableDates = ['2025-10-06']
  assert.equal(weekdayWeightCapacity(state).maxPercent, 34)
  state.assignments.push({ employeeId: 'e1', date: '2025-10-06', shiftId: 'off', locked: true })
  assert.equal(weekdayWeightCapacity(state).maxPercent, 30)
  assert.equal(weekdayWeightCapacity(fixture('2025-10', 2)).maxPercent, null)
})

test('calendar grouping handles low years, upper date boundary and leap February', () => {
  assert.equal(weightedWeeks(fixture('0001-01')).flatMap(w => w.dates).length, 31)
  assert.equal(weightedWeeks(fixture('9999-12')).flatMap(w => w.dates).at(-1), '9999-12-31')
  assert.equal(weightedWeeks(fixture('2000-02')).flatMap(w => w.dates).length, 29)
  assert.equal(weightedWeeks(fixture('1900-02')).flatMap(w => w.dates).length, 28)
})

test('all actual witnesses satisfy independently calculated integer formulas', () => {
  const state = fixture('2026-09', 4)
  state.shifts[0].required = 0
  for (const percent of [0, 1, 33, 40, 67, 99, 100]) {
    state.rules.weekdayWeights.percent = percent
    for (const week of weightedWeeks(state)) {
      for (let selected = 0; selected <= week.selectedDates.length * 4; selected++) {
        for (let other = 0; other <= week.otherDates.length * 4; other++) {
          const candidates = Array.from({ length: 29 }, (_, W) => W).filter(W => {
            const Q = Math.ceil(W * percent / 100)
            return selected === Math.ceil(Q * week.selectedDates.length / 2) && other === Math.ceil((W - Q) * week.otherDates.length / 5)
          })
          const actual = findWeightedWeek(state, week, selected, other)
          assert.equal(actual !== null, candidates.length > 0)
          if (actual) assert.ok(candidates.includes(actual.fullTotal))
        }
      }
    }
  }
})

test('large preview integers use exact ceilings without unsafe multiplication', () => {
  const state = fixture()
  const W = Number.MAX_SAFE_INTEGER
  const full = weightedWeeks(state, W).find(w => w.dates.length === 7)
  const expected = Number((BigInt(W) * 40n + 99n) / 100n)
  assert.equal(full.selectedTarget, expected)
  assert.equal(full.otherTarget, W - expected)
  assert.equal(full.totalTarget, W)
})
