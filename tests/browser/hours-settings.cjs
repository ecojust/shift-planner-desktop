const { selectGlobalMonth } = require('./helpers/month-picker.cjs')
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
  async function month(value) { await selectGlobalMonth(page, value); await persisted(s => s.month === value) }
  const employee = name => page.locator('.sp-settings-employee-card').filter({ has: page.getByRole('button', { name: `编辑${name}`, exact: true }) })
  const minWeek = name => page.getByLabel(`${name}每周最低工时`, { exact: true })
  const maxWeek = name => page.getByLabel(`${name}每周最高工时`, { exact: true })
  const finishHoursInput = async name => {
    // Automatic saving must work without a per-card Save button.
    await minWeek(name).blur(); await maxWeek(name).blur()
    assert.equal(await page.getByRole('button', { name: `保存${name}设置`, exact: true }).count(), 0)
  }
  async function widthCheck(name) {
    const size = await page.evaluate(() => ({ viewport: window.innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
    assert.ok(size.html <= size.viewport && size.body <= size.viewport, `${name}: ${JSON.stringify(size)}`)
    record(name, size)
  }
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    await navigate('成员管理')
    await month('2025-10')
    const legacy = await state()
    legacy.teamName = '每周工时兼容验收'
    legacy.monthlyReferenceHours = { '2025-10': 744, '2025-11': 0 }
    legacy.employees[0].minHoursPerMonth = 744
    legacy.employees[0].minHoursPerWeek = 0
    legacy.employees[0].maxHoursPerWeek = 48
    legacy.employees[1].minHoursPerMonth = null
    legacy.employees[1].minHoursPerWeek = 16
    legacy.employees[1].maxHoursPerWeek = 40
    await page.locator('input.sp-hidden[type=file]:not([aria-label])').setInputFiles({ name: 'legacy-monthly-hours.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) })
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    const imported = await persisted(s => s.teamName === legacy.teamName)
    assert.equal(Object.hasOwn(imported, 'monthlyReferenceHours'), false)
    assert.ok(imported.employees.every(person => !Object.hasOwn(person, 'minHoursPerMonth')))
    assert.equal(await page.getByLabel(/每月最低工时|月最低工时跟随|手动月参考工时/).count(), 0)
    assert.equal(await page.locator('.sp-settings-month-reference').count(), 0)
    assert.equal(await minWeek('陈晨').inputValue(), '0')
    assert.equal(await maxWeek('陈晨').inputValue(), '48')
    assert.equal(await minWeek('林晚晴').inputValue(), '16')
    assert.equal(await maxWeek('林晚晴').inputValue(), '40')
    record('legacy-monthly-fields-are-retired-without-deriving-or-changing-weekly-bounds')
    await widthCheck('desktop-member-page-no-overflow')
    await page.screenshot({ path: path.join(output, '01-members-desktop.png') })

    await minWeek('陈晨').fill('24')
    await finishHoursInput('陈晨')
    await persisted(s => s.employees.some(e => e.name === '陈晨' && e.minHoursPerWeek === 24 && e.maxHoursPerWeek === 48))
    record('inline-weekly-minimum-and-maximum-auto-save')
    await page.getByRole('button', { name: '添加员工' }).click()
    const personDialog = page.getByRole('dialog').filter({ has: page.getByLabel('员工姓名', { exact: true }) })
    await personDialog.getByLabel('员工姓名', { exact: true }).fill('工时测试员')
    assert.doesNotMatch(await personDialog.innerText(), /月最低|月参考/)
    await personDialog.getByRole('button', { name: '保存人员', exact: true }).click()
    await persisted(s => s.employees.some(e => e.name === '工时测试员' && e.minHoursPerWeek === 40 && e.maxHoursPerWeek === 48 && !Object.hasOwn(e, 'minHoursPerMonth')))
    await minWeek('工时测试员').fill('28')
    await maxWeek('工时测试员').fill('42')
    await finishHoursInput('工时测试员')
    await persisted(s => s.employees.some(e => e.name === '工时测试员' && e.minHoursPerWeek === 28 && e.maxHoursPerWeek === 42))
    await employee('工时测试员').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, '02-inline-hours-desktop.png') })
    record('new-employee-retains-40-48-default-and-supports-direct-weekly-range')

    const weekly = value => value.employees.map(e => [e.id, e.minHoursPerWeek, e.maxHoursPerWeek])
    const weeklyBeforeMonth = weekly(await state())
    await month('2025-11')
    assert.deepEqual(weekly(await state()), weeklyBeforeMonth)
    await month('2025-10')
    await navigate('排班日历')
    await page.getByRole('button', { name: '月视图', exact: true }).click()
    await page.getByRole('button', { name: '设置 2025-10-09 日期类型', exact: true }).click()
    await page.getByRole('button', { name: /^休息日 / }).click()
    await page.getByRole('button', { name: '确认日期类型', exact: true }).click()
    await persisted(s => s.calendar['2025-10-09'] === 'restday')
    await navigate('成员管理')
    assert.deepEqual(weekly(await state()), weeklyBeforeMonth)
    assert.equal(await page.getByLabel(/每月最低工时|月最低工时跟随|手动月参考工时/).count(), 0)
    record('month-and-calendar-changes-never-recalculate-weekly-bounds')

    const before = await state()
    await minWeek('工时测试员').fill('')
    await finishHoursInput('工时测试员')
    assert.match(await employee('工时测试员').getByRole('alert').innerText(), /每周最低工时/)
    await page.waitForTimeout(750)
    assert.deepEqual((await state()).employees, before.employees)
    for (const [minimum, maximum] of [['45', '40'], ['40', '47.99'], ['40.001', '40.009']]) {
      await maxWeek('工时测试员').fill('')
      await minWeek('工时测试员').fill(minimum)
      await maxWeek('工时测试员').fill(maximum)
      await finishHoursInput('工时测试员')
      assert.match(await employee('工时测试员').getByRole('alert').innerText(), /至少.*8|8.*小时/)
      await page.waitForTimeout(750)
      assert.deepEqual((await state()).employees, before.employees)
    }
    await maxWeek('工时测试员').fill('')
    await minWeek('工时测试员').fill('28')
    await finishHoursInput('工时测试员')
    assert.match(await employee('工时测试员').getByRole('alert').innerText(), /每周最高工时/)
    await maxWeek('工时测试员').fill('42')
    await finishHoursInput('工时测试员')
    await persisted(s => s.employees.some(e => e.name === '工时测试员' && e.minHoursPerWeek === 28 && e.maxHoursPerWeek === 42))
    record('blank-inverted-and-under-eight-hour-week-ranges-do-not-auto-save')
    await minWeek('工时测试员').fill('0')
    await finishHoursInput('工时测试员')
    await persisted(s => s.employees.some(e => e.name === '工时测试员' && e.minHoursPerWeek === 0 && e.maxHoursPerWeek === 42))
    await page.reload({ waitUntil: 'networkidle' })
    await navigate('成员管理')
    assert.equal(await minWeek('工时测试员').inputValue(), '0')
    assert.equal(await maxWeek('工时测试员').inputValue(), '42')
    assert.equal(await minWeek('陈晨').inputValue(), '24')
    record('explicit-zero-weekly-minimum-and-upper-bound-survive-refresh')

    const backupState = await state()
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /^导出完整备份/ }).click()
    const backupPath = path.join(output, 'hours-backup.json')
    await (await downloadPromise).saveAs(backupPath)
    const exported = JSON.parse(await fs.readFile(backupPath, 'utf8'))
    assert.deepEqual(exported.employees, backupState.employees)
    assert.equal(Object.hasOwn(exported, 'monthlyReferenceHours'), false)
    await minWeek('陈晨').fill('26')
    await finishHoursInput('陈晨')
    await persisted(s => s.employees.find(e => e.name === '陈晨').minHoursPerWeek === 26)
    await page.locator('input.sp-hidden[type=file]:not([aria-label])').setInputFiles(backupPath)
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await persisted(s => JSON.stringify(s.employees) === JSON.stringify(backupState.employees))
    record('backup-download-and-import-preserve-weekly-values-without-retired-fields')

    // A true weekly conflict: one eight-hour shift per day cannot reach 160h.
    await maxWeek('工时测试员').fill('168')
    await minWeek('工时测试员').fill('160')
    await finishHoursInput('工时测试员')
    await persisted(s => s.employees.find(e => e.name === '工时测试员').minHoursPerWeek === 160)
    await navigate('排班日历')
    await page.getByRole('button', { name: /^陈晨 2025-10-01 .*点击编辑$/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: /^早 早班/ }).click()
    await page.getByLabel('锁定本次安排，重新排班时保留').check()
    await page.getByRole('button', { name: '保存安排', exact: true }).click()
    const originalAssignments = (await persisted(s => s.assignments.some(a => a.employeeId === 'employee-1' && a.date === '2025-10-01' && a.shiftId === 'morning' && a.locked))).assignments
    await page.getByRole('button', { name: '自动排班', exact: true }).click()
    await page.getByRole('button', { name: '开始生成', exact: true }).click()
    await page.locator('.sp-solve-result.is-warning').waitFor({ timeout: 30000 })
    const unsuccessfulSearch = await page.locator('.sp-solve-result').innerText()
    assert.match(unsuccessfulSearch, /暂未找到符合规则的排班方案.*原排班未改变/s)
    assert.match(unsuccessfulSearch, /不代表无解/)
    assert.match(unsuccessfulSearch, /工时测试员/)
    assert.doesNotMatch(unsuccessfulSearch, /月最低|月参考|每月最低/)
    assert.deepEqual((await state()).assignments, originalAssignments)
    await page.screenshot({ path: path.join(output, '03-unmet-weekly-minimum-feedback.png') })
    record('unsatisfied-weekly-browser-search-preserves-original-roster')
    await page.getByRole('button', { name: '关闭排班结果', exact: true }).click()

    await navigate('成员管理')
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
      await employee('陈晨').scrollIntoViewIfNeeded()
      await widthCheck(`mobile-${width}-weekly-hours-no-overflow`)
      await page.screenshot({ path: path.join(output, `04-weekly-hours-${width}.png`) })
      assert.equal(await minWeek('陈晨').inputValue(), '24')
      assert.equal(await maxWeek('陈晨').inputValue(), '48')
    }
    const beforeHelp = await state()
    const weeklyHelp = page.locator('.sp-settings-weekly-help')
    await weeklyHelp.locator('summary').click()
    const boundaryNotice = weeklyHelp.getByRole('region', { name: '跨月自然周说明' })
    await boundaryNotice.waitFor({ state: 'visible' })
    assert.equal(await boundaryNotice.locator('[data-boundary-week="start"]').getAttribute('data-week-start'), '2025-09-29')
    assert.equal(await boundaryNotice.locator('[data-boundary-week="start"]').getAttribute('data-week-end'), '2025-10-05')
    assert.equal(await boundaryNotice.locator('[data-boundary-week="end"]').getAttribute('data-week-start'), '2025-10-27')
    assert.equal(await boundaryNotice.locator('[data-boundary-week="end"]').getAttribute('data-week-end'), '2025-11-02')
    assert.match(await weeklyHelp.innerText(), /只保存本月/)
    assert.match(await weeklyHelp.innerText(), /不.*把空白当休息/)
    assert.doesNotMatch(await weeklyHelp.innerText(), /月末部分周|上月未排的格子按休息/)
    assert.deepEqual(await state(), beforeHelp, 'expanding boundary guidance must not alter schedule or confirmation metadata')
    await widthCheck('mobile-320-expanded-boundary-help-no-overflow')
    await weeklyHelp.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, '05-boundary-week-help-320.png') })
    record('weekly-help-shows-both-natural-week-boundaries-without-mutating-state')
    await weeklyHelp.locator('summary').click()
    await minWeek('陈晨').fill('26')
    await finishHoursInput('陈晨')
    await persisted(s => s.employees.find(e => e.name === '陈晨')?.minHoursPerWeek === 26)
    record('mobile-inline-weekly-hours-save')
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
