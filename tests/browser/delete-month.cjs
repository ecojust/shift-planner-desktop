/* Destructive-action acceptance against an isolated Chromium profile.
 * DELETE_MONTH_TEST_URL=http://127.0.0.1:5194 \
 * PLAYWRIGHT_MODULE_PATH=/workspace/open-office/node_modules/playwright \
 * PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium node tests/browser/delete-month.cjs
 * Background DOM clicks deliberately exercise stale confirmation races; the
 * tests never access Vue internals or any existing user's browser storage.
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const { selectGlobalMonth, readGlobalMonth } = require('./helpers/month-picker.cjs')
const { selectOption } = require('./helpers/select-option.cjs')

const url = process.env.DELETE_MONTH_TEST_URL || 'http://127.0.0.1:5194'
const output = path.resolve(process.env.DELETE_MONTH_TEST_OUTPUT || 'test-results/delete-month')
const checks = [], errors = []
const report = { url, startedAt: new Date().toISOString(), scope: 'Isolated Chromium, imported two-member/three-month fixture; persistence, undo, stale-confirmation races and 320px touch controls', checks, errors, ok: false }
const record = (name, detail) => { checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) }); console.log(`PASS ${name}`) }

function fixture(name = '按月删除独立验证') {
  return {
    version: 1, teamName: name, month: '2026-10',
    monthlyReferenceHours: { '2026-09': 168, '2026-10': 144, '2026-11': 160 },
    calendar: { '2026-09-30': 'workday', '2026-10-05': 'statutory', '2026-10-11': 'restday', '2026-11-01': 'workday' },
    payroll: { monthlySalary: 7200, monthlyWorkdays: 21, hoursPerDay: 8, statutoryMultiplier: 3, restdayMultiplier: 2,
      ordinaryMultiplier: 1.5, restdayCompensated: true, employeeSalaries: { 'qa-a': 7800 }, dateShiftMultipliers: { '2026-10-01': { day: 2 } } },
    employees: [
      { id: 'qa-a', name: '陈小满', role: '值班员', group: '甲组', color: '#d7e8f8', minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 48, eligibleShiftIds: ['day', 'night'], unavailableDates: ['2026-09-10', '2026-10-05', '2026-11-05'] },
      { id: 'qa-b', name: '李青', role: '值班员', group: '乙组', color: '#e6dff5', minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 40, eligibleShiftIds: ['night', 'day'], unavailableDates: ['2026-10-06', '2026-11-06'] },
    ],
    shifts: [
      { id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 0, staffingMode: 'minimum', normalAllowance: 20 },
      { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#e6dff5', required: 0, staffingMode: 'minimum', normalAllowance: 50 },
    ],
    rules: { minRestHours: 11, maxConsecutiveDays: 5, weekdayWeights: { days: [1, 6], percent: 40 },
      separationGroups: [{ id: 'separate', name: '同班互斥组', employeeIds: ['qa-a', 'qa-b'], shiftIds: [] }],
      nonConsecutiveShifts: [{ id: 'night-gap', shiftId: 'night' }], weeklyShiftLimits: [{ id: 'night-limit', shiftId: 'night', maxPerWeek: 3 }] },
    assignments: [
      { employeeId: 'qa-b', date: '2026-09-15', shiftId: 'day', locked: false },
      { employeeId: 'qa-a', date: '2026-09-30', shiftId: 'night', locked: true },
      { employeeId: 'qa-a', date: '2026-10-01', shiftId: 'day', locked: false },
      { employeeId: 'qa-b', date: '2026-10-01', shiftId: 'night', locked: true },
      { employeeId: 'qa-a', date: '2026-10-03', shiftId: 'off', locked: true },
      { employeeId: 'qa-b', date: '2026-10-08', shiftId: 'off', locked: false },
      { employeeId: 'qa-b', date: '2026-10-20', shiftId: 'night', locked: false },
      { employeeId: 'qa-a', date: '2026-10-31', shiftId: 'night', locked: true },
      { employeeId: 'qa-b', date: '2026-11-01', shiftId: 'day', locked: true },
      { employeeId: 'qa-a', date: '2026-11-02', shiftId: 'off', locked: true },
      { employeeId: 'qa-b', date: '2026-11-30', shiftId: 'night', locked: false },
    ],
  }
}

const exceptAssignments = ({ assignments, ...remaining }) => remaining
const withoutMonth = (document, month) => ({ ...document, assignments: document.assignments.filter(item => !item.date.startsWith(`${month}-`)) })

async function main() {
  await fs.mkdir(output, { recursive: true })
  await fs.rm(path.join(output, 'failure.png'), { force: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', hasTouch: true })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1') || 'null'))
  const trigger = () => page.getByRole('button', { name: '删除本月排班', exact: true })
  const modal = () => page.getByRole('dialog', { name: /^删除 \d{4} 年 \d{1,2} 月排班？$/ })
  const cancel = () => modal().getByRole('button', { name: '取消', exact: true })
  const confirm = () => modal().getByRole('button', { name: '确认删除', exact: true })
  const undo = () => page.getByRole('button', { name: '撤销上次调整', exact: true })
  const source = () => page.locator('.sp-context').innerText()
  const focused = locator => locator.evaluate(element => document.activeElement === element)
  const screenshot = name => page.screenshot({ path: path.join(output, `${name}.png`) })
  async function persisted(predicate, label = 'expected state') {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) { const value = await state(); if (value && predicate(value)) return value; await page.waitForTimeout(40) }
    assert.fail(`${label} was not persisted: ${JSON.stringify(await state())}`)
  }
  async function equals(expected) {
    await persisted(value => JSON.stringify(value) === JSON.stringify(expected), 'exact expected document')
    assert.deepEqual(await state(), expected)
  }
  async function stageImport(document) {
    await page.locator('input[type=file]').setInputFiles({ name: 'delete-month-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) })
    await page.getByRole('button', { name: '确认导入', exact: true }).waitFor()
  }
  async function importDocument(document) {
    await stageImport(document)
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await persisted(value => value.teamName === document.teamName && value.month === document.month)
    assert.deepEqual((await state()).assignments, document.assignments)
    return state()
  }
  async function open() {
    await trigger().click()
    await modal().waitFor()
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '取消')
    assert.equal(await focused(cancel()), true)
  }
  async function closedWithFocus() {
    await modal().waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '删除本月排班')
  }
  async function widthCheck(locator) {
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
    assert.ok(dimensions.html <= dimensions.viewport && dimensions.body <= dimensions.viewport, JSON.stringify(dimensions))
    if (locator) {
      const box = await locator.evaluate(element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, scrollWidth: element.scrollWidth, width: element.clientWidth, viewport: innerWidth, height: innerHeight } })
      assert.ok(box.left >= -1 && box.right <= box.viewport + 1 && box.top >= -1 && box.bottom <= box.height + 1 && box.scrollWidth <= box.width + 1, JSON.stringify(box))
    }
    return dimensions
  }
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    const baseline = await importDocument(fixture())
    const originalSource = await source()
    assert.equal(await trigger().isEnabled(), true)
    assert.equal(await trigger().locator('svg').count(), 1)
    assert.equal(await trigger().evaluate(element => !!element.closest('.sp-calendar-toolbar')), true)
    record('calendar-right-trash-button-is-enabled-for-the-selected-month')

    await open()
    assert.equal(await modal().getAttribute('aria-modal'), 'true')
    assert.match(await modal().innerText(), /2026 年 10 月/)
    assert.match(await modal().innerText(), /6 条/)
    assert.match(await modal().innerText(), /锁定/)
    assert.match(await modal().innerText(), /休息/)
    await page.keyboard.press('Enter')
    await closedWithFocus()
    await equals(baseline)
    record('initial-keyboard-focus-is-cancel-and-enter-cannot-accidentally-delete')

    await open()
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key)
      assert.equal(await modal().evaluate(element => element.contains(document.activeElement)), true)
    }
    await page.keyboard.press('Escape')
    await closedWithFocus(); await equals(baseline)
    await open(); await cancel().click(); await closedWithFocus(); await equals(baseline)
    await open(); await modal().getByRole('button', { name: '关闭删除排班确认', exact: true }).click(); await closedWithFocus(); await equals(baseline)
    await open(); await page.mouse.click(5, 5); await closedWithFocus(); await equals(baseline)
    record('tab-stays-inside-confirmation-and-escape-cancel-close-backdrop-preserve-all-data')

    await page.getByLabel('搜索成员', { exact: true }).fill('陈小满')
    await selectOption(page, page.getByRole('combobox', { name: '按工作组筛选', exact: true }), '甲组')
    assert.equal(await page.locator('.sp-schedule-table tbody .sp-person').count(), 1)
    await open()
    assert.match(await modal().innerText(), /6 条/)
    await screenshot('delete-month-desktop-confirmation')
    await confirm().click()
    await modal().waitFor({ state: 'detached' })
    const deleted = withoutMonth(baseline, '2026-10')
    await equals(deleted)
    assert.deepEqual(exceptAssignments(await state()), exceptAssignments(baseline))
    assert.equal(await trigger().isDisabled(), true)
    assert.equal(await focused(page.locator('.sp-calendar-card')), true)
    assert.match(await source(), /2026 年 10 月排班已删除/)
    assert.equal(await page.locator('[data-employee-allowance="qa-a"]').getAttribute('data-allowance'), '0')
    assert.match(await page.locator('.sp-schedule-table tbody tr').filter({ hasText: '陈小满' }).locator('.sp-hours-col strong').innerText(), /^6\s*h$/)
    record('confirmation-removes-every-selected-month-start-including-hidden-members-locked-and-off-records', { deletedCount: 6, retainedCount: deleted.assignments.length })
    record('other-month-night-starts-and-all-members-leave-rules-calendar-payroll-remain-intact', { retainedCarryInHours: 6, selectedMonthAllowance: 0 })

    await undo().click(); await equals(baseline)
    assert.equal(await source(), originalSource)
    assert.equal(await trigger().isEnabled(), true)
    record('undo-restores-the-complete-roster-and-original-source-label')

    await open(); await confirm().click(); await equals(deleted)
    await page.reload({ waitUntil: 'networkidle' })
    assert.deepEqual(await state(), deleted)
    assert.equal(await trigger().isDisabled(), true)
    assert.equal(await undo().isDisabled(), true)
    record('deletion-is-automatically-persisted-and-survives-a-fresh-page-load')

    const race = await importDocument(fixture('切月竞态验证'))
    await open()
    const oldMonthConfirmation = await confirm().elementHandle()
    // Both clicks occur in the same task, before Vue can remove the old modal.
    await page.evaluate(oldButton => { document.querySelector('button[aria-label="下个月"]').click(); oldButton.click() }, oldMonthConfirmation)
    await modal().waitFor({ state: 'detached' })
    await equals({ ...race, month: '2026-11' })
    assert.equal(await readGlobalMonth(page), '2026-11')
    record('same-task-month-switch-and-stale-confirmation-cannot-delete-either-month')

    await selectGlobalMonth(page, '2026-10')
    await open()
    const staleImportConfirmation = await confirm().elementHandle()
    const replacement = fixture('同月导入竞态验证')
    replacement.assignments = replacement.assignments.map(item => ({ ...item, locked: !item.locked }))
    replacement.employees[0].unavailableDates.push('2026-10-12')
    await stageImport(replacement)
    await modal().waitFor({ state: 'detached' })
    await page.evaluate(oldButton => {
      const importing = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '确认导入')
      importing.click(); oldButton.click()
    }, staleImportConfirmation)
    await persisted(value => value.teamName === replacement.teamName)
    assert.deepEqual((await state()).assignments, replacement.assignments)
    assert.deepEqual((await state()).employees[0].unavailableDates, replacement.employees[0].unavailableDates)
    record('same-month-import-invalidates-the-old-confirmation-without-deleting-imported-data')

    await selectGlobalMonth(page, '2026-12')
    assert.equal(await trigger().isDisabled(), true)
    assert.match(await page.locator('.sp-schedule-table tbody tr').filter({ hasText: '李青' }).locator('.sp-hours-col strong').innerText(), /^6\s*h$/)
    assert.equal(await modal().count(), 0)
    record('month-with-no-start-records-is-disabled-even-when-previous-month-night-hours-carry-in')

    const offFixture = fixture('仅休息记录验证')
    offFixture.assignments = offFixture.assignments.filter(item => !item.date.startsWith('2026-10-') || item.shiftId === 'off')
    const offBaseline = await importDocument(offFixture)
    assert.equal(await trigger().isEnabled(), true)
    await open(); assert.match(await modal().innerText(), /2 条/)
    await confirm().click(); await equals(withoutMonth(offBaseline, '2026-10'))
    await undo().click(); await equals(offBaseline)
    record('month-containing-only-locked-and-unlocked-rest-records-can-be-deleted-and-undone')

    const mobileBaseline = await importDocument(fixture('窄屏删除验证'))
    await page.getByLabel('搜索成员', { exact: true }).fill('')
    await selectOption(page, page.getByRole('combobox', { name: '按工作组筛选', exact: true }), '')
    await page.setViewportSize({ width: 320, height: 740 })
    await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
    await trigger().scrollIntoViewIfNeeded()
    const touch = await trigger().boundingBox()
    assert.ok(touch && touch.width >= 44 && touch.height >= 44 && touch.x >= 0 && touch.x + touch.width <= 320)
    await trigger().tap(); await modal().waitFor(); await widthCheck(modal())
    for (const button of [cancel(), confirm()]) {
      const box = await button.boundingBox()
      assert.ok(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= 320 && box.y + box.height <= 740, `Touch control ${await button.innerText()}: ${JSON.stringify(box)}`)
    }
    await screenshot('delete-month-320-confirmation')
    await cancel().tap(); await closedWithFocus(); await equals(mobileBaseline)
    await trigger().tap(); await modal().waitFor(); await confirm().tap(); await equals(withoutMonth(mobileBaseline, '2026-10'))
    await undo().tap(); await equals(mobileBaseline); await widthCheck()
    record('320px-touch-controls-and-confirmation-fit-the-screen-and-support-cancel-delete-and-undo')
    assert.deepEqual(errors, [])
    record('no-browser-errors-during-import-deletion-races-refresh-and-touch-interactions')
    report.ok = true
  } catch (error) {
    report.failure = error.stack || String(error)
    await screenshot('failure').catch(() => {})
    report.failureText = await page.locator('body').innerText().catch(() => '')
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
