/* Actual Vue integration generation, controlled Tauri events and lifecycle races.
 * Successful MCP/HTTP paths execute the real CP-SAT Python process; other paths
 * hold solver replies deliberately. This does not exercise native HTTP sockets.
 * EXTERNAL_GENERATION_TEST_URL + PLAYWRIGHT_MODULE_PATH + optional executable. */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const { assertCurrentMonthStatus, assertMonthChoiceStatus, openMonthPicker } = require('./helpers/month-picker.cjs')
const root = path.resolve(__dirname, '../..')
const out = path.join(root, 'test-results/external-generation')
const url = process.env.EXTERNAL_GENERATION_TEST_URL || 'http://127.0.0.1:5194/'
const clone = value => JSON.parse(JSON.stringify(value))
const stamp = { source: 'manual', at: '2026-10-15T08:00:00.000Z' }
const fixture = {
  version: 1, teamName: '外部真实排班验收', month: '2026-10', calendar: {},
  employees: ['甲', '乙'].map((name, i) => ({ id: `generation-${i + 1}`, name: `外部成员${name}`, role: '值班员', group: '测试', color: '#d7e8f8', minHoursPerWeek: 0, maxHoursPerWeek: 56, eligibleShiftIds: ['day'], unavailableDates: [] })),
  shifts: [{ id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 1, staffingMode: 'fixed', normalAllowance: 0 }],
  rules: { minRestHours: 11, maxConsecutiveDays: 5 },
  payroll: { monthlySalary: 6000, monthlyWorkdays: 21.75, hoursPerDay: 8, ordinaryMultiplier: 1.5, restdayMultiplier: 2, statutoryMultiplier: 3, restdayCompensated: false, dateShiftMultipliers: {}, employeeSalaries: {} },
  assignments: [
    { employeeId: 'generation-2', date: '2026-09-30', shiftId: 'off', locked: false },
    { employeeId: 'generation-1', date: '2026-10-01', shiftId: 'day', locked: true },
    { employeeId: 'generation-2', date: '2026-11-01', shiftId: 'day', locked: true },
  ],
  provenance: { fields: {}, invalidatedSchedules: { '2026-10': stamp, '2026-11': stamp } },
}
const report = { url, scope: 'Real Vue bridge with live hosted Python progress, two real CP-SAT subprocess solves, independent roster audit and controlled lifecycle races; no native transport', checks: [], errors: [], solverRuns: [], screenshots: [], ok: false }
const control = { mode: 'hold', requests: [], pending: new Map(), cancellations: [], cancelMode: 'reject' }
let browser, page, nextId = 0
function record(name, detail) { report.checks.push({ name, ...(detail ? { detail } : {}) }); console.log('PASS', name) }
async function shot(name) { const file = path.join(out, `${name}.png`); await page.screenshot({ path: file }); report.screenshots.push(file) }
async function realSolve(request) {
  const index = report.solverRuns.length + 1
  const prefix = path.join(out, `real-${index}-${request.state.month}`)
  const inputFile = `${prefix}-request.json`
  await fs.writeFile(inputFile, JSON.stringify(request, null, 2) + '\n')
  const source = await page.evaluate(id => window.__generationBridge.requests[id]?.source, request.requestId)
  assert.ok(['mcp', 'http'].includes(source))
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'solver/.venv/bin/python'), [path.join(root, 'solver/main.py'), '--hosted'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', buffered = '', exited = false, stream = Promise.resolve(), streamError = null, screenshot = null
    const progress = []
    function lineReceived(raw) {
      const line = raw.replace(/\r$/, '')
      const count = /^SHIFTFLOW_SOLUTIONS_V1:(\d+)$/.exec(line)
      const stage = /^SHIFTFLOW_STAGE_V1:(loading|reading|solving|finishing)$/.exec(line)
      const payload = count ? { requestId: request.requestId, phase: 'solving', solutionCount: Number(count[1]) }
        : stage ? { requestId: request.requestId, phase: stage[1] } : null
      if (!payload) return
      const observation = { ...payload, receivedAt: Date.now(), receivedBeforeExit: !exited, receivedBeforeResultOutput: stdout.length === 0 }
      progress.push(observation)
      // Drain stderr continuously and deliver real lines in order. The process
      // never waits for screenshots or browser messages to continue solving.
      stream = stream.then(async () => {
        if (streamError) return
        const displayed = await page.evaluate(async payload => {
          window.__generationEmit('solver-progress', payload)
          await Promise.resolve() // Allow Vue's scheduled DOM update.
          const count = document.querySelector('[data-solution-count]')
          return { count: count ? Number(count.textContent) : null, claimed: window.__generationBridge.claims.some(item => item.requestId === payload.requestId) }
        }, payload)
        observation.deliveredAt = Date.now()
        observation.deliveredBeforeExit = !exited
        observation.displayedCount = displayed.count
        assert.equal(displayed.claimed, false, 'Progress must be visible before claiming or saving the final result')
        if (count) {
          assert.ok(Number.isSafeInteger(payload.solutionCount) && payload.solutionCount > 0)
          assert.equal(displayed.count, payload.solutionCount, 'Vue displays each actual count from the live Python stream')
          if (!screenshot) {
            // Capture the first actual positive count without sleeping or
            // injecting a count. Later lines continue to reach the UI.
            screenshot = shot(`real-${source}-generation-progress`)
            screenshot.catch(error => { streamError ??= error })
          }
        }
      }).catch(error => { streamError ??= error })
    }
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Real CP-SAT browser fixture exceeded 90 seconds')) }, 90000)
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => {
      stderr += data; buffered += data
      const lines = buffered.split('\n'); buffered = lines.pop()
      for (const line of lines) lineReceived(line)
    })
    child.on('exit', () => { exited = true })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', async code => {
      clearTimeout(timeout)
      try {
        if (buffered) lineReceived(buffered)
        await stream
        await screenshot
        await fs.writeFile(`${prefix}-stderr.log`, stderr)
        await fs.writeFile(`${prefix}-progress.json`, JSON.stringify(progress, null, 2) + '\n')
        if (streamError) throw streamError
        assert.equal(code, 0, stderr)
        const result = JSON.parse(stdout)
        const counts = progress.filter(item => item.solutionCount !== undefined)
        assert.ok(counts.length > 0, `${source} emits real solution updates`)
        assert.ok(counts.some(item => item.receivedBeforeExit && item.receivedBeforeResultOutput), `${source} reports solutions before completing its process and result output`)
        assert.ok(counts.some(item => item.deliveredBeforeExit), `${source} updates the actual Vue display while the Python process is still running`)
        assert.ok(counts.every((item, i) => i === 0 || item.solutionCount > counts[i - 1].solutionCount), 'Real distinct solution counts strictly increase')
        assert.equal(counts.at(-1).solutionCount, result.stats.solutionCount)
        assert.equal(progress.at(-1).displayedCount, result.stats.solutionCount, 'The final displayed count agrees with the actual solver result')
        await fs.writeFile(`${prefix}-result.json`, JSON.stringify(result, null, 2) + '\n')
        report.solverRuns.push({ month: request.state.month, source, requestId: request.requestId, engine: result.engine, status: result.status, stats: result.stats, inputFile, progressFile: `${prefix}-progress.json`, stderrFile: `${prefix}-stderr.log`, liveCounts: counts })
        resolve(result)
      } catch (error) { reject(error) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}
