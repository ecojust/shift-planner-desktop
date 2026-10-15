import test from 'node:test'
import assert from 'node:assert/strict'
import { weightedWeeks as weightedWeeksRaw, findWeightedWeek, weekdayWeightRuleError, weightedDayRange, weekdayWeightCapacity, weightedHistoryFits } from '../weekday-weights.ts'

const weightedWeeks = (state, total, options = {}) => weightedWeeksRaw(state, total, { referenceDate: '2026-10-15', ...options })
function confirmMonth(state, month) {
  state.scheduleCoverage = { ...state.scheduleCoverage, [month]: { employeeIds: state.employees.map(employee => employee.id) } }
}

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

test('all-fixed shifts limit weighted capacity even when more employees are available', () => {
  const state = fixture('2026-06', 12)
  state.shifts[0].staffingMode = 'fixed'
  assert.equal(weekdayWeightCapacity(state).maxPercent, 28, '35 fixed weekly assignments permit at most 28% for two days, not the requested 40%')
  const week = weightedWeeks(state).find(week => week.dates.length === 7)
  assert.equal(findWeightedWeek(state, week, 10, 25), null, 'daily fixed five cannot also satisfy 40%')
  state.rules.weekdayWeights.percent = 28
  assert.equal(findWeightedWeek(state, week, 10, 25)?.fullTotal, 35)
  state.rules.weekdayWeights = { days: [1, 2, 3, 4, 5, 6, 7], percent: 100 }
  assert.equal(weekdayWeightCapacity(state).maxPercent, 100)
})

test('fixed zero does not create capacity for employees who can only work that shift', () => {
  const state = fixture('2026-06', 12)
  state.shifts = [{ ...state.shifts[0], id: 'closed', required: 0, staffingMode: 'fixed' }, { ...state.shifts[0], required: 1 }]
  state.employees.forEach((employee, index) => { employee.eligibleShiftIds = index === 0 ? ['day'] : ['closed'] })
  assert.equal(weekdayWeightCapacity(state).maxPercent, 28, 'only the one employee qualified for an open shift can contribute')
  state.employees[0].eligibleShiftIds = ['closed']
  assert.equal(weekdayWeightCapacity(state).maxPercent, null, 'minimum one cannot be covered by a fixed-zero qualification')
  state.shifts[0].staffingMode = 'minimum'
  state.shifts[1].required = 0
  assert.equal(weekdayWeightCapacity(state).maxPercent, 100, 'minimum zero remains an optional working shift')
})

test('mixed-mode capacity keeps fixed slots capped and minimum shifts available for extras', () => {
  const state = fixture('2026-06', 6)
  state.shifts = [{ ...state.shifts[0], id: 'fixed', required: 2, staffingMode: 'fixed' }, { ...state.shifts[0], required: 1, staffingMode: 'minimum' }]
  state.employees.forEach((employee, index) => { employee.eligibleShiftIds = index < 3 ? ['fixed'] : ['day'] })
  assert.equal(weekdayWeightCapacity(state).maxPercent, 40, 'two fixed slots plus three minimum-qualified staff provide five daily slots')
  delete state.shifts[1].staffingMode
  assert.equal(weekdayWeightCapacity(state).maxPercent, 40, 'legacy mode omission means minimum')
  state.shifts[1].staffingMode = 'fixed'
  assert.equal(weekdayWeightCapacity(state).maxPercent, 28, 'all fixed means three daily slots')
})

test('locked assignments cannot consume more than fixed capacity or bypass fixed zero', () => {
  const state = fixture('2026-06', 6)
  state.shifts[0].required = 1
  state.shifts[0].staffingMode = 'fixed'
  state.assignments = [0, 1].map(i => ({ employeeId: `e${i}`, date: '2026-06-01', shiftId: 'day', locked: true }))
  assert.equal(weekdayWeightCapacity(state).maxPercent, null)
  state.assignments.pop()
  assert.equal(weekdayWeightCapacity(state).maxPercent, 28)
  state.shifts[0].required = 0
  assert.equal(weekdayWeightCapacity(state).maxPercent, null)
  delete state.shifts[0].staffingMode
  assert.notEqual(weekdayWeightCapacity(state).maxPercent, null, 'a lock above a minimum is allowed')
  state.assignments.push({ employeeId: 'e0', date: '2026-06-01', shiftId: 'off', locked: true })
  assert.equal(weekdayWeightCapacity(state).maxPercent, null, 'conflicting working/rest locks cannot be collapsed by map insertion order')
})

