/* Start Vite on 5197, then run:
 * PLAYWRIGHT_MODULE_PATH=/path/to/playwright PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium node tests/browser/member-interactions.cjs
 * Exercises auto-saving member cards, the profile modal and leave calendar,
 * including independent edits, keyboard focus and mobile interaction.
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const url = process.env.MEMBERS_TEST_URL || 'http://127.0.0.1:5197'
const output = path.resolve(process.env.MEMBERS_TEST_OUTPUT || 'test-results/member-interactions-ui')
const checks = [], errors = []
const report = { url, startedAt: new Date().toISOString(), scope: 'Real Chromium member cards and leave calendar; no native Tauri packaging', checks, errors, ok: false }
const record = (name, detail) => { checks.push({ name, ok: true, detail }); console.log(`PASS ${name}`) }

function fixture() {
  return {
    version: 1, teamName: '成员交互验证', month: '2026-10', calendar: {},
    employees: ['陈小满', '李青'].map((name, i) => ({ id: `qa-${i + 1}`, name, role: '值班员', group: '测试组', color: '#d7e8f8', minHoursPerMonth: null, minHoursPerWeek: 0, maxHoursPerWeek: 40, eligibleShiftIds: ['day', 'night'], unavailableDates: i ? ['2026-10-06'] : ['2026-09-30', '2026-10-02', '2026-11-01'] })),
    shifts: [
      { id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 0, normalAllowance: 20 },
      { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#e6dff5', required: 0, normalAllowance: 50 },
    ],
    rules: { minRestHours: 0, maxConsecutiveDays: 31 },
    assignments: [{ employeeId: 'qa-1', date: '2026-10-03', shiftId: 'day', locked: true }],
  }
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  await fs.rm(path.join(output, 'failure.png'), { force: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1') || 'null'))
  async function persisted(predicate) {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) { const value = await state(); if (value && predicate(value)) return value; await page.waitForTimeout(50) }
    assert.fail(`State did not persist: ${JSON.stringify(await state())}`)
  }
  async function navigate(label) {
    const mobile = page.getByRole('button', { name: '打开导航', exact: true })
    const compact = await mobile.isVisible()
    if (compact) await mobile.click()
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: label }).click()
    if (compact) await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
  }
  async function importDocument(document) {
    await page.locator('input[type=file]').setInputFiles({ name: 'member-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) })
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    return persisted(s => s.teamName === document.teamName && JSON.stringify(s.employees.map(e => e.unavailableDates)) === JSON.stringify(document.employees.map(e => e.unavailableDates)))
  }
  const card = name => page.locator('.sp-settings-employee-card').filter({ has: page.getByRole('heading', { name, exact: true }) })
  const follow = name => page.getByLabel(`${name}月最低工时跟随月参考值`, { exact: true })
  const monthHours = name => page.getByLabel(`${name}每月最低工时`, { exact: true })
  const minWeek = name => page.getByLabel(`${name}每周最低工时`, { exact: true })
  const maxWeek = name => page.getByLabel(`${name}每周最高工时`, { exact: true })
  const chip = (name, shift) => page.getByRole('button', { name: `${name}可上${shift}`, exact: true })
  const leaveButton = name => page.getByRole('button', { name: `设置${name}请假`, exact: true })
  const dialog = () => page.getByRole('dialog', { name: '陈小满 · 请假日历', exact: true })
  const profile = () => page.getByRole('dialog').filter({ has: page.getByLabel('岗位', { exact: true }) })
  const leaveDay = date => dialog().locator(`button[data-leave-date="${date}"]`)
  async function leaveMonth(month) { await dialog().getByLabel('请假月份', { exact: true }).fill(month); await dialog().getByLabel('请假月份', { exact: true }).dispatchEvent('change') }
  async function widthCheck(name) {
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
    assert.ok(sizes.html <= sizes.viewport && sizes.body <= sizes.viewport, JSON.stringify(sizes))
    record(name, sizes)
  }
  async function closeNotice() { const close = page.getByRole('button', { name: '关闭提示', exact: true }); if (await close.isVisible()) await close.click() }
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    const original = fixture()
    await importDocument(original)
    await navigate('成员管理')
    for (const name of ['陈小满', '李青']) {
      assert.equal(await monthHours(name).isVisible(), true)
      assert.equal(await monthHours(name).isDisabled(), true)
      assert.equal(await monthHours(name).inputValue(), '144')
      assert.equal(await minWeek(name).inputValue(), '0')
      assert.equal(await maxWeek(name).inputValue(), '40')
    }
    assert.equal(await profile().count(), 0)
    record('hours-are-visible-on-member-cards-without-opening-editor')
    await minWeek('陈小满').fill('24')
    await minWeek('李青').fill('20')
    await persisted(s => s.employees[0].minHoursPerWeek === 24 && s.employees[1].minHoursPerWeek === 20)
    assert.equal(await minWeek('陈小满').inputValue(), '24')
    assert.equal(await minWeek('李青').inputValue(), '20')
    // A bad weekly pair must not roll back another member's valid edit.
    await minWeek('陈小满').fill('40')
    await minWeek('李青').fill('22')
    await persisted(s => s.employees[0].minHoursPerWeek === 24 && s.employees[1].minHoursPerWeek === 22)
    assert.equal(await minWeek('陈小满').inputValue(), '40')
    assert.match(await card('陈小满').getByRole('alert').innerText(), /至少相差 8 小时/)
    await minWeek('陈小满').fill('24')
    await persisted(s => s.employees[0].minHoursPerWeek === 24 && s.employees[1].minHoursPerWeek === 22)
    assert.equal(await page.getByRole('button', { name: /保存.+设置|取消.+设置修改/ }).count(), 0)
    record('valid-member-edits-autosave-independently-and-invalid-weekly-pairs-do-not-write')
    await follow('陈小满').uncheck()
    await monthHours('陈小满').fill('120')
    await minWeek('陈小满').fill('24')
    await maxWeek('陈小满').fill('48')
    await persisted(s => s.employees[0].minHoursPerMonth === 120 && s.employees[0].maxHoursPerWeek === 48)
    await page.getByLabel('手动月参考工时', { exact: true }).fill('160')
    await persisted(s => s.monthlyReferenceHours?.['2026-10'] === 160)
    assert.equal(await monthHours('陈小满').inputValue(), '120')
    assert.equal(await monthHours('李青').inputValue(), '160')
    await follow('陈小满').check()
    await persisted(s => s.employees[0].minHoursPerMonth === null)
    assert.equal(await monthHours('陈小满').inputValue(), '160')
    record('inline-month-follow-and-custom-minimum-track-reference-correctly')
    await widthCheck('desktop-member-cards-no-overflow')
    await closeNotice()
    await page.screenshot({ path: path.join(output, '01-member-cards-desktop.png') })

    await chip('陈小满', '日班').click()
    assert.equal(await chip('陈小满', '日班').getAttribute('aria-pressed'), 'false')
    assert.equal(await chip('陈小满', '夜班').getAttribute('aria-pressed'), 'true')
    await persisted(s => JSON.stringify(s.employees[0].eligibleShiftIds) === JSON.stringify(['night']))
    await chip('陈小满', '夜班').click()
    await persisted(s => s.employees[0].eligibleShiftIds.length === 0)
    assert.deepEqual((await state()).assignments, original.assignments)
    await chip('陈小满', '日班').click()
    await persisted(s => JSON.stringify(s.employees[0].eligibleShiftIds) === JSON.stringify(['day']))
    record('shift-chips-autosave-multiselect-and-empty-eligibility-without-deleting-roster')

    // The leave editor owns a separate draft: changes across multiple months
    // cannot leak into storage until its Save button is used.
    const beforeLeave = await state()
    await leaveButton('陈小满').click()
    assert.equal(await leaveDay('2026-10-02').getAttribute('aria-pressed'), 'true')
    await leaveDay('2026-10-12').click()
    await leaveDay('2026-10-14').click()
    await leaveDay('2026-10-02').click()
    await page.getByRole('alertdialog', { name: '取消该日请假？', exact: true }).getByRole('button', { name: '确认取消请假', exact: true }).click()
    await dialog().getByRole('button', { name: '下个月', exact: true }).click()
    assert.equal(await dialog().getByLabel('请假月份', { exact: true }).inputValue(), '2026-11')
    assert.equal(await leaveDay('2026-11-01').getAttribute('aria-pressed'), 'true')
    await leaveDay('2026-11-07').click()
    await dialog().getByRole('button', { name: '上个月', exact: true }).click()
    assert.equal(await leaveDay('2026-10-12').getAttribute('aria-pressed'), 'true')
    assert.equal(await leaveDay('2026-10-02').getAttribute('aria-pressed'), 'false')
    assert.deepEqual((await state()).employees, beforeLeave.employees)
    await dialog().getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await dialog().count(), 0)
    assert.deepEqual((await state()).employees, beforeLeave.employees)
    record('multi-month-leave-draft-cancel-does-not-mutate-members')

    await leaveButton('陈小满').click()
    await leaveDay('2026-10-12').click()
    await dialog().getByRole('button', { name: '保存请假', exact: true }).click()
    await persisted(s => JSON.stringify(s.employees[0].unavailableDates) === JSON.stringify(['2026-09-30', '2026-10-02', '2026-10-12', '2026-11-01']))
    assert.deepEqual((await state()).employees[1].unavailableDates, ['2026-10-06'])
    assert.equal(await leaveButton('陈小满').evaluate(e => e === document.activeElement), true)
    record('leave-save-preserves-other-months-and-members-and-restores-focus')
    await leaveButton('陈小满').click()
    await dialog().getByRole('button', { name: '清空本月', exact: true }).click()
    await page.getByRole('alertdialog', { name: '清空本月请假？', exact: true }).getByRole('button', { name: '确认清空', exact: true }).click()
    assert.equal((await state()).employees[0].unavailableDates.length, 4)
    assert.equal(await leaveDay('2026-10-02').getAttribute('aria-pressed'), 'false')
    await dialog().getByRole('button', { name: '保存请假', exact: true }).click()
    await persisted(s => JSON.stringify(s.employees[0].unavailableDates) === JSON.stringify(['2026-09-30', '2026-11-01']))
    record('clear-current-month-preserves-previous-and-next-month-leave')

    await leaveButton('陈小满').focus()
    await page.keyboard.press('Enter')
    assert.equal(await dialog().evaluate(e => e.contains(document.activeElement)), true)
    for (let i = 0; i < 40; i++) { await page.keyboard.press('Tab'); assert.equal(await dialog().evaluate(e => e.contains(document.activeElement)), true) }
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Shift+Tab'); assert.equal(await dialog().evaluate(e => e.contains(document.activeElement)), true) }
    await leaveDay('2026-10-15').focus()
    await page.keyboard.press('Space')
    assert.equal(await leaveDay('2026-10-15').getAttribute('aria-pressed'), 'true')
    await page.keyboard.press('Escape')
    assert.equal(await dialog().count(), 0)
    assert.equal(await leaveButton('陈小满').evaluate(e => e === document.activeElement), true)
    assert.deepEqual((await state()).employees[0].unavailableDates, ['2026-09-30', '2026-11-01'])
    record('keyboard-dialog-focus-trap-space-selection-and-escape-cancel')
    await leaveButton('陈小满').click()
    await leaveDay('2026-10-31').focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await dialog().getByLabel('请假月份', { exact: true }).inputValue(), '2026-11')
    assert.equal(await leaveDay('2026-11-01').evaluate(e => e === document.activeElement), true)
    await page.keyboard.press('Escape')
    record('keyboard-day-navigation-crosses-month-boundary')

    await leaveButton('陈小满').click()
    await leaveMonth('2028-02')
    assert.equal(await dialog().locator('[data-leave-date]').count(), 29)
    await leaveDay('2028-02-29').click()
    await dialog().getByRole('button', { name: '保存请假', exact: true }).click()
    await persisted(s => s.employees[0].unavailableDates.includes('2028-02-29'))
    assert.equal((await state()).month, '2026-10', 'Browsing leave months must not change the roster month')
    await leaveButton('陈小满').click()
    await leaveMonth('2028-02')
    await page.screenshot({ path: path.join(output, '02-leave-calendar-desktop.png') })
    await dialog().getByRole('button', { name: '取消', exact: true }).click()
    record('leave-calendar-supports-leap-month-without-changing-roster-month')

    // The profile modal blocks interaction with the background. Begin a card
    // edit immediately before opening it, then let autosave finish while it is
    // open; profile changes must retain the latest hours, eligibility and leave.
    await leaveButton('陈小满').click()
    await leaveDay('2026-10-18').click()
    await dialog().getByRole('button', { name: '保存请假', exact: true }).click()
    await persisted(s => s.employees[0].unavailableDates.includes('2026-10-18'))
    await chip('陈小满', '夜班').click()
    await minWeek('陈小满').fill('30')
    await page.getByRole('button', { name: '编辑陈小满', exact: true }).click()
    await persisted(s => s.employees[0].minHoursPerWeek === 30 && s.employees[0].eligibleShiftIds.length === 2)
    assert.equal(await profile().getAttribute('aria-modal'), 'true')
    assert.equal(await profile().evaluate(e => e.contains(document.activeElement)), true)
    await profile().getByLabel('岗位', { exact: true }).fill('未保存岗位')
    for (let i = 0; i < 16; i++) { await page.keyboard.press('Tab'); assert.equal(await profile().evaluate(e => e.contains(document.activeElement)), true) }
    await page.keyboard.press('Escape')
    assert.equal(await profile().count(), 0)
    assert.equal((await state()).employees[0].role, '值班员')
    assert.equal((await state()).employees[0].minHoursPerWeek, 30)
    assert.equal(await page.getByRole('button', { name: '编辑陈小满', exact: true }).evaluate(e => e === document.activeElement), true)
    record('profile-modal-traps-focus-and-cancels-profile-only-without-rolling-back-autosave')
    await page.getByRole('button', { name: '编辑陈小满', exact: true }).click()
    await profile().getByLabel('岗位', { exact: true }).fill('资深值班员')
    await profile().getByRole('button', { name: '保存人员', exact: true }).click()
    await persisted(s => s.employees[0].role === '资深值班员')
    const merged = (await state()).employees[0]
    assert.equal(merged.minHoursPerWeek, 30)
    assert.deepEqual(merged.eligibleShiftIds, ['day', 'night'])
    assert.deepEqual(merged.unavailableDates, ['2026-09-30', '2026-10-18', '2026-11-01', '2028-02-29'])
    assert.deepEqual((await state()).assignments, original.assignments)
    record('profile-modal-save-preserves-latest-hours-shift-eligibility-and-leave')

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
      await closeNotice()
      await card('陈小满').scrollIntoViewIfNeeded()
      await widthCheck(`mobile-${width}-inline-member-card-no-overflow`)
      await page.screenshot({ path: path.join(output, `03-member-card-${width}.png`) })
      await leaveButton('陈小满').click()
      await widthCheck(`mobile-${width}-leave-dialog-no-overflow`)
      const bounds = await dialog().evaluate(e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth } })
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.width, JSON.stringify(bounds))
      await page.screenshot({ path: path.join(output, `04-leave-calendar-${width}.png`) })
      await leaveDay(width === 390 ? '2026-10-20' : '2026-10-21').click()
      await dialog().getByRole('button', { name: '保存请假', exact: true }).click()
      await persisted(s => s.employees[0].unavailableDates.includes(width === 390 ? '2026-10-20' : '2026-10-21'))
    }
    record('mobile-leave-dates-save-through-touch-sized-calendar-controls')

    // The hard limit is enforced before mutating the draft or saved member.
    const capped = fixture()
    capped.teamName = '请假上限验证'
    capped.employees[0].unavailableDates = Array.from({ length: 3660 }, (_, i) => new Date(Date.UTC(2000, 0, 1) + i * 86400000).toISOString().slice(0, 10))
    await minWeek('陈小满').fill('77')
    await importDocument(capped)
    await navigate('成员管理')
    assert.equal(await minWeek('陈小满').inputValue(), '0')
    assert.equal(await page.getByRole('button', { name: /保存陈小满设置|取消陈小满设置修改/ }).count(), 0)
    record('import-replaces-stale-card-drafts-even-for-matching-member-ids')
    await leaveButton('陈小满').click()
    await leaveDay('2026-10-12').click()
    assert.equal(await leaveDay('2026-10-12').getAttribute('aria-pressed'), 'false')
    assert.match(await dialog().getByRole('alert').innerText(), /3660/)
    assert.equal((await state()).employees[0].unavailableDates.length, 3660)
    await page.keyboard.press('Escape')
    record('leave-date-limit-rejects-a-3661st-date-without-mutation')
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
