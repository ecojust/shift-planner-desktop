/* Real Chromium row reordering with mouse, keyboard and touch input. Controlled
 * Tauri events expose the real application revision and hold generation pending;
 * no native transport or solver correctness is claimed by this interaction suite. */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const { selectGlobalMonth, assertCurrentMonthStatus } = require('./helpers/month-picker.cjs')
const url = process.env.EMPLOYEE_ORDER_TEST_URL || 'http://127.0.0.1:5194/'
const out = path.resolve(__dirname, '../../test-results/employee-order')
const report = { url, scope: 'Real Vue employee ordering with mouse, keyboard and simulated touch; controlled native IPC for revisions and pending generation', checks: [], errors: [], screenshots: [], ok: false }
const clone = value => JSON.parse(JSON.stringify(value))
const ids = ['order-a', 'order-b', 'order-c', 'order-d', 'order-e']
const names = ['排序甲', '排序乙', '排序丙', '排序丁', '排序戊']
const fixture = {
  version: 1, teamName: '人员顺序验收', month: '2026-10', calendar: { '2026-10-03': 'workday' },
  payroll: { monthlySalary: 6000, monthlyWorkdays: 21.75, hoursPerDay: 8, statutoryMultiplier: 3, restdayMultiplier: 2, ordinaryMultiplier: 1.5, restdayCompensated: false, employeeSalaries: {}, dateShiftMultipliers: {} },
  employees: ids.map((id, i) => ({ id, name: names[i], role: i % 2 ? '后勤' : '值班员', group: i % 2 ? '乙组' : '甲组', color: '#d7e8f8', minHoursPerWeek: 0, maxHoursPerWeek: 56, eligibleShiftIds: ['day'], unavailableDates: i === 4 ? ['2026-10-05'] : [] })),
  shifts: [{ id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 1, staffingMode: 'minimum', normalAllowance: 20 }],
  rules: { minRestHours: 11, maxConsecutiveDays: 7 },
  assignments: [
    { employeeId: 'order-a', date: '2026-10-01', shiftId: 'day', locked: true },
    { employeeId: 'order-c', date: '2026-10-02', shiftId: 'off', locked: false },
    { employeeId: 'order-e', date: '2026-11-01', shiftId: 'off', locked: true },
  ],
  provenance: {
    fields: { 'employees.order-a.name': { source: 'mcp', at: '2026-10-13T08:30:00.000Z' }, 'rules.minRestHours': { source: 'manual', at: '2026-10-14T09:00:00.000Z' } },
    pendingExternalChange: { source: 'mcp', at: '2026-10-13T08:30:00.000Z', categories: ['成员'] },
    scheduleUpdates: { '2026-10': { source: 'http', at: '2026-10-12T07:00:00.000Z' } },
    invalidatedSchedules: { '2026-10': { source: 'mcp', at: '2026-10-13T08:30:00.000Z' } },
  },
}
let browser, activePage, nextRequest = 0
function record(name, detail) { report.checks.push({ name, detail }); console.log('PASS', name) }
async function screenshot(page, name) { const file = path.join(out, `${name}.png`); await page.screenshot({ path: file, animations: 'disabled' }); report.screenshots.push(file) }
async function stored(page) { return page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1'))) }
function withoutOrder(state) { const value = clone(state); value.employees.sort((a, b) => a.id.localeCompare(b.id)); return value }
function onlyOrderChanged(before, after, expected) {
  assert.deepEqual(after.employees.map(item => item.id), expected)
  assert.deepEqual(withoutOrder(after), withoutOrder(before), 'Reordering may change only the employee array order, including all provenance and month validity')
}
async function prepare(options = {}, initial = fixture) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', ...options })
  activePage = page
  page.on('pageerror', error => report.errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })
  const control = { requests: [], pending: [] }
  await page.exposeFunction('qaOrderSolve', request => {
    control.requests.push(request)
    return new Promise((resolve, reject) => control.pending.push({ request, resolve, reject }))
  })
  await page.addInitScript(state => {
    if (!localStorage.getItem('shift-planner:v1')) localStorage.setItem('shift-planner:v1', JSON.stringify(state))
    localStorage.setItem('shift-planner:integration-permissions:v1', JSON.stringify({ members: true, shifts: false, rules: false, assignments: true }))
    window.isTauri = true
    const callbacks = new Map(), listeners = new Map()
    let callbackId = 0, listenerId = 0
    const bridge = window.__orderBridge = { requests: {}, responses: {}, failSave: false, writes: 0 }
    const originalSet = Storage.prototype.setItem
    Storage.prototype.setItem = function(key, value) {
      if (key === 'shift-planner:v1') {
        if (bridge.failSave) throw new DOMException('controlled employee order storage failure', 'QuotaExceededError')
        bridge.writes++
      }
      return originalSet.call(this, key, value)
    }
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback) { callbacks.set(++callbackId, callback); return callbackId },
      unregisterCallback(id) { callbacks.delete(id) },
      async invoke(command, args = {}) {
        if (command === 'plugin:event|listen') { const id = ++listenerId; listeners.set(args.event, { id, handler: args.handler }); return id }
        if (command === 'plugin:event|unlisten') return null
        if (command === 'solver_info') return { engine: 'ortools-cp-sat', protocolVersion: 1, version: 'controlled-employee-order', local: true }
        if (command === 'solve_schedule') return window.qaOrderSolve(args.request)
        if (command === 'cancel_solve') return true
        if (command === 'integration_status') return { enabled: true, url: `http://127.0.0.1:${args.service === 'mcp' ? 4318 : 4319}`, token: `order-${args.service}-token`, serviceId: `order-${args.service}-service` }
        if (command === 'integration_claim_request') return null
        if (command === 'integration_respond') { bridge.responses[args.requestId] = args.response; return null }
        throw new Error(`Unexpected employee order IPC ${command}`)
      },
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(event, id) { if (listeners.get(event)?.id === id) listeners.delete(event) } }
    window.__orderEmit = payload => {
      bridge.requests[payload.requestId] = payload
      const listener = listeners.get('integration-request'), callback = callbacks.get(listener?.handler)
      if (!callback) throw new Error('Integration request listener missing')
      callback({ event: 'integration-request', id: listener.id, payload })
    }
  }, initial)
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '排班日历', exact: true }).waitFor()
  return { page, control }
}
async function send(page, method, args = {}, source = 'mcp') {
  const requestId = `order-request-${++nextRequest}`
  await page.evaluate(payload => window.__orderEmit(payload), { requestId, serviceId: `order-${source}-service`, source, method, args, expiresAt: Date.now() + 60000 })
  return requestId
}
async function response(page, requestId) {
  await page.waitForFunction(id => Object.hasOwn(window.__orderBridge.responses, id), requestId)
  return page.evaluate(id => window.__orderBridge.responses[id], requestId)
}
async function snapshot(page) { const reply = await response(page, await send(page, 'get_state')); assert.ok(reply.result, JSON.stringify(reply)); return reply.result }
const rows = page => page.locator('.sp-schedule-table tbody tr[data-employee-id]')
const handle = (page, id) => page.locator(`button[data-drag-employee-id="${id}"]`)
async function visibleOrder(page) { return rows(page).evaluateAll(nodes => nodes.map(node => node.dataset.employeeId)) }
async function expectedOrder(page, expected) {
  await page.waitForFunction(expected => JSON.stringify(JSON.parse(localStorage.getItem('shift-planner:v1')).employees.map(item => item.id)) === JSON.stringify(expected), expected)
  assert.deepEqual(await visibleOrder(page), expected)
}
async function navigate(page, name) {
  const mobile = page.getByRole('button', { name: '打开导航', exact: true })
  if (await mobile.isVisible()) await mobile.click()
  await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name, exact: true }).click()
  await page.getByRole('heading', { name, exact: true }).waitFor()
}
async function selectMonth(page, month) {
  await selectGlobalMonth(page, month)
  await page.waitForFunction(month => JSON.parse(localStorage.getItem('shift-planner:v1')).month === month, month)
}
async function beginMouse(page, from) {
  await handle(page, from).scrollIntoViewIfNeeded()
  const box = await handle(page, from).boundingBox(); assert.ok(box)
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 1, point.y + 8, { steps: 3 })
  return point
}
async function moveMouse(page, to, edge = 'after') {
  const box = await rows(page).filter({ has: handle(page, to) }).boundingBox(); assert.ok(box)
  const grip = await handle(page, to).boundingBox(); assert.ok(grip)
  await page.mouse.move(grip.x + grip.width / 2, box.y + box.height * (edge === 'before' ? .2 : .8), { steps: 12 })
}
async function drag(page, from, to, edge = 'after') {
  // Solver feedback may make the fifth row fall just below the viewport. Bring
  // the whole destination into view before starting a real pointer gesture.
  await rows(page).filter({ has: handle(page, to) }).evaluate(node => {
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const bounds = node.getBoundingClientRect()
    if (bounds.bottom > window.innerHeight - 90) window.scrollBy(0, bounds.bottom - window.innerHeight + 90)
  })
  await beginMouse(page, from); await moveMouse(page, to, edge); await page.mouse.up()
}
async function group(page, value) {
  await page.getByRole('combobox', { name: '按工作组筛选', exact: true }).click()
  await page.getByRole('option', { name: value || '全部工作组', exact: true }).click()
}
function validResult(request) {
  const assignments = clone(request.state.assignments.filter(item => item.locked || !item.date.startsWith(`${request.state.month}-`)))
  const [year, month] = request.state.month.split('-').map(Number)
  for (let day = 1; day <= new Date(Date.UTC(year, month, 0)).getUTCDate(); day++) {
    const date = `${request.state.month}-${String(day).padStart(2, '0')}`
    if (!assignments.some(item => item.date === date && item.shiftId === 'day')) assignments.push({ employeeId: ids[day % 4], date, shiftId: 'day', locked: false })
  }
  return { protocolVersion: 1, requestId: request.requestId, engine: 'ortools-cp-sat', status: 'OPTIMAL', assignments, issues: [], stats: { wallTimeSeconds: .01, shortageCount: 0, optimal: true }, message: 'controlled complete order fixture' }
}
async function main() {
  await fs.mkdir(out, { recursive: true })
  await fs.rm(path.join(out, 'failure.png'), { force: true })
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  try {
    const { page, control } = await prepare()
    const initial = await snapshot(page)
    assert.deepEqual(await visibleOrder(page), ids)
    for (let i = 0; i < ids.length; i++) assert.equal(await handle(page, ids[i]).getAttribute('aria-label'), `调整${names[i]}的显示顺序`)
    await assertCurrentMonthStatus(page, 'invalid')

    await drag(page, 'order-a', 'order-e')
    const moved = ['order-b', 'order-c', 'order-d', 'order-e', 'order-a']
    await expectedOrder(page, moved)
    onlyOrderChanged(initial.state, await stored(page), moved)
    assert.notEqual((await snapshot(page)).revision, initial.revision, 'A saved order advances revision for in-flight work')
    await assertCurrentMonthStatus(page, 'invalid')
    await screenshot(page, '01-mouse-first-to-last')
    await drag(page, 'order-a', 'order-b', 'before')
    await expectedOrder(page, ids)
    onlyOrderChanged(initial.state, await stored(page), ids)
    record('real mouse moves first to last and last to first with persistent employee order while all assignments, configuration and provenance remain exact')

    await page.waitForTimeout(400) // Exclude the previous successful reorder's scheduled autosave from no-op write counts.
    const beforeNoop = await snapshot(page)
    const writes = await page.evaluate(() => window.__orderBridge.writes)
    await handle(page, 'order-a').click()
    await handle(page, 'order-a').press('Space')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await handle(page, 'order-e').press('Space')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Space')
    await drag(page, 'order-c', 'order-c')
    assert.deepEqual(await snapshot(page), beforeNoop)
    assert.equal(await page.evaluate(() => window.__orderBridge.writes), writes, 'Click, identical drop and boundary keyboard moves do not write')
    record('clicking without dragging, same-position drops and keyboard attempts beyond first or last are genuine no-ops')

    await handle(page, 'order-a').press('Space')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    assert.deepEqual((await stored(page)).employees.map(item => item.id), ids, 'Keyboard preview is not persisted before confirmation')
    await page.keyboard.press('Enter')
    const keyboardOrder = ['order-b', 'order-c', 'order-a', 'order-d', 'order-e']
    await expectedOrder(page, keyboardOrder)
    onlyOrderChanged(initial.state, await stored(page), keyboardOrder)
    assert.equal(await handle(page, 'order-a').evaluate(node => node === document.activeElement), true, 'Keyboard keeps focus on the reordered member')
    await screenshot(page, '02-keyboard-confirmed')
    record('Space and arrow keys preview without saving, Enter commits once and focus follows the same member')

    const beforeCancel = await snapshot(page)
    await handle(page, 'order-b').press('Space')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await beginMouse(page, 'order-b')
    await moveMouse(page, 'order-e')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    assert.deepEqual(await snapshot(page), beforeCancel)
    assert.deepEqual(await visibleOrder(page), keyboardOrder)
    record('Escape cancels both keyboard preview and an actual mouse drag without data or revision changes')

    await navigate(page, '成员管理')
    assert.deepEqual(await page.locator('.sp-settings-employee-card').evaluateAll(nodes => nodes.map(node => node.id.replace(/^member-/, ''))), keyboardOrder)
    await screenshot(page, '03-member-management-shares-order')
    await navigate(page, '排班日历')
    await page.getByRole('button', { name: '月视图', exact: true }).click()
    assert.deepEqual(await visibleOrder(page), keyboardOrder)
    await selectMonth(page, '2026-11')
    assert.deepEqual(await visibleOrder(page), keyboardOrder)
    await assertCurrentMonthStatus(page, 'scheduled')
    await page.getByRole('button', { name: '周视图', exact: true }).click()
    await page.reload({ waitUntil: 'networkidle' })
    await expectedOrder(page, keyboardOrder)
    await selectMonth(page, '2026-10')
    await assertCurrentMonthStatus(page, 'invalid')
    onlyOrderChanged(initial.state, await stored(page), keyboardOrder)
    record('member management, month and week views, another month and a reload all share the saved order without changing month validity')

    const beforeFiltered = await stored(page)
    await group(page, '甲组')
    assert.deepEqual(await visibleOrder(page), ['order-c', 'order-a', 'order-e'])
    await drag(page, 'order-e', 'order-c', 'before')
    const filteredOrder = ['order-b', 'order-e', 'order-c', 'order-d', 'order-a']
    await page.waitForFunction(expected => JSON.stringify(JSON.parse(localStorage.getItem('shift-planner:v1')).employees.map(item => item.id)) === JSON.stringify(expected), filteredOrder)
    assert.deepEqual(await visibleOrder(page), ['order-e', 'order-c', 'order-a'])
    onlyOrderChanged(beforeFiltered, await stored(page), filteredOrder)
    assert.equal((await stored(page)).employees[0].id, 'order-b')
    assert.equal((await stored(page)).employees[3].id, 'order-d')
    await screenshot(page, '04-filtered-visible-slots')
    await group(page, '')
    await expectedOrder(page, filteredOrder)
    await page.getByRole('textbox', { name: '搜索成员', exact: true }).fill('值班员')
    await drag(page, 'order-a', 'order-e', 'before')
    await page.getByRole('textbox', { name: '搜索成员', exact: true }).fill('')
    const searchOrder = ['order-b', 'order-a', 'order-e', 'order-d', 'order-c']
    await expectedOrder(page, searchOrder)
    onlyOrderChanged(beforeFiltered, await stored(page), searchOrder)
    record('group and search filtering reorder only visible slots and preserve every hidden member at its original index')

    const beforeRace = await snapshot(page)
    await beginMouse(page, 'order-b')
    await moveMouse(page, 'order-c')
    const attempted = clone(beforeRace.state); attempted.employees[0].name = '不应写入的成员'
    const busyReply = await response(page, await send(page, 'replace_state', { revision: beforeRace.revision, state: attempted }))
    assert.equal(busyReply.error?.status, 409, JSON.stringify(busyReply))
    await page.evaluate(() => { const input = document.querySelector('input[aria-label="搜索成员"]'); input.value = '值班员'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    await page.mouse.up()
    await page.getByRole('textbox', { name: '搜索成员', exact: true }).fill('')
    assert.deepEqual(await snapshot(page), beforeRace)
    await expectedOrder(page, searchOrder)
    record('an active drag rejects external writes and a filter change cancels the pending drop without overwriting any member')

    await beginMouse(page, 'order-b')
    await moveMouse(page, 'order-c')
    await page.getByRole('button', { name: '下个月', exact: true }).evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await page.mouse.up()
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('shift-planner:v1')).month === '2026-11')
    assert.deepEqual((await stored(page)).employees.map(item => item.id), searchOrder)
    assert.notEqual((await snapshot(page)).revision, beforeRace.revision)
    await selectMonth(page, '2026-10')
    onlyOrderChanged(beforeRace.state, await stored(page), searchOrder)
    record('a month and revision change during an actual drag rejects the stale drop instead of replaying its old order')

    const requestSnapshot = await snapshot(page)
    const requestId = await send(page, 'generate_schedule', { revision: requestSnapshot.revision, timeLimitSeconds: 1 })
    await page.locator('.sp-solve-progress').waitFor()
    for (const id of ids) assert.equal(await handle(page, id).isDisabled(), true)
    await handle(page, 'order-b').evaluate(node => { node.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); node.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, bubbles: true })) })
    assert.deepEqual(await stored(page), requestSnapshot.state)
    await page.waitForFunction(() => document.querySelector('.sp-solve-progress'))
    for (let i = 0; !control.pending.length && i < 100; i++) await page.waitForTimeout(20)
    assert.equal(control.pending.length, 1)
    const pending = control.pending.shift(); pending.resolve(validResult(pending.request))
    const generated = await response(page, requestId)
    assert.ok(generated.result, JSON.stringify(generated))
    await page.locator('.sp-solve-progress').waitFor({ state: 'detached' })
    await assertCurrentMonthStatus(page, 'scheduled')
    const successBefore = await stored(page)
    await drag(page, 'order-b', 'order-c')
    const afterSuccessOrder = ['order-a', 'order-e', 'order-d', 'order-c', 'order-b']
    await expectedOrder(page, afterSuccessOrder)
    onlyOrderChanged(successBefore, await stored(page), afterSuccessOrder)
    await assertCurrentMonthStatus(page, 'scheduled')
    assert.equal(await page.locator('.sp-diagnostic-stale').count(), 0)
    assert.doesNotMatch(await page.locator('.sp-solve-result').innerText(), /配置已更改|设置已更改/)
    await screenshot(page, '05-reorder-after-success-stays-current')
    record('MCP generation disables reorder handles, then a successful result remains current and preserves its source and timestamp after a real drag')

    await page.waitForTimeout(400) // Drain the preceding successful change's autosave before injecting a new write failure.
    const beforeFailure = await snapshot(page)
    await page.evaluate(() => { window.__orderBridge.failSave = true })
    await drag(page, 'order-a', 'order-b')
    await page.waitForTimeout(100)
    assert.deepEqual(await stored(page), beforeFailure.state)
    assert.deepEqual(await visibleOrder(page), afterSuccessOrder)
    assert.deepEqual(await snapshot(page), beforeFailure)
    assert.match(await page.locator('body').innerText(), /保存.*失败|未能保存|顺序.*保存/)
    await page.evaluate(() => { window.__orderBridge.failSave = false })
    await screenshot(page, '06-save-failure-is-atomic')
    record('a local storage write failure preserves original visible order, stored document, revision and all metadata atomically')

    const touch = (await prepare({ viewport: { width: 320, height: 1000 }, isMobile: true, hasTouch: true })).page
    const touchBefore = await snapshot(touch)
    await rows(touch).filter({ has: handle(touch, 'order-c') }).evaluate(node => {
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const bounds = node.getBoundingClientRect()
      if (bounds.bottom > window.innerHeight - 100) window.scrollBy(0, bounds.bottom - window.innerHeight + 100)
    })
    await handle(touch, 'order-a').scrollIntoViewIfNeeded()
    const startBox = await handle(touch, 'order-a').boundingBox()
    const endBox = await rows(touch).filter({ has: handle(touch, 'order-c') }).boundingBox()
    assert.ok(startBox && endBox)
    const x = startBox.x + startBox.width / 2, y = startBox.y + startBox.height / 2
    const targetY = endBox.y + endBox.height * .8
    const cdp = await touch.context().newCDPSession(touch)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await touch.waitForTimeout(30)
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (targetY - y) * step / 8 }] })
      await touch.waitForTimeout(30)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    const touchOrder = ['order-b', 'order-c', 'order-a', 'order-d', 'order-e']
    await expectedOrder(touch, touchOrder)
    onlyOrderChanged(touchBefore.state, await stored(touch), touchOrder)
    assert.ok(await touch.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '320px page should scroll the table internally')
    const handleSize = await handle(touch, 'order-a').boundingBox()
    assert.ok(handleSize.width >= 24 && handleSize.height >= 24)
    await screenshot(touch, '07-touch-order-320')
    await cdp.detach()
    record('real browser touch pointer events reorder at 320px without altering hidden calendar data or overflowing the page')

    const longFixture = clone(fixture)
    for (let index = 6; index <= 20; index++) longFixture.employees.push({ ...clone(fixture.employees[0]), id: `order-${index}`, name: `长名单成员${index}` })
    const long = (await prepare({}, longFixture)).page
    const longBefore = await snapshot(long)
    const initialScroll = await long.evaluate(() => window.scrollY)
    const startPoint = await beginMouse(long, 'order-a')
    await long.mouse.move(startPoint.x, 995, { steps: 12 })
    await long.waitForFunction(before => window.scrollY > before + 200, initialScroll)
    await long.waitForFunction(() => document.querySelector('tr[data-employee-id="order-20"]').getBoundingClientRect().bottom < window.innerHeight - 70)
    // Leave the scrolling edge before measuring the moving destination again,
    // as a user does when bringing the pointer onto the newly revealed row.
    await long.mouse.move(startPoint.x, 700, { steps: 3 })
    await long.waitForTimeout(50)
    const finalScroll = await long.evaluate(() => window.scrollY)
    await moveMouse(long, 'order-20')
    await long.mouse.up()
    const longOrder = [...longFixture.employees.slice(1).map(item => item.id), 'order-a']
    await expectedOrder(long, longOrder)
    onlyOrderChanged(longBefore.state, await stored(long), longOrder)
    await screenshot(long, '08-long-list-pointer-autoscroll')
    record('holding an actual mouse drag at the viewport bottom scrolls a 20-member list and saves a first-to-last move', { initialScroll, finalScroll })

    assert.deepEqual(report.errors, [])
    record('all employee reorder scenarios finish without browser errors')
    report.ok = true
  } catch (error) {
    report.failure = error.stack || String(error)
    if (activePage && !activePage.isClosed()) await screenshot(activePage, 'failure').catch(() => {})
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
