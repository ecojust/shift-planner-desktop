/* Real browser integration for fixed headcounts versus staffing minimums.
 * Start Vite on 5197; set PLAYWRIGHT_MODULE_PATH and optionally
 * PLAYWRIGHT_EXECUTABLE_PATH. Native solver packaging is tested separately. */
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { unzipSync, strFromU8 } = require('fflate')
const { fixture, audit } = require('./minimum-staffing.cjs')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const url = process.env.STAFFING_TEST_URL || 'http://127.0.0.1:5197'
const output = path.resolve(process.env.STAFFING_MODES_TEST_OUTPUT || 'test-results/staffing-modes-ui')
const checks = [], errors = []
const report = { url, seed: 1010, startedAt: new Date().toISOString(), scope: 'Real Chromium, browser worker, downloaded JSON/XLSX, independent staffing/hour audit; no native packaging', checks, errors, ok: false }
const record = (name, detail) => { checks.push({ name, ok: true, detail }); console.log(`PASS ${name}`) }
const modes = state => state.shifts.map(shift => ({ id: shift.id, required: shift.required, mode: shift.staffingMode ?? 'minimum' }))

function auditModes(state) {
  const monthEnd = new Date(`${state.month}-01T00:00:00Z`); monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1); monthEnd.setUTCDate(0)
  const fixedCounts = {}
  for (const shift of state.shifts) {
    const counts = Array.from({ length: monthEnd.getUTCDate() }, (_, index) => state.assignments.filter(item => item.date === `${state.month}-${String(index + 1).padStart(2, '0')}` && item.shiftId === shift.id).length)
    if (shift.staffingMode === 'fixed') {
      assert.ok(counts.every(count => count === shift.required), `${shift.id}: fixed means exactly ${shift.required} every day; got ${counts.join(',')}`)
      fixedCounts[shift.id] = counts
    } else assert.ok(counts.every(count => count >= shift.required), `${shift.id}: every day must cover the minimum`)
  }
  return fixedCounts
}