test('mixed eligibility upper bounds never reject a staffing pattern proven by exhaustive assignment enumeration', () => {
  const profiles = [
    [['fixed'], ['day'], ['day']],
    [['fixed', 'day'], ['fixed'], ['day']],
    [['fixed', 'day'], ['fixed', 'day'], ['fixed']],
    [['fixed', 'day'], ['fixed', 'day'], ['fixed', 'day']],
    [['fixed'], ['fixed'], ['fixed']],
    [['day'], ['day'], ['day']],
  ]
  for (const fixedRequired of [0, 1, 2]) for (const profile of profiles) {
    const state = fixture('2026-06', 3)
    state.shifts = [{ ...state.shifts[0], id: 'fixed', required: fixedRequired, staffingMode: 'fixed' }, { ...state.shifts[0], required: 1 }]
    state.employees.forEach((employee, index) => { employee.eligibleShiftIds = profile[index] })
    const totals = new Set()
    function enumerate(index, fixedCount, minimumCount) {
      if (index === state.employees.length) {
        if (fixedCount === fixedRequired && minimumCount >= 1) totals.add(fixedCount + minimumCount)
        return
      }
      enumerate(index + 1, fixedCount, minimumCount)
      if (profile[index].includes('fixed')) enumerate(index + 1, fixedCount + 1, minimumCount)
      if (profile[index].includes('day')) enumerate(index + 1, fixedCount, minimumCount + 1)
    }
    enumerate(0, 0, 0)
    let provenPercent = null
    for (const selectedDaily of totals) for (const otherDaily of totals) for (let percent = 0; percent <= 100; percent++) {
      const W = selectedDaily * 2 + otherDaily * 5
      if (Math.ceil(W * percent / 100) === selectedDaily * 2) provenPercent = Math.max(provenPercent ?? 0, percent)
    }
    const estimate = weekdayWeightCapacity(state).maxPercent
    if (provenPercent !== null) {
      assert.ok(estimate !== null && estimate >= provenPercent, `must not understate a proven feasible pattern: fixed=${fixedRequired}, qualifications=${JSON.stringify(profile)}`)
    }
  }
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

function priorWork(date, count, shiftId = 'day') {
  return Array.from({ length: count }, (_, index) => ({ employeeId: `e${index}`, date, shiftId, locked: false }))
}

test('confirmed prior-month coverage activates the full first week across New Year without adding out-of-month preview dates', () => {
  const state = fixture('2027-01')
  const withoutHistory = weightedWeeks(state, 14)
  state.assignments = [{ employeeId: 'e0', date: '2026-12-01', shiftId: 'off', locked: false }]
  assert.deepEqual(weightedWeeks(state, 14), withoutHistory, 'one earlier rest record does not prove all members and dates are known')
  confirmMonth(state, '2026-12')
  const weeks = weightedWeeks(state, 14)
  const first = weeks[0]
  assert.deepEqual(first.dates, ['2027-01-01', '2027-01-02', '2027-01-03'])
  assert.deepEqual(first.selectedDates, ['2027-01-02'])
  assert.deepEqual(first.otherDates, ['2027-01-01', '2027-01-03'])
  assert.deepEqual(first.history.dates, ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31'])
  assert.deepEqual(first.history.counts, { '2026-12-28': 0, '2026-12-29': 0, '2026-12-30': 0, '2026-12-31': 0 })
  assert.deepEqual([first.selectedTarget, first.otherTarget, first.totalTarget], [6, 8, 14], 'a known prior month leaves no imaginary work outside the current month')
  assert.equal(findWeightedWeek(state, first, 6, 8)?.fullTotal, 14)
  assert.ok(weeks.flatMap(week => week.dates).every(date => date.startsWith('2027-01-')))
  assert.deepEqual(weeks.slice(1), withoutHistory.slice(1), 'history only affects the month-start week')
})

test('previous-month rest is counted for team weights only when every member has a known cell', () => {
  const state = fixture('2026-09')
  const baseline = weightedWeeks(state, 35)
  for (const assignment of [
    { employeeId: 'departed', date: '2026-08-31', shiftId: 'day' },
    { employeeId: 'departed', date: '2026-08-31', shiftId: 'off' },
    { employeeId: 'e0', date: '2026-08-32', shiftId: 'off' },
    { employeeId: 'e0', date: '2026-07-31', shiftId: 'day' },
    { employeeId: 'e0', date: '2026-09-01', shiftId: 'off' },
  ]) {
    state.assignments = [assignment]
    assert.deepEqual(weightedWeeks(state, 35), baseline, `must not infer known previous-month data from ${JSON.stringify(assignment)}`)
  }
  state.assignments = [{ employeeId: 'e0', date: '2026-08-31', shiftId: 'off' }]
  assert.deepEqual(weightedWeeks(state, 35), baseline, 'one member’s explicit rest does not imply rest for the whole team')
  state.assignments = state.employees.map(employee => ({ employeeId: employee.id, date: '2026-08-31', shiftId: 'off' }))
  const first = weightedWeeks(state, 35)[0]
  assert.deepEqual(first.history.dates, ['2026-08-31'])
  assert.deepEqual(first.history.counts, { '2026-08-31': 0 })
  assert.deepEqual([first.selectedTarget, first.otherTarget], [14, 21])
})

test('month-end weights include confirmed next-month records while incomplete team history stays unconfirmed', () => {
  const monday = fixture('2026-06')
  const mondayBaseline = weightedWeeks(monday, 35)
  monday.assignments = priorWork('2026-05-31', 4)
  assert.deepEqual(weightedWeeks(monday, 35), mondayBaseline)

  const tuesday = fixture('2026-09')
  const monthEnd = weightedWeeks(tuesday, 35).at(-1)
  tuesday.assignments = [...priorWork('2026-08-31', 4), ...priorWork('2026-10-01', 10)]
  assert.deepEqual(weightedWeeks(tuesday, 35).at(-1), monthEnd, 'a few next-month records do not confirm the whole outside week')
  confirmMonth(tuesday, '2026-10')
  const confirmedEnd = weightedWeeks(tuesday, 35).at(-1)
  assert.deepEqual(confirmedEnd.history.dates, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
  assert.deepEqual([confirmedEnd.history.selectedTotal, confirmedEnd.history.otherTotal], [0, 10])
  assert.deepEqual([confirmedEnd.selectedTarget, confirmedEnd.otherTarget], [14, 11], 'confirmed next-month starts consume the same complete-week group totals')
})

test('actual first-week totals subtract recorded history rather than a prorated historical share', () => {
  const state = fixture('2026-09')
  state.assignments = priorWork('2026-08-31', 4)
  confirmMonth(state, '2026-08')
  const savedHistory = structuredClone(state.assignments)
  const first = weightedWeeks(state, 16)[0]
  assert.deepEqual([first.history.selectedTotal, first.history.otherTotal], [4, 0])
  assert.deepEqual([first.selectedTarget, first.otherTarget, first.totalTarget], [3, 9, 12])
  assert.equal(findWeightedWeek(state, first, 3, 9)?.fullTotal, 16, 'four historical plus twelve current starts form the actual full-week total')
  assert.equal(findWeightedWeek(state, first, 4, 9), null, 'eight selected out of seventeen starts violates ceil(17 × 40%) = 7')
  assert.equal(weightedHistoryFits(first), true, 'selected daily counts of four and three are balanced')
  assert.deepEqual(weightedDayRange(first, '2026-09-05'), [3, 4], 'the daily range uses both sides of the natural week')
  weekdayWeightCapacity(state)
  assert.deepEqual(state.assignments, savedHistory, 'weight previews and capacity checks never rewrite history')
})

test('full first-week ratios and daily balance can both be satisfied by the fixed historical counts', () => {
  const state = fixture('2027-01', 4)
  state.shifts[0].required = 1
  state.assignments = [
    ...priorWork('2026-12-28', 2),
    ...priorWork('2026-12-29', 1),
    ...priorWork('2026-12-30', 1),
    ...priorWork('2026-12-31', 1),
  ]
  confirmMonth(state, '2026-12')
  const first = weightedWeeks(state, 9)[0]
  assert.deepEqual([first.history.selectedTotal, first.history.otherTotal], [2, 3])
  assert.deepEqual([first.selectedTarget, first.otherTarget], [2, 2])
  assert.equal(findWeightedWeek(state, first, 2, 2)?.fullTotal, 9)
  assert.equal(weightedHistoryFits(first), true)
  assert.deepEqual(weightedDayRange(first, '2027-01-02'), [2, 2])
  assert.deepEqual(weightedDayRange(first, '2027-01-01'), [1, 1])
  assert.notEqual(weekdayWeightCapacity(state).maxPercent, null)
})

test('historical daily imbalance is infeasible even when the overall first-week ratio is exact', () => {
  const state = fixture('2027-01', 4)
  state.shifts[0].required = 0
  state.assignments = [
    ...priorWork('2026-12-28', 2),
    ...priorWork('2026-12-29', 1),
    ...priorWork('2026-12-30', 3),
    ...priorWork('2026-12-31', 1),
  ]
  confirmMonth(state, '2026-12')
  const first = weightedWeeks(state, 10)[0]
  assert.equal(findWeightedWeek(state, first, 2, 1)?.fullTotal, 10, 'group totals alone are four selected and six other starts')
  assert.equal(weightedHistoryFits(first), false, 'historical other-day counts of one and three already violate the daily spread')
  assert.equal(weekdayWeightCapacity(state).maxPercent, null, 'no current-month assignment can repair that historical difference')
})

test('a preview whose full-week quota is already exceeded by history is explicitly infeasible', () => {
  const state = fixture('2026-09', 4)
  state.assignments = priorWork('2026-08-31', 4)
  confirmMonth(state, '2026-08')
  const first = weightedWeeks(state, 5)[0]
  assert.equal(first.selectedTarget, -2)
  assert.equal(weightedHistoryFits(first), false)
  assert.equal(findWeightedWeek(state, first, 0, 3), null)
})

test('capacity honors fixed historical counts without imposing current minimum coverage on past days', () => {
  function independentlyEnumeratedMaximum(historyCount) {
    let maximum = null
    function enumerate(currentCounts) {
      if (currentCounts.length < 6) {
        for (let count = 1; count <= 4; count++) enumerate([...currentCounts, count])
        return
      }
      const [saturday, ...otherDays] = currentCounts
      if (Math.abs(historyCount - saturday) > 1 || Math.max(...otherDays) - Math.min(...otherDays) > 1) return
      const selected = historyCount + saturday
      const all = selected + otherDays.reduce((sum, count) => sum + count, 0)
      for (let percent = 0; percent <= 100; percent++) {
        if (Math.ceil(all * percent / 100) === selected) maximum = Math.max(maximum ?? 0, percent)
      }
    }
    enumerate([])
    return maximum
  }
  const expected = [16, 37, 50, 58, 61]
  for (let historicalMonday = 0; historicalMonday <= 4; historicalMonday++) {
    const state = fixture('2026-09', 4)
    state.shifts[0].required = 1
    state.assignments = historicalMonday
      ? priorWork('2026-08-31', historicalMonday)
      : [{ employeeId: 'e0', date: '2026-08-01', shiftId: 'off', locked: false }]
    confirmMonth(state, '2026-08')
    assert.equal(independentlyEnumeratedMaximum(historicalMonday), expected[historicalMonday])
    assert.equal(weekdayWeightCapacity(state).maxPercent, expected[historicalMonday], `history fixes Monday at ${historicalMonday}; current Saturday must stay within one`)
  }
})