function validResult(request) {
  const assignments = clone(request.state.assignments.filter(item => item.locked || !item.date.startsWith(`${request.state.month}-`)))
  const [year, month] = request.state.month.split('-').map(Number)
  for (let day = 1; day <= new Date(Date.UTC(year, month, 0)).getUTCDate(); day++) {
    const date = `${request.state.month}-${String(day).padStart(2, '0')}`
    if (!assignments.some(item => item.date === date && item.shiftId === 'day')) assignments.push({ employeeId: `generation-${day % 2 ? 1 : 2}`, date, shiftId: 'day', locked: false })
  }
  return { protocolVersion: 1, requestId: request.requestId, engine: 'ortools-cp-sat', status: 'OPTIMAL', assignments, issues: [], stats: { wallTimeSeconds: .01, shortageCount: 0, optimal: true }, message: 'controlled complete result' }
}
function settle(requestId, mode = 'success') {
  const item = control.pending.get(requestId)
  assert.ok(item, `Pending solver request ${requestId}`)
  control.pending.delete(requestId)
  const result = validResult(item.request)
  if (mode === 'infeasible') item.resolve({ ...result, status: 'INFEASIBLE', assignments: undefined, message: 'controlled infeasible constraints' })
  else if (mode === 'invalid') item.resolve({ ...result, assignments: [] })
  else item.resolve(result)
}
async function prepare() {
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  page.on('pageerror', error => report.errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })
  await page.exposeFunction('qaGenerationSolve', request => {
    control.requests.push(clone(request))
    if (control.mode === 'real') return realSolve(request)
    return new Promise((resolve, reject) => control.pending.set(request.requestId, { request, resolve, reject }))
  })
  await page.exposeFunction('qaGenerationCancel', requestId => {
    control.cancellations.push(requestId)
    const item = control.pending.get(requestId)
    if (item && control.cancelMode === 'reject') { control.pending.delete(requestId); item.reject(new Error('CANCELLED: controlled native cancellation')) }
    return true
  })
  await page.addInitScript(state => {
    localStorage.setItem('shift-planner:v1', JSON.stringify(state))
    window.isTauri = true
    const callbacks = new Map(), listeners = new Map()
    let callbackId = 0, listenerId = 0
    const empty = () => ({ starts: 0, info: { enabled: false, url: '', token: '', serviceId: '' } })
    const bridge = window.__generationBridge = { requests: {}, responses: {}, claims: [], calls: [], failClaim: false, failSave: false, services: { mcp: empty(), http: empty() } }
    const nativeSave = Storage.prototype.setItem
    Storage.prototype.setItem = function(key, value) {
      if (key === 'shift-planner:v1' && bridge.failSave) throw new DOMException('controlled storage failure', 'QuotaExceededError')
      return nativeSave.call(this, key, value)
    }
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback) { callbacks.set(++callbackId, callback); return callbackId },
      unregisterCallback(id) { callbacks.delete(id) },
      async invoke(command, args = {}) {
        bridge.calls.push({ command, args })
        if (command === 'plugin:event|listen') { const id = ++listenerId; listeners.set(args.event, { id, handler: args.handler }); return id }
        if (command === 'plugin:event|unlisten') return null
        if (command === 'solver_info') return { engine: 'ortools-cp-sat', protocolVersion: 1, version: 'real-python-browser-bridge', local: true }
        if (command === 'solve_schedule') return window.qaGenerationSolve(args.request)
        if (command === 'cancel_solve') return window.qaGenerationCancel(args.requestId)
        const service = bridge.services[args.service]
        if (!service) throw new Error(`Unexpected IPC ${command}`)
        if (command === 'integration_status') return { ...service.info }
        if (command === 'integration_start') {
          service.starts++
          service.info = { enabled: true, url: `http://127.0.0.1:${args.service === 'mcp' ? 4318 : 4319}`, token: `${args.service}-test-token-${service.starts}`, serviceId: `${args.service}-test-service-${service.starts}` }
          return { ...service.info }
        }
        if (command === 'integration_stop') { service.info = { enabled: false, url: '', token: '', serviceId: '' }; return { ...service.info } }
        if (command === 'integration_claim_request') {
          const request = bridge.requests[args.requestId]
          if (bridge.failClaim || !request || request.cancelled || request.source !== args.service || request.serviceId !== args.serviceId || service.info.serviceId !== args.serviceId || !service.info.enabled || request.expiresAt <= Date.now()) throw new Error('request is no longer awaiting a commit')
          bridge.claims.push({ ...args, persisted: JSON.parse(localStorage.getItem('shift-planner:v1')) })
          return null
        }
        if (command === 'integration_respond') {
          if (bridge.requests[args.requestId]?.source !== args.service) throw new Error('Response went to another service')
          bridge.responses[args.requestId] = { response: args.response, persisted: JSON.parse(localStorage.getItem('shift-planner:v1')) }
          return null
        }
        throw new Error(`Unexpected IPC ${command}`)
      },
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(event, id) { if (listeners.get(event)?.id === id) listeners.delete(event) } }
    window.__generationEmit = (event, payload) => {
      if (event === 'integration-request') bridge.requests[payload.requestId] = { ...payload }
      if (event === 'integration-cancelled') {
        const request = bridge.requests[payload.requestId]
        if (request?.source === payload.source && request.serviceId === payload.serviceId) request.cancelled = true
      }
      const listener = listeners.get(event), callback = callbacks.get(listener?.handler)
      if (!callback) throw new Error(`No listener for ${event}`)
      callback({ event, id: listener.id, payload })
    }
  }, fixture)
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '排班日历', exact: true }).waitFor()
  await settings(async dialog => { for (const source of ['MCP', 'HTTP']) await dialog.getByRole('switch', { name: source, exact: true }).click() })
}
async function settings(action, queued = false) {
  const trigger = page.getByRole('button', { name: '设置', exact: true })
  if (queued) await trigger.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  else await trigger.click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.waitFor()
  await action(dialog)
  if (await dialog.count()) { await dialog.getByRole('button', { name: '关闭设置', exact: true }).click({ force: queued }); await dialog.waitFor({ state: 'detached' }) }
}
async function permission(value, queued = false) {
  await settings(dialog => dialog.getByRole('checkbox', { name: '允许修改排班结果', exact: true }).setChecked(value, { force: queued }), queued)
}
async function stored() { return page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1'))) }
async function send(method, args = {}, { source = 'mcp', expiresIn = 90000, serviceId } = {}) {
  const requestId = `external-generation-${++nextId}`
  await page.evaluate(({ method, args, source, expiresIn, serviceId, requestId }) => {
    window.__generationEmit('integration-request', { method, args, source, requestId, serviceId: serviceId ?? window.__generationBridge.services[source].info.serviceId, expiresAt: Date.now() + expiresIn })
  }, { method, args, source, expiresIn, serviceId, requestId })
  return requestId
}
async function response(id) {
  await page.waitForFunction(id => !!window.__generationBridge.responses[id], id, { timeout: 100000 })
  return page.evaluate(id => window.__generationBridge.responses[id], id)
}
async function request(method, args, options) { return response(await send(method, args, options)) }
async function snapshot() { const result = await request('get_state'); assert.ok(result.response.result); return result.response.result }
async function begin(args = {}, options = {}) {
  const id = await send('generate_schedule', { revision: (await snapshot()).revision, ...args }, options)
  const deadline = Date.now() + 10000
  while (!control.pending.has(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(control.pending.has(id), 'Generation must reach the controlled native solver')
  await page.locator('.sp-solve-progress').waitFor()
  return id
}
async function released() {
  await page.locator('.sp-solve-progress').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '自动排班', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '自动排班', exact: true }).isEnabled(), true)
}
async function unchangedAfter(id, before, status) {
  const value = await response(id)
  if (status) assert.equal(value.response.error?.status, status, JSON.stringify(value.response))
  else { assert.equal(value.response.result?.success, false, JSON.stringify(value.response)); assert.equal(value.response.result.saved, false) }
  assert.deepEqual(value.persisted, before, 'No candidate or provenance stamp may reach storage')
  assert.deepEqual((await snapshot()).state, before, 'No candidate may replace the live state')
  await released()
  return value
}
function auditMonth(before, after, month) {
  assert.equal(after.month, before.month, 'External target month must not navigate the UI')
  assert.deepEqual(after.assignments.filter(a => !a.date.startsWith(`${month}-`)), before.assignments.filter(a => !a.date.startsWith(`${month}-`)))
  for (const locked of before.assignments.filter(a => a.locked)) assert.deepEqual(after.assignments.find(a => a.employeeId === locked.employeeId && a.date === locked.date), locked)
  const allKeys = after.assignments.map(a => `${a.employeeId}:${a.date}`)
  assert.equal(new Set(allKeys).size, allKeys.length)
  const [year, number] = month.split('-').map(Number), days = new Date(Date.UTC(year, number, 0)).getUTCDate()
  for (let day = 1; day <= days; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`
    const work = after.assignments.filter(a => a.date === date && a.shiftId !== 'off')
    assert.equal(work.length, 1, `${date} exact daily coverage`)
    assert.equal(work[0].shiftId, 'day')
    const employee = after.employees.find(e => e.id === work[0].employeeId)
    assert.ok(employee && employee.eligibleShiftIds.includes('day') && !employee.unavailableDates.includes(date))
  }
  for (const employee of after.employees) {
    const dates = after.assignments.filter(a => a.employeeId === employee.id && a.shiftId === 'day').map(a => a.date).sort()
    let prior = -Infinity, streak = 0
    const weekHours = new Map()
    for (const date of dates) {
      const time = Date.parse(`${date}T08:00:00Z`)
      assert.ok(time - prior >= 19 * 3600000, 'Eight-hour shifts require at least eleven hours rest')
      streak = time - prior === 86400000 ? streak + 1 : 1
      assert.ok(streak <= 5)
      prior = time
      const day = Date.parse(`${date}T00:00:00Z`), monday = day - ((new Date(day).getUTCDay() + 6) % 7) * 86400000
      weekHours.set(monday, (weekHours.get(monday) || 0) + 8)
    }
    for (const hours of weekHours.values()) assert.ok(hours <= 56, 'Whole-week hours include preserved neighboring months')
  }
}
async function main() {
  await fs.mkdir(out, { recursive: true })
  await fs.rm(path.join(out, 'failure.png'), { force: true })
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  try {
    await prepare()
    await assertCurrentMonthStatus(page, 'invalid')
    const initial = await snapshot()
    const denied = await request('generate_schedule', { revision: initial.revision })
    assert.equal(denied.response.error?.status, 403)
    assert.equal(control.requests.length, 0)
    assert.deepEqual(denied.persisted, initial.state)
    await permission(true)
    for (const args of [{ revision: 'stale' }, { month: '1899-12' }, { timeLimitSeconds: 0 }, { allowPartial: true }]) {
      const invalid = await request('generate_schedule', { revision: (await snapshot()).revision, ...args })
      assert.equal(invalid.response.error?.status, args.revision ? 409 : 400)
    }
    assert.equal(control.requests.length, 0)
    record('default permission and invalid or stale arguments reject before any native solver starts')

    control.mode = 'real'
    for (const [source, month, limit] of [['mcp', '2026-10', undefined], ['http', '2026-11', 3]]) {
      const before = (await snapshot()).state
      const args = { revision: (await snapshot()).revision, ...(limit ? { month, timeLimitSeconds: limit } : {}) }
      const id = await send('generate_schedule', args, { source })
      const note = page.getByRole('note', { name: '外部排班生成任务', exact: true })
      await note.waitFor()
      assert.match(await note.innerText(), new RegExp(`${source.toUpperCase()}.*${month}`))
      if (source === 'http') assert.match(await note.innerText(), /当前查看月份保持不变/)
      const result = await response(id), outcome = result.response.result
      assert.ok(outcome?.success && outcome.saved, JSON.stringify(result.response))
      assert.equal(outcome.month, month)
      assert.equal(control.requests.at(-1).options.timeLimitSeconds, limit ?? 15)
      assert.equal(control.requests.at(-1).options.allowPartial, false)
      auditMonth(before, outcome.state, month)
      assert.deepEqual(result.persisted, outcome.state, 'Persist before acknowledging success')
      assert.deepEqual(outcome.state.provenance.scheduleUpdates[month], { source, at: outcome.generatedAt })
      assert.equal(outcome.state.provenance.invalidatedSchedules?.[month], undefined)
      if (source === 'mcp') assert.deepEqual(outcome.state.provenance.invalidatedSchedules['2026-11'], stamp)
      assert.equal((await page.evaluate(() => window.__generationBridge.claims)).at(-1).requestId, id)
      await released()
      await assertCurrentMonthStatus(page, 'scheduled')
      const picker = await openMonthPicker(page, month)
      await assertMonthChoiceStatus(picker, '2026-10', 'scheduled')
      await assertMonthChoiceStatus(picker, '2026-11', source === 'mcp' ? 'invalid' : 'scheduled')
      await assertMonthChoiceStatus(picker, '2026-12', 'empty')
      await page.keyboard.press('Escape')
      await shot(`real-${source}-generation-saved`)
      record(`${source} displays live hosted-Python solution counts before process exit and agrees with final stats`, { solutionCount: report.solverRuns.at(-1).stats.solutionCount, progressFile: report.solverRuns.at(-1).progressFile })
      record(`${source} runs real CP-SAT, validates complete coverage and locks/history, saves source/time and preserves the viewed month`, { targetMonth: month, status: outcome.status })
    }
    assert.equal(report.solverRuns.length, 2)
    control.mode = 'hold'

    let before = (await snapshot()).state
    let id = await begin()
    assert.equal(await page.getByRole('button', { name: '正在排班…', exact: true }).isDisabled(), true)
    for (const source of ['mcp', 'http']) {
      const busy = await request('generate_schedule', { revision: (await snapshot()).revision }, { source })
      assert.equal(busy.response.error?.status, 409)
    }
    const busyWrite = await request('set_assignment', { revision: (await snapshot()).revision, employeeId: 'generation-1', date: '2026-10-02', shiftId: 'off' })
    assert.equal(busyWrite.response.error?.status, 409)
    assert.equal(control.pending.size, 1)
    settle(id, 'infeasible'); await unchangedAfter(id, before)
    await page.getByRole('button', { name: '自动排班', exact: true }).click()
    await page.getByRole('button', { name: '开始生成', exact: true }).click()
    await page.locator('.sp-solve-progress').waitFor()
    const manualId = control.requests.at(-1).requestId
    const manualBusy = await request('generate_schedule', { revision: (await snapshot()).revision }, { source: 'http' })
    assert.equal(manualBusy.response.error?.status, 409)
    settle(manualId, 'infeasible'); await released()
    assert.deepEqual((await snapshot()).state, before)
    record('MCP, HTTP and manual generation share one lock; concurrent writes reject and infeasible outcomes preserve the complete document')

    id = await begin(); settle(id, 'invalid'); await unchangedAfter(id, before)
    record('an apparently successful native result that omits locked assignments fails independent validation without saving')

    id = await begin()
    for (const [label, month] of [['下个月', '2026-11'], ['上个月', '2026-10']]) {
      await page.getByRole('button', { name: label, exact: true }).evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      await page.waitForFunction(month => JSON.parse(localStorage.getItem('shift-planner:v1')).month === month, month)
    }
    settle(id); await unchangedAfter(id, before, 409)
    record('a queued month edit and reversal still invalidates the in-flight revision and cannot commit an old candidate')

    id = await begin({}, { source: 'http' })
    await permission(false, true)
    await unchangedAfter(id, before, 403)
    assert.ok(control.cancellations.includes(id))
    await permission(true)
    record('revoking shared assignment permission aborts HTTP generation and preserves all assignments and metadata')

    id = await begin()
    const oldServiceId = await page.evaluate(() => window.__generationBridge.services.mcp.info.serviceId)
    await settings(async dialog => {
      await dialog.getByRole('switch', { name: 'MCP', exact: true }).click({ force: true })
      await page.waitForFunction(() => !document.querySelector('[data-integration-service="mcp"] [role="switch"]').disabled)
      await dialog.getByRole('switch', { name: 'MCP', exact: true }).click({ force: true })
    }, true)
    await unchangedAfter(id, before, 503)
    const staleService = await request('generate_schedule', { revision: (await snapshot()).revision }, { serviceId: oldServiceId })
    assert.equal(staleService.response.error?.status, 503)
    record('stopping and restarting MCP aborts its generation and rejects its old service ID while releasing the lock')

    control.cancelMode = 'defer'
    id = await begin({}, { source: 'http' })
    await page.getByRole('button', { name: '取消排班', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.sp-generation-progress')?.textContent.includes('正在取消'))
    assert.ok(control.cancellations.includes(id))
    const cancellingBusy = await request('generate_schedule', { revision: (await snapshot()).revision })
    assert.equal(cancellingBusy.response.error?.status, 409)
    assert.deepEqual(await stored(), before)
    settle(id); await unchangedAfter(id, before, 409)
    control.cancelMode = 'reject'
    record('user cancellation keeps the generation lock until the native call finishes and discards even a late valid result')

    id = await begin()
    await page.evaluate(id => {
      const request = window.__generationBridge.requests[id]
      window.__generationEmit('integration-cancelled', { requestId: id, source: request.source, serviceId: request.serviceId })
    }, id)
    await unchangedAfter(id, before, 409)
    id = await begin({}, { source: 'http', expiresIn: 500 })
    await unchangedAfter(id, before, 504)
    assert.ok(control.cancellations.includes(id))
    record('native client cancellation and a live request deadline both stop the matching generation without saving')

    id = await begin()
    await page.evaluate(() => { window.__generationBridge.failClaim = true })
    settle(id); await unchangedAfter(id, before, 503)
    await page.evaluate(() => { window.__generationBridge.failClaim = false })
    id = await begin()
    await page.evaluate(() => { window.__generationBridge.failSave = true })
    settle(id); await unchangedAfter(id, before, 400)
    await page.evaluate(() => { window.__generationBridge.failSave = false })
    record('a failed native commit claim or failed local save never replaces state or stamps a successful generation')

    id = await begin(); settle(id, 'infeasible'); await unchangedAfter(id, before)
    assert.equal(control.pending.size, 0)
    assert.deepEqual(report.errors, [])
    record('every failure releases the shared lock and leaves no pending solver or browser errors')
    report.ok = true
  } catch (error) {
    report.failure = error.stack || String(error)
    await page?.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
