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
const { assertCurrentMonthStatus } = require('./helpers/month-picker.cjs')
const url = process.env.WEEKLY_BOUNDARY_TEST_URL || 'http://127.0.0.1:5194'
const output = path.resolve(process.env.WEEKLY_BOUNDARY_TEST_OUTPUT || 'test-results/weekly-boundary')
const DAY = 86400000, MINUTE = 60000
const REFERENCE_DATE = '2026-10-15'
const checks = [], errors = [], workerUrls = []
const report = { url, seed: 1010, startedAt: new Date().toISOString(), scope: 'Real Chromium browser Worker and downloads; independent minute audit; no native Tauri or Python solver', checks, errors, workerUrls, ok: false }
const record = (name, detail) => { checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) }); console.log(`PASS ${name}`) }
const employeeName = '跨月成员'
const dayShift = { id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 0, staffingMode: 'minimum', normalAllowance: 0 }

function fixture({ teamName = '跨月周最低验证', historyDays = 5, firstDayLeave = true } = {}) {
  return {
    version: 1, teamName, month: '2026-11', calendar: {},
    employees: [{ id: 'boundary-1', name: employeeName, role: '值班员', group: '边界组', color: '#d7e8f8', minHoursPerWeek: 40, maxHoursPerWeek: 48, eligibleShiftIds: ['day'], unavailableDates: firstDayLeave ? ['2026-11-01'] : [] }],
    shifts: [{ ...dayShift }], rules: { minRestHours: 0, maxConsecutiveDays: 31 },
    scheduleCoverage: { '2026-10': { employeeIds: ['boundary-1'] } },
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
function knownCell(state, employeeId, date) {
  return state.scheduleCoverage?.[date.slice(0, 7)]?.employeeIds.includes(employeeId)
    || state.assignments.some(item => item.employeeId === employeeId && item.date === date)
}

function audit(original, generated, preview = []) {
  const [monthStart, monthEnd] = monthRange(original.month)
  const weeks = new Map()
  for (let day = monthStart; day < monthEnd; day += DAY) {
    const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY
    weeks.set(monday, (weeks.get(monday) || 0) + 1)
  }
  assert.deepEqual(outsideAssignments(generated), outsideAssignments(original), 'Every historical assignment remains unchanged, including unlocked history')
  assert.deepEqual(generated.employees, original.employees, 'Generation does not change employee hour limits or leave')
  assert.deepEqual(Object.fromEntries(Object.entries(generated.scheduleCoverage ?? {}).filter(([month]) => month !== original.month)), original.scheduleCoverage ?? {}, 'Only the generated month may gain a coverage marker')
  assert.deepEqual([...generated.scheduleCoverage[original.month].employeeIds].sort(), original.employees.map(employee => employee.id).sort())
  for (const item of preview) {
    assert.ok(!item.date.startsWith(`${original.month}-`) && item.date >= REFERENCE_DATE)
    assert.equal(Boolean(knownCell(original, item.employeeId, item.date)), false, 'Preview may not overwrite any known cell')
    assert.equal(item.locked, false)
  }
  const keys = [...generated.assignments, ...preview].map(item => `${item.employeeId}:${item.date}`)
  assert.equal(new Set(keys).size, keys.length, 'At most one assignment per employee and start date')
  for (const assignment of generated.assignments) assert.ok(generated.employees.some(employee => employee.id === assignment.employeeId))
  const members = generated.employees.map(employee => {
    const weekStart = Math.min(...weeks.keys()), weekEnd = Math.max(...weeks.keys()) + 7 * DAY
    const assignments = [...generated.assignments, ...preview].filter(item => item.employeeId === employee.id && Date.parse(`${item.date}T00:00:00Z`) >= weekStart - DAY && Date.parse(`${item.date}T00:00:00Z`) < weekEnd + DAY)
    const work = assignments.map(item => interval(item, generated.shifts)).filter(Boolean).sort((a, b) => a[0] - b[0])
    const fixed = original.assignments.filter(item => item.employeeId === employee.id && (item.locked || !item.date.startsWith(`${original.month}-`))).map(item => interval(item, original.shifts)).filter(Boolean)
    for (let index = 1; index < work.length; index++) {
      assert.ok(work[index][0] >= work[index - 1][1], 'Work intervals do not overlap')
      assert.ok(work[index][0] - work[index - 1][1] >= original.rules.minRestHours * 60 * MINUTE, 'Minimum rest remains enforced')
    }
    for (const assignment of assignments.filter(item => item.shiftId !== 'off')) {
      assert.ok(employee.eligibleShiftIds.includes(assignment.shiftId), 'Shift qualification remains enforced')
      const [start, end] = interval(assignment, generated.shifts)
      for (const date of employee.unavailableDates) {
        const from = Date.parse(`${date}T00:00:00Z`)
        assert.ok(end <= from || start >= from + DAY, 'Actual current and provisional work cannot overlap leave, including overnight tails')
      }
    }
    let previousDay = -Infinity, streak = 0
    for (const assignment of assignments.filter(item => item.shiftId !== 'off').sort((a, b) => a.date.localeCompare(b.date))) {
      const day = Date.parse(`${assignment.date}T00:00:00Z`)
      streak = day === previousDay + DAY ? streak + 1 : 1
      assert.ok(streak <= original.rules.maxConsecutiveDays, 'Consecutive day limit remains enforced')
      previousDay = day
    }
    const monthMinutes = minutesWithin(work, monthStart, monthEnd)
    const weekly = [...weeks].map(([monday, days]) => {
      const weekEnd = monday + 7 * DAY, inStart = Math.max(monday, monthStart), inEnd = Math.min(weekEnd, monthEnd)
      const fullMinimum = Math.ceil(employee.minHoursPerWeek * 60)
      const wholeDates = Array.from({ length: 7 }, (_, index) => new Date(monday + index * DAY).toISOString().slice(0, 10))
      const unknownPast = wholeDates.filter(date => !date.startsWith(`${original.month}-`) && date < REFERENCE_DATE && !knownCell(original, employee.id, date))
      const requiredWholeWeek = Math.ceil(fullMinimum * (7 - unknownPast.length) / 7)
      const knownOutside = minutesWithin(fixed, monday, weekEnd) - minutesWithin(fixed, inStart, inEnd)
      const inMonth = minutesWithin(work, inStart, inEnd), wholeWeek = minutesWithin(work, monday, weekEnd)
      assert.ok(wholeWeek >= requiredWholeWeek, `${employee.name}: ${new Date(monday).toISOString().slice(0, 10)} actual fixed/current/provisional work must reach ${requiredWholeWeek} minutes; has ${wholeWeek}`)
      assert.ok(wholeWeek <= Math.floor(employee.maxHoursPerWeek * 60), `${employee.name}: whole-week cap still includes outside history`)
      return { monday: new Date(monday).toISOString().slice(0, 10), days, unknownPast, knownOutside, requiredWholeWeek, inMonth, wholeWeek }
    })
    return { employeeId: employee.id, monthMinutes, weekly }
  })
  return { assignmentCount: generated.assignments.length, members }
}
function weightedHistoryFixture(unbalanced = false) {
  const result = fixture({ teamName: unbalanced ? '上月固定人次不均不可忽略' : '完整自然周星期权重', historyDays: 0, firstDayLeave: false })
  result.employees = Array.from({ length: 8 }, (_, index) => ({ ...result.employees[0], id: `weighted-${index + 1}`, name: `权重成员${index + 1}`, minHoursPerWeek: 0, maxHoursPerWeek: 168 }))
  result.scheduleCoverage['2026-10'].employeeIds = result.employees.map(employee => employee.id)
  result.shifts[0].required = 1
  result.rules.weekdayWeights = { days: [7], percent: 50 }
  result.assignments = Array.from({ length: 6 }, (_, index) => ({ employeeId: `weighted-${index + 1}`, date: `2026-10-${unbalanced && index === 5 ? 26 : 26 + index}`, shiftId: 'day', locked: index % 2 === 0 }))
  return result
}
function auditFullWeekWeights(original, generated, preview = []) {
  assert.deepEqual(outsideAssignments(generated), original.assignments, 'Weight balancing must not rewrite any fixed historical person-count')
  const work = [...generated.assignments, ...preview].filter(item => item.shiftId !== 'off')
  const weeks = [['2026-10-26', '2026-11-01'], ['2026-11-02', '2026-11-08'], ['2026-11-09', '2026-11-15'], ['2026-11-16', '2026-11-22'], ['2026-11-23', '2026-11-29'], ['2026-11-30', '2026-12-06']]
  return weeks.map(([first, last]) => {
    const records = work.filter(item => item.date >= first && item.date <= last)
    const dates = Array.from({ length: 7 }, (_, day) => new Date(Date.parse(`${first}T00:00:00Z`) + day * DAY).toISOString().slice(0, 10))
    const counts = dates.map(date => records.filter(item => item.date === date).length)
    const total = records.length, selected = counts[6], other = counts.slice(0, 6).reduce((sum, value) => sum + value, 0)
    // Directly count the seven actual dates; no extrapolated/prorated candidate
    // totals and no application weekday-weight helpers are used as an oracle.
    assert.equal(selected, Math.ceil(total / 2), `${first}: Sunday is half of the actual complete-week person-count, rounded up`)
    assert.equal(selected + other, total)
    assert.ok(Math.max(...counts.slice(0, 6)) - Math.min(...counts.slice(0, 6)) <= 1, `${first}: the other six dates must share their actual group total evenly`)
    assert.ok(counts.every(count => count >= 1), `${first}: daily staffing minima remain satisfied`)
    if (first === '2026-10-26') {
      assert.deepEqual(counts.slice(0, 6), [1, 1, 1, 1, 1, 1])
      assert.ok(selected >= 6, 'Six retained weekday assignments require at least six Sunday assignments, not the month-only prorated four')
    }
    return { first, last, counts, total, selected, other }
  })
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  await fs.rm(path.join(output, 'failure.png'), { force: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', acceptDownloads: true })
  page.setDefaultTimeout(10000)
  await page.clock.setFixedTime(new Date(`${REFERENCE_DATE}T04:00:00Z`))
  await page.addInitScript(() => {
    Math.random = () => 1010.5 / 2147483647
    window.__boundaryResults = []
    const ActualWorker = window.Worker
    window.Worker = class extends ActualWorker {
      constructor(...args) { super(...args); this.addEventListener('message', event => { if (event.data.result) window.__boundaryResults.push(event.data.result) }) }
    }
  })
  page.on('worker', worker => workerUrls.push(worker.url()))
  page.on('pageerror', error => errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const guidanceCaptured = new Set()
  let lastWorkerResult, generationCount = 0
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1') || 'null'))
  async function assertCell(date, label) {
    await page.getByRole('button', { name: '月视图', exact: true }).click()
    const cell = page.getByRole('button', { name: `${employeeName} ${date} ${label}，点击编辑`, exact: true })
    assert.equal(await cell.count(), 1, `${date} must expose its actual schedule state as ${label}`)
    assert.equal((await cell.locator('span').first().innerText()).trim(), label)
  }
  async function persisted(predicate) {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) { const value = await state(); if (value && predicate(value)) return value; await page.waitForTimeout(50) }
    assert.fail(`Expected state did not persist: ${JSON.stringify(await state())}`)
  }
  async function importFixture(document, name) {
    await fs.writeFile(path.join(output, `${name}-input.json`), JSON.stringify(document, null, 2) + '\n')
    await page.locator('input[type=file]:not([aria-label="导入规则文件"])').setInputFiles({ name: `${name}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) })
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await persisted(value => value.teamName === document.teamName && JSON.stringify(value.assignments) === JSON.stringify(document.assignments))
  }
  async function generate(expectedSuccess) {
    const original = await state()
    await page.getByRole('button', { name: '自动排班', exact: true }).click()
    const explanation = page.getByRole('region', { name: '跨月自然周说明', exact: true })
    await explanation.waitFor()
    const carried = original.employees.every(employee => original.scheduleCoverage?.['2026-10']?.employeeIds.includes(employee.id))
    assert.equal(await explanation.locator('[data-boundary-week="start"]').count(), 1)
    assert.equal(await explanation.locator('[data-boundary-week="end"]').count(), 1)
    assert.match(await explanation.innerText(), /只保存本月/)
    if (carried) assert.match(await explanation.innerText(), /已计入上月排班/)
    if (!guidanceCaptured.has(carried)) {
      guidanceCaptured.add(carried)
      await page.screenshot({ path: path.join(output, carried ? '08-generation-carried-guidance.png' : '10-generation-no-history-guidance.png') })
      if (carried) {
        await page.setViewportSize({ width: 320, height: 650 })
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        assert.equal(await explanation.evaluate(node => node.scrollWidth > node.clientWidth), false)
        await page.screenshot({ path: path.join(output, '09-generation-carried-guidance-320.png') })
        await page.setViewportSize({ width: 1440, height: 1050 })
      }
    }
    const beforeResults = await page.evaluate(() => window.__boundaryResults.length)
    generationCount++
    await page.getByRole('button', { name: '开始生成', exact: true }).click()
    await page.locator('.sp-solve-result').waitFor({ timeout: 45000 })
    await page.waitForFunction(count => window.__boundaryResults.length > count, beforeResults)
    lastWorkerResult = await page.evaluate(() => window.__boundaryResults.at(-1))
    const text = await page.locator('.sp-solve-result').innerText()
    assert.equal(lastWorkerResult.success, expectedSuccess, text)
    if (expectedSuccess) await persisted(value => value.scheduleCoverage?.[value.month]?.employeeIds.length === value.employees.length)
    else assert.match(text, /原排班未改变/)
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
    let completeHistory = fixture()
    const legacyHistory = structuredClone(completeHistory)
    legacyHistory.month = '2026-10'; delete legacyHistory.scheduleCoverage
    legacyHistory.assignments.forEach(item => { item.locked = true })
    legacyHistory.assignments.push({ employeeId: 'boundary-1', date: '2026-10-31', shiftId: 'off', locked: true })
    await importFixture(legacyHistory, 'previous-month-before-generation')
    assert.equal(await page.getByRole('button', { name: '确认本月记录完整', exact: true }).count(), 0)
    await assertCell('2026-10-01', '待排')
    await assertCell('2026-10-31', '休息')
    await generate(true)
    const generatedPrevious = await state()
    assert.deepEqual(generatedPrevious.scheduleCoverage['2026-10'].employeeIds, ['boundary-1'])
    assert.deepEqual(generatedPrevious.employees[0].unavailableDates, ['2026-11-01'], 'Automatically generated rest never becomes employee leave')
    for (const fixed of legacyHistory.assignments) assert.deepEqual(generatedPrevious.assignments.find(item => item.employeeId === fixed.employeeId && item.date === fixed.date), fixed)
    const generatedBlank = Array.from({ length: 31 }, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`).find(date => !generatedPrevious.assignments.some(item => item.date === date))
    assert.ok(generatedBlank, 'The generated month contains actual blank rest cells')
    await assertCell(generatedBlank, '休息')
    await page.getByRole('button', { name: '下个月', exact: true }).click()
    await persisted(value => value.month === '2026-11')
    completeHistory = await state()
    await assertCell('2026-11-01', '请假')
    record('real-previous-month-generation-automatically-marks-blank-days-as-rest-without-confirmation-or-changing-leave-before-generating-the-neighbor')
    const historyMessage = await generate(true)
    const historyResult = await persisted(value => value.assignments.some(item => item.date.startsWith('2026-11')))
    const historyAudit = audit(completeHistory, historyResult, lastWorkerResult.boundaryPreview)
    const firstWeek = historyAudit.members[0].weekly[0]
    assert.deepEqual(firstWeek, { monday: '2026-10-26', days: 1, unknownPast: [], knownOutside: 2400, requiredWholeWeek: 2400, inMonth: 0, wholeWeek: 2400 })
    assert.equal(historyResult.assignments.some(item => item.date === '2026-11-01' && item.shiftId !== 'off'), false)
    await assertCell('2026-11-01', '请假')
    assert.match(historyMessage, /排班已生成/)
    assert.match(historyMessage, /相邻月份未来排班尚未确认/)
    assert.ok(lastWorkerResult.issues.some(issue => issue.type === 'boundary-future-unconfirmed' && issue.severity === 'warning'))
    assert.equal(lastWorkerResult.issues.some(issue => issue.severity === 'error'), false)
    await fs.writeFile(path.join(output, 'complete-history-generated.json'), JSON.stringify(historyResult, null, 2) + '\n')
    await page.screenshot({ path: path.join(output, '01-history-credits-boundary-week.png') })
    record('known-october-40-hours-satisfy-boundary-week-with-november-first-on-leave', historyAudit)

    const currentExport = await downloadRules('导出规则', 'complete-history-current-debug.json')
    assert.equal(currentExport.debug.source, 'current')
    assert.equal(currentExport.debug.runtime, 'browser')
    assert.deepEqual(outsideAssignments(currentExport.state), completeHistory.assignments)
    assert.deepEqual(currentExport.state.employees.map(employee => [employee.minHoursPerWeek, employee.maxHoursPerWeek]), [[40, 48]])
    assert.ok(currentExport.state.employees.every(employee => !Object.hasOwn(employee, 'minHoursPerMonth')))
    assert.equal(currentExport.options.referenceDate, REFERENCE_DATE)
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

    const noHistory = fixture({ teamName: '未知下月临时预排不发布' })
    noHistory.employees[0].unavailableDates.push('2026-11-30')
    await importFixture(noHistory, 'future-unknown')
    await generate(true)
    const noHistoryResult = await state()
    const noHistoryAudit = audit(noHistory, noHistoryResult, lastWorkerResult.boundaryPreview), lastUnknown = noHistoryAudit.members[0].weekly.at(-1)
    assert.equal(lastUnknown.inMonth, 0)
    assert.ok(lastUnknown.wholeWeek >= 2400)
    assert.ok(lastWorkerResult.boundaryPreview.filter(item => item.date.startsWith('2026-12-')).length >= 5)
    assert.equal(noHistoryResult.assignments.some(item => item.date.startsWith('2026-12-')), false)
    assert.equal(Object.hasOwn(noHistoryResult.scheduleCoverage, '2026-12'), false)
    await fs.writeFile(path.join(output, 'no-history-generated.json'), JSON.stringify(noHistoryResult, null, 2) + '\n')
    await page.screenshot({ path: path.join(output, '02-future-preview-not-published.png') })
    await page.reload({ waitUntil: 'networkidle' })
    assert.deepEqual(await state(), noHistoryResult)
    record('future-preview-completes-the-last-week-without-publishing-december-assignments-or-coverage-even-after-reload', noHistoryAudit)

    const completeRest = structuredClone(noHistory)
    completeRest.teamName = '下月已确认全休不能借用临时工时'
    completeRest.scheduleCoverage['2026-12'] = { employeeIds: ['boundary-1'] }
    await importFixture(completeRest, 'future-confirmed-rest')
    const restMessage = await generate(false)
    assert.match(restMessage, /2026-11-30/)
    assert.deepEqual((await state()).assignments, completeRest.assignments)
    assert.deepEqual((await state()).scheduleCoverage, completeRest.scheduleCoverage)
    record('confirmed-all-rest-december-makes-the-last-full-week-infeasible-without-overwriting-its-known-empty-cells')

    const partialFuture = structuredClone(noHistory)
    partialFuture.teamName = '单条下月休息只确认一格'
    partialFuture.assignments.push({ employeeId: 'boundary-1', date: '2026-12-01', shiftId: 'off', locked: false })
    await importFixture(partialFuture, 'future-partial-rest')
    await generate(true)
    audit(partialFuture, await state(), lastWorkerResult.boundaryPreview)
    assert.deepEqual(lastWorkerResult.boundaryPreview.filter(item => item.date.startsWith('2026-12-')).map(item => item.date).sort(), ['2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06'])
    record('one-december-off-cell-stays-fixed-while-other-unconfirmed-cells-remain-available-for-real-lookahead')

    const remote = structuredClone(noHistory)
    remote.teamName = '远月无关超时记录不阻断本月'
    remote.assignments.unshift(...Array.from({ length: 7 }, (_, index) => ({ employeeId: 'boundary-1', date: `2026-06-${String(index + 1).padStart(2, '0')}`, shiftId: 'day', locked: false })))
    await importFixture(remote, 'remote-unrelated-conflict')
    await generate(true)
    audit(remote, await state(), lastWorkerResult.boundaryPreview)
    record('unrelated-remote-56-hour-week-is-retained-without-blocking-current-48-hour-week-limit-generation')

    const sixHourGap = fixture({ teamName: '上月32小时加本月6小时不足整周40', historyDays: 4, firstDayLeave: false })
    sixHourGap.shifts.push({ ...dayShift, id: 'six', name: '六小时班', shortName: '六', end: '14:00' })
    sixHourGap.employees[0].eligibleShiftIds.push('six')
    sixHourGap.assignments.push({ employeeId: 'boundary-1', date: '2026-11-01', shiftId: 'six', locked: true })
    await importFixture(sixHourGap, 'history-32-plus-six-insufficient')
    const sixHourMessage = await generate(false)
    assert.match(sixHourMessage, /原排班未改变/)
    assert.match(sixHourMessage, /2026-10-26/)
    assert.ok(lastWorkerResult.issues.some(issue => issue.type === 'weekly-min-hours'))
    assert.deepEqual((await state()).assignments, sixHourGap.assignments)
    record('retained-32-hours-plus-only-six-available-hours-fails-the-real-40-hour-first-week', { message: sixHourMessage, fixedMinutes: 32 * 60, availableInMonthMinutes: 6 * 60, requiredWholeWeekMinutes: 40 * 60 })

    const eightHourGap = fixture({ teamName: '上月32小时本月补8小时', historyDays: 4, firstDayLeave: false })
    await importFixture(eightHourGap, 'history-32-plus-eight')
    await generate(true)
    const eightHourResult = await persisted(value => value.assignments.some(item => item.date === '2026-11-01'))
    const eightHourAudit = audit(eightHourGap, eightHourResult, lastWorkerResult.boundaryPreview), eightHourWeek = eightHourAudit.members[0].weekly[0]
    assert.equal(eightHourWeek.knownOutside, 1920)
    assert.equal(eightHourWeek.inMonth, 480)
    assert.equal(eightHourWeek.wholeWeek, 2400)
    assert.equal(eightHourResult.assignments.find(item => item.date === '2026-11-01').shiftId, 'day')
    const lastWeek = eightHourAudit.members[0].weekly.at(-1)
    assert.equal(lastWeek.monday, '2026-11-30')
    assert.equal(lastWeek.requiredWholeWeek, 2400)
    assert.ok(lastWeek.wholeWeek >= 2400, 'The last whole week includes an actual feasible future preview')
    await fs.writeFile(path.join(output, 'history-32-plus-eight-generated.json'), JSON.stringify(eightHourResult, null, 2) + '\n')
    await page.screenshot({ path: path.join(output, '05-history-32-plus-eight.png') })
    record('retained-32-hours-generates-eight-more-hours-to-reach-40-and-the-last-week-also-meets-the-full-minimum', eightHourAudit)

    const offHistory = fixture({ teamName: '上月完整全休必须补整周', historyDays: 0, firstDayLeave: false })
    offHistory.assignments.push({ employeeId: 'boundary-1', date: '2026-10-30', shiftId: 'off', locked: false })
    await importFixture(offHistory, 'off-history')
    const offMessage = await generate(false)
    assert.ok(lastWorkerResult.issues.some(issue => issue.type === 'weekly-min-hours'))
    assert.deepEqual((await state()).assignments, offHistory.assignments)
    record('confirmed-all-rest-october-requires-the-full-first-week-minimum-without-inventing-worked-hours', { message: offMessage })

    const pastPartial = fixture({ teamName: '过去缺失历史不默认休息也不补造', historyDays: 0, firstDayLeave: false })
    pastPartial.month = '2026-10'
    pastPartial.scheduleCoverage = {}
    pastPartial.assignments = [{ employeeId: 'boundary-1', date: '2026-09-30', shiftId: 'off', locked: false }]
    await importFixture(pastPartial, 'past-partial-history')
    await generate(true)
    audit(pastPartial, await state(), lastWorkerResult.boundaryPreview)
    assert.ok(lastWorkerResult.issues.some(issue => /history-incomplete/.test(issue.type) && issue.severity === 'warning'))
    assert.ok(lastWorkerResult.boundaryContext.incompleteHistory.some(item => item.unknownDates.includes('2026-09-28')))
    assert.equal(lastWorkerResult.boundaryPreview.some(item => item.date < REFERENCE_DATE), false)
    record('a-single-past-off-record-does-not-confirm-the-month-and-unknown-history-remains-an-explicit-warning')

    const weightedHistory = weightedHistoryFixture()
    await importFixture(weightedHistory, 'weighted-history')
    await generate(true)
    const weightedResult = await persisted(value => value.assignments.some(item => item.date === '2026-11-01'))
    audit(weightedHistory, weightedResult, lastWorkerResult.boundaryPreview)
    const weightAudit = auditFullWeekWeights(weightedHistory, weightedResult, lastWorkerResult.boundaryPreview)
    await fs.writeFile(path.join(output, 'weighted-history-generated.json'), JSON.stringify(weightedResult, null, 2) + '\n')
    await page.screenshot({ path: path.join(output, '06-full-week-weighted-history.png') })
    record('weekday-weights-use-seven-actual-dates-including-fixed-october-person-counts-and-even-groups', weightAudit)

    const unbalancedHistory = weightedHistoryFixture(true)
    await importFixture(unbalancedHistory, 'weighted-unbalanced-history')
    const unbalancedMessage = await generate(false)
    assert.match(unbalancedMessage, /原排班未改变/)
    assert.deepEqual((await state()).assignments, unbalancedHistory.assignments)
    await page.screenshot({ path: path.join(output, '07-fixed-history-uneven-group.png') })
    record('uneven-fixed-october-daily-counts-cannot-be-hidden-by-a-correct-group-total', { fixedOtherGroupCounts: [2, 1, 1, 1, 1, 0], message: unbalancedMessage })

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
    assert.ok(lastWorkerResult.issues.some(issue => issue.type === 'weekly-min-hours'))
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
    assert.equal(attemptExport.options.referenceDate, REFERENCE_DATE)
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

    const allRest = fixture({ teamName: '零记录完整全休的删除与撤销', historyDays: 0, firstDayLeave: false })
    allRest.employees[0].minHoursPerWeek = 0
    allRest.scheduleCoverage['2026-12'] = { employeeIds: ['boundary-1'] }
    await importFixture(allRest, 'all-rest-generation')
    await assertCurrentMonthStatus(page, 'empty')
    await assertCell('2026-11-01', '待排')
    await generate(true)
    assert.deepEqual((await state()).assignments, [])
    assert.deepEqual((await state()).employees[0].unavailableDates, [])
    assert.equal(await page.getByRole('button', { name: '确认本月记录完整', exact: true }).count(), 0)
    await assertCurrentMonthStatus(page, 'scheduled')
    await assertCell('2026-11-01', '休息')
    await page.getByRole('button', { name: '删除本月排班', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click()
    await persisted(value => !value.scheduleCoverage?.['2026-11'])
    await assertCurrentMonthStatus(page, 'empty')
    await assertCell('2026-11-01', '待排')
    await page.getByRole('button', { name: '撤销上次调整', exact: true }).click()
    await persisted(value => value.scheduleCoverage?.['2026-11']?.employeeIds.includes('boundary-1'))
    await assertCurrentMonthStatus(page, 'scheduled')
    await assertCell('2026-11-01', '休息')
    assert.deepEqual((await state()).assignments, [])
    assert.deepEqual((await state()).employees[0].unavailableDates, [])
    await page.screenshot({ path: path.join(output, '11-generated-rest-restored-after-undo.png') })
    record('automatically-generated-all-rest-month-with-zero-rows-is-scheduled-and-delete-undo-restores-coverage-without-inventing-leave')

    assert.equal(workerUrls.length, generationCount, 'Every scenario creates a real browser Worker')
    assert.ok(workerUrls.every(workerUrl => /scheduler\.worker/.test(workerUrl)), JSON.stringify(workerUrls))
    record('real-browser-workers-perform-every-boundary-scenario-without-native-or-solver-mocks', { generationCount })
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
