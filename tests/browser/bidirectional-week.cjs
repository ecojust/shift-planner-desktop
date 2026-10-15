/* Real Vue / real hosted Python CP-SAT; controlled Tauri events, no native sockets.
 * BIDIRECTIONAL_WEEK_TEST_URL, PLAYWRIGHT_MODULE_PATH and executable are optional.
 * All current-month work is locked: many possible future previews must count as
 * exactly one current-month solution. The audit imports no scheduler helpers. */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const root = path.resolve(__dirname, '../..'), out = path.join(root, 'test-results/bidirectional-week')
const url = process.env.BIDIRECTIONAL_WEEK_TEST_URL || 'http://127.0.0.1:5194/'
const referenceDate = '2026-10-15', target = '2026-11'
const copy = value => JSON.parse(JSON.stringify(value))
const fixture = {
  version: 1, teamName: '双向周真实排班验收', month: '2026-10', calendar: {},
  employees: ['甲', '乙'].map((name, index) => ({ id: `week-${index + 1}`, name: `边界${name}`, role: '值班员', group: '测试', color: '#d7e8f8', minHoursPerWeek: 0, maxHoursPerWeek: 40, eligibleShiftIds: ['night'], unavailableDates: index ? [] : ['2026-12-01'] })),
  shifts: [{ id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#dbeee6', required: 1, staffingMode: 'fixed', normalAllowance: 0 }],
  rules: { minRestHours: 11, maxConsecutiveDays: 3, weeklyShiftLimits: [{ id: 'nights', shiftId: 'night', maxPerWeek: 4 }] },
  scheduleCoverage: { '2026-10': { employeeIds: ['week-1', 'week-2'] } },
  assignments: [
    ...Array.from({ length: 6 }, (_, index) => ({ employeeId: `week-${index % 2 + 1}`, date: `2026-10-${26 + index}`, shiftId: 'night', locked: false })),
    ...Array.from({ length: 30 }, (_, index) => ({ employeeId: `week-${index % 2 + 1}`, date: `2026-11-${String(index + 1).padStart(2, '0')}`, shiftId: 'night', locked: true })),
  ],
}
const report = { url, scope: 'Real Vue and Python CP-SAT with mocked native IPC; actual complete-week minute/count audit and publication guards', checks: [], errors: [], runs: [], ok: false }
let browser, page, sequence = 0, cached
function record(name, detail) { report.checks.push({ name, ...(detail ? { detail } : {}) }); console.log('PASS', name) }
async function stored() { return page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1'))) }
async function solve(request) {
  assert.equal(request.options.referenceDate, referenceDate)
  const prefix = path.join(out, `solve-${report.runs.length + 1}`)
  await fs.writeFile(`${prefix}-request.json`, JSON.stringify(request, null, 2))
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'solver/.venv/bin/python'), [path.join(root, 'solver/main.py'), '--hosted'], { cwd: root })
    let stdout = '', stderr = '', buffered = '', stream = Promise.resolve()
    const counts = []
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Python boundary solve exceeded 45 seconds')) }, 45000)
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => {
      stderr += data; buffered += data
      const lines = buffered.split('\n'); buffered = lines.pop()
      for (const line of lines) {
        const match = /^SHIFTFLOW_SOLUTIONS_V1:(\d+)$/.exec(line)
        if (!match) continue
        const count = Number(match[1]); counts.push(count)
        stream = stream.then(() => page.evaluate(payload => window.__weekEmit('solver-progress', payload), { requestId: request.requestId, phase: 'solving', solutionCount: count }))
      }
    })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', async code => {
      clearTimeout(timer)
      try {
        await stream
        assert.equal(code, 0, stderr)
        const result = JSON.parse(stdout)
        assert.ok(['OPTIMAL', 'FEASIBLE'].includes(result.status), stdout)
        assert.equal(result.stats.solutionCount, 1, 'Different future previews cannot inflate the only possible current-month roster')
        assert.deepEqual(counts, [1])
        await fs.writeFile(`${prefix}-result.json`, JSON.stringify(result, null, 2))
        await fs.writeFile(`${prefix}-stderr.log`, stderr)
        report.runs.push({ status: result.status, count: result.stats.solutionCount, previewCount: result.boundaryPreview.length, counts })
        cached = copy(result); resolve(result)
      } catch (error) { reject(error) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}
async function prepare(mode = 'real', initial = fixture) {
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  await page.clock.setFixedTime(new Date(`${referenceDate}T04:00:00Z`))
  page.on('pageerror', error => report.errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })
  await page.exposeFunction('weekSolve', async request => {
    if (mode === 'real') return solve(request)
    const result = { ...copy(cached), requestId: request.requestId }
    if (mode === 'missing') delete result.boundaryPreview
    if (mode === 'empty') result.boundaryPreview = []
    if (mode === 'leave') result.boundaryPreview = result.boundaryPreview.map(item => item.date === '2026-12-01' ? { ...item, employeeId: 'week-1' } : item)
    if (mode === 'published') result.assignments.push(result.boundaryPreview[0])
    return result
  })
  await page.addInitScript(initial => {
    localStorage.setItem('shift-planner:v1', JSON.stringify(initial)); window.isTauri = true
    const callbacks = new Map(), listeners = new Map(); let callback = 0, listener = 0
    const bridge = window.__weekBridge = { responses: {}, requests: {}, services: {}, claims: [] }
    for (const service of ['mcp', 'http']) bridge.services[service] = { enabled: false, url: '', token: '', serviceId: '' }
    window.__TAURI_INTERNALS__ = {
      transformCallback(fn) { callbacks.set(++callback, fn); return callback }, unregisterCallback(id) { callbacks.delete(id) },
      async invoke(command, args = {}) {
        if (command === 'plugin:event|listen') { const id = ++listener; listeners.set(args.event, { id, handler: args.handler }); return id }
        if (command === 'plugin:event|unlisten') return null
        if (command === 'solver_info') return { engine: 'ortools-cp-sat', protocolVersion: 1, version: 'real-python-boundary', local: true }
        if (command === 'solve_schedule') return window.weekSolve(args.request)
        if (command === 'cancel_solve') return true
        const service = bridge.services[args.service]
        if (!service) throw new Error(`Unexpected IPC ${command}`)
        if (command === 'integration_status') return { ...service }
        if (command === 'integration_start') return Object.assign(service, { enabled: true, url: `http://127.0.0.1:${args.service === 'mcp' ? 4318 : 4319}`, token: `week-${args.service}-token`, serviceId: `week-${args.service}` })
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
    window.__weekEmit = (event, payload) => {
      if (event === 'integration-request') bridge.requests[payload.requestId] = payload
      const item = listeners.get(event), fn = callbacks.get(item?.handler)
      if (!fn) throw new Error(`No listener for ${event}`)
      fn({ event, id: item.id, payload })
    }
  }, initial)
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  for (const service of ['MCP', 'HTTP']) await dialog.getByRole('switch', { name: service, exact: true }).click()
  await dialog.getByRole('checkbox', { name: '允许修改排班结果', exact: true }).check()
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click()
}
async function request(source, method, args = {}) {
  const id = `week-request-${++sequence}`
  await page.evaluate(({ source, method, args, id }) => window.__weekEmit('integration-request', { source, method, args, requestId: id, serviceId: window.__weekBridge.services[source].serviceId, expiresAt: Date.now() + 90000 }), { source, method, args, id })
  await page.waitForFunction(id => !!window.__weekBridge.responses[id], id, { timeout: 60000 })
  return page.evaluate(id => window.__weekBridge.responses[id], id)
}
function audit(assignments, preview) {
  assert.deepEqual(assignments, fixture.assignments, 'Locked current roster is the only possible saved solution')
  assert.equal(preview.length, 6)
  assert.ok(preview.every(item => item.date >= '2026-12-01' && item.date <= '2026-12-06' && !item.locked && item.shiftId === 'night'))
  const combined = [...assignments, ...preview], DAY = 86400000
  for (let day = 1; day <= 6; day++) assert.equal(preview.filter(item => item.date === `2026-12-0${day}`).length, 1, 'Each future day needs exactly one actual qualified person')
  for (const employee of fixture.employees) {
    const work = combined.filter(item => item.employeeId === employee.id).map(item => ({ ...item, start: Date.parse(`${item.date}T22:00:00Z`), end: Date.parse(`${item.date}T22:00:00Z`) + 8 * 3600000 })).sort((a, b) => a.start - b.start)
    let streak = 0, previous = -Infinity
    for (const [index, item] of work.entries()) {
      for (const date of employee.unavailableDates) { const start = Date.parse(`${date}T00:00:00Z`); assert.ok(item.end <= start || item.start >= start + DAY, 'Future work must not overlap leave, including overnight tails') }
      if (index) assert.ok(item.start - work[index - 1].end >= 11 * 3600000)
      streak = item.start - previous === DAY ? streak + 1 : 1; assert.ok(streak <= 3); previous = item.start
    }
    for (let start = Date.parse('2026-10-26T00:00:00Z'); start < Date.parse('2026-12-07T00:00:00Z'); start += 7 * DAY) {
      const end = start + 7 * DAY
      const minutes = work.reduce((sum, item) => sum + Math.max(0, Math.min(item.end, end) - Math.max(item.start, start)) / 60000, 0)
      assert.ok(minutes <= 40 * 60, 'Preview cannot overspend complete-week actual-minute capacity')
      assert.ok(work.filter(item => item.start >= start && item.start < end).length <= 4, 'Preview cannot overspend weekly night-start counts')
    }
  }
}
async function main() {
  await fs.mkdir(out, { recursive: true })
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  try {
    for (const source of ['mcp', 'http']) {
      await prepare()
      const snapshot = (await request(source, 'get_state')).result
      const reply = await request(source, 'generate_schedule', { revision: snapshot.revision, month: target, timeLimitSeconds: 3 })
      assert.equal(reply.result?.success, true, JSON.stringify(reply)); assert.equal(reply.result.saved, true)
      audit(reply.result.state.assignments, reply.result.boundaryPreview)
      assert.equal(reply.result.boundaryContext.referenceDate, referenceDate)
      const saved = await stored()
      assert.equal(saved.month, '2026-10', 'Generating another month does not change the UI month')
      assert.equal(Object.hasOwn(saved, 'boundaryPreview'), false)
      assert.equal(Object.hasOwn(saved.scheduleCoverage, '2026-12'), false)
      assert.deepEqual(saved.scheduleCoverage[target].employeeIds, ['week-1', 'week-2'])
      assert.equal(saved.provenance.scheduleUpdates[target].source, source)
      await page.screenshot({ path: path.join(out, `${source}-complete-week.png`) })
      record(`${source}-real-solver-checks-future-coverage-leave-weekly-night-counts-and-hours-without-publishing-the-preview`, report.runs.at(-1))
      await page.close()
    }
    record('real-solution-count-is-one-for-the-unique-locked-current-roster-despite-variable-future-previews')
    for (const mode of ['missing', 'empty', 'leave', 'published']) {
      await prepare(mode)
      const snapshot = (await request('mcp', 'get_state')).result, before = await stored()
      const reply = await request('mcp', 'generate_schedule', { revision: snapshot.revision, month: target, timeLimitSeconds: 3 })
      assert.ok(reply.error || reply.result?.success === false, `${mode}: invalid future evidence must fail`)
      assert.deepEqual(await stored(), before, 'Rejected boundary evidence must not mark coverage, source or save a roster')
      assert.equal(await page.evaluate(() => window.__weekBridge.claims.length), 0)
      record(`independent-app-validation-rejects-${mode}-future-evidence-atomically`)
      await page.close()
    }
    assert.deepEqual(report.errors, []); report.ok = true
  } catch (error) { report.failure = error.stack || String(error); await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw error }
  finally { await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
