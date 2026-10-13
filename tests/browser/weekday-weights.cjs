/* Real browser integration checks. Start Vite first, then run:
 * HOURS_TEST_URL=http://127.0.0.1:5197 PLAYWRIGHT_MODULE_PATH=/path/to/playwright node tests/browser/weekday-weights.cjs
 * Optional: PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium
 * Native Tauri/CP-SAT packaging is outside this browser suite.
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
let chromium
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')) }
catch { console.error('Browser checks need Playwright. Install it separately or set PLAYWRIGHT_MODULE_PATH to its package directory.'); process.exit(2) }
const url = process.env.HOURS_TEST_URL || 'http://127.0.0.1:5197'
const output = path.resolve(process.env.WEIGHTS_TEST_OUTPUT || 'test-results/weekday-weights-ui')
const checks = [], errors = []
const report = { url, mode: process.env.WEIGHTS_ENGINE_ONLY ? 'engine-and-calendar' : 'full-ui', startedAt: new Date().toISOString(), scope: 'Real Chromium web UI and browser worker; not native Tauri/CP-SAT packaging', checks, errors, ok: false }
const record = (name, detail) => { checks.push({ name, ok: true, detail }); console.log(`PASS ${name}`) }

function fixture(employeeCount = 12, weights) {
  return {
    version: 1, teamName: '星期权重验证团队', month: '2025-10',
    employees: Array.from({ length: employeeCount }, (_, i) => ({ id: `qa-${i + 1}`, name: `测试成员${i + 1}`, role: '测试岗位', group: '甲组', color: '#d7e8f8', minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 168, eligibleShiftIds: ['day'], unavailableDates: [] })),
    shifts: [{ id: 'day', name: '白班', shortName: '白', start: '08:00', end: '16:00', color: '#dbeee6', required: 5 }],
    rules: { minRestHours: 0, maxConsecutiveDays: 31, balanceWeekends: true, ...(weights ? { weekdayWeights: weights } : {}) },
    assignments: [], calendar: {},
  }
}

// These are explicitly displayed calculation examples for W=35, not hard
// staffing targets. Actual schedules may need larger totals to cover minima.
const OCTOBER = [
  { monday: '2025-09-29', selected: ['2025-10-04'], other: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-05'], selectedTarget: 7, otherTarget: 17 },
  ...['06', '13', '20'].map(day => {
    const first = Number(day)
    return { monday: `2025-10-${day}`, selected: [first, first + 5].map(n => `2025-10-${String(n).padStart(2, '0')}`), other: [first + 1, first + 2, first + 3, first + 4, first + 6].map(n => `2025-10-${String(n).padStart(2, '0')}`), selectedTarget: 14, otherTarget: 21 }
  }),
  { monday: '2025-10-27', selected: ['2025-10-27'], other: ['2025-10-28', '2025-10-29', '2025-10-30', '2025-10-31'], selectedTarget: 7, otherTarget: 17 },
]
function verifyOctober(assignments) {
  const current = assignments.filter(a => a.date.startsWith('2025-10') && a.shiftId !== 'off')
  assert.equal(new Set(current.map(a => `${a.date}:${a.employeeId}`)).size, current.length, 'No employee may work two shifts on one date')
  assert.ok(current.every(a => a.shiftId === 'day'))
  const audited = []
  for (const week of OCTOBER) {
    const selected = current.filter(a => week.selected.includes(a.date)).length
    const other = current.filter(a => week.other.includes(a.date)).length
    const candidates = []
    for (let fullTotal = 35; fullTotal <= 12 * 7; fullTotal++) {
      const fullSelected = Math.ceil(fullTotal * .4)
      if (Math.ceil(fullSelected * week.selected.length / 2) === selected && Math.ceil((fullTotal - fullSelected) * week.other.length / 5) === other) candidates.push(fullTotal)
    }
    assert.ok(candidates.length, `${week.monday}: ${selected}+${other} must represent the configured actual-total share`)
    for (const [dates, target] of [[week.selected, selected], [week.other, other]]) {
      const actual = current.filter(a => dates.includes(a.date)).length
      assert.equal(actual, target, `${week.monday} ${dates.join(',')} quota`)
      for (const date of dates) {
        const count = current.filter(a => a.date === date).length
        assert.ok(count >= 5, `${date}: daily minimum must not be reduced by weekday weights`)
        assert.ok(count >= Math.floor(target / dates.length) && count <= Math.ceil(target / dates.length), `${date}: ${count} outside group distribution`)
      }
    }
    audited.push({ monday: week.monday, selected, other, total: selected + other, fullWeekCountCandidates: candidates })
  }
  assert.ok(current.length > 155, '40% on Monday/Saturday requires additional staffing to preserve all daily minima')
  return audited
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', acceptDownloads: true })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1') || 'null'))
  async function persisted(predicate) {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) { const current = await state(); if (current && predicate(current)) return current; await page.waitForTimeout(50) }
    assert.fail(`State did not persist: ${JSON.stringify(await state())}`)
  }
  async function navigate(label) {
    const mobile = page.getByRole('button', { name: '打开导航', exact: true })
    if (await mobile.isVisible()) await mobile.click()
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: label }).click()
  }
  async function importDocument(document) {
    await page.locator('input[type=file]').setInputFiles({ name: 'weights-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) })
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    return persisted(s => s.teamName === document.teamName && s.employees.length === document.employees.length && s.month === document.month && JSON.stringify(s.rules.weekdayWeights) === JSON.stringify(document.rules.weekdayWeights))
  }
  async function widthCheck(name) {
    const size = await page.evaluate(() => ({ viewport: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
    assert.ok(size.html <= size.viewport && size.body <= size.viewport, `${name}: ${JSON.stringify(size)}`)
    record(name, size)
  }
  async function generate(expectSuccess = true) {
    await navigate('排班日历')
    await page.getByRole('button', { name: '自动排班', exact: true }).click()
    await page.getByRole('button', { name: '开始生成', exact: true }).click()
    await page.locator('.sp-solve-result').waitFor({ timeout: 35000 })
    const result = await page.locator('.sp-solve-result').innerText()
    assert.equal(await page.locator('.sp-solve-result').evaluate(e => e.classList.contains('is-warning')), !expectSuccess, result)
    await page.getByRole('button', { name: '关闭求解结果', exact: true }).click()
    return result
  }
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    const weightedFixture = fixture(12, { days: [1, 6], percent: 40 })
    await importDocument(weightedFixture)
    await generate()
    const generated = await persisted(s => s.assignments.filter(a => a.date.startsWith('2025-10')).length > 155)
    record('real-worker-weighted-quotas-and-daily-minima', { weeks: verifyOctober(generated.assignments), total: generated.assignments.length })
    await page.getByText('155 个需求班位已满足', { exact: true }).waitFor()
    await page.getByRole('button', { name: '月视图', exact: true }).click()
    const footer = await page.locator('.sp-schedule-table tfoot tr').first().locator('td').allInnerTexts()
    for (let index = 0; index < 31; index++) {
      const date = `2025-10-${String(index + 1).padStart(2, '0')}`
      const count = generated.assignments.filter(item => item.date === date && item.shiftId === 'day').length
      assert.equal(footer[index].replace(/\s/g, ''), `${count}/5`)
    }
    await page.getByRole('button', { name: '自动排班', exact: true }).click()
    assert.match(await page.locator('.sp-generation-summary').innerText(), /需求 155 个班位/)
    await page.getByRole('button', { name: '关闭自动排班', exact: true }).click()
    await page.screenshot({ path: path.join(output, '01-weighted-roster.png') })
    record('weighted-calendar-footer-total-and-generation-summary')

    const insufficient = fixture(2, { days: [1, 6], percent: 40 })
    insufficient.assignments = [{ employeeId: 'qa-1', date: '2025-10-01', shiftId: 'day', locked: true }]
    await importDocument(insufficient)
    const failedText = await generate(false)
    assert.match(failedText, /未找到.*原排班未改变/)
    assert.deepEqual((await state()).assignments, insufficient.assignments)
    assert.deepEqual((await state()).rules.weekdayWeights, insufficient.rules.weekdayWeights)
    record('hard-quota-failure-preserves-existing-locked-roster')
    if (process.env.WEIGHTS_ENGINE_ONLY) {
      assert.deepEqual(errors, [])
      record('no-browser-console-or-page-errors')
      report.ok = true
      return
    }

    await importDocument(fixture())
    await navigate('排班规则')
    const enabled = page.getByLabel('启用上班权重', { exact: true })
    const percent = page.getByLabel('所选星期合计占比', { exact: true })
    const names = ['一', '二', '三', '四', '五', '六', '日']
    async function setEnabled(value) {
      // Exercise the actual checkbox hit target without forcing or DOM mutation.
      await enabled.setChecked(value)
      assert.equal(await enabled.isChecked(), value)
    }
    async function selectDays(days) {
      for (let i = 0; i < 7; i++) await page.getByLabel(`上班权重星期${names[i]}`, { exact: true }).setChecked(days.includes(i + 1))
    }
    async function saveRule(days, value) {
      await selectDays(days)
      await percent.fill(String(value))
      await page.getByRole('button', { name: '保存规则', exact: true }).click()
      return persisted(s => JSON.stringify(s.rules.weekdayWeights?.days) === JSON.stringify(days) && s.rules.weekdayWeights.percent === value)
    }
    async function preview(monday, selected, other, total) {
      const examples = page.locator('.sp-settings-calculation-details')
      if (await examples.getAttribute('open') === null) await examples.locator(':scope > summary').click()
      const row = page.locator(`.sp-settings-weight-preview article[data-week="${monday}"]`)
      assert.equal(Number.parseInt(await row.locator('.sp-settings-weight-selected').innerText(), 10), selected)
      assert.equal(Number.parseInt(await row.locator('.sp-settings-weight-other').innerText(), 10), other)
      assert.equal(Number.parseInt(await row.locator('.sp-settings-weight-total').innerText(), 10), total)
    }
    assert.equal(await page.getByRole('checkbox', { name: '公平分配周末班', exact: true }).count(), 0)
    assert.equal(await enabled.isChecked(), false)
    await setEnabled(true)
    assert.equal((await state()).rules.weekdayWeights, undefined, 'Draft must not persist before Save')
    await saveRule([1, 6], 40)
    assert.equal(await page.locator('.sp-settings-calculation-details').getAttribute('open'), null, 'Calculation examples should start collapsed')
    for (const week of OCTOBER) await preview(week.monday, week.selectedTarget, week.otherTarget, week.selectedTarget + week.otherTarget)
    assert.equal(Number.parseInt(await page.locator('.sp-settings-weight-month-total').innerText(), 10), 153)
    record('controls-replace-weekend-switch-and-save-team-rule')
    record('october-example-full-and-partial-weeks', { exampleFullWeek: 35, totals: [24, 35, 35, 35, 24], monthExample: 153 })
    assert.match(await page.locator('.sp-settings-weight-capacity').innerText(), /48%/)
    const firstWeek = page.locator('.sp-settings-weight-preview article').first()
    await firstWeek.locator('summary').click()
    assert.equal((await firstWeek.locator('li.selected strong').innerText()).trim(), '7 班')
    assert.deepEqual(await firstWeek.locator('li:not(.selected) strong').allInnerTexts(), ['4–5 班', '4–5 班', '4–5 班', '4–5 班'])
    await firstWeek.locator('summary').click()
    record('capacity-reference-and-expanded-daily-range')
    const exampleTotal = page.getByLabel('完整周演示总班数', { exact: true })
    assert.equal(await exampleTotal.inputValue(), '35')
    assert.match(await page.locator('.sp-settings-weight-formula').innerText(), /未达到严格覆盖所需人数/)
    const savedBeforeExample = await state()
    await exampleTotal.fill('42')
    await preview('2025-09-29', 9, 20, 29)
    await preview('2025-10-06', 17, 25, 42)
    assert.equal(Number.parseInt(await page.locator('.sp-settings-weight-month-total').innerText(), 10), 184)
    assert.deepEqual(await state(), savedBeforeExample, 'Changing a worked example must not change scheduling rules')
    await exampleTotal.fill('35')
    record('editable-example-is-not-fixed-capacity-or-persisted-rule')
    await widthCheck('desktop-rules-page-no-overflow')
    if (await page.getByRole('button', { name: '关闭提示', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭提示', exact: true }).click()
    await page.getByRole('heading', { name: '上班权重', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, '02a-weight-controls-desktop.png') })
    await page.locator('.sp-settings-weight-preview').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, '02-weight-preview-desktop.png') })

    const savedRule = { days: [1, 6], percent: 40 }
    for (const invalid of ['', '-1', '101', '40.5']) {
      await percent.fill(invalid)
      await page.getByRole('button', { name: '保存规则', exact: true }).click()
      assert.ok(!(await percent.evaluate(e => e.validity.valid)) || await page.locator('.sp-settings-error').isVisible(), `Invalid percentage ${invalid} needs feedback`)
      assert.deepEqual((await state()).rules.weekdayWeights, savedRule)
    }
    await percent.fill('40')
    await selectDays([])
    await page.getByRole('button', { name: '保存规则', exact: true }).click()
    assert.match(await page.locator('.sp-settings-error').innerText(), /选择|星期/)
    assert.deepEqual((await state()).rules.weekdayWeights, savedRule)
    await selectDays([1, 2, 3, 4, 5, 6, 7])
    await percent.fill('99')
    await page.getByRole('button', { name: '保存规则', exact: true }).click()
    assert.match(await page.locator('.sp-settings-error').innerText(), /100/)
    assert.deepEqual((await state()).rules.weekdayWeights, savedRule)
    await saveRule([1, 2, 3, 4, 5, 6, 7], 100)
    await preview('2025-09-29', 25, 0, 25)
    await preview('2025-10-06', 35, 0, 35)
    assert.equal(Number.parseInt(await page.locator('.sp-settings-weight-month-total').innerText(), 10), 155)
    record('percentage-empty-range-integer-and-full-week-validation')
    await saveRule([1, 6], 0)
    await preview('2025-10-06', 0, 35, 35)
    record('zero-selected-weight-is-valid')
    await saveRule([1, 6], 40)

    await navigate('成员管理')
    await page.getByLabel('全局排班月份').fill('2025-04')
    await page.getByLabel('全局排班月份').dispatchEvent('change')
    await persisted(s => s.month === '2025-04')
    await navigate('排班规则')
    await preview('2025-03-31', 7, 21, 28)
    assert.equal(Number.parseInt(await page.locator('.sp-settings-weight-month-total').innerText(), 10), 149)
    record('missing-monday-preview-retains-outside-month-share', { firstWeek: 28, selected: 7, other: 21, month: 149 })
    await navigate('成员管理')
    await page.getByLabel('全局排班月份').fill('2025-10')
    await page.getByLabel('全局排班月份').dispatchEvent('change')
    await persisted(s => s.month === '2025-10')
    await page.reload({ waitUntil: 'networkidle' })
    await navigate('排班规则')
    assert.equal(await enabled.isChecked(), true)
    assert.equal(await percent.inputValue(), '40')
    assert.deepEqual((await state()).rules.weekdayWeights, savedRule)
    await preview('2025-09-29', 7, 17, 24)
    record('refresh-restores-rule-and-preview')

    await page.getByRole('button', { name: '备份与恢复', exact: true }).click()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /^导出完整备份/ }).click()
    const download = await downloadPromise
    const backupPath = path.join(output, 'weekday-weights-backup.json')
    await download.saveAs(backupPath)
    const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'))
    assert.deepEqual(backup.rules.weekdayWeights, savedRule)
    await setEnabled(false)
    await page.getByRole('button', { name: '保存规则', exact: true }).click()
    await persisted(s => s.rules.weekdayWeights === undefined)
    await generate()
    const unweighted = await persisted(s => s.assignments.filter(a => a.date.startsWith('2025-10')).length >= 155)
    for (let day = 1; day <= 31; day++) assert.ok(unweighted.assignments.filter(a => a.date === `2025-10-${String(day).padStart(2, '0')}` && a.shiftId === 'day').length >= 5)
    record('disabling-weight-keeps-daily-minimum', { actual: unweighted.assignments.length, monthMinimum: 155, dailyMinimum: 5 })
    await importDocument(backup)
    await navigate('排班规则')
    assert.equal(await enabled.isChecked(), true)
    assert.equal(await percent.inputValue(), '40')
    await preview('2025-10-06', 14, 21, 35)
    record('json-export-and-import-restore-weekday-weights')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
    if (await page.getByRole('button', { name: '关闭提示', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭提示', exact: true }).click()
    await widthCheck('mobile-rules-page-no-overflow')
    await percent.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, '03-weight-controls-mobile.png') })
    await page.locator('.sp-settings-weight-preview article').first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, '04-weight-preview-mobile.png') })
    await saveRule([1, 6], 42)
    await persisted(s => s.rules.weekdayWeights.percent === 42)
    record('mobile-rule-save')
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
main().catch(error => { console.error(error); process.exitCode = 1 })
