/* Real Vue regression for result freshness. Desktop results use deterministic,
 * valid payloads through controlled Tauri IPC and the app's independent validator;
 * browser cases execute the actual Worker. No native solver/packaging claims. */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const url = process.env.GENERATION_FRESHNESS_TEST_URL || 'http://127.0.0.1:5190/'
const out = path.resolve(__dirname, '../../test-results/generation-freshness')
const fixture = {
  version: 1, teamName: '排班结果时效验收', month: '2026-10',
  employees: ['甲', '乙'].map((name, index) => ({ id: `qa-${index + 1}`, name: `测试成员${name}`, role: '服务员', group: '测试', color: '#d7e8f8', minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 56, eligibleShiftIds: ['day'], unavailableDates: [] })),
  shifts: [{ id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 1, staffingMode: 'fixed', normalAllowance: 0 }],
  rules: { minRestHours: 11, maxConsecutiveDays: 5 },
  assignments: [{ employeeId: 'qa-1', date: '2026-10-01', shiftId: 'day', locked: true }, { employeeId: 'qa-2', date: '2026-09-30', shiftId: 'off', locked: false }],
  provenance: {
    fields: { 'employees.qa-1.name': { source: 'mcp', at: '2026-10-13T08:30:00.000Z' } },
    pendingExternalChange: { source: 'mcp', at: '2026-10-13T08:30:00.000Z', categories: ['成员'] },
  },
}
const clone = value => JSON.parse(JSON.stringify(value))
const report = { url, scope: 'Real Vue, controlled valid desktop solver responses and real web Worker; no native transport', checks: [], errors: [], screenshots: [], ok: false }
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
    if (command === 'integration_status') return { enabled: false, url: '', token: '', serviceId: '' }
    if (command === 'solve_schedule') {
      control.requests.push(args.request)
      return new Promise((resolve, reject) => control.pending.push({ request: args.request, resolve, reject }))
    }
    throw new Error(`Unexpected controlled IPC command: ${command}`)
  })
  await page.addInitScript(({ state, desktop }) => {
    localStorage.setItem('shift-planner:v1', JSON.stringify(state))
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
  for (let day = 1; day <= 31; day++) {
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
    await start(page, control); await settle(page, control)
    await freshness(page, false, /排班已生成/)
    const generated = await savedGenerated(page)
    await freshness(page, false, /排班已生成/)
    assert.equal(await page.locator('.sp-solve-result').evaluate(node => node.classList.contains('is-warning')), false)
    assert.deepEqual(generated.provenance, fixture.provenance)
    await screenshot(page, 'desktop-success-fresh')
    record('desktop successful roster commit stays fresh immediately and after autosave, preserving locked/history entries and provenance')

    await page.getByRole('button', { name: '已核对变更', exact: true }).click()
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('shift-planner:v1')).provenance.pendingExternalChange)
    await freshness(page, false, /排班已生成/)
    record('acknowledging source metadata after success does not mark the result stale')

    await changeRule(page, 12, false)
    await freshness(page, false, /排班已生成/)
    assert.equal((await stored(page)).rules.minRestHours, 11)
    record('an unsaved rule draft and navigation do not invalidate the successful result')
    await changeRule(page, 12)
    await freshness(page, true)
    await screenshot(page, 'desktop-rule-change-stale')
    record('saving a real rule change after successful generation marks the result stale')

    await start(page, control); await settle(page, control)
    await freshness(page, false, /排班已生成/)
    await changeMember(page, '手动改名后的成员')
    await freshness(page, true)
    record('regeneration clears prior staleness and a subsequent saved member change invalidates the new result')

    const beforeFailure = (await stored(page)).assignments
    await start(page, control); await settle(page, control, 'unknown')
    await freshness(page, false, /尚未找到可行方案/)
    assert.deepEqual((await stored(page)).assignments, beforeFailure)
    await changeRule(page, 13)
    await freshness(page, true)
    record('unchanged failed attempts remain fresh and preserve the roster; a later saved rule change marks their diagnostic stale')

    await start(page, control); await settle(page, control, 'transport')
    await freshness(page, false, /排班超过等待时长/)
    assert.deepEqual((await stored(page)).assignments, beforeFailure)
    record('transport failure preserves its current diagnostic and existing roster without a false stale warning')
    await page.close()

    const inflight = await prepare(true)
    await start(inflight.page, inflight.control)
    // Simulate a queued real UI event during asynchronous solving; the overlay
    // normally intercepts pointer input, but the revision guard must still hold.
    await inflight.page.getByRole('button', { name: '下个月', exact: true }).evaluate(node => node.click())
    await inflight.page.waitForFunction(() => JSON.parse(localStorage.getItem('shift-planner:v1')).month === '2026-11')
    await settle(inflight.page, inflight.control)
    await freshness(inflight.page, true)
    assert.deepEqual((await stored(inflight.page)).assignments, fixture.assignments)
    assert.equal((await stored(inflight.page)).month, '2026-11')
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
