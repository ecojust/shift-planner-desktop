import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { formatChangeTime } from '../changeTime.ts'

function formatInTimezone(timezone, timestamps) {
  const moduleUrl = new URL('../changeTime.ts', import.meta.url).href
  const script = `import { formatChangeTime } from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify(${JSON.stringify(timestamps)}.map(formatChangeTime)));`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, TZ: timezone }, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return JSON.parse(result.stdout)
}

test('change timestamps format in UTC and local time across day and year boundaries', () => {
  const timestamps = ['2026-12-31T16:05:09.987Z', '2027-01-01T00:05:09+08:00', '2026-12-31T11:05:09-05:00']
  assert.deepEqual(formatInTimezone('UTC', timestamps), Array(3).fill('2026-12-31 16:05:09'))
  assert.deepEqual(formatInTimezone('Asia/Shanghai', timestamps), Array(3).fill('2027-01-01 00:05:09'))
})

test('change timestamps use New York winter and summer offsets for their recorded instant', () => {
  assert.deepEqual(formatInTimezone('America/New_York', ['2026-01-15T04:05:06Z', '2026-07-15T04:05:06Z']), [
    '2026-01-14 23:05:06', '2026-07-15 00:05:06',
  ])
})

test('invalid, missing, timezone-free and rolling timestamps remain unrecorded', () => {
  for (const value of [
    '', 'invalid', null, undefined, 0,
    '2026-10-15', '2026-10-15T12:30:45', '2026-10-15T12:30:45.000',
    '2026-02-29T12:30:45Z', '2026-04-31T12:30:45+08:00', '2026-02-30T12:30:45-05:00',
    '2026-00-15T12:30:45Z', '2026-13-15T12:30:45Z', '2026-10-00T12:30:45Z',
    '2026-10-15T24:00:00Z', '2026-10-15T12:60:00Z', '2026-10-15T12:30:60Z',
    '2026-10-15T12:30:45+24:00', '2026-10-15T12:30:45+08:60', '2026-10-15T12:30:45+0800',
    ' 2026-10-15T12:30:45Z', '2026-10-15T12:30:45Z ',
  ]) assert.equal(formatChangeTime(value), '时间未记录', String(value))
})

test('valid leap dates and early years retain fixed width and second precision', () => {
  assert.deepEqual(formatInTimezone('UTC', ['2028-02-29T01:02:03.123456Z', '0099-01-02T03:04:05Z']), [
    '2028-02-29 01:02:03', '0099-01-02 03:04:05',
  ])
})
