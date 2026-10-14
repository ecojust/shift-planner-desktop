const { selectOption } = require('./helpers/select-option.cjs')
/* Run against a built preview with GENERATION_PROGRESS_TEST_URL, optionally
 * PLAYWRIGHT_MODULE_PATH / PLAYWRIGHT_EXECUTABLE_PATH / SHIFT_FLOW_PYTHON.
 * Desktop lifecycle and progress events use a controlled Tauri bridge in Chromium;
 * successful payloads come from the real Python CLI. This does not exercise Rust
 * IPC, packaged binaries or native windows. Web cases use the real bundled Worker.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const repo = path.resolve(__dirname, '../..')
const url = process.env.GENERATION_PROGRESS_TEST_URL || 'http://127.0.0.1:5194/'
const out = path.resolve(process.env.GENERATION_PROGRESS_TEST_OUTPUT || path.join(repo, 'test-results/generation-progress'))
const python = process.env.SHIFT_FLOW_PYTHON || path.join(repo, 'solver/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const fixture = {
  version: 1, teamName: '进度验收', month: '2026-10',
  employees: ['甲', '乙'].map((name, index) => ({ id: `qa-${index + 1}`, name: `测试成员${name}`, role: '服务员', group: '测试', color: '#d7e8f8', minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 56, eligibleShiftIds: ['day'], unavailableDates: [] })),
  shifts: [{ id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 1, staffingMode: 'fixed', normalAllowance: 0 }],
  rules: { minRestHours: 11, maxConsecutiveDays: 5 },
  assignments: [{ employeeId: 'qa-1', date: '2026-10-01', shiftId: 'day', locked: true }, { employeeId: 'qa-2', date: '2026-09-30', shiftId: 'off', locked: false }],
}
const clone = value => JSON.parse(JSON.stringify(value))
const report = { url, scope: 'Controlled desktop bridge and real Python CLI payloads; real web Worker; no native packaging or Rust IPC', startedAt: new Date().toISOString(), checks: [], errors: [], screenshots: [], ok: false }
let browser, activePage, cliSequence = 0
function record(name) { report.checks.push(name); console.log('PASS', name) }
async function until(predicate, message) {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(predicate(), message)
}
async function screenshot(page, name) { const file = path.join(out, name + '.png'); await page.screenshot({ path: file }); report.screenshots.push(file) }
async function stored(page) { return page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1'))) }
async function runSolver(request) {
  const file = path.join(out, `request-${++cliSequence}.json`)
  await fs.writeFile(file, JSON.stringify(request))
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(repo, 'solver/main.py'), '--input', file], { cwd: repo })
    let stdout = '', stderr = ''
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Python CLI did not finish within 45 seconds')) }, 45000)
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => {
      clearTimeout(timeout)
      try { assert.equal(code, 0, stderr); const result = JSON.parse(stdout); assert.ok(['OPTIMAL', 'FEASIBLE'].includes(result.status), stdout); resolve(result) } catch (error) { reject(error) }
    })
  })
}
async function preparePage(state, desktop = false, viewport = { width: 1440, height: 960 }) {
  const page = await browser.newPage({ viewport, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  activePage = page
  page.on('pageerror', error => report.errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })
  const control = { requests: [], cancelled: [], cancellations: [], pending: new Map() }
  if (desktop) {
    await page.clock.install({ time: new Date('2026-10-14T12:00:00Z') })
    await page.clock.pauseAt(new Date('2026-10-14T12:00:01Z'))
    await page.exposeFunction('qaProgressInvoke', async (command, args) => {
      if (command === 'plugin:event|listen') return 1
      if (command === 'plugin:event|unlisten') return null
      if (command === 'solver_info') return { engine: 'ortools-cp-sat', protocolVersion: 1, version: 'controlled-progress-bridge', local: true }
      if (command === 'solve_schedule') {
        control.requests.push(args.request)
        return new Promise((resolve, reject) => control.pending.set(args.request.requestId, { resolve, reject }))
      }
      if (command === 'cancel_solve') {
        control.cancelled.push(args.requestId)
        return new Promise((resolve, reject) => control.cancellations.push({ requestId: args.requestId, resolve, reject }))
      }
      throw new Error(`Unexpected controlled IPC command: ${command}`)
    })
  }
  await page.addInitScript(({ state, desktop }) => {
    localStorage.setItem('shift-planner:v1', JSON.stringify(state))
    // Observe actual DOM insertion even when the real Worker finishes quickly.
    window.__generationObservation = { visibleProgress: false, progressInDialog: false, workers: 0 }
    const observe = () => {
      const observer = new MutationObserver(records => {
        for (const mutation of records) for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue
          const found = node.matches('.sp-solve-progress') ? node : node.querySelector('.sp-solve-progress')
          if (found) { window.__generationObservation.visibleProgress = true; window.__generationObservation.progressInDialog = !!found.closest('[role="dialog"]') }
        }
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
    }
    if (document.documentElement) observe(); else document.addEventListener('DOMContentLoaded', observe, { once: true })
    if (desktop) {
      window.isTauri = true
      const callbacks = new Map(), listeners = new Map()
      let next = 0
      window.__TAURI_INTERNALS__ = {
        transformCallback(fn) { callbacks.set(++next, fn); return next },
        unregisterCallback(id) { callbacks.delete(id) },
        invoke(command, args) {
          if (command === 'plugin:event|listen') listeners.set(args.event, args.handler)
          return window.qaProgressInvoke(command, args)
        },
      }
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(event) { listeners.delete(event) } }
      window.__emitGenerationPhase = payload => {
        const handler = callbacks.get(listeners.get('solver-progress'))
        if (!handler) throw new Error('Expected active solver-progress listener')
        handler({ event: 'solver-progress', id: 1, payload })
      }
    } else {
      // Count workers without replacing scheduling, messages, errors or results.
      const ActualWorker = window.Worker
      window.Worker = class extends ActualWorker {
        constructor(...args) { super(...args); window.__generationObservation.workers++ }
      }
    }
  }, { state, desktop })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '排班日历', exact: true }).waitFor()
  return { page, control }
}
async function openGenerate(page, seconds) {
  await page.getByRole('button', { name: '自动排班', exact: true }).click()
  const dialog = page.getByRole('dialog')
  if (seconds) { await dialog.locator('.sp-generation-advanced summary').click(); await selectOption(page, dialog.getByLabel('最长等待时间', { exact: true }), String(seconds)) }
  return dialog
}
async function start(page, control, seconds, repeatStart = false) {
  const before = control.requests.length, dialog = await openGenerate(page, seconds)
  const element = await dialog.elementHandle()
  const trigger = dialog.getByRole('button', { name: '开始生成', exact: true })
  if (repeatStart) await trigger.evaluate(node => { node.click(); node.click() })
  else await trigger.click()
  await page.waitForFunction(() => !!document.querySelector('[role="dialog"] .sp-solve-progress'))
  await until(() => control.requests.length === before + 1, 'one request reaches the controlled desktop bridge')
  assert.equal(control.requests.length, before + 1)
  const request = control.requests.at(-1)
  assert.equal(request.options.allowPartial, false)
  assert.equal(await element.evaluate(node => node.isConnected && node === document.querySelector('[role="dialog"]')), true, 'settings and progress share the same dialog node')
  return { dialog, request, progress: dialog.locator('.sp-solve-progress') }
}
async function emit(page, requestId, phase) { await page.evaluate(({ requestId, phase }) => window.__emitGenerationPhase({ requestId, phase }), { requestId, phase }) }
async function timers(progress) {
  const text = await progress.innerText(), values = text.match(/总计\s*(\d+)\s*秒\s*·\s*当前阶段\s*(\d+)\s*秒/)
  assert.ok(values, text)
  return { total: Number(values[1]), phase: Number(values[2]) }
}
async function settle(control, request, mode) {
  const pending = control.pending.get(request.requestId)
  assert.ok(pending, 'request remains active until explicitly settled')
  control.pending.delete(request.requestId)
  if (mode === 'transport') pending.reject(new Error('SOLVE_TIMEOUT: controlled test deadline'))
  else if (mode === 'unknown') pending.resolve({ protocolVersion: 1, engine: 'ortools-cp-sat', requestId: request.requestId, status: 'UNKNOWN', issues: [], stats: { wallTimeSeconds: 15, shortageCount: 0, optimal: false }, message: 'Test controlled search did not find a result' })
  else pending.resolve(await runSolver(request))
}
async function finished(page, expected) {
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.locator('.sp-solve-result').waitFor()
  await page.waitForFunction(() => document.activeElement === document.querySelector('.sp-heading-actions .sp-primary'))
  assert.match(await page.locator('.sp-solve-result').innerText(), expected)
  assert.equal(await page.locator('.sp-solve-progress').count(), 0)
  assert.equal(await page.getByRole('button', { name: '自动排班', exact: true }).isEnabled(), true)
  assert.equal(await page.getByRole('button', { name: '自动排班', exact: true }).evaluate(node => node === document.activeElement), true, 'completion restores focus to the generation trigger')
}
async function focusInside(page) { assert.equal(await page.getByRole('dialog').evaluate(node => node.contains(document.activeElement)), true, 'focus remains inside active generation dialog') }
async function fits(page) {
  const viewport = page.viewportSize(), dialog = await page.getByRole('dialog').boundingBox()
  assert.ok(dialog && dialog.x >= 0 && dialog.y >= 0 && dialog.x + dialog.width <= viewport.width + 1 && dialog.y + dialog.height <= viewport.height + 1, JSON.stringify({ viewport, dialog }))
  const overflow = await page.evaluate(() => ({ width: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
  assert.ok(overflow.html <= overflow.width && overflow.body <= overflow.width, JSON.stringify(overflow))
}
async function main() {
  await fs.mkdir(out, { recursive: true }); await fs.rm(path.join(out, 'failure.png'), { force: true })
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  try {
    const { page, control } = await preparePage(fixture, true)
    const first = await start(page, control, undefined, true)
    assert.equal(first.request.options.timeLimitSeconds, 15)
    assert.equal(await first.dialog.locator('.sp-generation-advanced').count(), 0)
    assert.equal(await page.locator('.sp-main .sp-solve-progress').count(), 0, 'progress must not remain in the page behind the dialog')
    assert.equal(await first.dialog.getByRole('progressbar').count(), 0, 'no invented percentage progress')
    record('starting switches the same dialog from options to progress exactly once')

    await page.clock.runFor(2400)
    assert.deepEqual(await timers(first.progress), { total: 2, phase: 2 })
    await emit(page, first.request.requestId, 'loading')
    assert.deepEqual(await timers(first.progress), { total: 2, phase: 0 })
    await page.clock.runFor(2100)
    assert.deepEqual(await timers(first.progress), { total: 4, phase: 2 })
    await emit(page, 'unrelated-request', 'solving')
    assert.deepEqual(await timers(first.progress), { total: 4, phase: 2 })
    await emit(page, first.request.requestId, 'not-a-phase')
    assert.deepEqual(await timers(first.progress), { total: 4, phase: 2 })
    await emit(page, first.request.requestId, 'loading')
    assert.deepEqual(await timers(first.progress), { total: 4, phase: 2 }, 'repeated same-phase event must not reset its timer')
    record('only a new valid phase for the active request resets phase elapsed time')

    await emit(page, first.request.requestId, 'solving')
    assert.deepEqual(await timers(first.progress), { total: 4, phase: 0 })
    assert.match(await first.progress.innerText(), /正在计算方案与轮班公平性/)
    assert.match(await first.progress.innerText(), /排班搜索时限 15 秒，结束后还需返回并校验结果。/)
    await page.clock.runFor(1250)
    assert.deepEqual(await timers(first.progress), { total: 5, phase: 1 })
    await screenshot(page, '01-desktop-solving')
    record('desktop progress shows actual phase and elapsed clocks with selected 15-second search limit')

    await page.keyboard.press('Escape')
    assert.equal(await first.dialog.isVisible(), true)
    const dismiss = first.dialog.getByRole('button', { name: '关闭自动排班', exact: true })
    if (await dismiss.count()) assert.equal(await dismiss.isDisabled(), true)
    await page.locator('.sp-overlay').click({ position: { x: 4, y: 4 } })
    assert.equal(await first.dialog.isVisible(), true)
    await first.dialog.getByRole('button', { name: '取消排班', exact: true }).focus()
    await page.keyboard.press('Tab'); await focusInside(page)
    await page.keyboard.press('Shift+Tab'); await focusInside(page)
    assert.equal(await first.dialog.getByRole('button', { name: '开始生成', exact: true }).count(), 0)
    assert.equal(control.requests.length, 1)
    record('busy dialog resists Escape, backdrop and close dismissal while trapping focus without duplicate starts')

    await emit(page, first.request.requestId, 'finishing')
    assert.deepEqual(await timers(first.progress), { total: 5, phase: 0 })
    await settle(control, first.request, 'success')
    await finished(page, /排班已生成/)
    await page.clock.runFor(500)
    const generated = (await stored(page)).assignments
    assert.equal(generated.filter(item => item.date.startsWith('2026-10') && item.shiftId === 'day').length, 31)
    for (const fixed of fixture.assignments) assert.deepEqual(generated.find(item => item.employeeId === fixed.employeeId && item.date === fixed.date), fixed)
    assert.equal(await page.locator('.sp-solve-result').evaluate(node => node.classList.contains('is-warning')), false)
    record('real Python success payload closes progress, saves complete roster and preserves locked and outside-month entries')

    const second = await start(page, control, 30)
    assert.equal(second.request.options.timeLimitSeconds, 30)
    assert.deepEqual(await timers(second.progress), { total: 0, phase: 0 })
    const secondPhase = await second.progress.locator('[role="status"]').innerText()
    await emit(page, first.request.requestId, 'finishing')
    assert.deepEqual(await timers(second.progress), { total: 0, phase: 0 })
    assert.equal(await second.progress.locator('[role="status"]').innerText(), secondPhase)
    await emit(page, second.request.requestId, 'solving')
    assert.match(await second.progress.innerText(), /排班搜索时限 30 秒/)
    await settle(control, second.request, 'unknown')
    await finished(page, /尚未找到可行方案/)
    assert.deepEqual((await stored(page)).assignments, generated)
    assert.equal(await page.getByRole('button', { name: '导出本次规则', exact: true }).count(), 1)
    record('second run resets timers, uses 30 seconds and preserves roster when no solution was found yet')

    const third = await start(page, control)
    await emit(page, third.request.requestId, 'solving')
    const cancel = third.dialog.getByRole('button', { name: '取消排班', exact: true })
    await cancel.click()
    await until(() => control.cancellations.length === 1, 'cancel reaches the bridge')
    assert.equal(await third.dialog.isVisible(), true, 'dialog stays open until cancellation is settled')
    const cancelling = third.dialog.getByRole('button', { name: '正在取消…', exact: true })
    assert.equal(await cancelling.isDisabled(), true)
    assert.match(await third.progress.innerText(), /正在取消/)
    assert.deepEqual(control.cancelled, [third.request.requestId])
    await cancelling.evaluate(node => node.click())
    await page.keyboard.press('Tab'); await focusInside(page)
    await page.keyboard.press('Shift+Tab'); await focusInside(page)
    assert.equal(control.cancelled.length, 1)
    control.cancellations.at(-1).resolve(true)
    await finished(page, /本次排班已取消，原排班未改变/)
    await page.clock.runFor(500)
    assert.deepEqual((await stored(page)).assignments, generated)
    record('cancel is sent once, traps focus while pending and closes only after confirmation')

    const fourth = await start(page, control)
    await settle(control, third.request, 'success')
    assert.equal(await fourth.dialog.isVisible(), true)
    assert.equal(await page.locator('.sp-solve-result').count(), 0)
    assert.deepEqual((await stored(page)).assignments, generated)
    record('late success from a cancelled request cannot replace the roster or finish a new run')
    await settle(control, fourth.request, 'transport')
    await finished(page, /排班超过等待时长/)
    assert.deepEqual((await stored(page)).assignments, generated)
    assert.doesNotMatch(await page.locator('.sp-solve-result').innerText(), /SOLVE_TIMEOUT|controlled test/)
    record('transport failure closes progress, gives user guidance and retains the roster')

    const fifth = await start(page, control)
    await emit(page, fifth.request.requestId, 'solving')
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 740 }]) {
      await page.setViewportSize(viewport)
      await page.clock.runFor(500)
      await fits(page)
      const bounds = await fifth.dialog.getByRole('button', { name: '取消排班', exact: true }).boundingBox()
      assert.ok(bounds && bounds.height >= 40 && bounds.y + bounds.height <= viewport.height)
      await screenshot(page, `02-progress-${viewport.width}`)
    }
    await fifth.dialog.getByRole('button', { name: '取消排班', exact: true }).click()
    await until(() => control.cancellations.length === 2, 'mobile cancellation reaches the bridge')
    control.cancellations.at(-1).resolve(false)
    await fifth.dialog.getByRole('button', { name: '重试取消', exact: true }).waitFor()
    assert.equal(await fifth.dialog.isVisible(), true)
    await fifth.dialog.getByRole('button', { name: '重试取消', exact: true }).click()
    await until(() => control.cancellations.length === 3, 'retry cancellation reaches the bridge')
    control.cancellations.at(-1).reject(new Error('Controlled cancellation IPC failure'))
    await fifth.dialog.getByRole('button', { name: '重试取消', exact: true }).waitFor()
    assert.equal(await fifth.dialog.isVisible(), true)
    assert.doesNotMatch(await fifth.dialog.innerText(), /IPC failure/)
    await settle(control, fifth.request, 'success')
    await finished(page, /本次排班已取消/)
    await page.clock.runFor(500)
    assert.deepEqual((await stored(page)).assignments, generated)
    assert.equal(control.requests.length, 5)
    record('progress and reachable cancel fit 390px and 320px widths after failures and reruns')
    record('failed cancellation remains retryable and a later success still respects the intent to discard')
    await page.close()

    for (const mode of ['success', 'failure']) {
      const state = clone(fixture)
      if (mode === 'failure') state.shifts[0].required = 3 // Only two employees exist.
      const { page: web } = await preparePage(state)
      await openGenerate(web)
      await web.getByRole('button', { name: '开始生成', exact: true }).click()
      await web.locator('.sp-solve-result').waitFor({ timeout: 45000 })
      assert.equal(await web.getByRole('dialog').count(), 0)
      await web.waitForFunction(() => document.activeElement === document.querySelector('.sp-heading-actions .sp-primary'))
      const observed = await web.evaluate(() => window.__generationObservation)
      assert.deepEqual(observed, { visibleProgress: true, progressInDialog: true, workers: 1 })
      if (mode === 'success') {
        assert.match(await web.locator('.sp-solve-result').innerText(), /排班已生成/)
        await web.waitForFunction(() => JSON.parse(localStorage.getItem('shift-planner:v1')).assignments.filter(item => item.date.startsWith('2026-10') && item.shiftId === 'day').length === 31)
      } else {
        assert.match(await web.locator('.sp-solve-result').innerText(), /暂未找到.*原排班未改变/)
        assert.deepEqual((await stored(web)).assignments, fixture.assignments)
      }
      await screenshot(web, `03-real-worker-${mode}`)
      record(`real web Worker ${mode} displayed dialog progress, then closed it with the correct roster outcome`)
      await web.close()
    }
    assert.deepEqual(report.errors, [])
    record('all controlled desktop and real web lifecycles finish without browser errors')
    report.ok = true
  } catch (error) {
    report.failure = error.stack || String(error)
    await activePage?.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
