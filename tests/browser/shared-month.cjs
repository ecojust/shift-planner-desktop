/* Browser checks for one shared month selector across all application pages.
 * Start Vite on 5197 and set PLAYWRIGHT_MODULE_PATH (plus optional executable). */
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const url = process.env.STAFFING_TEST_URL || 'http://127.0.0.1:5197'
const output = path.resolve(process.env.SHARED_MONTH_TEST_OUTPUT || 'test-results/shared-month-ui')
const checks = [], errors = []
const report = { url, startedAt: new Date().toISOString(), scope: 'Real Chromium shared-month controls, draft isolation, calendar allowance totals, rules and independent leave calendar', checks, errors, ok: false }
const record = (name, detail) => { checks.push({ name, ok: true, detail }); console.log(`PASS ${name}`) }

function fixture() {
  return {
    version: 1, teamName: '共享月份验证', month: '2026-10', calendar: {}, monthlyReferenceHours: { '2026-11': 160, '2026-12': 168 },
    employees: ['月份测试甲', '月份测试乙'].map((name, index) => ({ id: `month-${index + 1}`, name, role: '值班员', group: '测试组', color: '#d7e8f8', minHoursPerMonth: null, minHoursPerWeek: 0, maxHoursPerWeek: 40, eligibleShiftIds: ['day', 'night'], unavailableDates: [] })),
    shifts: [
      { id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 1, staffingMode: 'minimum', normalAllowance: 20 },
      { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#e6dff5', required: 0, staffingMode: 'minimum', normalAllowance: 50 },
    ],
    rules: { minRestHours: 0, maxConsecutiveDays: 31, weekdayWeights: { days: [1, 6], percent: 40 } },
    assignments: [
      { employeeId: 'month-1', date: '2026-10-01', shiftId: 'day', locked: true },
      { employeeId: 'month-2', date: '2026-11-01', shiftId: 'night', locked: true },
      { employeeId: 'month-1', date: '2026-12-01', shiftId: 'day', locked: true },
    ],
  }
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  await fs.rm(path.join(output, 'failure.png'), { force: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1') || 'null'))
  async function persisted(predicate) {
    for (let attempts = 0; attempts < 160; attempts++) { const value = await state(); if (value && predicate(value)) return value; await page.waitForTimeout(50) }
    assert.fail('Expected shared month or settings did not persist')
  }
  const month = () => page.getByLabel('全局排班月份', { exact: true })
  async function setMonth(value) { await month().fill(value); await month().dispatchEvent('change'); await persisted(document => document.month === value) }
  async function navigate(label) {
    const toggle = page.getByRole('button', { name: '打开导航', exact: true }), mobile = await toggle.isVisible()
    if (mobile) await toggle.click()
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: label }).click()
    if (mobile) await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
  }
  async function uniqueMonth(value) {
    assert.equal(await page.locator('input[type=month]').count(), 1, 'Only the header can set the roster month')
    assert.equal(await month().inputValue(), value)
    assert.equal(await month().isVisible(), true)
  }
  const reference = () => page.getByLabel('手动月参考工时', { exact: true })
  const personalMonth = () => page.getByLabel('月份测试甲每月最低工时', { exact: true })
  async function saveReference(value) { await reference().fill(String(value)); await reference().blur(); await persisted(document => document.monthlyReferenceHours[document.month] === value) }
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    const original = fixture()
    await page.locator('input[type=file]').setInputFiles({ name: 'shared-month.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(original)) })
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await persisted(document => document.teamName === original.teamName)
    for (const section of ['排班日历', '成员管理', '班次设置', '排班规则']) {
      await navigate(section)
      await uniqueMonth('2026-10')
    }
    record('all-four-pages-share-one-visible-month-control')

    await navigate('排班日历')
    await setMonth('2026-11')
    assert.match(await page.locator('.sp-month-label').innerText(), /2026\s*年\s*11\s*月/)
    await navigate('成员管理')
    await uniqueMonth('2026-11')
    assert.equal(await reference().inputValue(), '160')
    assert.equal(await personalMonth().inputValue(), '160')
    await setMonth('2026-10')
    assert.equal(await reference().inputValue(), '144')
    await saveReference(168)
    assert.equal(await personalMonth().inputValue(), '168')
    record('calendar-month-updates-member-reference-and-following-month-hours')

    await page.getByLabel('月份测试甲每周最低工时', { exact: true }).fill('12')
    await page.getByLabel('月份测试甲每周最低工时', { exact: true }).blur()
    await persisted(document => document.employees[0].minHoursPerWeek === 12)
    assert.equal(await page.getByRole('button', { name: '保存月份测试甲设置', exact: true }).count(), 0)
    // Immediately move months while a valid reference edit is being saved.
    // It belongs to the month in which it was entered, never the next month.
    await reference().fill('123')
    await setMonth('2026-12')
    await persisted(document => document.monthlyReferenceHours['2026-10'] === 123)
    assert.equal(await reference().inputValue(), '168')
    assert.equal(await personalMonth().inputValue(), '168')
    assert.equal((await state()).monthlyReferenceHours['2026-10'], 123)
    assert.equal((await state()).monthlyReferenceHours['2026-12'], 168)
    assert.equal(await page.getByLabel('月份测试甲每周最低工时', { exact: true }).inputValue(), '12')
    await navigate('排班规则')
    await navigate('成员管理')
    assert.equal(await page.getByLabel('月份测试甲每周最低工时', { exact: true }).inputValue(), '12')
    assert.equal((await state()).employees[0].minHoursPerWeek, 12, 'Valid member hours automatically persist before navigation')
    record('member-hours-auto-save-and-reference-edit-remains-in-its-original-month')

    // A one-hour weekly range and blank reference are invalid drafts. Neither
    // may replace the last valid settings, including when changing months.
    await page.getByLabel('月份测试甲每周最低工时', { exact: true }).fill('39')
    await page.getByLabel('月份测试甲每周最低工时', { exact: true }).blur()
    await reference().fill('')
    await reference().blur()
    await page.waitForTimeout(750)
    assert.equal((await state()).employees[0].minHoursPerWeek, 12)
    assert.equal((await state()).monthlyReferenceHours['2026-12'], 168)
    await setMonth('2026-10')
    assert.equal(await reference().inputValue(), '123')
    assert.equal(await personalMonth().inputValue(), '123')
    assert.equal((await state()).employees[0].minHoursPerWeek, 12)
    assert.equal((await state()).monthlyReferenceHours['2026-12'], 168)
    await saveReference(168)
    await page.getByLabel('月份测试甲每周最低工时', { exact: true }).fill('12')
    await page.getByLabel('月份测试甲每周最低工时', { exact: true }).blur()
    await setMonth('2026-12')
    await saveReference(160)
    await setMonth('2026-10')
    assert.equal(await reference().inputValue(), '168')
    assert.equal((await state()).monthlyReferenceHours['2026-12'], 160)
    record('invalid-auto-save-drafts-do-not-overwrite-member-hours-or-other-month-references')

    await navigate('排班规则')
    await page.getByRole('tab', { name: '团队规则', exact: true }).click()
    await page.locator('.sp-settings-calculation-details > summary').click()
    await setMonth('2026-09')
    assert.equal(await page.getByRole('tab', { name: '团队规则', exact: true }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('.sp-settings-weight-preview article').first().getAttribute('data-week'), '2026-08-31')
    await setMonth('2026-10')
    assert.equal(await page.getByRole('tab', { name: '团队规则', exact: true }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('.sp-settings-weight-preview article').first().getAttribute('data-week'), '2026-09-28')
    record('weekday-example-regroups-weeks-from-shared-month')

    await navigate('排班日历')
    const allowanceTotal = () => page.locator('[data-allowance-total] strong')
    assert.equal(Number((await allowanceTotal().innerText()).replace(/[¥￥,\s]/g, '')), 20)
    await setMonth('2026-11')
    assert.equal(Number((await allowanceTotal().innerText()).replace(/[¥￥,\s]/g, '')), 50)
    await uniqueMonth('2026-11')
    record('calendar-allowance-total-follows-shared-month-assignments', { october: 20, november: 50 })

    await navigate('成员管理')
    await page.getByRole('button', { name: '设置月份测试甲请假', exact: true }).click()
    const leave = page.getByRole('dialog', { name: '月份测试甲 · 请假日历', exact: true })
    assert.equal(await leave.getByLabel('请假月份', { exact: true }).inputValue(), '2026-11')
    await leave.getByLabel('请假月份', { exact: true }).fill('2027-01')
    await leave.getByLabel('请假月份', { exact: true }).dispatchEvent('change')
    await leave.locator('[data-leave-date="2027-01-02"]').click()
    assert.equal((await state()).month, '2026-11')
    assert.equal(await month().inputValue(), '2026-11')
    await leave.getByRole('button', { name: '保存请假', exact: true }).click()
    await persisted(document => document.employees[0].unavailableDates.includes('2027-01-02'))
    await uniqueMonth('2026-11')
    record('leave-calendar-browses-other-months-without-changing-global-roster-month')

    await page.reload({ waitUntil: 'networkidle' })
    await uniqueMonth('2026-11')
    await navigate('成员管理')
    assert.equal(await reference().inputValue(), '160')
    assert.deepEqual((await state()).monthlyReferenceHours, { '2026-10': 168, '2026-11': 160, '2026-12': 160 })
    assert.deepEqual((await state()).assignments, original.assignments)
    record('reload-retains-shared-month-overrides-and-cross-month-assignments')
    await page.screenshot({ path: path.join(output, '01-shared-month-desktop.png') })

    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width > 390 ? 650 : 844 })
      if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible()) await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
      await month().scrollIntoViewIfNeeded()
      const size = await page.evaluate(() => ({ viewport: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
      assert.ok(size.html <= width && size.body <= width, JSON.stringify(size))
      const box = await month().boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0, JSON.stringify(box))
      const geometry = await page.locator('.sp-topbar').evaluate(header => {
        const bounds = header.getBoundingClientRect()
        const selectors = ['.sp-breadcrumb > button', '.sp-breadcrumb > strong', '.sp-global-month > button', '.sp-global-month label > span', '.sp-global-month input', '.sp-save-indicator', '.sp-build-version']
        const items = selectors.flatMap(selector => [...header.querySelectorAll(selector)]).map(element => {
          const rect = element.getBoundingClientRect()
          return { label: element.getAttribute('aria-label') || element.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
        }).filter(rect => rect.width > 0 && rect.height > 0)
        return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, items }
      })
      for (let index = 0; index < geometry.items.length; index++) {
        const current = geometry.items[index]
        assert.ok(current.left >= geometry.left - .5 && current.right <= geometry.right + .5 && current.top >= geometry.top - .5 && current.bottom <= geometry.bottom + .5, `${width}: ${current.label} exceeds header bounds`)
        for (const other of geometry.items.slice(index + 1)) {
          const intersectionWidth = Math.min(current.right, other.right) - Math.max(current.left, other.left)
          const intersectionHeight = Math.min(current.bottom, other.bottom) - Math.max(current.top, other.top)
          assert.ok(intersectionWidth <= 1 || intersectionHeight <= 1, `${width}: ${current.label} overlaps ${other.label}`)
        }
      }
      await page.evaluate(() => window.scrollTo({ top: 400, behavior: 'instant' }))
      await page.waitForFunction(() => scrollY > 0)
      const sticky = await page.locator('.sp-topbar').boundingBox()
      assert.ok(sticky && Math.abs(sticky.y) <= .5, `${width}: header must remain pinned after real scroll`)
      assert.equal(await month().isVisible(), true)
      await uniqueMonth('2026-11')
      await page.screenshot({ path: path.join(output, `02-shared-month-${width}.png`) })
      record(`width-${width}-header-controls-do-not-overlap-and-stay-pinned-after-scroll`, { ...size, geometry, sticky })
    }
    await setMonth('2026-10')
    assert.equal(await personalMonth().inputValue(), '168')
    await navigate('排班日历')
    await uniqueMonth('2026-10')
    assert.equal(Number((await allowanceTotal().innerText()).replace(/[¥￥,\s]/g, '')), 20)
    record('mobile-shared-month-change-updates-members-and-allowances')
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
