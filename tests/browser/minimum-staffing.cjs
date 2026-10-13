/* Start Vite on 5197, then run with PLAYWRIGHT_MODULE_PATH and optionally
 * PLAYWRIGHT_EXECUTABLE_PATH. This checks the real browser worker, not a native
 * Tauri binary. The oracle below deliberately imports no scheduling helpers. */
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const DAY = 86400000, MINUTE = 60000

function fixture(required = 1) {
  return {
    version: 1, teamName: `每日最低人数验证 · ${required} 人`, month: '2026-10', calendar: {},
    employees: Array.from({ length: 12 }, (_, index) => ({ id: `coverage-${index + 1}`, name: `成员${String(index + 1).padStart(2, '0')}`, role: '值班员', group: '测试组', color: '#d7e8f8', minHoursPerMonth: 144, minHoursPerWeek: 40, maxHoursPerWeek: 56, eligibleShiftIds: ['early', 'late', 'night'], unavailableDates: [] })),
    shifts: [
      { id: 'early', name: '早班', shortName: '早', start: '08:00', end: '16:00', color: '#dbeee6', required, normalAllowance: 0 },
      { id: 'late', name: '晚班', shortName: '晚', start: '14:00', end: '22:00', color: '#fff0d2', required, normalAllowance: 0 },
      { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#e6dff5', required, normalAllowance: 50 },
    ],
    rules: { minRestHours: 11, maxConsecutiveDays: 5 }, assignments: [],
  }
}

function audit(state) {
  const monthStart = Date.parse(`${state.month}-01T00:00:00Z`)
  const endDate = new Date(monthStart); endDate.setUTCMonth(endDate.getUTCMonth() + 1)
  const monthEnd = +endDate, dates = [], weeks = new Map()
  for (let day = monthStart; day < monthEnd; day += DAY) {
    const date = new Date(day).toISOString().slice(0, 10)
    dates.push(date)
    const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY
    weeks.set(monday, (weeks.get(monday) || 0) + 1)
  }
  const current = state.assignments.filter(item => item.date.startsWith(state.month) && item.shiftId !== 'off')
  assert.equal(new Set(current.map(item => `${item.employeeId}:${item.date}`)).size, current.length, 'At most one shift per employee per start date')
  let surplusDates = 0
  for (const date of dates) {
    for (const shift of state.shifts) {
      const count = current.filter(item => item.date === date && item.shiftId === shift.id).length
      assert.ok(count >= shift.required, `${date} ${shift.id}: ${count} < minimum ${shift.required}`)
      if (count > shift.required) surplusDates++
    }
  }
  const overlapMinutes = (intervals, from, to) => intervals.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(end, to) - Math.max(start, from)) / MINUTE, 0)
  const members = state.employees.map(employee => {
    const assignments = state.assignments.filter(item => item.employeeId === employee.id && item.shiftId !== 'off').sort((a, b) => a.date.localeCompare(b.date))
    const intervals = assignments.map(item => {
      const shift = state.shifts.find(entry => entry.id === item.shiftId)
      assert.ok(shift && employee.eligibleShiftIds.includes(shift.id), `${employee.id}: valid shift qualification`)
      assert.ok(!employee.unavailableDates.includes(item.date), `${employee.id}: leave respected`)
      const date = Date.parse(`${item.date}T00:00:00Z`)
      const clock = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
      const first = clock(shift.start), last = clock(shift.end)
      return [date + first * MINUTE, date + (last > first ? last : last + 1440) * MINUTE]
    }).sort((a, b) => a[0] - b[0])
    for (let index = 1; index < intervals.length; index++) {
      assert.ok(intervals[index][0] - intervals[index - 1][1] >= state.rules.minRestHours * 60 * MINUTE, `${employee.id}: minimum rest`)
    }
    let streak = 0, previous = -Infinity
    for (const item of assignments) {
      const day = Date.parse(`${item.date}T00:00:00Z`)
      streak = day - previous === DAY ? streak + 1 : 1
      assert.ok(streak <= state.rules.maxConsecutiveDays, `${employee.id}: maximum consecutive days`)
      previous = day
    }
    const monthMinutes = overlapMinutes(intervals, monthStart, monthEnd)
    assert.ok(monthMinutes >= employee.minHoursPerMonth * 60, `${employee.id}: monthly ${monthMinutes / 60} < ${employee.minHoursPerMonth}`)
    const weeklyHours = [...weeks].map(([monday, days]) => {
      const whole = overlapMinutes(intervals, monday, monday + 7 * DAY)
      const inMonth = overlapMinutes(intervals, Math.max(monday, monthStart), Math.min(monday + 7 * DAY, monthEnd))
      const minimum = Math.ceil(employee.minHoursPerWeek * 60 * days / 7)
      assert.ok(inMonth >= minimum, `${employee.id}: ${new Date(monday).toISOString().slice(0, 10)} weekly minimum ${inMonth} < ${minimum} minutes`)
      assert.ok(whole <= employee.maxHoursPerWeek * 60, `${employee.id}: weekly maximum`)
      return { monday: new Date(monday).toISOString().slice(0, 10), inMonthHours: inMonth / 60, wholeWeekHours: whole / 60, minimumMinutes: minimum }
    })
    return { id: employee.id, monthHours: monthMinutes / 60, weeklyHours }
  })
  assert.ok(surplusDates > 0, 'Meeting employee hours requires staffing above the daily minima')
  return { assignments: current.length, baselineMinimum: dates.length * state.shifts.reduce((sum, shift) => sum + shift.required, 0), surplusDateShiftPairs: surplusDates, members }
}

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
  const url = process.env.STAFFING_TEST_URL || 'http://127.0.0.1:5197'
  const output = path.resolve(process.env.STAFFING_TEST_OUTPUT || 'test-results/minimum-staffing-ui')
  await fs.mkdir(output, { recursive: true })
  await fs.rm(path.join(output, 'failure.png'), { force: true })
  const checks = [], errors = []
  const report = { url, seed: 1010, startedAt: new Date().toISOString(), scope: 'Real Chromium worker; independent integer-minute audit; no native packaging', checks, errors, ok: false }
  const record = (name, detail) => { checks.push({ name, ok: true, detail }); console.log(`PASS ${name}`) }
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1080 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  // App derives its worker seed from Math.random; stabilize that input while
  // still exercising the real button, worker transport and schedule search.
  await page.addInitScript(() => { Math.random = () => 1010.5 / 2147483647 })
  page.on('pageerror', error => errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1') || 'null'))
  async function persisted(predicate) {
    for (let tries = 0; tries < 160; tries++) { const value = await state(); if (value && predicate(value)) return value; await page.waitForTimeout(50) }
    assert.fail('Expected state did not persist')
  }
  async function navigate(label) {
    const mobile = page.getByRole('button', { name: '打开导航', exact: true })
    const compact = await mobile.isVisible()
    if (compact) await mobile.click()
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: label }).click()
    if (compact) await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
  }
  async function importFixture(document) {
    await page.locator('input[type=file]').setInputFiles({ name: 'minimum-staffing.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) })
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await persisted(value => value.teamName === document.teamName && JSON.stringify(value.assignments) === JSON.stringify(document.assignments))
  }
  async function generate() {
    await navigate('排班日历')
    await page.getByRole('button', { name: '自动排班', exact: true }).click()
    assert.match(await page.locator('.sp-generation-summary').innerText(), /至少需要/)
    await page.getByRole('button', { name: '开始生成', exact: true }).click()
    await page.locator('.sp-solve-result').waitFor({ timeout: 45000 })
    const text = await page.locator('.sp-solve-result').innerText()
    assert.equal(await page.locator('.sp-solve-result').evaluate(element => element.classList.contains('is-warning')), false, text)
    await page.getByRole('button', { name: '关闭求解结果', exact: true }).click()
    return persisted(value => value.assignments.length > 0)
  }
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    await importFixture(fixture())
    await navigate('班次设置')
    const shiftCard = page.locator('.sp-settings-shift-card').filter({ has: page.getByRole('heading', { name: '早班', exact: true }) })
    assert.match(await shiftCard.innerText(), /每日最少\s*1\s*人/)
    await shiftCard.getByRole('button', { name: '编辑早班', exact: true }).click()
    assert.equal(await page.getByLabel('每日最少人数', { exact: true }).inputValue(), '1')
    await page.getByLabel('每日最少人数', { exact: true }).fill('2')
    await page.getByRole('button', { name: '保存班次', exact: true }).click()
    await persisted(value => value.shifts.find(shift => shift.id === 'early').required === 2)
    await shiftCard.getByRole('button', { name: '编辑早班', exact: true }).click()
    await page.getByLabel('每日最少人数', { exact: true }).fill('1')
    await page.getByRole('button', { name: '保存班次', exact: true }).click()
    await persisted(value => value.shifts.every(shift => shift.required === 1))
    record('shift-editor-saves-daily-minimum')
    await page.screenshot({ path: path.join(output, '01-shift-minimum-settings.png') })

    const generated = await generate()
    record('12-members-month144-week40-to56-cover-each-shift-with-extra-staff', audit(generated))
    assert.doesNotMatch(await page.locator('body').innerText(), /超编|overstaffed/)
    assert.match(await page.locator('.sp-check-status').innerText(), /排班检查通过/)
    await page.getByRole('button', { name: '月视图', exact: true }).click()
    await page.screenshot({ path: path.join(output, '02-high-hours-roster-desktop.png') })
    await fs.writeFile(path.join(output, 'generated-roster.json'), JSON.stringify(generated, null, 2) + '\n')
    record('surplus-staff-is-accepted-and-calendar-displays-result')

    await navigate('成员管理')
    assert.equal(await page.getByLabel('成员01每月最低工时', { exact: true }).inputValue(), '144')
    assert.equal(await page.getByLabel('成员01每周最低工时', { exact: true }).inputValue(), '40')
    assert.equal(await page.getByLabel('成员01每周最高工时', { exact: true }).inputValue(), '56')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
    const size = await page.evaluate(() => ({ viewport: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
    assert.ok(size.html <= size.viewport && size.body <= size.viewport, JSON.stringify(size))
    await page.screenshot({ path: path.join(output, '03-member-hours-mobile.png') })
    record('mobile-member-cards-preserve-bounds-and-fit-screen', size)

    await page.setViewportSize({ width: 1600, height: 1080 })
    await importFixture(fixture(0))
    const noFloor = await generate()
    record('zero-minimum-shifts-can-be-used-to-meet-personal-hours', audit(noFloor))

    // A minimum is still mandatory: with only two people, three separate daily
    // shifts cannot all be covered. A candidate must not replace the old table.
    const impossible = fixture()
    impossible.teamName = '不足最低人数时保留原排班'
    impossible.employees = impossible.employees.slice(0, 2).map(employee => ({ ...employee, minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 168 }))
    impossible.rules = { minRestHours: 0, maxConsecutiveDays: 31 }
    impossible.assignments = [{ employeeId: 'coverage-1', date: '2026-10-01', shiftId: 'early', locked: true }]
    await importFixture(impossible)
    await navigate('排班日历')
    await page.getByRole('button', { name: '自动排班', exact: true }).click()
    await page.getByRole('button', { name: '开始生成', exact: true }).click()
    await page.locator('.sp-solve-result').waitFor({ timeout: 45000 })
    assert.equal(await page.locator('.sp-solve-result').evaluate(element => element.classList.contains('is-warning')), true)
    assert.match(await page.locator('.sp-solve-result').innerText(), /原排班未改变/)
    assert.deepEqual((await state()).assignments, impossible.assignments)
    record('minimum-staffing-shortage-rejects-candidate-and-preserves-locked-roster')
    assert.deepEqual(errors, [])
    record('no-browser-console-or-page-errors')
    report.ok = true
  } catch (error) {
    report.failure = error.stack || String(error)
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
