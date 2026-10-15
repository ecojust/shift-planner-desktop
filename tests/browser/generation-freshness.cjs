/* Real Vue regression for result freshness. Desktop results use deterministic,
 * valid payloads through controlled Tauri IPC and the app's independent validator;
 * browser cases execute the actual Worker. No native solver/packaging claims. */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const { assertCurrentMonthStatus, assertMonthChoiceStatus, openMonthPicker } = require('./helpers/month-picker.cjs')
const url = process.env.GENERATION_FRESHNESS_TEST_URL || 'http://127.0.0.1:5190/'
const out = path.resolve(__dirname, '../../test-results/generation-freshness')
const fixture = {
  version: 1, teamName: '排班结果时效验收', month: '2026-10',
  employees: ['甲', '乙'].map((name, index) => ({ id: `qa-${index + 1}`, name: `测试成员${name}`, role: '服务员', group: '测试', color: '#d7e8f8', minHoursPerWeek: 0, maxHoursPerWeek: 56, eligibleShiftIds: ['day'], unavailableDates: [] })),
  shifts: [{ id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 1, staffingMode: 'fixed', normalAllowance: 0 }],
  rules: { minRestHours: 11, maxConsecutiveDays: 5 },
  assignments: [{ employeeId: 'qa-1', date: '2026-10-01', shiftId: 'day', locked: true }, { employeeId: 'qa-2', date: '2026-09-30', shiftId: 'off', locked: false }],
  provenance: {
    fields: { 'employees.qa-1.name': { source: 'mcp', at: '2026-10-13T08:30:00.000Z' } },
    pendingExternalChange: { source: 'mcp', at: '2026-10-13T08:30:00.000Z', categories: ['成员'] },
  },
}
const clone = value => JSON.parse(JSON.stringify(value))
const report = { url, scope: 'Real Vue persistent per-month schedule validity, controlled valid desktop solver responses and real web Worker; no native transport', checks: [], errors: [], screenshots: [], ok: false }
let browser, activePage
function record(name) { report.checks.push(name); console.log('PASS', name) }
async function screenshot(page, name) { const file = path.join(out, `${name}.png`); await page.screenshot({ path: file, animations: 'disabled' }); report.screenshots.push(file) }
async function stored(page) { return page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1'))) }
async function prepare(desktop, state = fixture) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  activePage = page
  page.on('pageerror', error => report.errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })
  const control = { requests: [], pending: [] }
  if (desktop) await page.exposeFunction('qaFreshnessInvoke', async (command, args) => {
    if (command === 'plugin:event|listen') return 1
    if (command === 'plugin:event|unlisten') return null
    if (command === 'solver_info') return { engine: 'ortools-cp-sat', protocolVersion: 1, version: 'controlled-freshness-test', local: true }
    if (command === 'integration_status' || command === 'integration_stop') {
      assert.ok(['mcp', 'http'].includes(args?.service), 'integration commands require an explicit service')
      return { enabled: false, url: '', token: '', serviceId: '' }
    }
    if (command === 'solve_schedule') {
      control.requests.push(args.request)
      return new Promise((resolve, reject) => control.pending.push({ request: args.request, resolve, reject }))
    }
    throw new Error(`Unexpected controlled IPC command: ${command}`)
  })
  await page.addInitScript(({ state, desktop }) => {
    if (!localStorage.getItem('shift-planner:v1')) localStorage.setItem('shift-planner:v1', JSON.stringify(state))
    window.__freshnessWorkerCount = 0
    if (desktop) {
      window.isTauri = true
      let callbackId = 0
      window.__TAURI_INTERNALS__ = { transformCallback() { return ++callbackId }, unregisterCallback() {}, invoke: (command, args) => window.qaFreshnessInvoke(command, args) }
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    } else {
      const ActualWorker = window.Worker
      window.Worker = class extends ActualWorker { constructor(...args) { super(...args); window.__freshnessWorkerCount++ } }
    }
  }, { state, desktop })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '排班日历', exact: true }).waitFor()
  return { page, control }
}
async function start(page, control) {
  await page.getByRole('button', { name: '自动排班', exact: true }).click()
  await page.getByRole('button', { name: '开始生成', exact: true }).click()
  if (control) {
    await page.locator('.sp-solve-progress').waitFor()
    const deadline = Date.now() + 5000
    while (!control.pending.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(control.pending.length, 'desktop request reached the bridge')
  }
}
function success(request) {
  const assignments = clone(request.state.assignments.filter(item => item.locked || !item.date.startsWith(`${request.state.month}-`)))
  const [year, month] = request.state.month.split('-').map(Number)
  for (let day = 1; day <= new Date(Date.UTC(year, month, 0)).getUTCDate(); day++) {
    const date = `${request.state.month}-${String(day).padStart(2, '0')}`
    if (!assignments.some(item => item.date === date && item.shiftId === 'day')) assignments.push({ employeeId: `qa-${day % 2 ? 1 : 2}`, date, shiftId: 'day', locked: false })
  }
  return { protocolVersion: 1, requestId: request.requestId, engine: 'ortools-cp-sat', status: 'OPTIMAL', assignments, issues: [], stats: { wallTimeSeconds: 0.01, shortageCount: 0, optimal: true }, message: 'valid controlled response' }
}
async function settle(page, control, mode = 'success') {
  const pending = control.pending.shift()
  assert.ok(pending)
  if (mode === 'transport') pending.reject(new Error('SOLVE_TIMEOUT: controlled test deadline'))
  else if (mode === 'unknown') pending.resolve({ ...success(pending.request), status: 'UNKNOWN', assignments: undefined })
  else pending.resolve(success(pending.request))
  await complete(page)
}
async function complete(page) {
  await page.locator('.sp-solve-result').waitFor({ timeout: 45000 })
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('.sp-solve-progress').count(), 0)
}
async function freshness(page, stale, message) {
  const result = page.locator('.sp-solve-result')
  await result.waitFor()
  assert.equal(await result.locator('.sp-diagnostic-stale').count(), stale ? 1 : 0)
  const text = await result.innerText()
  if (stale) assert.match(text, /配置已更改，上次排班结果需要重新检查/)
  else { assert.doesNotMatch(text, /配置已更改|设置已更改/); if (message) assert.match(text, message) }
}
async function monthStatus(page, expected) {
  await assertCurrentMonthStatus(page, expected)
}
async function moveMonth(page, direction, month, expected) {
  await page.getByRole('button', { name: direction > 0 ? '下个月' : '上个月', exact: true }).click()
  await page.waitForFunction(month => JSON.parse(localStorage.getItem('shift-planner:v1')).month === month, month)
  await monthStatus(page, expected)
}
async function section(page, name) {
  await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: new RegExp(name) }).click()
  await page.getByRole('heading', { name, exact: true }).waitFor()
}
async function changeRule(page, value, save = true) {
  await section(page, '排班规则')
  await page.getByRole('spinbutton', { name: '班间最短休息小时数', exact: true }).fill(String(value))
  if (save) {
    await page.getByRole('button', { name: '保存个人规则', exact: true }).click()
    await page.waitForFunction(value => JSON.parse(localStorage.getItem('shift-planner:v1')).rules.minRestHours === value, value)
  }
  await section(page, '排班日历')
}
async function changeMember(page, name) {
  const before = await stored(page)
  await section(page, '成员管理')
  await page.getByRole('button', { name: `编辑${before.employees[0].name}`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑成员资料', exact: true })
  await dialog.getByRole('textbox', { name: '员工姓名', exact: true }).fill(name)
  await dialog.getByRole('button', { name: '保存人员', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(name => JSON.parse(localStorage.getItem('shift-planner:v1')).employees[0].name === name, name)
  await section(page, '排班日历')
}
async function changeShift(page, name) {
  await section(page, '班次设置')
  await page.locator('#shift-day .sp-settings-edit').click()
  const dialog = page.getByRole('dialog', { name: '编辑班次', exact: true })
  await dialog.getByRole('textbox', { name: '班次名称', exact: true }).fill(name)
  await dialog.getByRole('button', { name: '保存班次', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(name => JSON.parse(localStorage.getItem('shift-planner:v1')).shifts[0].name === name, name)
  await section(page, '排班日历')
}
async function restFirstCell(page) {
  const state = await stored(page)
  await page.getByRole('button', { name: '月视图', exact: true }).click()
  await page.getByRole('button', { name: `${state.employees[0].name} 2026-10-01 ${state.shifts[0].name}，点击编辑`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '调整班次', exact: true })
  await dialog.getByRole('button', { name: /安排休息/ }).click()
  await dialog.getByRole('button', { name: '保存安排', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('shift-planner:v1')).assignments.some(item => item.employeeId === 'qa-1' && item.date === '2026-10-01' && item.shiftId === 'off'))
}
async function undoAndPersist(page, expected) {
  await page.getByRole('button', { name: '撤销上次调整', exact: true }).click()
  await page.waitForFunction(assignments => JSON.stringify(JSON.parse(localStorage.getItem('shift-planner:v1')).assignments) === JSON.stringify(assignments), expected)
}
async function savedGenerated(page) {
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('shift-planner:v1')).assignments.filter(item => item.date.startsWith('2026-10') && item.shiftId === 'day').length === 31)
  const state = await stored(page)
  for (const fixed of fixture.assignments) assert.deepEqual(state.assignments.find(item => item.employeeId === fixed.employeeId && item.date === fixed.date), fixed)
  return state
}
async function main() {
  await fs.mkdir(out, { recursive: true })
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  try {
    const { page, control } = await prepare(true)
    await monthStatus(page, 'scheduled')
    await moveMonth(page, -1, '2026-09', 'scheduled')
    await moveMonth(page, 1, '2026-10', 'scheduled')
    await moveMonth(page, 1, '2026-11', 'empty')
    await moveMonth(page, -1, '2026-10', 'scheduled')
    await changeRule(page, 11)
    await monthStatus(page, 'scheduled')
    assert.equal((await stored(page)).provenance.invalidatedSchedules, undefined)
    record('legacy working and off-only months are scheduled, an empty month is not, and a saved no-op preserves validity')
    await start(page, control); await settle(page, control)
    await freshness(page, false, /排班已生成/)
    const generated = await savedGenerated(page)
    await freshness(page, false, /排班已生成/)
    assert.equal(await page.locator('.sp-solve-result').evaluate(node => node.classList.contains('is-warning')), false)
    assert.deepEqual(generated.provenance, fixture.provenance)
    await monthStatus(page, 'scheduled')
    await screenshot(page, 'desktop-success-fresh')
    record('desktop successful roster commit stays fresh immediately and after autosave, preserving locked/history entries and provenance')

    await page.getByRole('button', { name: '已核对变更', exact: true }).click()
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('shift-planner:v1')).provenance.pendingExternalChange)
    await freshness(page, false, /排班已生成/)
    await monthStatus(page, 'scheduled')
    record('acknowledging source metadata after success does not mark the result stale')

    await changeRule(page, 12, false)
    await freshness(page, false, /排班已生成/)
    assert.equal((await stored(page)).rules.minRestHours, 11)
    await monthStatus(page, 'scheduled')
    record('an unsaved rule draft and navigation do not invalidate the successful result')
    await changeRule(page, 12)
    await freshness(page, true)
    await monthStatus(page, 'invalid')
    const invalidated = clone((await stored(page)).provenance.invalidatedSchedules)
    assert.deepEqual(Object.keys(invalidated).sort(), ['2026-09', '2026-10'])
    for (const stamp of Object.values(invalidated)) assert.equal(stamp.source, 'manual')
    await screenshot(page, 'desktop-rule-change-stale')
    record('saving a real rule change after successful generation marks the result stale')

    await section(page, '成员管理'); await section(page, '排班日历')
    await monthStatus(page, 'invalid')
    await page.reload({ waitUntil: 'networkidle' })
    await monthStatus(page, 'invalid')
    assert.deepEqual((await stored(page)).provenance.invalidatedSchedules, invalidated)
    await moveMonth(page, -1, '2026-09', 'invalid')
    await moveMonth(page, 1, '2026-10', 'invalid')
    await moveMonth(page, 1, '2026-11', 'empty')
    await moveMonth(page, -1, '2026-10', 'invalid')
    record('configuration invalidation persists across pages, reload and months without labelling an empty month scheduled')

    await start(page, control); await settle(page, control)
    await freshness(page, false, /排班已生成/)
    await monthStatus(page, 'scheduled')
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('shift-planner:v1')).provenance.invalidatedSchedules?.['2026-10'])
    assert.deepEqual((await stored(page)).provenance.invalidatedSchedules, { '2026-09': invalidated['2026-09'] })
    await undoAndPersist(page, generated.assignments)
    await monthStatus(page, 'invalid')
    await start(page, control); await settle(page, control)
    await freshness(page, false, /排班已生成/)
    await monthStatus(page, 'scheduled')
    await changeShift(page, '重排后保存的新日班')
    await monthStatus(page, 'invalid')
    await freshness(page, true)
    await start(page, control); await settle(page, control)
    await freshness(page, false, /排班已生成/)
    await monthStatus(page, 'scheduled')
    await changeMember(page, '手动改名后的成员')
    await freshness(page, true)
    await monthStatus(page, 'invalid')
    record('regeneration clears only its current month, undo restores prior invalidity, and saved shift and member changes invalidate the new result')

    const beforeFailure = (await stored(page)).assignments
    await start(page, control); await settle(page, control, 'unknown')
    await freshness(page, false, /尚未找到可行方案/)
    assert.deepEqual((await stored(page)).assignments, beforeFailure)
    await monthStatus(page, 'invalid')
    await changeRule(page, 13)
    await freshness(page, true)
    record('unchanged failed attempts remain fresh and preserve the roster; a later saved rule change marks their diagnostic stale')

    await start(page, control); await settle(page, control, 'transport')
    await freshness(page, false, /排班超过等待时长/)
    assert.deepEqual((await stored(page)).assignments, beforeFailure)
    await monthStatus(page, 'invalid')
    record('transport failure preserves its current diagnostic and existing roster without a false stale warning')
    await page.close()

    const editing = await prepare(true)
    await restFirstCell(editing.page)
    await monthStatus(editing.page, 'scheduled')
    await editing.page.getByRole('button', { name: '设置 2026-10-01 日期类型', exact: true }).click()
    const dateDialog = editing.page.getByRole('dialog', { name: '2026-10-01 · 日期类型', exact: true })
    await dateDialog.getByRole('button', { name: /休息日 在日历中标记为休息日/ }).click()
    await dateDialog.getByRole('button', { name: '确认日期类型', exact: true }).click()
    await dateDialog.waitFor({ state: 'detached' })
    await editing.page.waitForFunction(() => JSON.parse(localStorage.getItem('shift-planner:v1')).calendar['2026-10-01'] === 'restday')
    await monthStatus(editing.page, 'scheduled')
    assert.deepEqual((await stored(editing.page)).provenance.invalidatedSchedules ?? {}, {})
    assert.equal((await stored(editing.page)).provenance.fields['calendar.2026-10-01'].source, 'manual')
    await undoAndPersist(editing.page, fixture.assignments)
    await monthStatus(editing.page, 'scheduled')
    record('a calendar display marker records its source without invalidating an existing schedule or its undo history')
    await changeRule(editing.page, 10)
    await monthStatus(editing.page, 'invalid')
    let configurationInvalidated = clone((await stored(editing.page)).provenance.invalidatedSchedules)
    await restFirstCell(editing.page)
    await undoAndPersist(editing.page, fixture.assignments)
    await monthStatus(editing.page, 'invalid')
    const undoInvalidated = (await stored(editing.page)).provenance.invalidatedSchedules
    assert.deepEqual(Object.keys(undoInvalidated).sort(), Object.keys(configurationInvalidated).sort())
    for (const [month, stamp] of Object.entries(undoInvalidated)) {
      assert.equal(stamp.source, 'manual')
      assert.ok(Date.parse(stamp.at) >= Date.parse(configurationInvalidated[month].at))
    }
    configurationInvalidated = clone(undoInvalidated)
    await restFirstCell(editing.page)
    await monthStatus(editing.page, 'invalid')
    assert.deepEqual((await stored(editing.page)).provenance.invalidatedSchedules, configurationInvalidated)
    await undoAndPersist(editing.page, fixture.assignments)
    await monthStatus(editing.page, 'invalid')
    await editing.page.getByRole('button', { name: '删除本月排班', exact: true }).click()
    await editing.page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click()
    await monthStatus(editing.page, 'empty')
    await editing.page.waitForFunction(() => !JSON.parse(localStorage.getItem('shift-planner:v1')).provenance.invalidatedSchedules?.['2026-10'])
    await undoAndPersist(editing.page, fixture.assignments)
    await monthStatus(editing.page, 'invalid')
    assert.deepEqual((await stored(editing.page)).provenance.invalidatedSchedules, configurationInvalidated)
    await editing.page.reload({ waitUntil: 'networkidle' })
    await monthStatus(editing.page, 'invalid')
    await screenshot(editing.page, 'persistent-invalid-schedule-desktop')
    await editing.page.setViewportSize({ width: 320, height: 640 })
    await monthStatus(editing.page, 'invalid')
    const monthDialog = await openMonthPicker(editing.page, '2026-10')
    await assertMonthChoiceStatus(monthDialog, '2026-09', 'invalid')
    await assertMonthChoiceStatus(monthDialog, '2026-10', 'invalid')
    await assertMonthChoiceStatus(monthDialog, '2026-11', 'empty')
    const statusBounds = await monthDialog.boundingBox()
    assert.ok(statusBounds && statusBounds.x >= 0 && statusBounds.x + statusBounds.width <= 321)
    assert.equal(await editing.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await screenshot(editing.page, 'persistent-invalid-schedule-320')
    await editing.page.keyboard.press('Escape')
    record('single-cell replacement and undo cannot erase saved rule invalidity; deleting and undoing restores the prior month status')
    await editing.page.close()

    const inflightState = clone(fixture)
    inflightState.provenance.invalidatedSchedules = { '2026-10': { source: 'manual', at: '2026-10-14T08:30:00.000Z' } }
    const inflight = await prepare(true, inflightState)
    await start(inflight.page, inflight.control)
    // Simulate a queued real UI event during asynchronous solving; the overlay
    // normally intercepts pointer input, but the revision guard must still hold.
    await inflight.page.getByRole('button', { name: '下个月', exact: true }).evaluate(node => node.click())
    await inflight.page.waitForFunction(() => JSON.parse(localStorage.getItem('shift-planner:v1')).month === '2026-11')
    await settle(inflight.page, inflight.control)
    await freshness(inflight.page, true)
    assert.deepEqual((await stored(inflight.page)).assignments, fixture.assignments)
    assert.equal((await stored(inflight.page)).month, '2026-11')
    await monthStatus(inflight.page, 'empty')
    assert.deepEqual((await stored(inflight.page)).provenance.invalidatedSchedules, inflightState.provenance.invalidatedSchedules)
    await moveMonth(inflight.page, -1, '2026-10', 'invalid')
    record('a real month change during generation rejects the old successful response and preserves the new current state')
    await inflight.page.close()

    for (const mode of ['success', 'failure']) {
      const state = clone(fixture)
      if (mode === 'failure') state.shifts[0].required = 3
      const { page: web } = await prepare(false, state)
      await start(web); await complete(web)
      assert.equal(await web.evaluate(() => window.__freshnessWorkerCount), 1)
      if (mode === 'success') {
        await freshness(web, false, /排班已生成/)
        await monthStatus(web, 'scheduled')
        await savedGenerated(web)
        await freshness(web, false, /排班已生成/)
        await screenshot(web, 'real-worker-success-fresh')
        await web.getByRole('button', { name: '已核对变更', exact: true }).click()
        await web.waitForFunction(() => !JSON.parse(localStorage.getItem('shift-planner:v1')).provenance.pendingExternalChange)
        await freshness(web, false, /排班已生成/)
        await changeRule(web, 12)
      } else {
        await freshness(web, false, /暂未找到.*原排班未改变/)
        assert.deepEqual((await stored(web)).assignments, fixture.assignments)
        await screenshot(web, 'real-worker-failure-fresh')
        await changeMember(web, '失败后手动修改的成员')
      }
      await freshness(web, true)
      await monthStatus(web, 'invalid')
      record(`real web Worker ${mode} stays fresh until an actual saved configuration change`)
      await web.close()
    }
    assert.deepEqual(report.errors, [])
    report.ok = true
    record('all result-freshness scenarios complete without browser errors')
  } catch (error) {
    report.failure = error.stack || String(error)
    await activePage?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
