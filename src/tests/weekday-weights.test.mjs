import test from 'node:test'
import assert from 'node:assert/strict'
import { weightedWeeks, weekdayWeightRuleError, weightedDayRange, weekdayWeightCapacity } from '../weekday-weights.ts'

function fixture(month = '2025-10', headcount = 12) {
  return { version: 1, teamName: '权重测试', month, rules: { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: { days: [1, 6], percent: 40 } }, shifts: [{ id: 'day', name: '白班', start: '08:00', end: '16:00', required: 5 }], employees: Array.from({ length: headcount }, (_, i) => ({ id: `e${i}`, maxHoursPerWeek: 168, eligibleShiftIds: ['day'], unavailableDates: [] })), assignments: [] }
}

test('full team week uses one combined ceil and balances within both groups', () => {
  const full = weightedWeeks(fixture()).find(w => w.dates.length === 7)
  assert.equal(full.totalTarget, 35)
  assert.equal(full.selectedTarget, 14)
  assert.equal(full.otherTarget, 21)
  assert.deepEqual(weightedDayRange(full, full.selectedDates[0]), [7, 7])
  assert.deepEqual(weightedDayRange(full, full.otherDates[0]), [4, 5])
  assert.deepEqual(weightedDayRange(full, '2000-01-01'), [0, 0])
  const state = fixture(); state.rules.weekdayWeights.percent = 41
  const rounded = weightedWeeks(state).find(w => w.dates.length === 7)
  assert.equal(rounded.selectedTarget, 15)
  assert.equal(rounded.otherTarget, 20)
  assert.equal(rounded.totalTarget, 35)
})

test('partial weeks retain absent weekdays shares instead of renormalizing to 100%', () => {
  const tuesday = weightedWeeks(fixture('2026-09'))[0]
  assert.deepEqual(tuesday.dates, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'])
  assert.deepEqual([tuesday.selectedTarget, tuesday.otherTarget, tuesday.totalTarget], [7, 21, 28])
  const october = weightedWeeks(fixture())
  for (const partial of [october[0], october.at(-1)]) assert.deepEqual([partial.selectedTarget, partial.otherTarget, partial.totalTarget], [7, 17, 24])
  assert.equal(october.reduce((sum, w) => sum + w.totalTarget, 0), 153)
})

test('shift budgets use largest remainders and never multiply team rounding by shift count', () => {
  const state = fixture()
  state.shifts = [{ id: 'a', required: 2 }, { id: 'b', required: 2 }, { id: 'c', required: 1 }]
  const partial = weightedWeeks(state)[0]
  assert.deepEqual({ ...partial.shiftTargets }, { a: 10, b: 9, c: 5 })
  state.rules.weekdayWeights.percent = 10
  const full = weightedWeeks(state).find(w => w.dates.length === 7)
  assert.equal(full.selectedTarget, 4)
  assert.deepEqual({ ...full.shiftTargets }, { a: 14, b: 14, c: 7 })
  for (let percent = 0; percent <= 100; percent++) {
    state.rules.weekdayWeights.percent = percent
    for (const week of weightedWeeks(state)) {
      assert.equal(Object.values(week.shiftTargets).reduce((a, b) => a + b, 0), week.totalTarget)
      assert.equal(week.totalTarget, week.selectedTarget + week.otherTarget)
    }
  }
})

test('zero/100 weights and all-seven selection have explicit, finite quotas', () => {
  const state = fixture('2026-06') // last partial week is Monday, Tuesday
  state.rules.weekdayWeights = { days: [6, 7], percent: 100 }
  const last = weightedWeeks(state).at(-1)
  assert.equal(last.totalTarget, 0)
  state.rules.weekdayWeights = { days: [1, 2, 3, 4, 5, 6, 7], percent: 100 }
  assert.equal(weightedWeeks(state).at(-1).totalTarget, 10)
  state.rules.weekdayWeights = { days: [1, 6], percent: 0 }
  assert.ok(weightedWeeks(state).every(w => w.selectedTarget === 0))
  state.shifts[0].required = 0
  assert.ok(weightedWeeks(state).every(w => w.totalTarget === 0))
})

test('invalid weight configurations cannot produce silent fallback quotas', () => {
  for (const invalid of [null, false, {}, { days: [], percent: 40 }, { days: [1, 1], percent: 40 }, { days: [0], percent: 40 }, { days: [8], percent: 40 }, { days: [1], percent: '40' }, { days: [1], percent: 40.5 }, { days: [1], percent: -1 }, { days: [1], percent: 101 }, { days: [1, 2, 3, 4, 5, 6, 7], percent: 40 }]) {
    assert.ok(weekdayWeightRuleError(invalid))
    const state = fixture(); state.rules.weekdayWeights = invalid
    assert.deepEqual(weightedWeeks(state), [])
  }
  assert.equal(weekdayWeightRuleError(undefined), null)
  const state = fixture(); delete state.rules.weekdayWeights
  assert.deepEqual(weightedWeeks(state), [])
})

test('capacity upper limit counts at most one available employee per day and reflects leave and locked rest', () => {
  const state = fixture('2025-10', 7)
  assert.equal(weekdayWeightCapacity(state).maxPercent, 40)
  state.employees[0].unavailableDates = ['2025-10-06']
  assert.equal(weekdayWeightCapacity(state).maxPercent, 37) // at most 13 selected shifts out of 35
  state.assignments.push({ employeeId: 'e1', date: '2025-10-06', shiftId: 'off', locked: true })
  assert.equal(weekdayWeightCapacity(state).maxPercent, 31) // balanced group cannot exceed 6+5
  assert.equal(weekdayWeightCapacity(fixture('2025-10', 2)).maxPercent, null)
})
