/* Fresh production preview required:
 * WEEKLY_BOUNDARY_TEST_URL=http://127.0.0.1:5194 \
 * PLAYWRIGHT_MODULE_PATH=/path/to/playwright PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium \
 * node tests/browser/weekly-boundary.cjs
 * Real Vue UI, real browser Worker and downloads. The minute-based audit below
 * imports no application scheduling helpers and uses the original input history.
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const url = process.env.WEEKLY_BOUNDARY_TEST_URL || 'http://127.0.0.1:5194'
const output = path.resolve(process.env.WEEKLY_BOUNDARY_TEST_OUTPUT || 'test-results/weekly-boundary')
const DAY = 86400000, MINUTE = 60000
const checks = [], errors = [], workerUrls = []
const report = { url, seed: 1010, startedAt: new Date().toISOString(), scope: 'Real Chromium browser Worker and downloads; independent minute audit; no native Tauri or Python solver', checks, errors, workerUrls, ok: false }
const record = (name, detail) => { checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) }); console.log(`PASS ${name}`) }
const employeeName = '跨月成员'
const dayShift = { id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 0, staffingMode: 'minimum', normalAllowance: 0 }

function fixture({ teamName = '跨月周最低验证', historyDays = 5, firstDayLeave = true } = {}) {
  return {
    version: 1, teamName, month: '2026-11', calendar: {},
    employees: [{ id: 'boundary-1', name: employeeName, role: '值班员', group: '边界组', color: '#d7e8f8', minHoursPerMonth: 0, minHoursPerWeek: 40, maxHoursPerWeek: 48, eligibleShiftIds: ['day'], unavailableDates: firstDayLeave ? ['2026-11-01'] : [] }],
    shifts: [{ ...dayShift }], rules: { minRestHours: 0, maxConsecutiveDays: 31 },
    // Unlocked out-of-month history is equally authoritative and must survive.
    assignments: Array.from({ length: historyDays }, (_, index) => ({ employeeId: 'boundary-1', date: `2026-10-${26 + index}`, shiftId: 'day', locked: index % 2 === 0 })),
  }
}

function monthRange(month) {
  const start = Date.parse(`${month}-01T00:00:00Z`), end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  return [start, +end]
}
function interval(assignment, shifts) {
  if (assignment.shiftId === 'off') return null
  const shift = shifts.find(item => item.id === assignment.shiftId)
  assert.ok(shift, `Unknown shift ${assignment.shiftId}`)
  const midnight = Date.parse(`${assignment.date}T00:00:00Z`)
  const clock = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
  const start = clock(shift.start), end = clock(shift.end)
  return [midnight + start * MINUTE, midnight + (end > start ? end : end + 1440) * MINUTE]
}
function minutesWithin(intervals, from, to) {
  return intervals.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(end, to) - Math.max(start, from)) / MINUTE, 0)
}
function outsideAssignments(state) { return state.assignments.filter(item => !item.date.startsWith(`${state.month}-`)) }

function audit(original, generated) {
  const [monthStart, monthEnd] = monthRange(original.month)
  const weeks = new Map()
  for (let day = monthStart; day < monthEnd; day += DAY) {
    const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY
    weeks.set(monday, (weeks.get(monday) || 0) + 1)
  }
  assert.deepEqual(outsideAssignments(generated), outsideAssignments(original), 'Every historical assignment remains unchanged, including unlocked history')
  assert.deepEqual(generated.employees, original.employees, 'Generation does not change employee hour limits or leave')
  const keys = generated.assignments.map(item => `${item.employeeId}:${item.date}`)
  assert.equal(new Set(keys).size, keys.length, 'At most one assignment per employee and start date')
  for (const assignment of generated.assignments) assert.ok(generated.employees.some(employee => employee.id === assignment.employeeId))
  const members = generated.employees.map(employee => {
    const assignments = generated.assignments.filter(item => item.employeeId === employee.id)
    const work = assignments.map(item => interval(item, generated.shifts)).filter(Boolean).sort((a, b) => a[0] - b[0])
    const fixed = original.assignments.filter(item => item.employeeId === employee.id && (item.locked || !item.date.startsWith(`${original.month}-`))).map(item => interval(item, original.shifts)).filter(Boolean)
    for (let index = 1; index < work.length; index++) {
      assert.ok(work[index][0] >= work[index - 1][1], 'Work intervals do not overlap')
      assert.ok(work[index][0] - work[index - 1][1] >= original.rules.minRestHours * 60 * MINUTE, 'Minimum rest remains enforced')
    }
    for (const assignment of assignments.filter(item => item.date.startsWith(`${original.month}-`) && item.shiftId !== 'off')) {
      assert.ok(employee.eligibleShiftIds.includes(assignment.shiftId), 'Shift qualification remains enforced')
      assert.ok(!employee.unavailableDates.includes(assignment.date), 'Leave remains enforced')
    }
    let previousDay = -Infinity, streak = 0
    for (const assignment of assignments.filter(item => item.shiftId !== 'off').sort((a, b) => a.date.localeCompare(b.date))) {
      const day = Date.parse(`${assignment.date}T00:00:00Z`)
      streak = day === previousDay + DAY ? streak + 1 : 1
      assert.ok(streak <= original.rules.maxConsecutiveDays, 'Consecutive day limit remains enforced')
      previousDay = day
    }
    const monthMinutes = minutesWithin(work, monthStart, monthEnd)
    assert.ok(monthMinutes >= Math.ceil(employee.minHoursPerMonth * 60), 'Monthly minimum is separately satisfied')
    const weekly = [...weeks].map(([monday, days]) => {
      const weekEnd = monday + 7 * DAY, inStart = Math.max(monday, monthStart), inEnd = Math.min(weekEnd, monthEnd)
      const fullMinimum = Math.ceil(employee.minHoursPerWeek * 60)
      const proratedMinimum = Math.ceil(fullMinimum * days / 7)
      const knownOutside = minutesWithin(fixed, monday, weekEnd) - minutesWithin(fixed, inStart, inEnd)
      const requiredInMonth = Math.min(proratedMinimum, Math.max(0, fullMinimum - knownOutside))
      const inMonth = minutesWithin(work, inStart, inEnd), wholeWeek = minutesWithin(work, monday, weekEnd)
      assert.ok(inMonth >= requiredInMonth, `${employee.name}: ${new Date(monday).toISOString().slice(0, 10)} needs ${requiredInMonth} minutes; has ${inMonth}`)
      assert.ok(wholeWeek <= Math.floor(employee.maxHoursPerWeek * 60), `${employee.name}: whole-week cap still includes outside history`)
      return { monday: new Date(monday).toISOString().slice(0, 10), days, proratedMinimum, knownOutside, requiredInMonth, inMonth, wholeWeek }
    })
    return { employeeId: employee.id, monthMinutes, weekly }
  })
  return { assignmentCount: generated.assignments.length, members }
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  await fs.rm(path.join(output, 'failure.png'), { force: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', acceptDownloads: true })
  page.setDefaultTimeout(10000)
  await page.addInitScript(() => { Math.random = () => 1010.5 / 2147483647 })
  page.on('worker', worker => workerUrls.push(worker.url()))
  page.on('pageerror', error => errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1') || 'null'))
  async function persisted(predicate) {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) { const value = await state(); if (value && predicate(value)) return value; await page.waitForTimeout(50) }
    assert.fail(`Expected state did not persist: ${JSON.stringify(await state())}`)
  }
  async function importFixture(document, name) {
    await fs.writeFile(path.join(output, `${name}-input.json`), JSON.stringify(document, null, 2) + '\n')
    await page.locator('input[type=file]').setInputFiles({ name: `${name}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) })
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await persisted(value => value.teamName === document.teamName && JSON.stringify(value.assignments) === JSON.stringify(document.assignments))
  }
  async function generate(expectedSuccess) {
    await page.getByRole('button', { name: '自动排班', exact: true }).click()
    await page.getByRole('button', { name: '开始生成', exact: true }).click()
    await page.locator('.sp-solve-result').waitFor({ timeout: 45000 })
    const text = await page.locator('.sp-solve-result').innerText()
    assert.equal(await page.locator('.sp-solve-result').evaluate(element => element.classList.contains('is-warning')), !expectedSuccess, text)
    return text
  }
  async function downloadRules(button, filename) {
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: button, exact: true }).click()
    const download = await pending
    const file = path.join(output, filename)
    await download.saveAs(file)
    return JSON.parse(await fs.readFile(file, 'utf8'))
  }
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    assert.equal(await page.evaluate(() => !!(window.isTauri || window.__TAURI_INTERNALS__)), false)
    const completeHistory = fixture()
    await importFixture(completeHistory, 'complete-history')
    const historyMessage = await generate(true)
    const historyResult = await persisted(value => value.assignments.some(item => item.date.startsWith('2026-11')))
    const historyAudit = audit(completeHistory, historyResult)
    const firstWeek = historyAudit.members[0].weekly[0]
    assert.deepEqual(firstWeek, { monday: '2026-10-26', days: 1, proratedMinimum: 343, knownOutside: 2400, requiredInMonth: 0, inMonth: 0, wholeWeek: 2400 })
    assert.equal(historyResult.assignments.some(item => item.date === '2026-11-01' && item.shiftId !== 'off'), false)
    assert.match(historyMessage, /规则检查通过/)
    assert.match(await page.locator('.sp-check-status').innerText(), /排班检查通过/)
    await fs.writeFile(path.join(output, 'complete-history-generated.json'), JSON.stringify(historyResult, null, 2) + '\n')
    await page.screenshot({ path: path.join(output, '01-history-credits-boundary-week.png') })
    record('known-october-40-hours-satisfy-boundary-week-with-november-first-on-leave', historyAudit)

    const currentExport = await downloadRules('导出规则', 'complete-history-current-debug.json')
    assert.equal(currentExport.debug.source, 'current')
    assert.equal(currentExport.debug.runtime, 'browser')
    assert.deepEqual(outsideAssignments(currentExport.state), completeHistory.assignments)
    assert.deepEqual(currentExport.state.employees.map(employee => [employee.minHoursPerMonth, employee.minHoursPerWeek, employee.maxHoursPerWeek]), [[0, 40, 48]])
    record('current-debug-download-preserves-all-month-outside-history-and-hour-limits')

    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: '成员管理' }).click()
    await page.getByLabel(`${employeeName}每周最高工时`, { exact: true }).fill('56')
    await persisted(value => value.employees[0].maxHoursPerWeek === 56)
    assert.equal(await page.getByLabel(`${employeeName}每周最低工时`, { exact: true }).inputValue(), '40')
    assert.equal(await page.locator('.sp-settings-employee-card').getByRole('alert').count(), 0)
    await page.reload({ waitUntil: 'networkidle' })
    assert.deepEqual((await state()).employees.map(employee => [employee.minHoursPerWeek, employee.maxHoursPerWeek]), [[40, 56]])
    assert.deepEqual(outsideAssignments(await state()), completeHistory.assignments)
    record('explicit-40-to56-weekly-input-is-accepted-and-survives-refresh-with-history-intact')

    const noHistory = fixture({ teamName: '无历史仍需折算最低', historyDays: 0, firstDayLeave: false })
    await importFixture(noHistory, 'no-history')
    await generate(true)
    const noHistoryResult = await persisted(value => value.assignments.some(item => item.date === '2026-11-01'))
    const noHistoryAudit = audit(noHistory, noHistoryResult), controlWeek = noHistoryAudit.members[0].weekly[0]
    assert.deepEqual(controlWeek, { monday: '2026-10-26', days: 1, proratedMinimum: 343, knownOutside: 0, requiredInMonth: 343, inMonth: 480, wholeWeek: 480 })
    assert.equal(noHistoryResult.assignments.find(item => item.date === '2026-11-01').shiftId, 'day')
    await fs.writeFile(path.join(output, 'no-history-generated.json'), JSON.stringify(noHistoryResult, null, 2) + '\n')
    await page.screenshot({ path: path.join(output, '02-no-history-retains-prorated-minimum.png') })
    record('no-history-control-still-requires-343-minutes-and-generates-november-first', noHistoryAudit)

    const shortfall = fixture({ teamName: '月外36小时仍需补足4小时' })
    shortfall.shifts.push({ ...dayShift, id: 'half', name: '短班', shortName: '短', end: '12:00' })
    shortfall.employees[0].eligibleShiftIds.push('half')
    shortfall.assignments[4].shiftId = 'half'
    shortfall.assignments.push({ employeeId: 'boundary-1', date: '2026-11-05', shiftId: 'day', locked: false })
    await importFixture(shortfall, 'remaining-four-hours')
    const shortfallMessage = await generate(false)
    assert.match(shortfallMessage, /原排班未改变/)
    assert.match(shortfallMessage, /跨月成员/)
    assert.match(shortfallMessage, /2026-10-26/)
    assert.match(shortfallMessage, /周最低工时\s*4\s*小时/)
    assert.match(shortfallMessage, /月外已知工时\s*36\s*小时/)
    assert.match(shortfallMessage, /建议：/)
    assert.match(shortfallMessage, /跨月|自然周/)
    assert.ok(await page.locator('.sp-solve-result').getByRole('button', { name: /查看成员设置/ }).count() > 0)
    await page.waitForTimeout(500)
    assert.deepEqual((await state()).assignments, shortfall.assignments)
    await page.screenshot({ path: path.join(output, '03-genuine-four-hour-shortfall.png') })
    record('genuine-remaining-four-hour-shortfall-has-specific-evidence-and-preserves-old-table', { message: shortfallMessage, originalAssignmentCount: shortfall.assignments.length })

    const attemptExport = await downloadRules('导出本次规则', 'remaining-four-hours-attempt-debug.json')
    assert.equal(attemptExport.protocolVersion, 1)
    assert.equal(attemptExport.debug.source, 'attempt')
    assert.equal(attemptExport.debug.runtime, 'browser')
    assert.equal(attemptExport.options.seed, 1010)
    assert.deepEqual(attemptExport.state.assignments, shortfall.assignments)
    assert.deepEqual(outsideAssignments(attemptExport.state), shortfall.assignments.slice(0, 5))
    assert.deepEqual(attemptExport.state.employees[0].unavailableDates, ['2026-11-01'])
    assert.equal(attemptExport.state.shifts.find(shift => shift.id === 'half').end, '12:00')
    record('failed-attempt-debug-retains-original-history-leave-short-shift-and-request-seed')

    const overCap = fixture({ teamName: '跨月最低抵扣不放宽周最高', historyDays: 6, firstDayLeave: false })
    overCap.assignments.push({ employeeId: 'boundary-1', date: '2026-11-01', shiftId: 'day', locked: true })
    await importFixture(overCap, 'whole-week-cap')
    const capMessage = await generate(false)
    assert.match(capMessage, /原排班未改变/)
    assert.match(capMessage, /2026-10-26/)
    assert.match(capMessage, /56\s*小时/)
    assert.match(capMessage, /超过\s*48\s*小时上限/)
    await page.waitForTimeout(500)
    assert.deepEqual((await state()).assignments, overCap.assignments)
    await page.screenshot({ path: path.join(output, '04-whole-week-cap-still-enforced.png') })
    record('whole-week-56-hour-conflict-still-rejects-against-48-hour-cap-and-preserves-roster', { message: capMessage })

    assert.equal(workerUrls.length, 4, 'Every scenario creates a real browser Worker')
    assert.ok(workerUrls.every(workerUrl => /scheduler\.worker/.test(workerUrl)), JSON.stringify(workerUrls))
    record('four-real-browser-workers-perform-the-scenarios-without-native-or-solver-mocks')
    assert.deepEqual(errors, [])
    record('no-browser-console-or-page-errors')
    report.ok = true
  } catch (error) {
    report.failure = error.stack || String(error)
    report.lastState = await state().catch(() => null)
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    await browser.close()
  }
}
module.exports = { fixture, audit }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
