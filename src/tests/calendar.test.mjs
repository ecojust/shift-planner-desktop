import test from 'node:test'
import assert from 'node:assert/strict'
import { dayInfo, calendarYearInfo } from '../calendar.ts'

// Independent fixtures from the published 2026 arrangement, not library-derived expectations.
const statutory2026 = new Set(['2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-04-05', '2026-05-01', '2026-05-02', '2026-06-19', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-03'])
const work2026 = new Set(['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'])
const holiday2026 = [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']]

test('all 365 dates agree with the 2026 statutory, holiday and compensatory-workday arrangement', () => {
  for (let stamp = Date.UTC(2026, 0, 1); stamp < Date.UTC(2027, 0, 1); stamp += 86400000) {
    const date = new Date(stamp).toISOString().slice(0, 10)
    const weekday = new Date(stamp).getUTCDay()
    const off = holiday2026.some(([first, last]) => date >= `2026-${first}` && date <= `2026-${last}`)
    const expected = statutory2026.has(date) ? 'statutory' : work2026.has(date) ? 'workday' : off || [0, 6].includes(weekday) ? 'restday' : 'workday'
    assert.equal(dayInfo(date).kind, expected, date)
    assert.equal(dayInfo(date).verified, true, date)
    assert.match(dayInfo(date).source, /国家节假日及调休安排/)
  }
})

test('lunar holidays and Qingming change with the year; the 2025 additions are statutory', () => {
  for (const date of ['2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-04-04', '2025-05-02', '2025-05-31', '2025-10-06']) {
    assert.equal(dayInfo(date).kind, 'statutory', date)
    assert.equal(dayInfo(date).verified, true, date)
  }
  assert.match(dayInfo('2025-01-28').label, /除夕/)
  assert.match(dayInfo('2026-02-16').label, /除夕/)
  assert.equal(dayInfo('2026-04-04').kind, 'restday')
  assert.equal(dayInfo('2025-10-04').kind, 'restday')
  assert.equal(dayInfo('2025-09-28').kind, 'workday')
  let total = 0
  for (let stamp = Date.UTC(2025, 0, 1); stamp < Date.UTC(2026, 0, 1); stamp += 86400000) if (dayInfo(new Date(stamp).toISOString().slice(0, 10)).kind === 'statutory') total++
  assert.equal(total, 13)
})

test('folk festivals and continuous holiday breaks are never all statutory', () => {
  for (const date of ['2026-03-03', '2026-08-19']) assert.equal(dayInfo(date).kind, 'workday', date)
  for (const date of ['2026-02-15', '2026-02-20', '2026-05-05', '2026-10-07', '2026-10-17']) assert.equal(dayInfo(date).kind, 'restday', date)
})

test('missing future arrangements and historical legal regimes require verification', () => {
  for (const year of [2001, 2020, 2024, 2027, 2028]) assert.equal(calendarYearInfo(year).verified, false, String(year))
  assert.match(calendarYearInfo(2024).reason, /历史年份/)
  assert.match(calendarYearInfo(2027).reason, /尚未收录/)
  for (const date of ['2024-02-09', '2027-01-01', '2028-01-01']) {
    assert.equal(dayInfo(date).verified, false, date)
    assert.match(dayInfo(date).label, /待核对/)
  }
  // No guessed future 3x dates, and no current-law treatment of the historical eve.
  assert.equal(dayInfo('2027-01-01').kind, 'workday')
  assert.equal(dayInfo('2024-02-09').kind, 'workday')
})

test('manual overrides win over statutory, adjusted and unverified defaults without changing other dates', () => {
  const overrides = { '2026-10-01': 'workday', '2026-10-10': 'restday', '2027-01-01': 'statutory' }
  for (const [date, kind] of Object.entries(overrides)) {
    assert.equal(dayInfo(date, overrides).kind, kind)
    assert.equal(dayInfo(date, overrides).verified, true)
    assert.match(dayInfo(date, overrides).label, /手动/)
    assert.equal(dayInfo(date, overrides).source, '用户自定义日历')
  }
  assert.equal(dayInfo('2026-10-02', overrides).kind, 'statutory')
  assert.equal(dayInfo('2026-02-30', { '2026-02-30': 'statutory' }).verified, false)
  const inherited = Object.create({ '2026-10-01': 'workday' })
  assert.equal(dayInfo('2026-10-01', inherited).kind, 'statutory')
})
