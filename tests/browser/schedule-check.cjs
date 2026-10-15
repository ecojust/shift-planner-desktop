/* Real Vue + production rule-check Worker. Network holds/failures delay only
 * the actual Worker asset; no rule-check result is mocked. External generation
 * uses controlled native IPC and real Python CP-SAT except one explicit native
 * failure fixture per service. Native sockets are outside this browser test. */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const { selectGlobalMonth, readGlobalMonth } = require('./helpers/month-picker.cjs')
const root = path.resolve(__dirname, '../..')
const out = path.join(root, 'test-results/schedule-check')
const url = process.env.SCHEDULE_CHECK_TEST_URL || 'http://127.0.0.1:5194/'
const copy = value => JSON.parse(JSON.stringify(value))
const base = {
  version: 1, teamName: '独立规则检查验收', month: '2027-02', calendar: {},
  employees: [{ id: 'check-1', name: '核对成员', role: '值班员', group: '检查组', color: '#d7e8f8', minHoursPerWeek: 0, maxHoursPerWeek: 56, eligibleShiftIds: ['day'], unavailableDates: [] }],
  shifts: [{ id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 0, staffingMode: 'minimum', normalAllowance: 0 }],
  rules: { minRestHours: 11, maxConsecutiveDays: 5 }, assignments: [],
  scheduleCoverage: { '2027-02': { employeeIds: ['check-1'] } },
}
const report = { url, scope: 'Real production rule-check Worker, real UI controls, real Python via simulated desktop IPC; delayed/failed assets and an explicit native failure fixture', checks: [], errors: [], solverRuns: [], ok: false }
let browser, page, sequence = 0
const record = (name, detail) => { report.checks.push({ name, ...(detail ? { detail } : {}) }); console.log('PASS', name) }
const panel = () => page.getByRole('region', { name: '排班规则检查', exact: true })
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1')))
const posts = () => page.evaluate(() => window.__checkWorkers.posts)
async function status(value) { await panel().locator(`:scope[data-check-status="${value}"]`).waitFor(); assert.equal(await panel().getAttribute('aria-busy'), value === 'checking' ? 'true' : 'false') }
async function screenshot(name) { await page.screenshot({ path: path.join(out, `${name}.png`) }) }
async function waitPosts(count) { await page.waitForFunction(count => window.__checkWorkers.posts.length > count, count) }
async function realSolve(request) {
  const index = report.solverRuns.length + 1
  const prefix = path.join(out, `solve-${index}-${request.state.month}`)
  await fs.writeFile(`${prefix}-request.json`, JSON.stringify(request, null, 2))
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'solver/.venv/bin/python'), [path.join(root, 'solver/main.py'), '--hosted'], { cwd: root })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Rule-check browser solver exceeded 45 seconds')) }, 45000)
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', async code => {
      clearTimeout(timer)
      try {
        assert.equal(code, 0, stderr)
        const result = JSON.parse(stdout)
        assert.ok(['OPTIMAL', 'FEASIBLE'].includes(result.status), stdout)
        await fs.writeFile(`${prefix}-result.json`, JSON.stringify(result, null, 2))
        report.solverRuns.push({ requestId: request.requestId, month: request.state.month, status: result.status, assignments: result.assignments.length, preview: result.boundaryPreview?.length })
        resolve(result)
      } catch (error) { reject(error) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}
