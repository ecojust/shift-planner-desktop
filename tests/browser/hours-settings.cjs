/* Run against an existing Vite server:
 * HOURS_TEST_URL=http://127.0.0.1:5197 PLAYWRIGHT_MODULE_PATH=/path/to/playwright node tests/browser/hours-settings.cjs
 * Browser-only verification: this does not exercise the packaged Tauri solver.
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
let chromium
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')) }
catch (error) { console.error('Browser checks need Playwright. Install it separately or set PLAYWRIGHT_MODULE_PATH to its package directory.'); process.exit(2) }

const url = process.env.HOURS_TEST_URL || 'http://127.0.0.1:5197'
const output = path.resolve(process.env.HOURS_TEST_OUTPUT || 'test-results/hours-ui')
const checks = [], errors = []
const report = { url, startedAt: new Date().toISOString(), scope: 'Real Chromium web UI; not native Tauri or solver packaging', checks, errors, ok: false }
const record = (name, detail) => { checks.push({ name, ok: true, detail }); console.log(`PASS ${name}`) }

async function main() {
  await fs.mkdir(output, { recursive: true })
  await fs.rm(path.join(output, 'failure.png'), { force: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', acceptDownloads: true })
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
    const compact = await mobile.isVisible()
    if (compact) await mobile.click()
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: label }).click()
    if (compact) await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
  }
  async function month(value) { const input = page.getByRole('textbox', { name: '月参考工时的排班月份' }); await input.fill(value); await input.dispatchEvent('change'); await persisted(s => s.month === value) }
  async function reference(value) { await page.getByLabel('手动月参考工时', { exact: true }).fill(String(value)); await page.getByRole('button', { name: '保存本月', exact: true }).click(); await persisted(s => s.monthlyReferenceHours?.[s.month] === value) }
  const employee = name => page.locator('.sp-settings-employee-card').filter({ has: page.getByRole('heading', { name, exact: true }) })
  const follow = name => page.getByLabel(`${name}月最低工时跟随月参考值`, { exact: true })
  const monthHours = name => page.getByLabel(`${name}每月最低工时`, { exact: true })
  const minWeek = name => page.getByLabel(`${name}每周最低工时`, { exact: true })
  const maxWeek = name => page.getByLabel(`${name}每周最高工时`, { exact: true })
  const saveHours = name => page.getByRole('button', { name: `保存${name}设置`, exact: true }).click()
  async function widthCheck(name) {
    const size = await page.evaluate(() => ({ viewport: window.innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
    assert.ok(size.html <= size.viewport && size.body <= size.viewport, `${name}: ${JSON.stringify(size)}`)
    record(name, size)
  }
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    await navigate('成员管理')
    // Oct 2025: 18 workdays including Oct 11 make-up work, after Oct 1–8 holiday.
    await month('2025-10')
    assert.equal((await page.locator('.sp-settings-reference-summary strong').textContent()).trim(), '144')
    assert.match(await page.locator('.sp-settings-reference-summary').innerText(), /18 个工作日 × 8 小时 = 144 小时/)
    assert.equal(await monthHours('陈晨').inputValue(), '144')
    assert.equal(await monthHours('陈晨').isDisabled(), true)
    assert.equal(await follow('陈晨').isChecked(), true)
    record('automatic-month-reference', { month: '2025-10', workdays: 18, hours: 144 })
    await widthCheck('desktop-member-page-no-overflow')
    if (await page.getByRole('button', { name: '关闭提示', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭提示', exact: true }).click()
    await page.getByRole('heading', { name: '成员管理', exact: true }).click()
    await page.screenshot({ path: path.join(output, '01-members-desktop.png') })

    // Existing personal overrides are directly editable on each member card.
    assert.equal(await page.locator('.sp-settings-editor').count(), 0)
    await follow('陈晨').uncheck()
    await monthHours('陈晨').fill('120')
    await minWeek('陈晨').fill('24')
    await maxWeek('陈晨').fill('48')
    await saveHours('陈晨')
    await persisted(s => s.employees.find(e => e.name === '陈晨')?.minHoursPerMonth === 120)
    await reference(152)
    assert.equal(await monthHours('陈晨').inputValue(), '120')
    assert.equal(await minWeek('陈晨').inputValue(), '24')
    assert.equal(await maxWeek('陈晨').inputValue(), '48')
    assert.equal(await monthHours('林晚晴').inputValue(), '152')
    record('inline-personal-month-and-week-overrides-preserved')

    await page.getByRole('button', { name: '添加员工' }).click()
    await page.getByLabel('员工姓名', { exact: true }).fill('工时测试员')
    assert.equal(await page.locator('.sp-settings-editor').getByLabel('每周最低工时', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '保存人员', exact: true }).click()
    await persisted(s => s.employees.some(e => e.name === '工时测试员' && e.minHoursPerMonth === null && e.minHoursPerWeek === 0 && e.maxHoursPerWeek === 40))
    assert.equal(await follow('工时测试员').isChecked(), true)
    assert.equal(await monthHours('工时测试员').isDisabled(), true)
    assert.equal(await minWeek('工时测试员').inputValue(), '0')
    assert.equal(await maxWeek('工时测试员').inputValue(), '40')
    await minWeek('工时测试员').fill('28')
    await maxWeek('工时测试员').fill('42')
    await saveHours('工时测试员')
    await persisted(s => s.employees.some(e => e.name === '工时测试员' && e.minHoursPerMonth === null && e.minHoursPerWeek === 28 && e.maxHoursPerWeek === 42))
    if (await page.getByRole('button', { name: '关闭提示', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭提示', exact: true }).click()
    await employee('工时测试员').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, '02-inline-hours-desktop.png') })
    record('new-employee-defaults-and-direct-week-range', { monthMinimum: null, weekMinimum: 28, weekMaximum: 42 })

    await month('2025-11')
    assert.equal((await page.locator('.sp-settings-reference-summary strong').textContent()).trim(), '160')
    await reference(168)
    await month('2025-10')
    assert.equal(await page.getByLabel('手动月参考工时', { exact: true }).inputValue(), '152')
    await page.getByRole('button', { name: '恢复自动', exact: true }).click()
    await persisted(s => s.monthlyReferenceHours?.['2025-10'] === undefined && s.monthlyReferenceHours?.['2025-11'] === 168)
    assert.equal((await page.locator('.sp-settings-reference-summary strong').textContent()).trim(), '144')
    assert.equal(await monthHours('工时测试员').inputValue(), '144')
    assert.equal(await monthHours('陈晨').inputValue(), '120')
    record('per-month-reference-and-restore-auto')

    // Date overrides must feed the reference as well as the payroll calendar.
    await navigate('排班日历')
    await page.getByRole('button', { name: '月视图', exact: true }).click()
    await page.getByRole('button', { name: '设置 2025-10-09 日期类型', exact: true }).click()
    await page.getByRole('button', { name: /^休息日 / }).click()
    await page.getByRole('button', { name: '确认日期类型', exact: true }).click()
    await navigate('成员管理')
    assert.equal((await page.locator('.sp-settings-reference-summary strong').textContent()).trim(), '136')
    assert.equal(await monthHours('陈晨').inputValue(), '120')
    record('manual-calendar-override-updates-reference', { changedDate: '2025-10-09', hours: 136 })

    // Invalid native form inputs and cross-field constraints cannot mutate storage.
    const before = await persisted(s => s.calendar['2025-10-09'] === 'restday')
    await page.getByLabel('手动月参考工时', { exact: true }).fill('')
    await page.getByRole('button', { name: '保存本月', exact: true }).click()
    assert.equal(await page.getByLabel('手动月参考工时', { exact: true }).evaluate(e => e.validity.valueMissing), true)
    assert.deepEqual((await state()).monthlyReferenceHours, before.monthlyReferenceHours)
    await page.getByLabel('手动月参考工时', { exact: true }).fill('136')
    await minWeek('工时测试员').fill('')
    await saveHours('工时测试员')
    assert.match(await employee('工时测试员').getByRole('alert').innerText(), /每周最低工时/)
    for (const [minimum, maximum] of [['45', '40'], ['40.001', '40.009']]) {
      await minWeek('工时测试员').fill(minimum)
      await maxWeek('工时测试员').fill(maximum)
      await saveHours('工时测试员')
      assert.match(await employee('工时测试员').getByRole('alert').innerText(), /每周最低工时不能高于.*最高工时/)
      assert.deepEqual((await state()).employees, before.employees)
    }
    await minWeek('工时测试员').fill('28')
    await maxWeek('工时测试员').fill('')
    await saveHours('工时测试员')
    assert.match(await employee('工时测试员').getByRole('alert').innerText(), /每周最高工时/)
    await maxWeek('工时测试员').fill('42')
    await follow('工时测试员').uncheck()
    await monthHours('工时测试员').fill('')
    await saveHours('工时测试员')
    assert.match(await employee('工时测试员').getByRole('alert').innerText(), /每月最低工时|月最低工时/)
    assert.deepEqual((await state()).employees, before.employees)
    record('blank-and-inverted-minute-bounds-rejected', { minuteGap: ['40.001', '40.009'] })
    await monthHours('工时测试员').fill('0')
    await minWeek('工时测试员').fill('0')
    await saveHours('工时测试员')
    await persisted(s => s.employees.some(e => e.name === '工时测试员' && e.minHoursPerMonth === 0 && e.minHoursPerWeek === 0))
    assert.equal(await follow('工时测试员').isChecked(), false)
    assert.equal(await monthHours('工时测试员').inputValue(), '0')
    record('explicit-zero-disables-minimum')

    await page.reload({ waitUntil: 'networkidle' })
    await navigate('成员管理')
    assert.equal((await page.locator('.sp-settings-reference-summary strong').textContent()).trim(), '136')
    assert.equal(await monthHours('陈晨').inputValue(), '120')
    assert.equal(await monthHours('工时测试员').inputValue(), '0')
    record('refresh-preserves-hours-and-calendar')
    const backupState = await state()
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /^导出完整备份/ }).click()
    const download = await downloadPromise
    const backupPath = path.join(output, 'hours-backup.json')
    await download.saveAs(backupPath)
    const exported = JSON.parse(await fs.readFile(backupPath, 'utf8'))
    assert.deepEqual(exported.employees, backupState.employees)
    assert.deepEqual(exported.monthlyReferenceHours, backupState.monthlyReferenceHours)
    await reference(200)
    await page.locator('input[type=file]').setInputFiles(backupPath)
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await persisted(s => JSON.stringify(s.employees) === JSON.stringify(backupState.employees) && JSON.stringify(s.monthlyReferenceHours) === JSON.stringify(backupState.monthlyReferenceHours))
    record('json-download-and-confirmed-import-preserve-new-fields')

    // Old sample has more employee minimum hours than supplied shift hours.
    // Browser heuristic must reject safely, without claiming a proof of infeasibility.
    await navigate('排班日历')
    await page.getByRole('button', { name: '陈晨 2025-10-01 休息，点击编辑', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: /^早 早班/ }).click()
    await page.getByLabel('锁定本次安排，重新排班时保留').check()
    await page.getByRole('button', { name: '保存安排', exact: true }).click()
    const originalAssignments = (await persisted(s => s.assignments.some(a => a.employeeId === 'employee-1' && a.date === '2025-10-01' && a.shiftId === 'morning' && a.locked))).assignments
    await page.getByRole('button', { name: '自动排班', exact: true }).click()
    await page.getByRole('button', { name: '开始生成', exact: true }).click()
    await page.getByText('浏览器搜索未找到满足全部硬性规则的方案，原排班未改变。可调整工时或使用桌面约束求解器重试。', { exact: true }).waitFor({ timeout: 30000 })
    assert.deepEqual((await state()).assignments, originalAssignments)
    await page.screenshot({ path: path.join(output, '03-unmet-minimum-feedback.png') })
    record('unsatisfied-browser-search-preserves-original-roster')
    await page.getByRole('button', { name: '关闭求解结果', exact: true }).click()

    await navigate('成员管理')
    await page.setViewportSize({ width: 390, height: 844 })
    // Wait for the responsive off-canvas sidebar transition to finish before
    // measuring/capturing the stable mobile view.
    await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
    await page.evaluate(() => window.scrollTo(0, 0))
    await widthCheck('mobile-member-page-no-overflow')
    await page.screenshot({ path: path.join(output, '04-members-mobile.png') })
    await employee('陈晨').scrollIntoViewIfNeeded()
    await widthCheck('mobile-inline-hours-no-overflow')
    await page.screenshot({ path: path.join(output, '05-inline-hours-mobile.png') })
    assert.equal(await monthHours('陈晨').inputValue(), '120')
    assert.equal(await minWeek('陈晨').inputValue(), '24')
    assert.equal(await maxWeek('陈晨').inputValue(), '48')
    await minWeek('陈晨').fill('26')
    await saveHours('陈晨')
    await persisted(s => s.employees.find(e => e.name === '陈晨')?.minHoursPerWeek === 26)
    record('mobile-inline-hours-save')
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
