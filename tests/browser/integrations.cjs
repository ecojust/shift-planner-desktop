/* Run against Vite with INTEGRATIONS_TEST_URL and optional PLAYWRIGHT_MODULE_PATH /
 * PLAYWRIGHT_EXECUTABLE_PATH. Tests the actual app and its data bridge using controlled
 * Tauri IPC/events in Chromium; native HTTP/MCP transport is covered separately.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const url = process.env.INTEGRATIONS_TEST_URL || 'http://127.0.0.1:5190/'
const out = path.resolve(__dirname, '../../test-results/integrations')
const fixture = {
  version: 1, teamName: 'MCP 验收', month: '2026-10',
  employees: ['甲', '乙'].map((name, index) => ({ id: `qa-${index + 1}`, name: `测试成员${name}`, role: '服务员', group: '测试', color: '#d7e8f8', minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 56, eligibleShiftIds: ['day'], unavailableDates: [] })),
  shifts: [{ id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 1, staffingMode: 'fixed', normalAllowance: 0 }],
  rules: { minRestHours: 11, maxConsecutiveDays: 5 },
  assignments: [{ employeeId: 'qa-1', date: '2026-10-01', shiftId: 'day', locked: true }],
}
const report = { url, scope: 'Real Vue UI/data bridge with controlled Tauri IPC/events; no native transport or packaged window', checks: [], errors: [], screenshots: [], ok: false }
let browser, activePage, nextRequest = 0
const clone = value => JSON.parse(JSON.stringify(value))
function record(name) { report.checks.push(name); console.log('PASS', name) }
async function screenshot(page, name) {
  const file = path.join(out, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  report.screenshots.push(file)
}
async function preparePage(desktop) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  activePage = page
  page.on('pageerror', error => report.errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })
  await page.addInitScript(({ fixture, desktop }) => {
    localStorage.setItem('shift-planner:v1', JSON.stringify(fixture))
    window.__clipboardWrites = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__clipboardWrites.push(text) } } })
    if (!desktop) return
    window.isTauri = true
    const callbacks = new Map(), listeners = new Map()
    let nextCallback = 0, nextListener = 0
    const control = window.__integrationBridge = {
      commands: [], responses: {}, starts: 0, stops: 0, deferStop: false,
      info: { enabled: false, url: '', token: '', serviceId: '' },
    }
    window.__TAURI_INTERNALS__ = {
      transformCallback(fn) { callbacks.set(++nextCallback, fn); return nextCallback },
      unregisterCallback(id) { callbacks.delete(id) },
      async invoke(command, args = {}) {
        control.commands.push(command)
        if (command === 'plugin:event|listen') {
          const id = ++nextListener
          listeners.set(args.event, { handler: args.handler, id })
          return id
        }
        if (command === 'plugin:event|unlisten') return null
        if (command === 'solver_info') return { engine: 'ortools-cp-sat', protocolVersion: 1, version: 'controlled-integration-test', local: true }
        if (command === 'integration_status') return { ...control.info }
        if (command === 'integration_start') {
          control.starts++
          control.info = { enabled: true, url: `http://127.0.0.1:${4317 + control.starts}`, token: `controlled-access-token-${control.starts}-1234567890abcdef`, serviceId: `controlled-service-${control.starts}` }
          return { ...control.info }
        }
        if (command === 'integration_stop') {
          control.stops++
          const finish = () => { control.info = { enabled: false, url: '', token: '', serviceId: '' }; return { ...control.info } }
          if (control.deferStop) return new Promise(resolve => { control.finishStop = () => resolve(finish()) })
          return finish()
        }
        if (command === 'integration_respond') {
          control.responses[args.requestId] = { response: args.response, persisted: JSON.parse(localStorage.getItem('shift-planner:v1')) }
          return null
        }
        throw new Error(`Unexpected mocked IPC command: ${command}`)
      },
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(event, id) { if (listeners.get(event)?.id === id) listeners.delete(event) },
    }
    window.__emitIntegrationRequest = payload => {
      const listener = listeners.get('integration-request')
      const handler = callbacks.get(listener?.handler)
      if (!handler) throw new Error('Expected an active integration-request listener')
      handler({ event: 'integration-request', id: listener.id, payload })
    }
  }, { fixture, desktop })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '排班日历', exact: true }).waitFor()
  return page
}
async function openSettings(page) {
  await page.getByRole('button', { name: '⚙ Setting', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Setting', exact: true })
  await dialog.waitFor()
  return dialog
}
async function request(page, method, args = {}, expired = false, serviceId) {
  const requestId = `browser-request-${++nextRequest}`
  await page.evaluate(({ requestId, method, args, expired, serviceId }) => {
    window.__emitIntegrationRequest({ requestId, serviceId: serviceId ?? window.__integrationBridge.info.serviceId, method, args, expiresAt: Date.now() + (expired ? -1 : 10000) })
  }, { requestId, method, args, expired, serviceId })
  await page.waitForFunction(requestId => Object.hasOwn(window.__integrationBridge.responses, requestId), requestId)
  return page.evaluate(requestId => window.__integrationBridge.responses[requestId], requestId)
}
async function snapshot(page) {
  const { response } = await request(page, 'get_state')
  assert.ok(response.result, JSON.stringify(response))
  return response.result
}
async function copied(page) { return page.evaluate(() => window.__clipboardWrites.at(-1)) }
async function fits(page) {
  const viewport = page.viewportSize(), bounds = await page.getByRole('dialog').boundingBox()
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, JSON.stringify({ viewport, bounds }))
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.getByRole('dialog').evaluate(node => node.scrollWidth > node.clientWidth), false)
}
async function main() {
  await fs.mkdir(out, { recursive: true })
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  try {
    const page = await preparePage(true)
    let dialog = await openSettings(page)
    const toggle = dialog.getByRole('switch', { name: 'MCP', exact: true })
    await page.waitForFunction(() => !document.querySelector('[role="switch"]').disabled)
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    assert.equal(await dialog.locator('input').count(), 0)
    assert.doesNotMatch(await dialog.innerText(), /npm|服务地址|连接并启用同步|同步方向/)
    await toggle.click()
    await page.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true')
    const firstInfo = await page.evaluate(() => window.__integrationBridge.info)
    assert.equal(await page.evaluate(() => window.__integrationBridge.starts), 1)
    assert.match(await dialog.innerText(), /已开启/)
    assert.ok((await dialog.innerText()).includes(`${firstInfo.url}/mcp`))
    assert.ok((await dialog.innerText()).includes(`${firstInfo.url}/api`))
    assert.ok(!(await dialog.innerText()).includes(firstInfo.token))
    const configColors = await dialog.getByRole('button', { name: '复制 MCP 配置', exact: true }).evaluate(node => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }))
    assert.equal(configColors.background, 'rgb(36, 91, 78)')
    assert.equal(configColors.color, 'rgb(255, 255, 255)')
    record('desktop Setting enables MCP directly and shows addresses without setup forms or commands')

    await dialog.getByRole('button', { name: '复制 MCP 地址', exact: true }).click()
    assert.equal(await copied(page), `${firstInfo.url}/mcp`)
    await dialog.getByRole('button', { name: '复制 HTTP API 地址', exact: true }).click()
    assert.equal(await copied(page), `${firstInfo.url}/api`)
    await dialog.getByRole('button', { name: '显示访问令牌', exact: true }).click()
    assert.ok((await dialog.innerText()).includes(firstInfo.token))
    await dialog.getByRole('button', { name: '隐藏访问令牌', exact: true }).click()
    assert.ok(!(await dialog.innerText()).includes(firstInfo.token))
    await dialog.getByRole('button', { name: '复制访问令牌', exact: true }).click()
    assert.equal(await copied(page), firstInfo.token)
    await dialog.getByRole('button', { name: '复制 MCP 配置', exact: true }).click()
    const config = JSON.parse(await copied(page)).mcpServers['shift-schedule-expert']
    assert.deepEqual(config, { type: 'http', url: `${firstInfo.url}/mcp`, headers: { Authorization: `Bearer ${firstInfo.token}` } })
    assert.ok(!(await dialog.innerText()).includes(firstInfo.token))
    await screenshot(page, 'desktop-enabled')
    record('addresses and token copy correctly; token stays masked; copied MCP config includes usable credentials')

    await dialog.getByRole('button', { name: '关闭设置', exact: true }).focus()
    await page.keyboard.press('Shift+Tab')
    assert.equal(await dialog.getByRole('button', { name: '复制 MCP 配置', exact: true }).evaluate(node => node === document.activeElement), true)
    await page.keyboard.press('Tab')
    assert.equal(await dialog.getByRole('button', { name: '关闭设置', exact: true }).evaluate(node => node === document.activeElement), true)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.getByRole('button', { name: '⚙ Setting', exact: true }).evaluate(node => node === document.activeElement), true)
    assert.equal(await page.evaluate(() => window.__integrationBridge.info.enabled), true)
    assert.equal(await page.evaluate(() => window.__integrationBridge.stops), 0)
    record('settings trap keyboard focus, restore focus on Escape and keep MCP running after closing')

    const initial = await snapshot(page)
    assert.equal(initial.state.employees[0].name, fixture.employees[0].name)
    const changed = clone(initial)
    changed.state.employees[0].name = '外部 AI 已修改成员'
    const update = await request(page, 'replace_state', changed)
    assert.ok(update.response.result, JSON.stringify(update.response))
    assert.notEqual(update.response.result.revision, initial.revision)
    assert.equal(update.persisted.employees[0].name, '外部 AI 已修改成员', 'data is saved before response acknowledgement')
    await page.getByText('外部 AI 已修改成员', { exact: true }).first().waitFor()
    assert.match(await page.locator('.sp-context').innerText(), /MCP \/ HTTP/)
    record('external get_state/replace_state reads live data and updates the visible calendar with persistence before acknowledgement')

    const stale = clone(initial)
    stale.state.employees[0].name = '旧版本不得写入'
    const rejectedStale = await request(page, 'replace_state', stale)
    assert.equal(rejectedStale.response.error.status, 409)
    assert.equal(rejectedStale.persisted.employees[0].name, '外部 AI 已修改成员')
    const expired = clone(await snapshot(page))
    expired.state.employees[0].name = '过期请求不得写入'
    const rejectedExpired = await request(page, 'replace_state', expired, true)
    assert.equal(rejectedExpired.response.error.status, 504)
    assert.equal(rejectedExpired.persisted.employees[0].name, '外部 AI 已修改成员')
    record('stale revisions and expired bridge requests are rejected without changing stored data')

    const beforeLocal = await snapshot(page)
    await page.getByRole('button', { name: '下个月', exact: true }).click()
    const afterLocal = await snapshot(page)
    assert.notEqual(afterLocal.state.month, beforeLocal.state.month)
    assert.notEqual(afterLocal.revision, beforeLocal.revision)
    record('external reads immediately see current application changes and a new revision')

    dialog = await openSettings(page)
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await fits(page)
      await screenshot(page, `mobile-${width}`)
    }
    record('enabled connection details fit mobile viewports at 390px and 320px')

    const beforeStop = await snapshot(page)
    await page.evaluate(() => { window.__integrationBridge.deferStop = true })
    await dialog.getByRole('switch', { name: 'MCP', exact: true }).click()
    await page.waitForFunction(() => typeof window.__integrationBridge.finishStop === 'function')
    assert.equal(await dialog.getByRole('switch', { name: 'MCP', exact: true }).getAttribute('aria-checked'), 'false')
    assert.equal(await dialog.getByRole('switch', { name: 'MCP', exact: true }).isDisabled(), true)
    const queued = clone(beforeStop)
    queued.state.employees[0].name = '关闭后的请求不得写入'
    const rejectedQueued = await request(page, 'replace_state', queued)
    assert.equal(rejectedQueued.response.error.status, 503)
    assert.equal(rejectedQueued.persisted.employees[0].name, '外部 AI 已修改成员')
    await page.evaluate(() => { window.__integrationBridge.deferStop = false; window.__integrationBridge.finishStop() })
    await page.waitForFunction(() => !document.querySelector('[role="switch"]').disabled)
    assert.equal(await dialog.getByRole('button', { name: '复制 MCP 配置', exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => window.__integrationBridge.stops), 1)
    assert.equal((await request(page, 'get_state')).response.error.status, 503)
    record('switching off immediately rejects queued data access while native stop is still pending')

    await dialog.getByRole('switch', { name: 'MCP', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true')
    const secondInfo = await page.evaluate(() => window.__integrationBridge.info)
    assert.notEqual(secondInfo.token, firstInfo.token)
    await dialog.getByRole('button', { name: '复制 MCP 配置', exact: true }).click()
    assert.equal(JSON.parse(await copied(page)).mcpServers['shift-schedule-expert'].headers.Authorization, `Bearer ${secondInfo.token}`)
    assert.ok(!(await dialog.innerText()).includes(secondInfo.token))
    assert.equal((await snapshot(page)).state.employees[0].name, '外部 AI 已修改成员')
    record('reenabling publishes newly issued credentials and continues operating on current saved data')
    const oldSession = clone(await snapshot(page))
    oldSession.state.employees[0].name = '旧服务请求不得写入'
    const rejectedOldSession = await request(page, 'replace_state', oldSession, false, firstInfo.serviceId)
    assert.equal(rejectedOldSession.response.error.status, 503)
    assert.equal(rejectedOldSession.persisted.employees[0].name, '外部 AI 已修改成员')
    record('requests from an earlier service session cannot mutate data after reenabling')
    await page.close()

    const web = await preparePage(false)
    dialog = await openSettings(web)
    assert.equal(await dialog.getByRole('switch', { name: 'MCP', exact: true }).isDisabled(), true)
    assert.equal(await dialog.getByRole('switch', { name: 'MCP', exact: true }).getAttribute('aria-checked'), 'false')
    assert.match(await dialog.innerText(), /请使用桌面版/)
    assert.equal(await dialog.locator('input').count(), 0)
    assert.equal(await dialog.getByRole('button', { name: '复制 MCP 配置', exact: true }).count(), 0)
    await screenshot(web, 'browser-unsupported')
    await web.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    record('browser version clearly requests the desktop app and disables the unavailable service switch')
    assert.deepEqual(report.errors, [])
    report.ok = true
    record('all settings and bridge scenarios complete without browser errors')
  } catch (error) {
    report.failure = error.stack || String(error)
    await activePage?.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