function xmlCells(xml) {
  const unescape = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row => [...row[1].matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)].map(cell => {
    const number = cell[1].match(/<v>([^<]*)<\/v>/)
    return number ? Number(number[1]) : unescape([...cell[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(value => value[1]).join(''))
  }))
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  await fs.rm(path.join(output, 'failure.png'), { force: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1080 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', acceptDownloads: true })
  await page.addInitScript(() => { Math.random = () => 1010.5 / 2147483647 })
  page.on('pageerror', error => errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1') || 'null'))
  async function persisted(predicate) {
    for (let attempts = 0; attempts < 160; attempts++) { const value = await state(); if (value && predicate(value)) return value; await page.waitForTimeout(50) }
    assert.fail('Expected staffing mode or roster did not persist')
  }
  async function navigate(label) {
    const toggle = page.getByRole('button', { name: '打开导航', exact: true }), mobile = await toggle.isVisible()
    if (mobile) await toggle.click()
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: label }).click()
    if (mobile) await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
  }
  async function importDocument(document) {
    await page.locator('input[type=file]').setInputFiles({ name: 'staffing-modes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) })
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    return persisted(value => value.teamName === document.teamName && JSON.stringify(modes(value)) === JSON.stringify(modes(document)) && JSON.stringify(value.assignments) === JSON.stringify(document.assignments))
  }
  const editor = () => page.locator('.sp-settings-editor')
  const radio = mode => page.getByRole('radio', { name: mode === 'fixed' ? '人数模式：每日固定人数' : '人数模式：每日最少人数', exact: true })
  const amount = mode => page.getByLabel(mode === 'fixed' ? '每日固定人数' : '每日最少人数', { exact: true })
  const card = name => page.locator('.sp-settings-shift-card').filter({ has: page.getByRole('heading', { name, exact: true }) })
  async function editShift(name, mode, value) {
    await card(name).getByRole('button', { name: `编辑${name}`, exact: true }).click()
    await radio(mode).check()
    if (value !== undefined) await amount(mode).fill(String(value))
    await editor().getByRole('button', { name: '保存班次', exact: true }).click()
    return persisted(valueState => valueState.shifts.some(shift => shift.name === name && (shift.staffingMode ?? 'minimum') === mode && (value === undefined || shift.required === value)))
  }
  async function generate(success = true) {
    const before = await state()
    await navigate('排班日历')
    await page.getByRole('button', { name: '自动排班', exact: true }).click()
    await page.getByRole('button', { name: '开始生成', exact: true }).click()
    await page.locator('.sp-solve-result').waitFor({ timeout: 45000 })
    const message = await page.locator('.sp-solve-result').innerText()
    assert.equal(await page.locator('.sp-solve-result').evaluate(element => element.classList.contains('is-warning')), !success, message)
    if (!success) {
      assert.match(message, /原排班未改变/)
      assert.deepEqual((await state()).assignments, before.assignments)
    }
    await page.getByRole('button', { name: '关闭排班结果', exact: true }).click()
    if (success) {
      assert.match(await page.locator('.sp-check-status').innerText(), /排班检查通过/)
      // The previous minimum roster may still be in debounced localStorage
      // briefly after success. Wait for the replacement to honor fixed counts.
      return persisted(value => { try { auditModes(value); return value.assignments.length > 0 } catch { return false } })
    }
    return state()
  }
  async function widthCheck(width) {
    const size = await page.evaluate(() => ({ viewport: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
    assert.ok(size.html <= width && size.body <= width, JSON.stringify(size))
    for (const mode of ['minimum', 'fixed']) {
      assert.equal(await radio(mode).isVisible(), true)
      const box = await radio(mode).boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${mode}: radio must remain in the viewport`)
    }
    return size
  }
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    const legacy = fixture()
    legacy.teamName = '旧备份兼容 · 人数模式'
    await importDocument(legacy)
    await navigate('班次设置')
    await card('早班').getByRole('button', { name: '编辑早班', exact: true }).click()
    assert.equal(await radio('minimum').isChecked(), true)
    assert.equal(await amount('minimum').inputValue(), '1')
    assert.match(await card('早班').innerText(), /每日最少\s*1\s*人/)
    record('legacy-mode-missing-opens-as-minimum-with-original-number')

    const beforeCancel = await state()
    await radio('minimum').focus()
    await radio('minimum').press('ArrowRight')
    assert.equal(await radio('fixed').isChecked(), true)
    await amount('fixed').fill('2')
    await editor().getByRole('button', { name: '取消', exact: true }).click()
    assert.deepEqual((await state()).shifts, beforeCancel.shifts)
    record('keyboard-mode-choice-and-cancel-do-not-persist-draft')

    await page.getByRole('button', { name: /新建班次/ }).click()
    assert.equal(await radio('minimum').isChecked(), true)
    await page.getByLabel('班次名称', { exact: true }).fill('支援班')
    await page.getByLabel('日历简称', { exact: true }).fill('援')
    await page.getByLabel('开始时间', { exact: true }).fill('10:00')
    await page.getByLabel('结束时间', { exact: true }).fill('18:00')
    await radio('fixed').check()
    await amount('fixed').fill('2')
    await editor().getByRole('button', { name: '保存班次', exact: true }).click()
    await persisted(value => value.shifts.some(shift => shift.name === '支援班' && shift.staffingMode === 'fixed' && shift.required === 2))
    assert.match(await card('支援班').innerText(), /每日固定\s*2\s*人/)
    record('new-shift-defaults-to-minimum-and-can-save-fixed-mode')

    await importDocument(legacy)
    const minimum = await generate()
    record('legacy-all-minimum-high-hour-roster-remains-feasible', audit(minimum))
    await navigate('班次设置')
    await editShift('早班', 'fixed', 1)
    assert.match(await card('早班').innerText(), /每日固定\s*1\s*人/)
    assert.match(await card('晚班').innerText(), /每日最少\s*1\s*人/)
    record('editing-mode-persists-and-cards-distinguish-fixed-from-minimum')
    await page.screenshot({ path: path.join(output, '01-mixed-mode-settings.png') })

    const mixed = await generate()
    const fixed = auditModes(mixed)
    record('mixed-mode-honors-fixed-one-and-extra-staff-for-personal-hours', { ...audit(mixed), fixedCounts: fixed })
    assert.match(await page.locator('.sp-check-status').innerText(), /排班检查通过/)
    await page.getByRole('button', { name: '月视图', exact: true }).click()
    await page.screenshot({ path: path.join(output, '02-mixed-mode-roster.png') })
    await fs.writeFile(path.join(output, 'mixed-roster.json'), JSON.stringify(mixed, null, 2) + '\n')

    await page.getByRole('button', { name: '备份与恢复', exact: true }).click()
    const backupPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /^导出完整备份/ }).click()
    const backupPath = path.join(output, 'staffing-modes-backup.json')
    await (await backupPromise).saveAs(backupPath)
    const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'))
    assert.deepEqual(modes(backup), modes(mixed))
    await navigate('班次设置')
    await editShift('早班', 'minimum', 1)
    await page.reload({ waitUntil: 'networkidle' })
    await navigate('班次设置')
    assert.match(await card('早班').innerText(), /每日最少\s*1\s*人/)
    await importDocument(backup)
    assert.match(await card('早班').innerText(), /每日固定\s*1\s*人/)
    record('mode-survives-refresh-and-json-backup-import')

    await navigate('排班日历')
    const excelPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出 Excel', exact: true }).click()
    const excelPath = path.join(output, 'staffing-modes.xlsx')
    await (await excelPromise).saveAs(excelPath)
    const files = unzipSync(await fs.readFile(excelPath))
    const rows = xmlCells(strFromU8(files['xl/worksheets/sheet2.xml']))
    const modeColumn = rows[0].findIndex(value => /人数模式/.test(String(value)))
    const numberColumn = rows[0].findIndex(value => /人数/.test(String(value)) && !/模式/.test(String(value)))
    assert.ok(modeColumn >= 0 && numberColumn >= 0, `Workbook must identify both mode and headcount: ${rows[0]}`)
    assert.match(String(rows.find(row => row[0] === '早班')[modeColumn]), /固定/)
    assert.match(String(rows.find(row => row[0] === '晚班')[modeColumn]), /最少|最低/)
    assert.equal(rows.find(row => row[0] === '早班')[numberColumn], 1)
    assert.equal(rows.find(row => row[0] === '晚班')[numberColumn], 1)
    assert.match(rows.flat().join(' '), /固定/)
    record('downloaded-excel-distinguishes-mode-and-configured-headcount')

    await navigate('班次设置')
    await editShift('晚班', 'fixed', 1)
    await editShift('夜班', 'fixed', 1)
    const beforeImpossible = await state()
    await generate(false)
    assert.deepEqual((await state()).assignments, beforeImpossible.assignments)
    record('all-fixed-one-conflicts-with-high-hours-and-preserves-roster')

    const exact = fixture()
    exact.teamName = '固定人数精确覆盖'
    exact.employees = exact.employees.slice(0, 6).map(employee => ({ ...employee, minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 168 }))
    exact.rules = { minRestHours: 0, maxConsecutiveDays: 31 }
    exact.shifts = exact.shifts.map((shift, index) => ({ ...shift, staffingMode: 'fixed', required: [1, 2, 0][index] }))
    await importDocument(exact)
    const exactResult = await generate()
    auditModes(exactResult)
    assert.equal(exactResult.assignments.length, 93)
    assert.equal(exactResult.assignments.some(item => item.shiftId === 'night'), false)
    record('all-fixed-shifts-cover-exactly-required-and-fixed-zero-is-unused', { assignments: exactResult.assignments.length })

    const zero = fixture()
    zero.teamName = '固定零与最少零的差异'
    zero.employees = zero.employees.slice(0, 2).map(employee => ({ ...employee, minHoursPerMonth: 144, minHoursPerWeek: 0, maxHoursPerWeek: 168 }))
    zero.rules = { minRestHours: 0, maxConsecutiveDays: 31 }
    zero.shifts = zero.shifts.map((shift, index) => ({ ...shift, staffingMode: index === 2 ? 'minimum' : 'fixed', required: index === 0 ? 1 : 0 }))
    await importDocument(zero)
    const zeroResult = await generate()
    auditModes(zeroResult)
    assert.equal(zeroResult.assignments.some(item => item.shiftId === 'late'), false)
    assert.equal(zeroResult.assignments.some(item => item.shiftId === 'night'), true)
    record('fixed-zero-forbids-work-but-minimum-zero-can-meet-personal-hours', audit(zeroResult))

    await navigate('班次设置')
    await card('晚班').getByRole('button', { name: '编辑晚班', exact: true }).click()
    assert.equal(await radio('fixed').isChecked(), true)
    assert.equal(await amount('fixed').inputValue(), '0')
    assert.match(await editor().innerText(), /不安排|禁止|不再安排/)
    const unchanged = await state()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await radio('fixed').scrollIntoViewIfNeeded()
      record(`mobile-${width}-mode-controls-fit-and-have-labels`, await widthCheck(width))
      await page.screenshot({ path: path.join(output, `03-mode-editor-${width}.png`) })
    }
    await radio('minimum').check()
    assert.equal(await amount('minimum').inputValue(), '0')
    assert.match(await editor().innerText(), /仍可.*增派/)
    await editor().getByRole('button', { name: '取消', exact: true }).click()
    assert.deepEqual((await state()).shifts, unchanged.shifts)
    record('mobile-mode-switch-explains-zero-and-cancel-keeps-saved-fixed-mode')
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