async function prepare(initial = base, { held = false, failOnce = false, desktop = false } = {}) {
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  page.setDefaultTimeout(12000)
  await page.clock.setFixedTime(new Date('2026-10-15T04:00:00Z'))
  const controller = { held, pending: [], failures: failOnce ? 1 : 0, failedUrls: [], nativeFailure: false }
  await page.route(/\/schedule-check\.worker-[^/]+\.js(?:\?.*)?$/, async route => {
    if (controller.failures) { controller.failures--; controller.failedUrls.push(route.request().url()); return route.abort('failed') }
    if (controller.held) await new Promise(resolve => controller.pending.push(resolve))
    await route.continue().catch(() => {}) // Terminated obsolete workers can cancel their held request.
  })
  controller.release = () => { controller.held = false; controller.pending.splice(0).forEach(resolve => resolve()) }
  page.on('pageerror', error => report.errors.push(error.stack || String(error)))
  page.on('console', message => {
    if (message.type() !== 'error') return
    if (controller.failedUrls.includes(message.location().url) && /ERR_FAILED|Failed to load resource/.test(message.text())) return
    report.errors.push(message.text())
  })
  if (desktop) await page.exposeFunction('checkRealSolve', request => controller.nativeFailure
    ? { protocolVersion: 1, requestId: request.requestId, engine: 'ortools-cp-sat', status: 'ERROR', issues: [], message: '受控的原生求解失败', stats: { wallTimeSeconds: 0, shortageCount: 0, optimal: false } }
    : realSolve(request))
  await page.addInitScript(({ initial, desktop }) => {
    localStorage.setItem('shift-planner:v1', JSON.stringify(initial))
    const actual = window.Worker
    const audit = window.__checkWorkers = { posts: [], replies: [], terminated: [], urls: [] }
    window.Worker = class extends actual {
      constructor(...args) {
        super(...args); this.auditUrl = String(args[0]); audit.urls.push(this.auditUrl)
        this.addEventListener('message', event => {
          if (this.auditUrl.includes('schedule-check.worker')) audit.replies.push(JSON.parse(JSON.stringify(event.data)))
        })
      }
      postMessage(value, ...rest) {
        if (this.auditUrl.includes('schedule-check.worker')) { this.auditId = value.requestId; audit.posts.push({ requestId: value.requestId, month: value.month }) }
        return super.postMessage(value, ...rest)
      }
      terminate() { if (this.auditUrl.includes('schedule-check.worker')) audit.terminated.push(this.auditId); return super.terminate() }
    }
    if (!desktop) return
    window.isTauri = true
    const callbacks = new Map(), listeners = new Map(); let callback = 0, listener = 0
    const bridge = window.__checkBridge = { requests: {}, responses: {}, services: {}, claims: [] }
    for (const service of ['mcp', 'http']) bridge.services[service] = { enabled: false, url: '', token: '', serviceId: '' }
    window.__TAURI_INTERNALS__ = {
      transformCallback(fn) { callbacks.set(++callback, fn); return callback }, unregisterCallback(id) { callbacks.delete(id) },
      async invoke(command, args = {}) {
        if (command === 'plugin:event|listen') { const id = ++listener; listeners.set(args.event, { id, handler: args.handler }); return id }
        if (command === 'plugin:event|unlisten') return null
        if (command === 'solver_info') return { engine: 'ortools-cp-sat', protocolVersion: 1, version: 'real-python-check', local: true }
        if (command === 'solve_schedule') return window.checkRealSolve(args.request)
        if (command === 'cancel_solve') return true
        const service = bridge.services[args.service]
        if (!service) throw new Error(`Unexpected IPC ${command}`)
        if (command === 'integration_status') return { ...service }
        if (command === 'integration_start') return Object.assign(service, { enabled: true, url: `http://127.0.0.1:${args.service === 'mcp' ? 4318 : 4319}`, token: `check-${args.service}-token`, serviceId: `check-${args.service}` })
        if (command === 'integration_stop') return Object.assign(service, { enabled: false, url: '', token: '', serviceId: '' })
        if (command === 'integration_claim_request') {
          const request = bridge.requests[args.requestId]
          if (!service.enabled || request?.source !== args.service || request.serviceId !== args.serviceId || service.serviceId !== args.serviceId) throw new Error('Invalid claim')
          bridge.claims.push(args); return null
        }
        if (command === 'integration_respond') { bridge.responses[args.requestId] = args.response; return null }
        throw new Error(`Unexpected IPC ${command}`)
      },
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.__checkEmit = (event, payload) => {
      if (event === 'integration-request') bridge.requests[payload.requestId] = payload
      const item = listeners.get(event), fn = callbacks.get(item?.handler)
      if (!fn) throw new Error(`No listener for ${event}`)
      fn({ event, id: item.id, payload })
    }
  }, { initial, desktop })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await panel().waitFor()
  return controller
}
async function enableServices() {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  for (const service of ['MCP', 'HTTP']) await dialog.getByRole('switch', { name: service, exact: true }).click()
  await dialog.getByRole('checkbox', { name: '允许修改排班结果', exact: true }).check()
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click()
}
async function request(source, method, args = {}) {
  const id = `check-request-${++sequence}`
  await page.evaluate(({ source, method, args, id }) => window.__checkEmit('integration-request', { source, method, args, requestId: id, serviceId: window.__checkBridge.services[source].serviceId, expiresAt: Date.now() + 90000 }), { source, method, args, id })
  await page.waitForFunction(id => !!window.__checkBridge.responses[id], id, { timeout: 60000 })
  return page.evaluate(id => window.__checkBridge.responses[id], id)
}
async function main() {
  await fs.mkdir(out, { recursive: true })
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  try {
    const loading = await prepare(base, { held: true })
    await status('checking')
    assert.equal(await panel().locator('.sp-schedule-check-spinner').isVisible(), true)
    assert.equal(await panel().locator('[role=status]').getAttribute('aria-live'), 'polite')
    await screenshot('01-loading-real-worker')
    const initialPosts = await posts()
    assert.ok(initialPosts.length >= 1)
    loading.release(); await status('compliant')
    assert.match(await panel().innerText(), /符合规则/)
    assert.equal(await panel().locator('li').count(), 0)
    assert.ok(await page.evaluate(() => window.__checkWorkers.replies.some(reply => reply.result?.status === 'compliant')))
    record('actual-worker-load-displays-accessible-loading-then-generated-all-rest-is-compliant')

    const before = await stored(), count = (await posts()).length
    loading.held = true
    await page.getByRole('button', { name: '下个月', exact: true }).click()
    await waitPosts(count); await status('checking')
    assert.equal(await panel().locator('time').getAttribute('datetime'), '2027-03')
    const obsolete = (await posts()).at(-1).requestId
    await page.getByRole('button', { name: '上个月', exact: true }).click()
    await waitPosts(count + 1); await status('checking')
    loading.release(); await status('compliant')
    assert.equal(await readGlobalMonth(page), '2027-02')
    assert.equal(await panel().locator('time').getAttribute('datetime'), '2027-02')
    assert.ok(await page.evaluate(id => window.__checkWorkers.terminated.includes(id), obsolete))
    // Allow any response already queued before termination to arrive.
    await page.waitForTimeout(150)
    await status('compliant')
    const after = await stored()
    for (const key of ['assignments', 'employees', 'shifts', 'rules', 'scheduleCoverage', 'provenance']) assert.deepEqual(after[key], before[key], `${key} must not change merely by checking/switching months`)
    record('every-month-switch-rechecks-shows-loading-and-cancels-stale-month-without-mutating-roster-or-source')
    await page.close()

    const shortage = copy(base); shortage.shifts[0].required = 1
    await prepare(shortage); await status('noncompliant')
    const reasons = await panel().innerText()
    assert.match(reasons, /不符合规则/); assert.match(reasons, /2027-02-01/); assert.match(reasons, /日班/)
    assert.equal(await panel().locator('li').count(), 5)
    await panel().getByRole('button', { name: /展开其余/ }).click()
    assert.equal(await panel().locator('li').count(), 28, 'Every daily staffing failure can be inspected')
    record('missing-staffing-warning-is-noncompliant-with-date-shift-and-all-expandable-reasons')
    await page.setViewportSize({ width: 320, height: 800 })
    await panel().scrollIntoViewIfNeeded()
    const bounds = await panel().boundingBox()
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 321)
    assert.equal(await panel().evaluate(node => node.scrollWidth <= node.clientWidth + 1), true)
    await screenshot('02-noncompliant-320px')
    record('rule-results-and-expanded-reasons-fit-320px-without-panel-horizontal-overflow')
    await page.close()

    const rest = copy(base); delete rest.scheduleCoverage
    await prepare(rest); await status('empty')
    assert.doesNotMatch(await panel().innerText(), /符合规则/)
    record('never-generated-empty-month-does-not-present-green-compliance')
    await page.close()

    const boundary = copy(base); boundary.month = '2027-03'; boundary.scheduleCoverage['2027-03'] = { employeeIds: ['check-1'] }
    await prepare(boundary); await status('pending')
    assert.match(await panel().innerText(), /跨月规则待核对/)
    assert.ok(await panel().locator('li').count() > 0)
    await screenshot('03-cross-month-pending')
    record('unknown-adjacent-dates-remain-pending-with-reasons-instead-of-false-compliance')
    await page.close()

    const working = copy(base)
    working.assignments = ['2027-02-01', '2027-02-02'].map(date => ({ employeeId: 'check-1', date, shiftId: 'day', locked: false }))
    await prepare(working); await status('compliant')
    const ruleCount = (await posts()).length
    await page.getByRole('button', { name: '排班规则', exact: true }).click()
    await page.getByRole('spinbutton', { name: '最大连续工作天数', exact: true }).fill('1')
    await page.getByRole('button', { name: '保存个人规则', exact: true }).click()
    await page.getByRole('button', { name: '排班日历', exact: true }).click()
    await waitPosts(ruleCount); await status('noncompliant')
    assert.match(await panel().innerText(), /连续/)
    assert.deepEqual((await stored()).assignments, working.assignments)
    record('editing-real-rule-controls-rechecks-unchanged-roster-and-displays-new-conflict')
    await page.close()

    await prepare(base, { failOnce: true }); await status('error')
    assert.match(await panel().innerText(), /检查未完成/)
    assert.doesNotMatch(await panel().innerText(), /符合规则/)
    await panel().getByRole('button', { name: '重试检查', exact: true }).click()
    await status('compliant')
    record('actual-worker-load-failure-is-explicit-and-retry-loads-real-worker-successfully')
    await page.close()

    for (const source of ['mcp', 'http']) {
      const control = await prepare(base, { desktop: true })
      await status('compliant'); await enableServices()
      let snapshot = (await request(source, 'get_state')).result
      const firstCount = (await posts()).length
      const first = await request(source, 'generate_schedule', { revision: snapshot.revision, timeLimitSeconds: 1 })
      assert.equal(first.result?.success, true, JSON.stringify(first))
      assert.equal(first.result.validation.month, '2027-02')
      assert.equal(first.result.validation.status, 'compliant')
      await waitPosts(firstCount); await status('compliant')
      const firstAssignments = copy((await stored()).assignments)
      snapshot = (await request(source, 'get_state')).result
      const repeatedCount = (await posts()).length
      const repeated = await request(source, 'generate_schedule', { revision: snapshot.revision, timeLimitSeconds: 1 })
      assert.equal(repeated.result?.success, true, JSON.stringify(repeated))
      assert.equal(repeated.result.validation.status, 'compliant')
      await waitPosts(repeatedCount); await status('compliant')
      assert.deepEqual((await stored()).assignments, firstAssignments)
      record(`${source}-real-generation-and-byte-identical-repeat-both-recheck-and-return-current-compliance`)

      snapshot = (await request(source, 'get_state')).result
      const failureBefore = await stored(), failureCount = (await posts()).length
      control.nativeFailure = true
      const failed = await request(source, 'generate_schedule', { revision: snapshot.revision, timeLimitSeconds: 1 })
      assert.equal(failed.result?.success, false, JSON.stringify(failed))
      assert.equal(failed.result.saved, false)
      assert.equal(failed.result.validation.month, '2027-02')
      assert.equal(failed.result.validation.status, 'compliant', 'Failed solver and saved roster compliance are different facts')
      await waitPosts(failureCount); await status('compliant')
      assert.deepEqual(await stored(), failureBefore)
      assert.equal((await request(source, 'get_state')).result.revision, snapshot.revision)
      record(`${source}-native-generation-failure-rechecks-preserved-roster-without-changing-revision-or-provenance`)

      control.nativeFailure = false
      const otherCount = (await posts()).length
      const other = await request(source, 'generate_schedule', { revision: snapshot.revision, month: '2027-03', timeLimitSeconds: 1 })
      assert.equal(other.result?.success, true, JSON.stringify(other))
      assert.equal(other.result.validation.month, '2027-03')
      assert.equal(other.result.validation.status, 'pending')
      await waitPosts(otherCount); await status('compliant')
      assert.equal(await readGlobalMonth(page), '2027-02')
      assert.equal(await panel().locator('time').getAttribute('datetime'), '2027-02')
      assert.ok((await posts()).slice(otherCount).some(item => item.month === '2027-02'), 'Current month independently rechecked after another month is generated')
      await selectGlobalMonth(page, '2027-03'); await status('pending')
      assert.equal(await panel().locator('time').getAttribute('datetime'), '2027-03')
      record(`${source}-explicit-other-month-validation-never-overwrites-current-month-and-is-rechecked-when-opened`)
      await page.close()
    }
    assert.deepEqual(report.errors, []); report.ok = true
  } catch (error) {
    report.failure = error.stack || String(error)
    await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
