/* Destructive-action confirmation checks in an isolated browser context.
 * DELETE_CONFIRMATIONS_TEST_URL=http://127.0.0.1:5194 \
 * PLAYWRIGHT_MODULE_PATH=/workspace/open-office/node_modules/playwright \
 * PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium node tests/browser/delete-confirmations.cjs
 * Uses actual Vue controls and persistence; no real user's storage is accessed.
 * Month-wide roster deletion is covered separately by delete-month.cjs.
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')

const url = process.env.DELETE_CONFIRMATIONS_TEST_URL || 'http://127.0.0.1:5194'
const output = path.resolve(process.env.DELETE_CONFIRMATIONS_TEST_OUTPUT || 'test-results/delete-confirmations')
const report = { url, startedAt: new Date().toISOString(), scope: 'Real Chromium confirmation UI and local persistence, isolated three-member fixture; native packaging is not exercised', checks: [], errors: [], screenshots: [], ok: false }
const record = (name, detail) => { report.checks.push({ name, ...(detail ? { detail } : {}) }); console.log('PASS', name) }
const clone = value => JSON.parse(JSON.stringify(value))

function fixture(avatar) {
  return {
    version: 1, teamName: '删除确认验收', month: '2026-10',
    monthlyReferenceHours: { '2026-10': 144, '2026-11': 160 },
    calendar: { '2026-10-05': 'workday', '2026-10-11': 'restday', '2026-11-01': 'workday' },
    payroll: { monthlySalary: 7200, monthlyWorkdays: 21.75, hoursPerDay: 8, statutoryMultiplier: 3, restdayMultiplier: 2, ordinaryMultiplier: 1.5, restdayCompensated: false, employeeSalaries: { 'qa-a': 7800, 'qa-b': 6000 }, dateShiftMultipliers: { '2026-10-01': { day: 2, night: 3 }, '2026-11-01': { night: 2 } } },
    employees: ['甲测试员', '乙测试员', '丙测试员'].map((name, index) => ({ id: `qa-${'abc'[index]}`, name, role: '测试岗位', group: '验收组', color: '#d7e8f8', ...(index === 0 ? { avatar } : {}), minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 48, eligibleShiftIds: ['day', 'evening', 'night'], unavailableDates: index === 0 ? ['2026-09-20', '2026-10-05', '2026-10-12', '2026-11-20'] : ['2026-10-08'] })),
    shifts: [
      { id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 0, staffingMode: 'minimum', normalAllowance: 20 },
      { id: 'evening', name: '晚班', shortName: '晚', start: '14:00', end: '22:00', color: '#f8e5cc', required: 0, staffingMode: 'minimum', normalAllowance: 30 },
      { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#e5def7', required: 0, staffingMode: 'minimum', normalAllowance: 50 },
    ],
    rules: { minRestHours: 11, maxConsecutiveDays: 5,
      nonConsecutiveShifts: [{ id: 'night-gap', shiftId: 'night' }, { id: 'day-gap', shiftId: 'day' }],
      weeklyShiftLimits: [{ id: 'night-cap', shiftId: 'night', maxPerWeek: 2 }, { id: 'day-cap', shiftId: 'day', maxPerWeek: 3 }],
      separationGroups: [{ id: 'all-group', name: '三人错班', employeeIds: ['qa-a', 'qa-b', 'qa-c'], shiftIds: [] }, { id: 'night-group', name: '夜班错开', employeeIds: ['qa-a', 'qa-b'], shiftIds: ['night'] }] },
    assignments: [
      { employeeId: 'qa-a', date: '2026-09-30', shiftId: 'night', locked: true },
      { employeeId: 'qa-a', date: '2026-10-01', shiftId: 'day', locked: true },
      { employeeId: 'qa-b', date: '2026-10-01', shiftId: 'night', locked: true },
      { employeeId: 'qa-c', date: '2026-10-02', shiftId: 'evening', locked: false },
      { employeeId: 'qa-a', date: '2026-10-05', shiftId: 'off', locked: true },
      { employeeId: 'qa-b', date: '2026-11-01', shiftId: 'day', locked: false },
    ],
  }
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  await fs.rm(path.join(output, 'failure.png'), { force: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', hasTouch: true })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => report.errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1')))
  const confirmation = () => page.getByRole('alertdialog')
  const cancel = () => confirmation().locator('footer').getByRole('button').first()
  const confirm = () => confirmation().locator('footer').getByRole('button').last()
  const profile = () => page.getByRole('dialog', { name: '编辑成员资料', exact: true })
  const leave = () => page.getByRole('dialog', { name: '甲测试员 · 请假日历', exact: true })
  const leaveDay = date => leave().locator(`[data-leave-date="${date}"]`)
  const focused = locator => locator.evaluate(element => element === document.activeElement)
  async function persisted(expected) {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      try { assert.deepEqual(await state(), expected); return } catch {}
      await page.waitForTimeout(40)
    }
    assert.deepEqual(await state(), expected)
  }
  async function navigate(name) {
    const toggle = page.getByRole('button', { name: '打开导航', exact: true })
    const mobile = await toggle.isVisible()
    if (mobile) await toggle.click()
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name }).click()
    if (mobile) await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
  }
  async function importFixture(document) {
    await page.locator('input[type=file]').first().setInputFiles({ name: 'delete-confirmations-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) })
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await page.waitForFunction(name => JSON.parse(localStorage.getItem('shift-planner:v1'))?.teamName === name, document.teamName)
    await page.waitForTimeout(100)
    return state()
  }
  let sequence = 0
  async function reset(section, avatar) {
    const document = fixture(avatar); document.teamName += ` ${++sequence}`
    const baseline = await importFixture(document)
    await navigate(section)
    return baseline
  }
  async function opened(trigger, textPattern, tap = false) {
    if (tap) await trigger.tap(); else await trigger.click()
    await confirmation().waitFor()
    assert.equal(await confirmation().getAttribute('aria-modal'), 'true')
    assert.match(await confirmation().innerText(), textPattern)
    await page.waitForFunction(() => document.querySelector('[role="alertdialog"] footer button') === document.activeElement)
    assert.equal(await focused(cancel()), true)
  }
  async function canceled(trigger, baseline, textPattern) {
    await opened(trigger, textPattern)
    assert.deepEqual(await state(), baseline, 'Opening a confirmation must not mutate persisted data')
    await cancel().click()
    await confirmation().waitFor({ state: 'detached' })
    assert.deepEqual(await state(), baseline)
    assert.equal(await focused(trigger), true, 'Cancel returns keyboard focus to its trigger')
  }
  async function accepted() {
    await confirm().click()
    await confirmation().waitFor({ state: 'detached' })
  }
  async function screenshot(name) { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file }); report.screenshots.push(file) }
  async function geometry() {
    const size = await confirmation().evaluate(element => { const r = element.getBoundingClientRect(); return { viewport: innerWidth, height: innerHeight, html: document.documentElement.scrollWidth, body: document.body.scrollWidth, x: r.x, right: r.right, y: r.y, bottom: r.bottom, scroll: element.scrollWidth, width: element.clientWidth } })
    assert.ok(size.html <= size.viewport && size.body <= size.viewport && size.x >= 0 && size.right <= size.viewport && size.y >= 0 && size.bottom <= size.height && size.scroll <= size.width + 1, JSON.stringify(size))
    for (const action of [cancel(), confirm()]) { const box = await action.boundingBox(); assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= size.viewport, JSON.stringify(box)) }
    return size
  }
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    const avatar = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32; const c = canvas.getContext('2d'); c.fillStyle = '#245b4e'; c.fillRect(0, 0, 32, 32); return canvas.toDataURL('image/jpeg', .8) })

    let baseline = await reset('成员管理', avatar)
    let trigger = page.getByRole('button', { name: '删除甲测试员', exact: true })
    await canceled(trigger, baseline, /甲测试员/)
    record('employee-delete-opens-modal-and-cancel-preserves-all-data')
    await opened(trigger, /甲测试员/)
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key)
      assert.equal(await confirmation().evaluate(element => element.contains(document.activeElement)), true)
    }
    await page.keyboard.press('Escape'); await confirmation().waitFor({ state: 'detached' }); assert.deepEqual(await state(), baseline)
    await opened(trigger, /甲测试员/); await page.keyboard.press('Enter'); await confirmation().waitFor({ state: 'detached' }); assert.deepEqual(await state(), baseline)
    await opened(trigger, /甲测试员/); await page.mouse.click(2, 2); await confirmation().waitFor({ state: 'detached' }); assert.deepEqual(await state(), baseline)
    record('default-cancel-enter-tab-trap-escape-and-backdrop-are-safe')
    await opened(trigger, /甲测试员/); await screenshot('employee-delete-desktop'); await accepted()
    let expected = clone(baseline)
    expected.employees = expected.employees.filter(employee => employee.id !== 'qa-a')
    expected.assignments = expected.assignments.filter(assignment => assignment.employeeId !== 'qa-a')
    delete expected.payroll.employeeSalaries['qa-a']
    expected.rules.separationGroups = [{ ...expected.rules.separationGroups[0], employeeIds: ['qa-b', 'qa-c'] }]
    await persisted(expected)
    record('employee-confirm-deletes-only-that-member-associated-roster-payroll-and-invalid-exclusion-membership')

    baseline = await reset('班次设置', avatar)
    trigger = page.getByRole('button', { name: '删除夜班', exact: true })
    await canceled(trigger, baseline, /夜班/)
    record('shift-delete-opens-modal-and-cancel-preserves-all-data')
    await opened(trigger, /夜班/); await accepted()
    expected = clone(baseline)
    expected.shifts = expected.shifts.filter(shift => shift.id !== 'night')
    expected.assignments = expected.assignments.filter(assignment => assignment.shiftId !== 'night')
    expected.employees.forEach(employee => { employee.eligibleShiftIds = employee.eligibleShiftIds.filter(id => id !== 'night') })
    expected.rules.nonConsecutiveShifts = expected.rules.nonConsecutiveShifts.filter(rule => rule.shiftId !== 'night')
    expected.rules.weeklyShiftLimits = expected.rules.weeklyShiftLimits.filter(rule => rule.shiftId !== 'night')
    expected.rules.separationGroups = expected.rules.separationGroups.filter(group => group.id !== 'night-group')
    expected.payroll.dateShiftMultipliers = { '2026-10-01': { day: 2 } }
    await persisted(expected)
    record('shift-confirm-cleans-only-related-roster-eligibility-rules-and-multipliers')

    baseline = await reset('排班规则', avatar)
    await page.getByRole('tab', { name: '团队规则', exact: true }).click()
    trigger = page.getByRole('button', { name: '删除互斥组三人错班', exact: true })
    await canceled(trigger, baseline, /三人错班/)
    record('separation-group-delete-opens-modal-and-cancel-preserves-all-data')
    await opened(trigger, /三人错班/); await accepted()
    expected = clone(baseline); expected.rules.separationGroups = expected.rules.separationGroups.filter(group => group.id !== 'all-group')
    await persisted(expected)
    record('separation-group-confirm-retains-other-rule-groups-and-all-roster-records')

    for (const [kind, label] of [['nonConsecutiveShifts', '不相连'], ['weeklyShiftLimits', '周次数']]) {
      baseline = await reset('排班规则', avatar)
      await page.getByRole('tab', { name: '个人规则', exact: true }).click()
      trigger = page.getByRole('button', { name: `删除第 1 条${label}规则`, exact: true })
      await canceled(trigger, baseline, /夜班/)
      record(`${kind}-delete-opens-modal-and-cancel-preserves-all-data`)
      await opened(trigger, /夜班/); await accepted()
      expected = clone(baseline); expected.rules[kind] = expected.rules[kind].slice(1)
      await persisted(expected)
      record(`${kind}-confirm-removes-one-rule-and-keeps-other-rules-and-roster`)
    }

    baseline = await reset('成员管理', avatar)
    trigger = page.getByRole('button', { name: '恢复自动', exact: true })
    await canceled(trigger, baseline, /2026.*10|10 月/)
    record('monthly-reference-reset-requires-confirmation-and-cancel-keeps-manual-hours')
    await opened(trigger, /2026.*10|10 月/); await accepted()
    expected = clone(baseline); delete expected.monthlyReferenceHours['2026-10']
    await persisted(expected)
    record('monthly-reference-confirm-removes-only-the-selected-month-override')

    baseline = await reset('排班日历', avatar)
    await page.getByRole('button', { name: '月视图', exact: true }).click()
    await page.getByRole('button', { name: '设置 2026-10-05 日期类型', exact: true }).click()
    const dateDialog = page.getByRole('dialog', { name: '2026-10-05 · 日期类型', exact: true })
    trigger = dateDialog.getByRole('button', { name: '恢复默认', exact: true })
    await canceled(trigger, baseline, /2026-10-05/)
    assert.equal(await dateDialog.isVisible(), true)
    await opened(trigger, /2026-10-05/); await page.keyboard.press('Escape'); await confirmation().waitFor({ state: 'detached' })
    assert.equal(await dateDialog.isVisible(), true); assert.deepEqual(await state(), baseline)
    record('date-reset-cancel-and-escape-close-only-the-confirmation-and-keep-the-date-editor')
    await opened(trigger, /2026-10-05/); await accepted()
    expected = clone(baseline); delete expected.calendar['2026-10-05']
    await persisted(expected)
    record('date-reset-confirm-removes-only-the-selected-date-override')

    baseline = await reset('成员管理', avatar)
    await page.getByRole('button', { name: '编辑甲测试员', exact: true }).click()
    trigger = profile().getByRole('button', { name: '移除头像', exact: true })
    await canceled(trigger, baseline, /头像/)
    assert.equal(await profile().getByRole('img', { name: '头像预览', exact: true }).count(), 1)
    await opened(trigger, /头像/)
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key)
      assert.equal(await confirmation().evaluate(element => element.contains(document.activeElement)), true, 'Nested confirmation owns the tab sequence')
    }
    await page.keyboard.press('Escape'); await confirmation().waitFor({ state: 'detached' })
    assert.equal(await profile().isVisible(), true); assert.equal(await focused(trigger), true)
    record('avatar-removal-cancel-and-escape-preserve-preview-and-parent-editor')
    await opened(trigger, /头像/); await accepted()
    assert.equal(await profile().getByRole('img', { name: '头像预览', exact: true }).count(), 0)
    assert.deepEqual(await state(), baseline)
    await profile().getByRole('button', { name: '取消', exact: true }).click()
    assert.deepEqual(await state(), baseline)
    await page.getByRole('button', { name: '编辑甲测试员', exact: true }).click()
    await opened(profile().getByRole('button', { name: '移除头像', exact: true }), /头像/); await accepted()
    await profile().getByRole('button', { name: '保存人员', exact: true }).click()
    expected = clone(baseline); expected.employees[0].avatar = null
    await persisted(expected)
    record('confirmed-avatar-removal-is-only-a-draft-until-profile-save-and-does-not-touch-other-fields')

    baseline = await reset('成员管理', avatar)
    await page.getByRole('button', { name: '设置甲测试员请假', exact: true }).click()
    trigger = leaveDay('2026-10-05')
    await canceled(trigger, baseline, /2026-10-05/)
    assert.equal(await trigger.getAttribute('aria-pressed'), 'true')
    await opened(trigger, /2026-10-05/); await page.keyboard.press('Escape'); await confirmation().waitFor({ state: 'detached' })
    assert.equal(await leave().isVisible(), true); assert.equal(await focused(trigger), true)
    record('single-leave-removal-cancel-and-escape-retain-the-date-and-parent-calendar')
    await opened(trigger, /2026-10-05/); await accepted()
    assert.equal(await trigger.getAttribute('aria-pressed'), 'false'); assert.deepEqual(await state(), baseline)
    await leave().getByRole('button', { name: '取消', exact: true }).click(); assert.deepEqual(await state(), baseline)
    await page.getByRole('button', { name: '设置甲测试员请假', exact: true }).click()
    await opened(leaveDay('2026-10-05'), /2026-10-05/); await accepted()
    await leave().getByRole('button', { name: '保存请假', exact: true }).click()
    expected = clone(baseline); expected.employees[0].unavailableDates = expected.employees[0].unavailableDates.filter(date => date !== '2026-10-05')
    await persisted(expected)
    record('confirmed-single-leave-removal-requires-save-and-retains-other-dates-members-and-locked-roster')

    baseline = await reset('成员管理', avatar)
    await page.getByRole('button', { name: '设置甲测试员请假', exact: true }).click()
    trigger = leave().getByRole('button', { name: '清空本月', exact: true })
    await canceled(trigger, baseline, /2026.*10|10 月/)
    assert.equal(await leave().locator('[data-leave-date][aria-pressed=true]').count(), 2)
    record('clear-month-leave-requires-confirmation-and-cancel-preserves-selection')
    await opened(trigger, /2026.*10|10 月/); await accepted()
    assert.equal(await leave().locator('[data-leave-date][aria-pressed=true]').count(), 0); assert.deepEqual(await state(), baseline)
    await leave().getByRole('button', { name: '取消', exact: true }).click(); assert.deepEqual(await state(), baseline)
    await page.getByRole('button', { name: '设置甲测试员请假', exact: true }).click()
    await opened(leave().getByRole('button', { name: '清空本月', exact: true }), /2026.*10|10 月/); await accepted()
    await leave().getByRole('button', { name: '保存请假', exact: true }).click()
    expected = clone(baseline); expected.employees[0].unavailableDates = expected.employees[0].unavailableDates.filter(date => !date.startsWith('2026-10-'))
    await persisted(expected)
    record('confirmed-month-leave-clear-requires-save-and-retains-other-months-members-and-all-roster-records')

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      baseline = await reset('成员管理', avatar)
      await page.getByRole('button', { name: '设置甲测试员请假', exact: true }).tap()
      await opened(leave().getByRole('button', { name: '清空本月', exact: true }), /2026.*10|10 月/, true)
      const dimensions = await geometry()
      await screenshot(`nested-delete-${width}`)
      await cancel().tap(); await confirmation().waitFor({ state: 'detached' })
      assert.equal(await leave().isVisible(), true); assert.deepEqual(await state(), baseline)
      await leave().getByRole('button', { name: '取消', exact: true }).tap()
      await opened(page.getByRole('button', { name: '删除甲测试员', exact: true }), /甲测试员/, true)
      await geometry(); await screenshot(`employee-delete-${width}`)
      await cancel().tap(); await confirmation().waitFor({ state: 'detached' }); assert.deepEqual(await state(), baseline)
      record(`${width}px-touch-confirmations-fit-the-viewport-and-cancel-safely`, dimensions)
    }
    await page.reload({ waitUntil: 'networkidle' })
    await persisted(baseline)
    assert.deepEqual(report.errors, [])
    record('canceled-mobile-actions-survive-reload-and-all-confirmation-paths-emit-no-browser-errors')
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
