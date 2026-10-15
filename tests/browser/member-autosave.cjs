const { selectGlobalMonth, openMonthPicker } = require('./helpers/month-picker.cjs')
/* Run against a freshly built production preview (or an existing Vite server):
 * MEMBER_AUTOSAVE_TEST_URL=http://127.0.0.1:5194 \
 * PLAYWRIGHT_MODULE_PATH=/path/to/playwright PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium \
 * node tests/browser/member-autosave.cjs
 * Real Chromium acceptance, including deliberately injected background DOM events
 * for pending-save races. No application internals or native Tauri solver are used.
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const url = process.env.MEMBER_AUTOSAVE_TEST_URL || 'http://127.0.0.1:5194'
const output = path.resolve(process.env.MEMBER_AUTOSAVE_TEST_OUTPUT || 'test-results/member-autosave')
const settleMs = Number(process.env.MEMBER_AUTOSAVE_SETTLE_MS || 1200)
const checks = [], errors = []
const report = { url, startedAt: new Date().toISOString(), scope: 'Real Chromium member cards, profile modal and local persistence; synthetic DOM events exercise background races; no native packaging', checks, errors, ok: false }
const record = (name, detail) => { checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) }); console.log(`PASS ${name}`) }
const firstName = '陈小满'

function fixture(teamName = '成员自动保存验证') {
  return {
    version: 1, teamName, month: '2026-10', calendar: {}, monthlyReferenceHours: { '2026-10': 144, '2026-11': 168 },
    employees: [
      { id: 'qa-1', name: firstName, role: '值班员', group: '测试组', color: '#d7e8f8', minHoursPerMonth: null, minHoursPerWeek: 40, maxHoursPerWeek: 48, eligibleShiftIds: ['night', 'day'], unavailableDates: ['2026-09-30', '2026-10-02', '2026-11-01'] },
      { id: 'qa-2', name: '李青', role: '值班员', group: '测试组', color: '#d7e8f8', minHoursPerMonth: null, minHoursPerWeek: 0, maxHoursPerWeek: 40, eligibleShiftIds: ['night', 'day'], unavailableDates: [] },
      { id: 'qa-3', name: '旧资料', role: '值班员', group: '历史组', color: '#d7e8f8', minHoursPerMonth: 100, minHoursPerWeek: 36, maxHoursPerWeek: 40, eligibleShiftIds: ['day'], unavailableDates: ['2026-10-10'] },
    ],
    shifts: [
      { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#e6dff5', required: 0, normalAllowance: 50 },
      { id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 0, normalAllowance: 20 },
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
  await context.addInitScript(() => {
    window.__memberStorageWrites = []
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'shift-planner:v1') window.__memberStorageWrites.push(JSON.parse(value))
      return original.call(this, key, value)
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1') || 'null'))
  const member = async (name = firstName) => (await state()).employees.find(employee => employee.name === name)
  const card = (name = firstName) => page.locator('.sp-settings-employee-card').filter({ has: page.getByRole('button', { name: `编辑${name}`, exact: true }) })
  const minWeek = (name = firstName) => page.getByLabel(`${name}每周最低工时`, { exact: true })
  const maxWeek = (name = firstName) => page.getByLabel(`${name}每周最高工时`, { exact: true })
  const chip = (shift, name = firstName) => page.getByRole('button', { name: `${name}可上${shift}`, exact: true })
  const edit = (name = firstName) => page.getByRole('button', { name: `编辑${name}`, exact: true })
  const add = () => page.getByRole('button', { name: '添加员工', exact: true })
  const profile = () => page.getByRole('dialog').filter({ has: page.getByLabel('员工姓名', { exact: true }) })
  const leave = () => page.getByRole('dialog', { name: `${firstName} · 请假日历`, exact: true })
  const leaveButton = () => page.getByRole('button', { name: `设置${firstName}请假`, exact: true })
  const clearWrites = () => page.evaluate(() => { window.__memberStorageWrites = [] })
  const writes = () => page.evaluate(() => window.__memberStorageWrites)
  async function persisted(predicate, description = 'expected state') {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) { const value = await state(); if (value && predicate(value)) return value; await page.waitForTimeout(40) }
    assert.fail(`${description} did not persist: ${JSON.stringify(await state())}`)
  }
  async function persistedMember(predicate, name = firstName) { return persisted(value => value.employees.some(employee => employee.name === name && predicate(employee)), `member ${name}`) }
  async function navigate(label) {
    const mobile = page.getByRole('button', { name: '打开导航', exact: true })
    if (await mobile.isVisible()) await mobile.click()
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: label }).click()
    if (await mobile.isVisible()) await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
  }
  async function stageImport(document) {
    await page.locator('input.sp-hidden[type=file]:not([aria-label])').setInputFiles({ name: 'member-autosave.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) })
    await page.getByRole('button', { name: '确认导入', exact: true }).waitFor()
  }
  async function importDocument(document) {
    await stageImport(document)
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await persisted(value => value.teamName === document.teamName)
  }
  async function saveProfile() { await profile().getByRole('button', { name: '保存人员', exact: true }).click(); await profile().waitFor({ state: 'detached' }) }
  async function closeNotice() { const close = page.getByRole('button', { name: '关闭提示', exact: true }); if (await close.isVisible()) await close.click() }
  async function widthCheck(name, modal) {
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
    assert.ok(sizes.html <= sizes.viewport && sizes.body <= sizes.viewport, JSON.stringify(sizes))
    if (modal) {
      const bounds = await modal.evaluate(element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, viewport: innerWidth, client: element.clientWidth, scroll: element.scrollWidth } })
      assert.ok(bounds.left >= -0.5 && bounds.right <= bounds.viewport + 0.5 && bounds.scroll <= bounds.client + 1, JSON.stringify(bounds))
    }
    record(name, sizes)
  }
  // Dispatching both events in one browser task guarantees the tested transition
  // occurs before a debounce timer, independent of browser/CI speed.
  async function inputThen(label, value, action) {
    if (action.month) await openMonthPicker(page, action.month)
    await page.evaluate(({ label, value, action }) => {
      const input = document.querySelector(`input[aria-label="${label}"]`)
      if (!input) throw new Error(`Missing input ${label}`)
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      if (action.month) {
        const [year, month] = action.month.split('-').map(Number)
        const choice = document.querySelector(`[role="dialog"][aria-label="选择排班月份"] button[aria-label="${year} 年 ${month} 月"]`)
        if (!choice) throw new Error(`Missing month choice ${action.month}`)
        choice.click()
      } else {
        const selector = action.navigation ? 'nav[aria-label="应用导航"] button' : 'button'
        const button = [...document.querySelectorAll(selector)].find(button => button.textContent.trim() === action.button)
        if (!button) throw new Error(`Missing action ${action.button}`)
        button.click()
      }
    }, { label, value, action })
  }
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    const initial = fixture()
    await importDocument(initial)
    await navigate('成员管理')
    assert.equal(await minWeek('李青').inputValue(), '0')
    assert.equal(await maxWeek('李青').inputValue(), '40')
    assert.equal(await minWeek('旧资料').inputValue(), '36')
    assert.equal(await maxWeek('旧资料').inputValue(), '40')
    assert.deepEqual((await state()).employees.map(employee => [employee.minHoursPerWeek, employee.maxHoursPerWeek]), [[40, 48], [0, 40], [36, 40]])
    assert.equal(await page.getByRole('button', { name: /^保存.+设置$/ }).count(), 0)
    const chipNames = await card().locator('button[aria-pressed]').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))
    assert.deepEqual(chipNames, [`${firstName}可上夜班`, `${firstName}可上日班`])
    assert.equal(await page.getByLabel(/每月最低工时|月最低工时跟随|手动月参考工时/).count(), 0)
    assert.ok((await state()).employees.every(employee => !Object.hasOwn(employee, 'minHoursPerMonth')))
    assert.equal(Object.hasOwn(await state(), 'monthlyReferenceHours'), false)
    record('legacy-weekly-values-load-unchanged-and-retired-month-fields-are-removed')

    await add().click()
    await profile().waitFor()
    assert.equal(await profile().getAttribute('aria-modal'), 'true')
    assert.equal(await profile().getByLabel('员工姓名', { exact: true }).evaluate(element => element === document.activeElement), true)
    assert.equal(await page.locator('.sp-settings-editor').count(), 0)
    await profile().getByLabel('员工姓名', { exact: true }).fill('取消的新成员')
    await profile().getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await profile().count(), 0)
    assert.equal((await state()).employees.length, 3)
    assert.equal(await add().evaluate(element => element === document.activeElement), true)
    record('create-uses-modal-with-initial-focus-and-cancel-restores-trigger')

    await add().click()
    await profile().getByLabel('员工姓名', { exact: true }).fill('陈小满')
    await profile().getByRole('button', { name: '保存人员', exact: true }).click()
    assert.equal(await profile().isVisible(), true)
    assert.match(await profile().getByRole('alert').innerText(), /同名/)
    assert.equal((await state()).employees.length, 3)
    await profile().getByLabel('员工姓名', { exact: true }).fill('周小夏')
    await profile().getByLabel('岗位', { exact: true }).fill('轮班专员')
    await profile().getByLabel('所属分组', { exact: true }).fill('测试组')
    await saveProfile()
    await persistedMember(employee => employee.role === '轮班专员', '周小夏')
    const created = await member('周小夏')
    assert.deepEqual([created.minHoursPerWeek, created.maxHoursPerWeek], [40, 48])
    assert.equal(Object.hasOwn(created, 'minHoursPerMonth'), false)
    assert.deepEqual([...created.eligibleShiftIds].sort(), ['day', 'night'])
    assert.equal(await minWeek('周小夏').inputValue(), '40')
    assert.equal(await maxWeek('周小夏').inputValue(), '48')
    record('duplicate-error-stays-inside-modal-and-new-members-default-to-40-48')

    await edit('周小夏').click()
    await profile().getByLabel('员工姓名', { exact: true }).fill('周小夏（专员）')
    await profile().getByLabel('所属分组', { exact: true }).fill('综合组')
    await saveProfile()
    await persistedMember(employee => employee.id === created.id && employee.group === '综合组', '周小夏（专员）')
    assert.equal(await card('周小夏').count(), 0)
    assert.equal(await minWeek('周小夏（专员）').inputValue(), '40')
    assert.equal(await maxWeek('周小夏（专员）').inputValue(), '48')
    record('profile-edit-renames-member-and-keeps-card-hours-and-identity')

    await edit().click()
    const originalRole = (await member()).role
    await profile().getByLabel('岗位', { exact: true }).fill('未保存岗位')
    for (let i = 0; i < 18; i++) { await page.keyboard.press('Tab'); assert.equal(await profile().evaluate(element => element.contains(document.activeElement)), true) }
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Shift+Tab'); assert.equal(await profile().evaluate(element => element.contains(document.activeElement)), true) }
    await page.keyboard.press('Escape')
    assert.equal(await profile().count(), 0)
    assert.equal((await member()).role, originalRole)
    assert.equal(await edit().evaluate(element => element === document.activeElement), true)
    record('edit-modal-traps-tab-and-escape-cancels-and-restores-focus')
    await edit('旧资料').click()
    await profile().getByLabel('岗位', { exact: true }).fill('历史岗位更新')
    await saveProfile()
    await persistedMember(employee => employee.role === '历史岗位更新', '旧资料')
    assert.deepEqual([(await member('旧资料')).minHoursPerWeek, (await member('旧资料')).maxHoursPerWeek], [36, 40])
    await chip('夜班', '旧资料').click()
    await persistedMember(employee => employee.eligibleShiftIds.length === 2, '旧资料')
    assert.deepEqual([(await member('旧资料')).minHoursPerWeek, (await member('旧资料')).maxHoursPerWeek], [36, 40])
    record('profile-save-does-not-rewrite-legacy-weekly-hours-with-gap-under-eight')

    await clearWrites()
    await minWeek().fill('41')
    await page.waitForTimeout(settleMs)
    assert.deepEqual([(await member()).minHoursPerWeek, (await member()).maxHoursPerWeek], [40, 48])
    assert.match(await card().getByRole('alert').innerText(), /8/)
    assert.equal(await minWeek().inputValue(), '41')
    await maxWeek().fill('49')
    await persistedMember(employee => employee.minHoursPerWeek === 41 && employee.maxHoursPerWeek === 49)
    assert.ok((await writes()).every(value => { const employee = value.employees.find(employee => employee.id === 'qa-1'); return employee.maxHoursPerWeek - employee.minHoursPerWeek >= 8 }))
    record('gap-seven-rejects-without-overwrite-and-gap-eight-autosaves-pair-atomically')

    await minWeek().fill('40.001')
    await maxWeek().fill('48.001')
    await page.waitForTimeout(settleMs)
    // The last valid value may have saved on a field blur, but the invalid final
    // pair must never persist: ceil(min*60) to floor(max*60) leaves 479 minutes.
    assert.notDeepEqual([(await member()).minHoursPerWeek, (await member()).maxHoursPerWeek], [40.001, 48.001])
    assert.match(await card().getByRole('alert').innerText(), /8|分钟/)
    await maxWeek().fill('48.02')
    await persistedMember(employee => employee.minHoursPerWeek === 40.001 && employee.maxHoursPerWeek === 48.02)
    record('minimum-ceil-and-maximum-floor-require-full-480-minute-gap')

    await minWeek().fill('40')
    await maxWeek().fill('48')
    await persistedMember(employee => employee.minHoursPerWeek === 40 && employee.maxHoursPerWeek === 48)
    await clearWrites()
    for (const value of ['', '-1', '169']) {
      await minWeek().fill(value)
      await page.waitForTimeout(settleMs)
      assert.equal((await member()).minHoursPerWeek, 40)
    }
    await minWeek().fill('32')
    await minWeek().fill('')
    await page.waitForTimeout(settleMs)
    assert.equal((await member()).minHoursPerWeek, 40)
    assert.equal((await writes()).length, 0)
    await chip('夜班').click()
    await persistedMember(employee => employee.eligibleShiftIds.length === 1 && employee.minHoursPerWeek === 40)
    assert.equal(await minWeek().inputValue(), '')
    await chip('夜班').click()
    await persistedMember(employee => employee.eligibleShiftIds.length === 2)
    assert.equal(await minWeek().inputValue(), '')
    record('valid-qualification-edit-saves-independently-of-invalid-weekly-draft')
    await minWeek().fill('32')
    await persistedMember(employee => employee.minHoursPerWeek === 32)
    record('empty-out-of-range-and-interrupted-input-never-overwrite-saved-hours')

    await minWeek().fill('50')
    await page.waitForTimeout(settleMs)
    assert.equal((await member()).minHoursPerWeek, 32)
    await maxWeek().fill('58')
    await persistedMember(employee => employee.minHoursPerWeek === 50 && employee.maxHoursPerWeek === 58)
    record('minimum-and-maximum-can-cross-old-range-and-save-together-once-valid')

    await chip('日班').click()
    await persistedMember(employee => JSON.stringify(employee.eligibleShiftIds) === JSON.stringify(['night']))
    await chip('夜班').click()
    await persistedMember(employee => employee.eligibleShiftIds.length === 0)
    assert.deepEqual((await state()).assignments, initial.assignments)
    await chip('日班').click()
    await chip('夜班').click()
    await persistedMember(employee => employee.eligibleShiftIds.length === 2)
    record('qualification-chips-auto-save-including-empty-selection-and-preserve-assignments')

    for (const value of ['', '-1', '169']) {
      await maxWeek().fill(value)
      await page.waitForTimeout(settleMs)
      assert.equal((await member()).maxHoursPerWeek, 58)
      assert.match(await card().getByRole('alert').innerText(), /每周最高工时/)
    }
    await maxWeek().fill('58')
    assert.equal((await member('李青')).minHoursPerWeek, 0)
    record('invalid-weekly-maximum-drafts-do-not-save-and-existing-zero-remains-zero')

    await inputThen(`${firstName}每周最低工时`, '48', { navigation: true, button: '班次设置' })
    await persistedMember(employee => employee.minHoursPerWeek === 48)
    await navigate('成员管理')
    await inputThen(`${firstName}每周最低工时`, '46', { navigation: true, button: '排班日历' })
    await persistedMember(employee => employee.minHoursPerWeek === 46)
    await navigate('成员管理')
    assert.equal(await minWeek().inputValue(), '46')
    record('valid-pending-edit-persists-when-switching-section-or-unmounting-settings')

    await inputThen(`${firstName}每周最低工时`, '44', { month: '2026-11' })
    await persisted(value => value.month === '2026-11')
    await page.waitForTimeout(settleMs)
    assert.equal((await member()).minHoursPerWeek, 44)
    assert.equal(await minWeek().inputValue(), '44')
    assert.equal(await maxWeek().inputValue(), '58')
    assert.equal(await minWeek('李青').inputValue(), '0')
    await inputThen(`${firstName}每周最低工时`, '43', { month: '2026-10' })
    await persisted(value => value.month === '2026-10' && value.employees[0].minHoursPerWeek === 43)
    await minWeek().fill('44')
    await selectGlobalMonth(page, '2026-11')
    await persisted(value => value.month === '2026-11' && value.employees[0].minHoursPerWeek === 44)
    await selectGlobalMonth(page, '2026-10')
    await persisted(value => value.month === '2026-10')
    assert.equal(await minWeek().inputValue(), '44')
    assert.equal(await maxWeek().inputValue(), '58')
    record('month-change-flushes-valid-pending-edits-with-and-without-blur')

    await leaveButton().click()
    await leave().locator('button[data-leave-date="2026-10-18"]').click()
    await leave().getByRole('button', { name: '保存请假', exact: true }).click()
    await persistedMember(employee => employee.unavailableDates.includes('2026-10-18'))
    // Preserve data saved after the profile draft was opened. Deliberate DOM
    // events emulate independent background changes beneath a modal overlay.
    await edit().click()
    await profile().getByLabel('岗位', { exact: true }).fill('资深轮班员')
    await minWeek().evaluate(element => { element.value = '42'; element.dispatchEvent(new Event('input', { bubbles: true })) })
    await chip('夜班').dispatchEvent('click')
    await persistedMember(employee => employee.minHoursPerWeek === 42 && employee.eligibleShiftIds.length === 1)
    await saveProfile()
    await persistedMember(employee => employee.role === '资深轮班员')
    const merged = await member()
    assert.deepEqual([merged.minHoursPerWeek, merged.maxHoursPerWeek], [42, 58])
    assert.deepEqual(merged.eligibleShiftIds, ['day'])
    assert.deepEqual(merged.unavailableDates, ['2026-09-30', '2026-10-02', '2026-10-18', '2026-11-01'])
    assert.deepEqual((await state()).assignments, initial.assignments)
    record('open-profile-save-merges-background-hours-and-qualifications-and-preserves-leave')

    const beforeReload = await state()
    await page.reload({ waitUntil: 'networkidle' })
    await navigate('成员管理')
    assert.deepEqual(await state(), beforeReload)
    assert.equal(await minWeek().inputValue(), '42')
    assert.equal(await chip('日班').getAttribute('aria-pressed'), 'true')
    assert.equal(await chip('夜班').getAttribute('aria-pressed'), 'false')
    record('refresh-restores-auto-saved-hours-qualifications-profile-and-leave')

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      minWeek().evaluate(element => { element.value = '40'; element.dispatchEvent(new Event('input', { bubbles: true })); location.reload() }),
    ])
    await navigate('成员管理')
    assert.equal((await member()).minHoursPerWeek, 40)
    assert.equal(await minWeek().inputValue(), '40')
    record('immediate-browser-refresh-flushes-pending-valid-input-before-storage-save')

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      maxWeek().evaluate(element => { element.value = '60'; element.dispatchEvent(new Event('input', { bubbles: true })); location.reload() }),
    ])
    await navigate('成员管理')
    assert.deepEqual([(await member()).minHoursPerWeek, (await member()).maxHoursPerWeek], [40, 60])
    assert.equal(await minWeek('李青').inputValue(), '0')
    record('immediate-refresh-also-flushes-weekly-maximum-without-changing-other-member-minimum')

    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1050 : 844 })
      if (width < 720) await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
      const mobileNavigation = page.getByRole('button', { name: '打开导航', exact: true })
      if (await mobileNavigation.isVisible()) {
        await mobileNavigation.click()
        await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().left >= -0.5)
      }
      const brand = page.getByRole('link', { name: 'Shift Schedule Expert', exact: true })
      assert.equal(await brand.isVisible(), true)
      const brandBounds = await brand.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return { client: element.clientWidth, scroll: element.scrollWidth, left: rect.left, right: rect.right, viewport: innerWidth }
      })
      assert.ok(brandBounds.scroll <= brandBounds.client + 1 && brandBounds.left >= 0 && brandBounds.right <= brandBounds.viewport, JSON.stringify(brandBounds))
      record(`brand-${width}-fits-sidebar-without-overflow`, brandBounds)
      if (await mobileNavigation.isVisible()) {
        await page.screenshot({ path: path.join(output, `03-brand-navigation-${width}.png`) })
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0)
      }
      await closeNotice()
      await card().scrollIntoViewIfNeeded()
      await widthCheck(`member-cards-${width}-no-horizontal-overflow`)
      await page.screenshot({ path: path.join(output, `01-member-cards-${width}.png`) })
      await edit().click()
      await widthCheck(`profile-dialog-${width}-no-horizontal-overflow`, profile())
      await page.screenshot({ path: path.join(output, `02-profile-dialog-${width}.png`) })
      await profile().getByRole('button', { name: '取消', exact: true }).click()
      assert.equal(await edit().evaluate(element => element === document.activeElement), true)
    }

    await page.setViewportSize({ width: 1440, height: 1050 })
    const replacement = fixture('导入替换计时器验证')
    await stageImport(replacement)
    await inputThen(`${firstName}每周最低工时`, '30', { button: '确认导入' })
    await persisted(value => value.teamName === replacement.teamName)
    await page.waitForTimeout(settleMs)
    assert.deepEqual([(await member()).minHoursPerWeek, (await member()).maxHoursPerWeek], [40, 48])
    assert.equal(await minWeek().inputValue(), '40')
    assert.deepEqual((await member()).unavailableDates, replacement.employees[0].unavailableDates)
    record('import-with-same-member-id-cancels-old-pending-draft-and-timer')

    // Begin the edit while the card is interactive. The confirmation is modal,
    // so deletion must never rely on injecting input into its inert background.
    await minWeek().fill('30')
    await page.getByRole('button', { name: `删除${firstName}`, exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '确认删除', exact: true }).click()
    await persisted(value => !value.employees.some(employee => employee.id === 'qa-1'))
    await page.waitForTimeout(settleMs)
    assert.equal((await state()).employees.some(employee => employee.id === 'qa-1'), false)
    assert.equal((await state()).assignments.some(assignment => assignment.employeeId === 'qa-1'), false)
    assert.equal(await card().count(), 0)
    record('deleted-member-cannot-be-resurrected-by-pending-autosave')
    assert.deepEqual(errors, [])
    record('no-browser-console-or-page-errors')
    report.ok = true
  } catch (error) {
    report.failure = error.stack || String(error)
    report.lastState = await state().catch(() => null)
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
