/* Real browser integration checks. Start Vite first, then run:
 * ALLOWANCES_TEST_URL=http://127.0.0.1:5197 PLAYWRIGHT_MODULE_PATH=/path/to/playwright node tests/browser/allowances.cjs
 * Optional: PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium
 * Uses independently specified monetary expectations; no production calculator is imported.
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { unzipSync, strFromU8 } = require('fflate')
let chromium
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')) }
catch { console.error('Browser checks need Playwright. Install it separately or set PLAYWRIGHT_MODULE_PATH to its package directory.'); process.exit(2) }
const url = process.env.ALLOWANCES_TEST_URL || 'http://127.0.0.1:5197'
const output = path.resolve(process.env.ALLOWANCES_TEST_OUTPUT || 'test-results/fixed-allowances-ui')
const checks = [], errors = []
const report = { url, startedAt: new Date().toISOString(), scope: 'Fixed per-shift allowance only; real Chromium web UI, downloaded JSON and XLSX; not native Tauri packaging', checks, errors, ok: false }
const record = (name, detail) => { checks.push({ name, ok: true, detail }); console.log(`PASS ${name}`) }

function fixture() {
  return {
    version: 1, teamName: '津贴验算团队', month: '2026-10',
    employees: ['日班员', '夜班员'].map((name, i) => ({ id: `qa-${i + 1}`, name, role: '值班员', group: '测试组', color: '#d7e8f8', minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 168, eligibleShiftIds: ['day', 'night'], unavailableDates: [] })),
    shifts: [
      { id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 0 },
      { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#e6dff5', required: 0 },
    ],
    rules: { minRestHours: 0, maxConsecutiveDays: 31 },
    assignments: [
      ['qa-1', '2026-10-01', 'day'], ['qa-1', '2026-10-10', 'day'],
      ['qa-2', '2026-09-30', 'night'], ['qa-2', '2026-10-03', 'night'],
      ['qa-2', '2026-10-08', 'night'], ['qa-2', '2026-10-31', 'night'],
    ].map(([employeeId, date, shiftId]) => ({ employeeId, date, shiftId, locked: true })),
    calendar: {},
    payroll: { monthlySalary: 17400, monthlyWorkdays: 21.75, hoursPerDay: 8, statutoryMultiplier: 3, restdayMultiplier: 2, ordinaryMultiplier: 1.5, restdayCompensated: false, employeeSalaries: {} },
  }
}

function numericMoney(text) { return Number(text.replace(/[¥￥,\s]/g, '').replace(/^[+＋]/, '')) }
function xmlCells(xml) {
  const unescape = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row => [...row[1].matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)].map(cell => {
    const numeric = cell[1].match(/<v>([^<]*)<\/v>/)
    return numeric ? Number(numeric[1]) : unescape([...cell[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(value => value[1]).join(''))
  }))
}

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
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: label, exact: true }).click()
    if (compact) await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
  }
  async function importDocument(document) {
    await page.locator('input[type=file]').setInputFiles({ name: 'allowances-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) })
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    return persisted(s => s.teamName === document.teamName && s.month === document.month)
  }
  async function widthCheck(name) {
    const size = await page.evaluate(() => ({ viewport: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
    assert.ok(size.html <= size.viewport && size.body <= size.viewport, `${name}: ${JSON.stringify(size)}`)
    record(name, size)
  }
  async function closeNotice() { const close = page.getByRole('button', { name: '关闭提示', exact: true }); if (await close.isVisible()) await close.click() }
  async function month(value) {
    await page.getByLabel('全局排班月份', { exact: true }).fill(value)
    await page.getByLabel('全局排班月份', { exact: true }).dispatchEvent('change')
    await persisted(s => s.month === value)
  }
  async function amount(employeeId, expected) {
    const cell = page.locator(`[data-employee-allowance="${employeeId}"]`)
    assert.equal(numericMoney(await cell.locator('strong').innerText()), expected)
  }
  async function daily(employeeId, date, expected) {
    const badge = page.locator(`.sp-allowance-badge[data-allowance-employee="${employeeId}"][data-allowance-date="${date}"]`)
    if (!expected) assert.equal(await badge.count(), 0)
    else assert.equal(numericMoney(await badge.innerText()), expected)
  }
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    await importDocument(fixture())
    await page.getByRole('button', { name: '月视图', exact: true }).click()
    await amount('qa-1', 0)
    await amount('qa-2', 0)
    record('old-backup-without-fixed-allowances-does-not-apply-salary-or-holiday-multipliers')

    await navigate('班次设置')
    await page.getByRole('button', { name: '编辑夜班', exact: true }).click()
    const normal = page.getByLabel('班次津贴', { exact: true })
    assert.equal(await normal.inputValue(), '0')
    for (const invalid of ['', '-1', '0.001']) {
      await normal.fill(invalid)
      await page.getByRole('button', { name: '保存班次', exact: true }).click()
      assert.equal(await normal.evaluate(e => e.validity.valid), false)
      assert.equal((await state()).shifts.find(s => s.id === 'night').normalAllowance || 0, 0)
    }
    await normal.fill('50')
    await page.getByRole('button', { name: '保存班次', exact: true }).click()
    await persisted(s => s.shifts.find(shift => shift.id === 'night').normalAllowance === 50)
    record('shift-fixed-allowance-required-range-and-cent-validation')
    await navigate('排班日历')
    await amount('qa-1', 0)
    await amount('qa-2', 150)
    await daily('qa-2', '2026-10-01', 0)
    await daily('qa-2', '2026-10-03', 50)
    await daily('qa-2', '2026-10-04', 0)
    await daily('qa-2', '2026-10-08', 50)
    await daily('qa-2', '2026-10-09', 0)
    await daily('qa-2', '2026-10-31', 50)
    const glow = await page.locator('.sp-allowance-badge').first().evaluate(e => { const css = getComputedStyle(e); return { color: css.color, textShadow: css.textShadow, boxShadow: css.boxShadow, animation: css.animationName } })
    assert.ok(glow.textShadow !== 'none' || glow.boxShadow !== 'none', JSON.stringify(glow))
    assert.equal(glow.animation, 'none', 'Monetary amounts must not continually flash')
    record('fixed-per-shift-amount-is-paid-once-with-gold-badge-and-month-total', { nightEmployee: 150, gold: glow })

    // The October 31 shift contributes only two working hours to October, but
    // its full fixed 50 yuan belongs to its start date. Changing duration is free
    // of any hidden hourly multiplication.
    await navigate('班次设置')
    await page.getByRole('button', { name: '编辑夜班', exact: true }).click()
    await page.getByLabel('结束时间', { exact: true }).fill('10:00')
    await page.getByRole('button', { name: '保存班次', exact: true }).click()
    await persisted(s => s.shifts.find(shift => shift.id === 'night').end === '10:00')
    await navigate('排班日历')
    await amount('qa-2', 150)
    await daily('qa-2', '2026-10-31', 50)
    await navigate('班次设置')
    await page.getByRole('button', { name: '编辑夜班', exact: true }).click()
    await page.getByLabel('结束时间', { exact: true }).fill('06:00')
    await page.getByRole('button', { name: '保存班次', exact: true }).click()
    record('shift-duration-change-does-not-change-fixed-payment')
    await page.getByRole('button', { name: '编辑日班', exact: true }).click()
    await normal.fill('20')
    await page.getByRole('button', { name: '保存班次', exact: true }).click()
    await persisted(s => s.shifts.find(shift => shift.id === 'day').normalAllowance === 20)
    await navigate('排班日历')
    await amount('qa-1', 40)
    await daily('qa-1', '2026-10-01', 20)
    await daily('qa-1', '2026-10-10', 20)
    record('holiday-and-ordinary-day-receive-identical-fixed-allowance')

    await page.getByRole('button', { name: '夜班员 2026-10-08 夜班，点击编辑', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: /安排休息/ }).click()
    await page.getByRole('button', { name: '保存安排', exact: true }).click()
    await persisted(s => s.assignments.some(a => a.employeeId === 'qa-2' && a.date === '2026-10-08' && a.shiftId === 'off'))
    await amount('qa-2', 100)
    await daily('qa-2', '2026-10-08', 0)
    await page.getByRole('button', { name: '撤销上次调整', exact: true }).click()
    await amount('qa-2', 150)
    await daily('qa-2', '2026-10-08', 50)
    await persisted(s => s.assignments.some(a => a.employeeId === 'qa-2' && a.date === '2026-10-08' && a.shiftId === 'night'))
    record('roster-edit-and-undo-update-fixed-allowance-immediately')

    // Legacy date allowances and multipliers are deliberately not interpreted as
    // new currency. Only the saved shift amount participates in this release.
    const legacy = await state()
    legacy.teamName = '旧金额配置不影响班次固定津贴'
    Object.assign(legacy.payroll, { monthlySalary: 34800, statutoryMultiplier: 10, restdayMultiplier: 10, ordinaryMultiplier: 10, dateShiftMultipliers: { '2026-10-08': { night: 10 } }, dateShiftAllowances: { '2026-10-08': { night: 999 } } })
    await importDocument(legacy)
    await amount('qa-1', 40)
    await amount('qa-2', 150)
    record('legacy-salary-date-amounts-and-multipliers-are-ignored')

    await month('2026-11')
    await amount('qa-1', 0)
    await amount('qa-2', 0)
    await daily('qa-2', '2026-11-01', 0)
    await month('2026-09')
    await amount('qa-2', 50)
    await daily('qa-2', '2026-09-30', 50)
    await month('2026-10')
    await amount('qa-1', 40)
    await amount('qa-2', 150)
    record('night-shift-fixed-pay-belongs-only-to-start-month')
    await closeNotice()
    await page.getByRole('button', { name: '周视图', exact: true }).click()
    await page.screenshot({ path: path.join(output, '01-fixed-allowances-desktop.png') })
    await page.getByRole('button', { name: '月视图', exact: true }).click()

    await navigate('班次设置')
    await widthCheck('desktop-shift-allowance-settings-no-overflow')
    await closeNotice()
    await page.screenshot({ path: path.join(output, '02-shift-allowance-settings-desktop.png') })

    await page.getByRole('button', { name: '编辑夜班', exact: true }).click()
    await normal.fill('80')
    await page.locator('.sp-settings-editor').getByRole('button', { name: '取消', exact: true }).click()
    assert.equal((await state()).shifts.find(shift => shift.id === 'night').normalAllowance, 50)
    await page.getByRole('button', { name: '编辑夜班', exact: true }).click()
    await normal.fill('55')
    await page.getByRole('button', { name: '保存班次', exact: true }).click()
    await persisted(s => s.shifts.find(shift => shift.id === 'night').normalAllowance === 55)
    await navigate('排班日历')
    await amount('qa-2', 165)
    await navigate('班次设置')
    await page.getByRole('button', { name: '编辑夜班', exact: true }).click()
    await normal.fill('50')
    await page.getByRole('button', { name: '保存班次', exact: true }).click()
    await persisted(s => s.shifts.find(shift => shift.id === 'night').normalAllowance === 50)
    record('shift-allowance-save-and-cancel-update-calendar-totals')

    await page.getByRole('button', { name: '备份与恢复', exact: true }).click()
    const backupDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: /^导出完整备份/ }).click()
    const backup = await backupDownload
    const backupPath = path.join(output, 'fixed-allowances-backup.json')
    await backup.saveAs(backupPath)
    const document = JSON.parse(await fs.readFile(backupPath, 'utf8'))
    assert.equal(document.shifts.find(s => s.id === 'night').normalAllowance, 50)
    assert.equal(document.shifts.find(s => s.id === 'day').normalAllowance, 20)
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '月视图', exact: true }).click()
    await amount('qa-1', 40)
    await amount('qa-2', 150)
    await navigate('班次设置')
    await page.getByRole('button', { name: '编辑夜班', exact: true }).click()
    await normal.fill('0')
    await page.getByRole('button', { name: '保存班次', exact: true }).click()
    await persisted(s => s.shifts.find(shift => shift.id === 'night').normalAllowance === 0)
    await importDocument(document)
    await persisted(s => s.shifts.find(shift => shift.id === 'night').normalAllowance === 50)
    await navigate('排班日历')
    await amount('qa-2', 150)
    record('json-download-refresh-and-import-restore-fixed-shift-amounts')

    const excelDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出 Excel', exact: true }).click()
    const excel = await excelDownload
    const excelPath = path.join(output, 'fixed-allowances.xlsx')
    await excel.saveAs(excelPath)
    const files = unzipSync(await fs.readFile(excelPath))
    const roster = xmlCells(strFromU8(files['xl/worksheets/sheet1.xml']))
    assert.match(roster[0].at(-1), /额外津贴/)
    assert.equal(roster.find(row => row[0] === '日班员').at(-1), 40)
    assert.equal(roster.find(row => row[0] === '夜班员').at(-1), 150)
    const eighthColumn = roster[0].findIndex(cell => String(cell).startsWith('2026-10-08'))
    assert.equal(roster.find(row => row[0] === '夜班员')[eighthColumn], '夜班\n+¥50.00')
    const monetary = xmlCells(strFromU8(files['xl/worksheets/sheet3.xml']))
    assert.equal(monetary.find(row => row[0] === '日班员').at(-1), 40)
    assert.equal(monetary.find(row => row[0] === '夜班员').at(-1), 150)
    assert.equal(monetary.find(row => row[0] === '合计').at(-1), 190)
    const eighthDetail = monetary.find(row => row[0] === '夜班员' && row[1] === '2026-10-08')
    assert.deepEqual(eighthDetail.slice(2, 4), [2, 50])
    assert.equal(monetary.filter(row => row[0] === '夜班员' && /^2026-10-\d{2}$/.test(String(row[1]))).reduce((sum, row) => sum + row[3], 0), 150)
    record('downloaded-excel-daily-and-monthly-fixed-allowances-match-screen', { dayEmployee: 40, nightEmployee: 150, team: 190 })

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
    await closeNotice()
    await widthCheck('mobile-roster-page-no-overflow')
    await page.screenshot({ path: path.join(output, '03-fixed-roster-mobile.png') })
    await page.locator('.sp-table-scroll').first().evaluate(e => { e.scrollLeft = e.scrollWidth })
    const rightColumn = await page.locator('[data-employee-allowance="qa-2"]').evaluate(e => { const rect = e.getBoundingClientRect(); return { left: rect.left, right: rect.right, viewport: innerWidth } })
    assert.ok(rightColumn.left >= 0 && rightColumn.right <= rightColumn.viewport, JSON.stringify(rightColumn))
    await page.screenshot({ path: path.join(output, '04-fixed-roster-summary-mobile.png') })
    record('mobile-horizontal-scroll-reaches-fixed-month-total', rightColumn)
    await navigate('班次设置')
    await closeNotice()
    await page.evaluate(() => window.scrollTo(0, 0))
    await widthCheck('mobile-shift-allowance-settings-no-overflow')
    await page.screenshot({ path: path.join(output, '05-shift-allowance-settings-mobile.png') })

    await page.getByRole('button', { name: '编辑夜班', exact: true }).click()
    await normal.scrollIntoViewIfNeeded()
    await widthCheck('mobile-fixed-allowance-editor-no-overflow')
    await page.screenshot({ path: path.join(output, '06-fixed-allowance-editor-mobile.png') })
    await normal.fill('60')
    await page.getByRole('button', { name: '保存班次', exact: true }).click()
    await persisted(s => s.shifts.find(shift => shift.id === 'night').normalAllowance === 60)
    await navigate('排班日历')
    await amount('qa-1', 40)
    await amount('qa-2', 180)
    record('mobile-shift-allowance-save-updates-month-total')

    // Decimal amounts must add in cents over all paid shifts, not accumulate
    // binary rounding errors: 40.15 × 2 + 0.10 × 2 = 80.50.
    const cents = fixture()
    cents.teamName = '固定津贴小数验算'
    cents.shifts[0].normalAllowance = 0.1
    cents.shifts[1].normalAllowance = 40.15
    cents.assignments = cents.assignments.filter(a => a.date.startsWith('2026-10') && a.date !== '2026-10-31')
    await importDocument(cents)
    await navigate('排班日历')
    await amount('qa-1', 0.2)
    await amount('qa-2', 80.3)
    await daily('qa-1', '2026-10-01', 0.1)
    await daily('qa-2', '2026-10-08', 40.15)
    const centExcelPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出 Excel', exact: true }).click()
    const centExcel = await centExcelPromise
    const centExcelPath = path.join(output, 'fixed-allowances-cents.xlsx')
    await centExcel.saveAs(centExcelPath)
    const centFiles = unzipSync(await fs.readFile(centExcelPath))
    const centRows = xmlCells(strFromU8(centFiles['xl/worksheets/sheet3.xml']))
    assert.equal(centRows.find(row => row[0] === '日班员').at(-1), 0.2)
    assert.equal(centRows.find(row => row[0] === '夜班员').at(-1), 80.3)
    assert.equal(centRows.find(row => row[0] === '合计').at(-1), 80.5)
    record('fixed-currency-cents-sum-correctly-in-screen-and-excel', { day: 0.2, night: 80.3, team: 80.5 })
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
