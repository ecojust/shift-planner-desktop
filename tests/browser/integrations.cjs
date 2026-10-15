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
  await page.screenshot({ path: file, fullPage: !name.startsWith('settings-'), animations: 'disabled' })
  report.screenshots.push(file)
}
async function preparePage(desktop, options = {}, initial = fixture) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', ...options })
  activePage = page
  page.on('pageerror', error => report.errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })
  await page.addInitScript(({ fixture, desktop }) => {
    if (!localStorage.getItem('shift-planner:v1')) localStorage.setItem('shift-planner:v1', JSON.stringify(fixture))
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
        if (command === 'import_backup') return control.importContents ?? null
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
  }, { fixture: initial, desktop })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '排班日历', exact: true }).waitFor()
  return page
}
async function openSettings(page) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.waitFor()
  return dialog
}
async function request(page, method, args = {}, { expired = false, serviceId, source = 'mcp' } = {}) {
  const requestId = `browser-request-${++nextRequest}`
  await page.evaluate(({ requestId, method, args, expired, serviceId, source }) => {
    window.__emitIntegrationRequest({ requestId, serviceId: serviceId ?? window.__integrationBridge.info.serviceId, method, args, source, expiresAt: Date.now() + (expired ? -1 : 10000) })
  }, { requestId, method, args, expired, serviceId, source })
  await page.waitForFunction(requestId => Object.hasOwn(window.__integrationBridge.responses, requestId), requestId)
  return page.evaluate(requestId => window.__integrationBridge.responses[requestId], requestId)
}
async function snapshot(page) {
  const { response } = await request(page, 'get_state')
  assert.ok(response.result, JSON.stringify(response))
  return response.result
}
async function copied(page) { return page.evaluate(() => window.__clipboardWrites.at(-1)) }
async function stored(page) { return page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1'))) }
async function closeSettings(page) {
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
}
async function section(page, name) {
  const menu = page.getByRole('button', { name: '打开导航', exact: true })
  if (await menu.isVisible() && !await page.locator('.sp-sidebar').evaluate(node => node.classList.contains('is-open'))) await menu.click()
  await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: new RegExp(name) }).click()
  await page.getByRole('heading', { name, exact: true }).waitFor()
}
async function badge(page, field, source, label) {
  const locator = page.locator(`[data-source-path="${field}"]`)
  await locator.waitFor()
  assert.equal(await locator.count(), 1, `${field} must have one card badge`)
  assert.equal(await locator.getAttribute('data-source'), source, field)
  assert.equal(await locator.innerText(), label, field)
  assert.ok(await locator.getAttribute('aria-label'), 'source badge needs an accessible description')
}
async function localDateTime(page, at) {
  return page.evaluate(value => {
    const date = new Date(value), pad = number => String(number).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }, at)
}
async function scheduleTime(page, stamp) {
  const update = page.locator('.sp-schedule-update')
  if (!stamp) { assert.equal(await update.count(), 0); return }
  await update.waitFor()
  assert.ok((await update.innerText()).includes(`最近 ${stamp.source.toUpperCase()} 排班生成 / 更新`))
  assert.equal(await update.locator('time').getAttribute('datetime'), stamp.at)
  assert.equal(await update.locator('time').innerText(), await localDateTime(page, stamp.at))
}
async function sourceTooltip(page, locator, stamp, { focus = false, pending = false } = {}) {
  await page.mouse.move(0, 0)
  await page.evaluate(() => { if (document.activeElement?.matches('[data-source-path]')) document.activeElement.blur() })
  if (focus) await locator.focus()
  else await locator.hover()
  const tooltip = page.getByRole('tooltip')
  await tooltip.waitFor()
  const text = await tooltip.innerText()
  if (pending) assert.match(text, /未保存|尚未保存/)
  if (stamp) {
    assert.ok(text.includes(({ manual: '手动修改', mcp: 'MCP', http: 'HTTP' })[stamp.source]), text)
    assert.equal(await tooltip.locator('time').getAttribute('datetime'), stamp.at)
    assert.equal(await tooltip.locator('time').innerText(), await localDateTime(page, stamp.at))
    if (pending) assert.match(text, /上次|最近保存|已保存/)
  } else {
    assert.equal(await tooltip.locator('time').count(), 0)
    assert.match(text, /保存后记录修改来源与时间/)
  }
  const viewport = page.viewportSize(), bounds = await tooltip.boundingBox()
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, JSON.stringify({ viewport, bounds }))
  assert.equal(await tooltip.evaluate(node => {
    const bounds = node.getBoundingClientRect()
    return node.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
  }), true, 'tooltip must be visible above panels and scrolling containers')
  return tooltip
}
async function dismissSourceTooltip(page, locator) {
  await page.mouse.move(0, 0)
  await locator.evaluate(node => node.blur())
  await page.getByRole('tooltip').waitFor({ state: 'hidden' })
}
async function deniedWithoutMutation(page, method, args, options = {}) {
  const before = await snapshot(page), persisted = await stored(page)
  const denied = await request(page, method, args, options)
  assert.equal(denied.response.error?.status, 403, JSON.stringify(denied.response))
  assert.deepEqual(denied.persisted, persisted, 'denied write must not partially persist')
  assert.deepEqual(await snapshot(page), before, 'denied write must preserve the complete document and revision')
  return denied
}
async function enableAfterReload(page) {
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '排班日历', exact: true }).waitFor()
  const dialog = await openSettings(page)
  await page.waitForFunction(() => !document.querySelector('[role="switch"]').disabled)
  await dialog.getByRole('switch', { name: 'MCP', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true')
  await closeSettings(page)
}
async function fits(page) {
  const viewport = page.viewportSize(), bounds = await page.getByRole('dialog').boundingBox()
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, JSON.stringify({ viewport, bounds }))
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.getByRole('dialog').evaluate(node => node.scrollWidth > node.clientWidth), false)
  assert.equal(await page.locator('.integration-body').evaluate(node => node.scrollWidth > node.clientWidth), false)
}
async function settingsTrigger(page, size) {
  const trigger = page.getByRole('button', { name: '设置', exact: true })
  assert.equal(await trigger.getAttribute('title'), '设置')
  assert.equal(await trigger.getAttribute('aria-haspopup'), 'dialog')
  assert.equal(await trigger.innerText(), '', 'settings trigger must have no visible label or emoji')
  assert.equal(await trigger.locator(':scope > svg').count(), 1, 'settings trigger needs a real SVG icon')
  assert.equal(await trigger.evaluate(node => node.classList.contains('sp-settings-trigger') && node.children.length === 1), true)
  assert.equal(await trigger.evaluate(node => node.parentElement.matches('.sp-top-actions') && node.parentElement.lastElementChild === node), true)
  const bounds = await trigger.boundingBox(), viewport = page.viewportSize()
  assert.ok(bounds && Math.abs(bounds.width - size) < 1 && Math.abs(bounds.height - size) < 1, JSON.stringify({ bounds, size }))
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1, JSON.stringify({ bounds, viewport }))
  assert.equal(await trigger.evaluate(node => {
    const rect = node.getBoundingClientRect()
    return [...node.parentElement.children].filter(sibling => sibling !== node && sibling.getClientRects().length)
      .every(sibling => sibling.getBoundingClientRect().right <= rect.left + 1)
  }), true, 'settings gear must be to the right of every other topbar action')
}
async function checkAggregatedCards() {
  const seed = clone(fixture)
  seed.employees.push({ ...clone(seed.employees[1]), id: 'qa-10', name: '独立来源成员' })
  seed.shifts.push({ ...clone(seed.shifts[0]), id: 'day-2', name: '独立来源班次', start: '16:00', end: '00:00', required: 0 })
  seed.rules.weekdayWeights = { days: [1, 6], percent: 40 }
  seed.rules.separationGroups = [
    { id: 'g1', name: '第一互斥组', employeeIds: ['qa-1', 'qa-2'], shiftIds: ['day'] },
    { id: 'g10', name: '独立互斥组', employeeIds: ['qa-2', 'qa-10'], shiftIds: [] },
  ]
  const old = { source: 'mcp', at: '2026-10-10T08:00:00.000Z' }
  const manual = { source: 'manual', at: '2026-10-11T09:00:00.000Z' }
  const latest = { source: 'http', at: '2026-10-12T10:00:00.000Z' }
  const unrelated = { source: 'mcp', at: '2026-10-14T11:00:00.000Z' }
  // Deliberately omit aggregate parent records and keep insertion order out of time order.
  seed.provenance = { fields: {
    'employees.qa-1.role': latest, 'employees.qa-1.name': old, 'employees.qa-1.group': manual,
    'employees.qa-10.name': unrelated,
    'shifts.day.required': latest, 'shifts.day.name': old, 'shifts.day.color': manual,
    'shifts.day-2.name': unrelated,
    'rules.minRestHours': old, 'rules.maxConsecutiveDays': manual,
    'rules.weekdayWeights.percent': latest,
    'rules.separationGroups.g1.employeeIds': latest, 'rules.separationGroups.g1.name': old,
    'rules.separationGroups.g10.name': unrelated,
  } }
  const page = await preparePage(false, {}, seed)
  await section(page, '成员管理')
  assert.equal(await page.locator('.sp-settings-employee-card').count(), 3)
  for (const [id, count] of [['qa-1', 1], ['qa-2', 0], ['qa-10', 1]]) {
    assert.equal(await page.locator(`#member-${id} .sp-source-badge`).count(), count, id)
  }
  await badge(page, 'employees.qa-1', 'http', 'HTTP')
  await badge(page, 'employees.qa-10', 'mcp', 'MCP')
  const memberBadge = page.locator('[data-source-path="employees.qa-1"]')
  await sourceTooltip(page, memberBadge, latest)
  await screenshot(page, 'aggregated-member-cards')
  await dismissSourceTooltip(page, memberBadge)
  assert.equal(await page.locator('[data-source-path="employees.qa-1.name"]').count(), 0)
  record('member cards aggregate the latest field source into one badge, hide untracked members and do not mix qa-1 with qa-10')
  await page.getByRole('button', { name: '添加员工', exact: true }).click()
  const newMember = page.getByRole('dialog', { name: '添加员工', exact: true })
  assert.equal(await newMember.locator('.sp-source-badge').count(), 0)
  await newMember.getByRole('textbox', { name: '员工姓名', exact: true }).fill(seed.employees[0].name)
  assert.equal(await newMember.locator('.sp-source-badge').count(), 1)
  assert.equal(await newMember.locator('.sp-source-badge').getAttribute('data-source'), 'pending')
  await newMember.getByRole('button', { name: '保存人员', exact: true }).click()
  await newMember.getByRole('alert').waitFor()
  assert.match(await newMember.getByRole('alert').innerText(), /同名/)
  assert.equal(await newMember.locator('.sp-source-badge').count(), 1)
  assert.equal(await newMember.locator('.sp-source-badge').getAttribute('data-source'), 'pending')
  await newMember.getByRole('button', { name: '取消', exact: true }).click()
  await newMember.waitFor({ state: 'detached' })
  assert.equal(await page.locator('.sp-settings-employee-card').count(), 3)
  assert.equal(await page.locator('[data-source="pending"]').count(), 0)
  record('a new member has no initial badge and retains one pending badge after a duplicate-name save failure without adding a card')

  await section(page, '班次设置')
  assert.equal(await page.locator('.sp-settings-shift-card').count(), 2)
  for (const card of await page.locator('.sp-settings-shift-card').all()) assert.equal(await card.locator('.sp-source-badge').count(), 1)
  await badge(page, 'shifts.day', 'http', 'HTTP')
  await badge(page, 'shifts.day-2', 'mcp', 'MCP')
  const shiftBadge = page.locator('[data-source-path="shifts.day"]')
  await sourceTooltip(page, shiftBadge, latest)
  await screenshot(page, 'aggregated-shift-cards')
  await dismissSourceTooltip(page, shiftBadge)
  record('each shift card has one latest-source badge and a newer neighboring shift does not leak into it')
  await page.getByRole('button', { name: '新建班次', exact: true }).click()
  const newShift = page.getByRole('dialog', { name: '新建班次', exact: true })
  assert.equal(await newShift.locator('.sp-source-badge').count(), 0)
  const shiftName = newShift.getByRole('textbox', { name: '班次名称', exact: true })
  await shiftName.fill('尚未保存的新班次')
  assert.equal(await newShift.locator('.sp-source-badge').count(), 1)
  assert.equal(await newShift.locator('.sp-source-badge').getAttribute('data-source'), 'pending')
  await shiftName.fill('')
  assert.equal(await newShift.locator('.sp-source-badge').count(), 0)
  await newShift.getByRole('button', { name: '取消', exact: true }).click()
  await newShift.waitFor({ state: 'detached' })

  await section(page, '排班规则')
  const basicCard = page.locator('form[aria-label="个人休息与连续工作规则"]')
  assert.equal(await basicCard.locator('.sp-source-badge').count(), 1)
  const basicBadge = basicCard.locator('[data-source-path="rules.minRestHours"]')
  assert.equal(await basicBadge.getAttribute('data-source'), 'manual')
  await sourceTooltip(page, basicBadge, manual)
  await screenshot(page, 'aggregated-personal-rule-card')
  await dismissSourceTooltip(page, basicBadge)
  assert.equal(await page.locator('[data-source-path="rules.nonConsecutiveShifts"]').count(), 0)
  assert.equal(await page.locator('[data-source-path="rules.weeklyShiftLimits"]').count(), 0)
  await page.getByRole('tab', { name: '团队规则', exact: true }).click()
  const weightCard = page.locator('form[aria-label="团队上班权重规则"]')
  assert.equal(await weightCard.locator('.sp-source-badge').count(), 1)
  await sourceTooltip(page, weightCard.locator('[data-source-path="rules.weekdayWeights"]'), latest)
  await dismissSourceTooltip(page, weightCard.locator('[data-source-path="rules.weekdayWeights"]'))
  assert.equal(await page.locator('.sp-settings-separation-group').count(), 2)
  for (const card of await page.locator('.sp-settings-separation-group').all()) assert.equal(await card.locator('.sp-source-badge').count(), 1)
  await badge(page, 'rules.separationGroups.g1', 'http', 'HTTP')
  await badge(page, 'rules.separationGroups.g10', 'mcp', 'MCP')
  const separationBadge = page.locator('[data-source-path="rules.separationGroups.g1"]')
  await sourceTooltip(page, separationBadge, latest)
  await screenshot(page, 'aggregated-team-rule-cards')
  await dismissSourceTooltip(page, separationBadge)
  record('rule cards aggregate only their own fields and separation-group IDs without copying a newer sibling source')
  await page.getByRole('button', { name: /添加互斥组/ }).click()
  const newGroup = page.locator('.sp-settings-separation-editor')
  assert.equal(await newGroup.locator('.sp-source-badge').count(), 0)
  await newGroup.getByRole('textbox', { name: '规则名称', exact: true }).fill('尚未保存的新互斥组')
  assert.equal(await newGroup.locator('.sp-source-badge').count(), 1)
  assert.equal(await newGroup.locator('.sp-source-badge').getAttribute('data-source'), 'pending')
  await newGroup.getByRole('textbox', { name: '规则名称', exact: true }).fill('')
  assert.equal(await newGroup.locator('.sp-source-badge').count(), 0)
  await newGroup.getByRole('button', { name: '取消', exact: true }).click()
  await newGroup.waitFor({ state: 'detached' })
  record('new shift and separation drafts show no initial badge, one badge only while changed, and hide it when restored')

  await page.setViewportSize({ width: 320, height: 480 })
  for (const [sectionName, cardSelector] of [
    ['成员管理', '.sp-settings-employee-card'],
    ['班次设置', '.sp-settings-shift-card'],
    ['排班规则', 'form.sp-settings-config-card:visible, .sp-settings-separation-group:visible, .sp-shift-rule-card:visible'],
  ]) {
    await section(page, sectionName)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, sectionName)
    for (const card of await page.locator(cardSelector).all()) {
      assert.ok(await card.locator('.sp-source-badge').count() <= 1, `${sectionName} cards must not repeat badges`)
      assert.equal(await card.evaluate(node => node.scrollWidth > node.clientWidth), false, sectionName)
    }
    await screenshot(page, `aggregated-cards-320-${sectionName}`)
  }
  record('aggregated member, shift and rule cards fit 320px screens and retain at most one badge per card')
  await page.close()
}
async function main() {
  await fs.mkdir(out, { recursive: true })
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  try {
    const page = await preparePage(true)
    for (const viewport of [{ width: 1440, height: 960 }, { width: 800, height: 600 }, { width: 320, height: 480 }]) {
      await page.setViewportSize(viewport)
      await settingsTrigger(page, 32)
      await screenshot(page, `settings-trigger-${viewport.width}`)
    }
    await page.setViewportSize({ width: 1440, height: 960 })
    record('settings gear is a 32px SVG-only button at the far right of desktop and narrow topbars')
    let dialog = await openSettings(page)
    const toggle = dialog.getByRole('switch', { name: 'MCP', exact: true })
    await page.waitForFunction(() => !document.querySelector('[role="switch"]').disabled)
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    assert.equal(await dialog.getByRole('checkbox').count(), 4)
    for (const [name, checked] of [['成员', true], ['班次', false], ['排班规则', false], ['排班结果', false]]) {
      const checkbox = dialog.getByRole('checkbox', { name: `允许修改${name}`, exact: true })
      assert.equal(await checkbox.isChecked(), checked)
      assert.equal(await checkbox.isDisabled(), false)
    }
    assert.equal(await dialog.locator('input:not([type="checkbox"])').count(), 0)
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
    record('desktop settings enable MCP directly and show addresses without setup forms or commands')

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
    assert.equal(await page.getByRole('button', { name: '设置', exact: true }).evaluate(node => node === document.activeElement), true)
    assert.equal(await page.evaluate(() => window.__integrationBridge.info.enabled), true)
    assert.equal(await page.evaluate(() => window.__integrationBridge.stops), 0)
    record('settings trap keyboard focus, restore focus on Escape and keep MCP running after closing')

    await section(page, '成员管理')
    assert.equal(await page.locator('.sp-settings-employee-card').count(), 2)
    assert.equal(await page.locator('.sp-source-badge').count(), 0, 'legacy cards without saved history must have no badge')
    await section(page, '排班日历')
    record('legacy member cards with no saved history hide provenance badges entirely')
    const initial = await snapshot(page)
    await scheduleTime(page)
    assert.equal(initial.state.employees[0].name, fixture.employees[0].name)
    const changed = clone(initial)
    changed.state.employees[0].name = '外部 AI 已修改成员'
    const update = await request(page, 'replace_state', changed)
    assert.ok(update.response.result, JSON.stringify(update.response))
    assert.notEqual(update.response.result.revision, initial.revision)
    assert.equal(update.persisted.employees[0].name, '外部 AI 已修改成员', 'data is saved before response acknowledgement')
    await page.getByText('外部 AI 已修改成员', { exact: true }).first().waitFor()
    assert.match(await page.locator('.sp-context').innerText(), /已通过 MCP 更新/)
    assert.equal(update.persisted.provenance.fields['employees.qa-1.name'].source, 'mcp')
    await scheduleTime(page)
    record('external get_state/replace_state reads live data and updates the visible calendar with persistence before acknowledgement')

    const stale = clone(initial)
    stale.state.employees[0].name = '旧版本不得写入'
    const rejectedStale = await request(page, 'replace_state', stale)
    assert.equal(rejectedStale.response.error.status, 409)
    assert.equal(rejectedStale.persisted.employees[0].name, '外部 AI 已修改成员')
    const expired = clone(await snapshot(page))
    expired.state.employees[0].name = '过期请求不得写入'
    const rejectedExpired = await request(page, 'replace_state', expired, { expired: true })
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
    const rejectedOldSession = await request(page, 'replace_state', oldSession, { serviceId: firstInfo.serviceId })
    assert.equal(rejectedOldSession.response.error.status, 503)
    assert.equal(rejectedOldSession.persisted.employees[0].name, '外部 AI 已修改成员')
    record('requests from an earlier service session cannot mutate data after reenabling')
    await closeSettings(page)
    await page.setViewportSize({ width: 1440, height: 960 })

    const baseline = await snapshot(page)
    for (const [field, source] of [['shifts', 'mcp'], ['rules', 'http']]) {
      const change = clone(baseline)
      if (field === 'shifts') change.state.shifts[0].name = '未授权班次'
      else change.state.rules.minRestHours = 12
      await deniedWithoutMutation(page, 'replace_state', change, { source })
    }
    await deniedWithoutMutation(page, 'set_assignment', { revision: baseline.revision, employeeId: 'qa-2', date: '2026-11-02', shiftId: 'off' })
    const mixed = clone(baseline)
    mixed.state.employees[0].name = '混合写入不得部分保存'
    mixed.state.shifts[0].name = '混合未授权班次'
    mixed.state.rules.minRestHours = 12
    mixed.state.assignments.push({ employeeId: 'qa-2', date: '2026-11-02', shiftId: 'off', locked: false })
    await deniedWithoutMutation(page, 'replace_state', mixed, { source: 'http' })
    assert.ok((await request(page, 'validate_schedule', {}, { source: 'http' })).response.result)
    record('default permissions reject shifts, rules, single assignments and mixed full-document writes atomically while reads remain available')

    dialog = await openSettings(page)
    for (const name of ['班次', '排班规则', '排班结果']) await dialog.getByRole('checkbox', { name: `允许修改${name}`, exact: true }).check()
    await closeSettings(page)
    const permitted = clone(await snapshot(page))
    permitted.state.shifts[0].name = '授权后的日班'
    permitted.state.rules.minRestHours = 12
    assert.ok((await request(page, 'replace_state', permitted, { source: 'http' })).response.result)
    const assignment = await request(page, 'set_assignment', { revision: (await snapshot(page)).revision, employeeId: 'qa-2', date: '2026-11-02', shiftId: 'off' })
    assert.ok(assignment.response.result, JSON.stringify(assignment.response))
    assert.equal(assignment.persisted.assignments.some(item => item.employeeId === 'qa-2' && item.date === '2026-11-02'), true)
    dialog = await openSettings(page)
    for (const name of ['班次', '排班规则', '排班结果']) await dialog.getByRole('checkbox', { name: `允许修改${name}`, exact: true }).uncheck()
    await closeSettings(page)
    const revoked = clone(await snapshot(page))
    revoked.state.shifts[0].name = '撤销后不得修改'
    await deniedWithoutMutation(page, 'replace_state', revoked)
    const revokedRule = clone(await snapshot(page))
    revokedRule.state.rules.minRestHours = 13
    await deniedWithoutMutation(page, 'replace_state', revokedRule, { source: 'http' })
    await deniedWithoutMutation(page, 'set_assignment', { revision: (await snapshot(page)).revision, employeeId: 'qa-2', date: '2026-11-03', shiftId: 'off' })
    record('checking write permissions grants access immediately and revoking them immediately blocks both transports')

    const beforeHttp = await snapshot(page)
    const httpChange = clone(beforeHttp)
    httpChange.state.employees[0].role = 'HTTP 调整的岗位'
    const httpResult = await request(page, 'replace_state', httpChange, { source: 'http' })
    assert.ok(httpResult.response.result, JSON.stringify(httpResult.response))
    assert.equal(httpResult.persisted.provenance.fields['employees.qa-1.role'].source, 'http')
    assert.deepEqual(httpResult.persisted.provenance.fields['employees.qa-1.name'], beforeHttp.state.provenance.fields['employees.qa-1.name'])
    assert.equal(httpResult.persisted.provenance.fields['employees.qa-1.group'], undefined)
    assert.match(await page.locator('.sp-context').innerText(), /已通过 HTTP 更新/)
    await section(page, '成员管理')
    await badge(page, 'employees.qa-1', 'http', 'HTTP')
    assert.equal(await page.locator('#member-qa-1 .sp-source-badge').count(), 1)
    assert.equal(await page.locator('#member-qa-2 .sp-source-badge').count(), 0)
    const latestMemberBadge = page.locator('[data-source-path="employees.qa-1"]')
    await sourceTooltip(page, latestMemberBadge, httpResult.persisted.provenance.fields['employees.qa-1.role'])
    await dismissSourceTooltip(page, latestMemberBadge)
    await screenshot(page, 'field-sources-mcp-http')
    await section(page, '排班日历')
    record('one member card badge shows the latest HTTP source and exact time while saved field histories remain independent')

    const forged = clone(await snapshot(page))
    const oldRoleStamp = clone(forged.state.provenance.fields['employees.qa-1.role'])
    forged.state.employees[0].name = 'HTTP 可信来源成员'
    forged.source = 'mcp'
    forged.state.provenance = { fields: { 'employees.qa-1.name': { source: 'manual', at: '2000-01-01T00:00:00.000Z' } } }
    const trusted = await request(page, 'replace_state', forged, { source: 'http' })
    assert.ok(trusted.response.result, JSON.stringify(trusted.response))
    assert.equal(trusted.persisted.provenance.fields['employees.qa-1.name'].source, 'http')
    assert.notEqual(trusted.persisted.provenance.fields['employees.qa-1.name'].at, '2000-01-01T00:00:00.000Z')
    assert.deepEqual(trusted.persisted.provenance.fields['employees.qa-1.role'], oldRoleStamp)
    assert.equal(trusted.persisted.provenance.pendingExternalChange.source, 'http')
    const metadataOnly = clone(await snapshot(page))
    metadataOnly.state.provenance = { fields: {} }
    const noMetadataChange = await request(page, 'replace_state', metadataOnly, { source: 'mcp' })
    assert.deepEqual(noMetadataChange.response.result, await snapshot(page))
    assert.deepEqual(noMetadataChange.persisted.provenance, trusted.persisted.provenance)
    await deniedWithoutMutation(page, 'replace_state', clone(await snapshot(page)), { source: 'forged' })
    record('caller-provided metadata and args.source cannot forge field provenance or erase pending external-change notices')

    await section(page, '成员管理')
    await badge(page, 'employees.qa-1', 'http', 'HTTP')
    await page.getByRole('button', { name: '编辑HTTP 可信来源成员', exact: true }).click()
    const employeeDialog = page.getByRole('dialog', { name: '编辑成员资料', exact: true })
    await employeeDialog.getByRole('textbox', { name: '员工姓名', exact: true }).fill('手动修改后的成员')
    assert.equal(await employeeDialog.locator('[data-source-path="employees.qa-1"]').getAttribute('data-source'), 'pending')
    await employeeDialog.getByRole('button', { name: '保存人员', exact: true }).click()
    await employeeDialog.waitFor({ state: 'detached' })
    await badge(page, 'employees.qa-1', 'manual', '手动修改')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('shift-planner:v1')).employees[0].name === '手动修改后的成员')
    const manuallySaved = await stored(page)
    assert.equal(manuallySaved.provenance.fields['employees.qa-1.name'].source, 'manual')
    assert.deepEqual(manuallySaved.provenance.fields['employees.qa-1.role'], oldRoleStamp)
    assert.deepEqual(manuallySaved.provenance.pendingExternalChange, trusted.persisted.provenance.pendingExternalChange)
    await screenshot(page, 'field-sources-manual-http')
    await section(page, '排班日历')
    record('a manual member edit updates the single card badge while preserving other saved field sources and the review notice')

    dialog = await openSettings(page)
    await dialog.getByRole('checkbox', { name: '允许修改班次', exact: true }).check()
    await closeSettings(page)
    const beforeReload = await snapshot(page)
    await enableAfterReload(page)
    const reloaded = await snapshot(page)
    assert.deepEqual(reloaded.state.provenance, beforeReload.state.provenance)
    assert.equal(reloaded.state.employees[0].name, '手动修改后的成员')
    const notice = page.getByRole('status', { name: '外部配置变更提醒', exact: true })
    await notice.waitFor()
    assert.match(await notice.innerText(), /HTTP/)
    assert.match(await notice.innerText(), /不会自动重新排班/)
    dialog = await openSettings(page)
    for (const [name, checked] of [['成员', true], ['班次', true], ['排班规则', false], ['排班结果', false]]) {
      assert.equal(await dialog.getByRole('checkbox', { name: `允许修改${name}`, exact: true }).isChecked(), checked)
    }
    await closeSettings(page)
    const afterReloadShift = clone(await snapshot(page))
    afterReloadShift.state.shifts[0].name = '刷新后权限仍生效'
    assert.ok((await request(page, 'replace_state', afterReloadShift)).response.result)
    await section(page, '成员管理')
    await badge(page, 'employees.qa-1', 'manual', '手动修改')
    await section(page, '排班日历')
    record('field provenance, pending configuration review and nondefault permissions survive a full reload')

    const beforeAcknowledgement = await snapshot(page)
    await notice.getByRole('button', { name: '已核对变更', exact: true }).click()
    await notice.waitFor({ state: 'detached' })
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('shift-planner:v1')).provenance.pendingExternalChange)
    assert.deepEqual((await stored(page)).provenance.fields, beforeAcknowledgement.state.provenance.fields)
    await enableAfterReload(page)
    assert.equal(await notice.count(), 0)
    const laterChange = clone(await snapshot(page))
    laterChange.state.employees[0].group = '后续外部变更'
    assert.ok((await request(page, 'replace_state', laterChange, { source: 'http' })).response.result)
    await notice.waitFor()
    assert.match(await notice.innerText(), /HTTP/)
    await screenshot(page, 'pending-external-review')
    record('acknowledging external changes persistently clears the notice without losing sources and a later change restores it')

    const referenceMonth = (await snapshot(page)).state.month
    const referencePath = `monthlyReferenceHours.${referenceMonth}`
    await section(page, '成员管理')
    const referenceInput = page.getByRole('spinbutton', { name: '手动月参考工时', exact: true })
    await referenceInput.fill('160')
    await referenceInput.blur()
    await page.waitForFunction(month => JSON.parse(localStorage.getItem('shift-planner:v1')).monthlyReferenceHours?.[month] === 160, referenceMonth)
    await badge(page, referencePath, 'manual', '手动修改')
    await page.getByRole('button', { name: '恢复自动', exact: true }).click()
    const resetDialog = page.getByRole('alertdialog', { name: `恢复 ${referenceMonth} 的自动参考工时？`, exact: true })
    await resetDialog.getByRole('button', { name: '确认恢复', exact: true }).click()
    await resetDialog.waitFor({ state: 'detached' })
    await badge(page, referencePath, 'manual', '手动修改')
    await page.waitForFunction(month => {
      const state = JSON.parse(localStorage.getItem('shift-planner:v1'))
      return !Object.hasOwn(state.monthlyReferenceHours ?? {}, month) && state.provenance.fields[`monthlyReferenceHours.${month}`]?.source === 'manual'
    }, referenceMonth)
    const resetStamp = clone((await stored(page)).provenance.fields[referencePath])
    await enableAfterReload(page)
    assert.equal(Object.hasOwn((await snapshot(page)).state.monthlyReferenceHours ?? {}, referenceMonth), false)
    assert.deepEqual((await stored(page)).provenance.fields[referencePath], resetStamp)
    await section(page, '成员管理')
    await badge(page, referencePath, 'manual', '手动修改')
    assert.equal(await page.getByRole('button', { name: '恢复自动', exact: true }).isDisabled(), true)
    await screenshot(page, 'restored-reference-source')
    await section(page, '排班日历')
    record('restoring automatic reference hours retains the manual source for the omitted override through persistence and reload')

    const backup = clone((await snapshot(page)).state)
    assert.equal(backup.provenance.fields['employees.qa-1.name'].source, 'manual')
    assert.equal(backup.provenance.fields['employees.qa-1.role'].source, 'http')
    assert.equal(backup.provenance.fields['shifts.day.name'].source, 'mcp')
    assert.ok(backup.provenance.pendingExternalChange)
    dialog = await openSettings(page)
    await dialog.getByRole('checkbox', { name: '允许修改班次', exact: true }).uncheck()
    await dialog.getByRole('checkbox', { name: '允许修改排班规则', exact: true }).check()
    await closeSettings(page)
    const permissionsBeforeImport = await page.evaluate(() => localStorage.getItem('shift-planner:integration-permissions:v1'))
    const temporaryChange = clone(await snapshot(page))
    temporaryChange.state.employees[0].role = '导入前临时岗位'
    assert.ok((await request(page, 'replace_state', temporaryChange, { source: 'http' })).response.result)
    assert.notDeepEqual((await snapshot(page)).state, backup)
    await page.evaluate(contents => { window.__integrationBridge.importContents = contents }, JSON.stringify(backup))
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click()
    const backupDialog = page.getByRole('dialog', { name: '备份与恢复', exact: true })
    await backupDialog.getByRole('button', { name: /导入备份文件/ }).click()
    const importDialog = page.getByRole('dialog', { name: '确认恢复这个工作空间？', exact: true })
    await importDialog.waitFor()
    assert.equal(await page.evaluate(() => window.__integrationBridge.commands.filter(command => command === 'import_backup').length), 1)
    await importDialog.getByRole('button', { name: '确认导入', exact: true }).click()
    await importDialog.waitFor({ state: 'detached' })
    await page.waitForFunction(role => JSON.parse(localStorage.getItem('shift-planner:v1')).employees[0].role === role, backup.employees[0].role)
    assert.deepEqual((await snapshot(page)).state, backup)
    assert.deepEqual((await stored(page)).provenance, backup.provenance)
    assert.equal(await page.evaluate(() => localStorage.getItem('shift-planner:integration-permissions:v1')), permissionsBeforeImport)
    assert.match(await page.locator('.sp-context').innerText(), /已导入备份排班/)
    await notice.waitFor()
    assert.match(await notice.innerText(), /HTTP/)
    await section(page, '成员管理')
    await badge(page, 'employees.qa-1', 'http', 'HTTP')
    await badge(page, referencePath, 'manual', '手动修改')
    await screenshot(page, 'import-preserves-field-sources')
    await section(page, '排班日历')
    dialog = await openSettings(page)
    assert.equal(await dialog.getByRole('checkbox', { name: '允许修改班次', exact: true }).isChecked(), false)
    assert.equal(await dialog.getByRole('checkbox', { name: '允许修改排班规则', exact: true }).isChecked(), true)
    await closeSettings(page)
    record('confirmed JSON backup import replaces changed data while preserving mixed sources, pending review and independent device permissions')

    const scheduleMonth = (await snapshot(page)).state.month
    dialog = await openSettings(page)
    await dialog.getByRole('checkbox', { name: '允许修改排班结果', exact: true }).check()
    await closeSettings(page)
    const newAssignment = await request(page, 'set_assignment', { revision: (await snapshot(page)).revision, employeeId: 'qa-1', date: `${scheduleMonth}-03`, shiftId: 'day' })
    assert.ok(newAssignment.response.result, JSON.stringify(newAssignment.response))
    const mcpScheduleStamp = clone(newAssignment.persisted.provenance.scheduleUpdates[scheduleMonth])
    assert.equal(mcpScheduleStamp.source, 'mcp')
    assert.ok(Number.isFinite(Date.parse(mcpScheduleStamp.at)))
    await scheduleTime(page, mcpScheduleStamp)
    await screenshot(page, 'mcp-schedule-update-time')
    await enableAfterReload(page)
    assert.deepEqual((await snapshot(page)).state.provenance.scheduleUpdates[scheduleMonth], mcpScheduleStamp)
    await scheduleTime(page, mcpScheduleStamp)
    record('successful MCP assignment changes show the current month update timestamp and preserve it through reload')

    const beforeNoOps = clone((await snapshot(page)).state.provenance.scheduleUpdates)
    await request(page, 'get_state')
    await request(page, 'validate_schedule', {}, { source: 'http' })
    const unchanged = await request(page, 'set_assignment', { revision: (await snapshot(page)).revision, employeeId: 'qa-1', date: `${scheduleMonth}-03`, shiftId: 'day' })
    assert.ok(unchanged.response.result)
    const configOnly = clone(await snapshot(page))
    configOnly.state.employees[0].group = '仅更新配置不刷新排班时间'
    assert.ok((await request(page, 'replace_state', configOnly)).response.result)
    const invalidAssignment = await request(page, 'set_assignment', { revision: (await snapshot(page)).revision, employeeId: 'qa-1', date: 'not-a-date', shiftId: 'off' })
    assert.equal(invalidAssignment.response.error?.status, 400)
    dialog = await openSettings(page)
    await dialog.getByRole('checkbox', { name: '允许修改排班结果', exact: true }).uncheck()
    await closeSettings(page)
    await deniedWithoutMutation(page, 'set_assignment', { revision: (await snapshot(page)).revision, employeeId: 'qa-1', date: `${scheduleMonth}-04`, shiftId: 'off' })
    assert.deepEqual((await snapshot(page)).state.provenance.scheduleUpdates, beforeNoOps)
    await scheduleTime(page, mcpScheduleStamp)
    record('reads, config-only writes, no-op assignments, invalid inputs and denied writes do not refresh schedule timestamps')

    // Ordinary calendar editing must retain the last external update stamp.
    const manualState = (await snapshot(page)).state
    const currentMemberName = manualState.employees[0].name
    const currentShiftName = manualState.shifts.find(shift => shift.id === 'day').name
    await page.getByRole('button', { name: '月视图', exact: true }).click()
    await page.getByRole('button', { name: `${currentMemberName} ${scheduleMonth}-03 ${currentShiftName}，点击编辑`, exact: true }).click()
    const assignmentDialog = page.getByRole('dialog', { name: '调整班次', exact: true })
    await assignmentDialog.getByRole('button', { name: /安排休息/ }).click()
    await assignmentDialog.getByRole('button', { name: '保存安排', exact: true }).click()
    await assignmentDialog.waitFor({ state: 'detached' })
    await page.waitForFunction(({ month }) => JSON.parse(localStorage.getItem('shift-planner:v1')).assignments.some(item => item.employeeId === 'qa-1' && item.date === `${month}-03` && item.shiftId === 'off'), { month: scheduleMonth })
    assert.deepEqual((await snapshot(page)).state.provenance.scheduleUpdates, beforeNoOps)
    await scheduleTime(page, mcpScheduleStamp)
    record('manual calendar edits retain the most recent external schedule timestamp')

    dialog = await openSettings(page)
    await dialog.getByRole('checkbox', { name: '允许修改排班结果', exact: true }).check()
    await closeSettings(page)
    const otherMonth = '2026-12'
    const otherMonthWrite = await request(page, 'set_assignment', { revision: (await snapshot(page)).revision, employeeId: 'qa-2', date: `${otherMonth}-02`, shiftId: 'day' }, { source: 'http' })
    assert.ok(otherMonthWrite.response.result)
    const httpScheduleStamp = clone(otherMonthWrite.persisted.provenance.scheduleUpdates[otherMonth])
    assert.equal(httpScheduleStamp.source, 'http')
    assert.deepEqual(otherMonthWrite.persisted.provenance.scheduleUpdates[scheduleMonth], mcpScheduleStamp)
    await scheduleTime(page, mcpScheduleStamp)
    await page.getByRole('button', { name: '下个月', exact: true }).click()
    assert.equal((await snapshot(page)).state.month, otherMonth)
    await scheduleTime(page, httpScheduleStamp)
    const deleted = await request(page, 'set_assignment', { revision: (await snapshot(page)).revision, employeeId: 'qa-2', date: `${otherMonth}-02`, remove: true })
    assert.ok(deleted.response.result)
    const deletionStamp = clone(deleted.persisted.provenance.scheduleUpdates[otherMonth])
    assert.equal(deletionStamp.source, 'mcp')
    assert.notEqual(deletionStamp.at, httpScheduleStamp.at)
    assert.deepEqual(deleted.persisted.provenance.scheduleUpdates[scheduleMonth], mcpScheduleStamp)
    await scheduleTime(page, deletionStamp)
    await page.getByRole('button', { name: '上个月', exact: true }).click()
    await scheduleTime(page, mcpScheduleStamp)
    record('HTTP and MCP track update times separately per changed month, including deletions, and month navigation shows the matching stamp')

    const scheduleBackup = clone((await snapshot(page)).state)
    const nextScheduleWrite = await request(page, 'set_assignment', { revision: (await snapshot(page)).revision, employeeId: 'qa-1', date: `${scheduleMonth}-05`, shiftId: 'day' }, { source: 'http' })
    assert.ok(nextScheduleWrite.response.result)
    assert.equal(nextScheduleWrite.persisted.provenance.scheduleUpdates[scheduleMonth].source, 'http')
    await page.evaluate(contents => { window.__integrationBridge.importContents = contents }, JSON.stringify(scheduleBackup))
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click()
    await page.getByRole('dialog', { name: '备份与恢复', exact: true }).getByRole('button', { name: /导入备份文件/ }).click()
    await page.getByRole('dialog', { name: '确认恢复这个工作空间？', exact: true }).getByRole('button', { name: '确认导入', exact: true }).click()
    await page.waitForFunction(stamps => JSON.stringify(JSON.parse(localStorage.getItem('shift-planner:v1')).provenance.scheduleUpdates) === JSON.stringify(stamps), scheduleBackup.provenance.scheduleUpdates)
    assert.deepEqual((await snapshot(page)).state, scheduleBackup)
    await scheduleTime(page, mcpScheduleStamp)
    await enableAfterReload(page)
    assert.deepEqual((await snapshot(page)).state.provenance.scheduleUpdates, scheduleBackup.provenance.scheduleUpdates)
    await scheduleTime(page, mcpScheduleStamp)
    record('JSON backup restoration preserves historical per-month schedule timestamps instead of stamping import time')

    const fieldStamps = (await snapshot(page)).state.provenance.fields
    for (const [sectionName, field, focus] of [
      ['成员管理', 'employees.qa-1', false],
      ['成员管理', referencePath, true],
      ['班次设置', 'shifts.day', false],
      ['排班规则', 'rules.minRestHours', false],
    ]) {
      await section(page, sectionName)
      const locator = page.locator(`[data-source-path="${field}"]`).first()
      await sourceTooltip(page, locator, fieldStamps[field], { focus })
      if (field === 'employees.qa-1') await screenshot(page, 'source-tooltip-member')
      await dismissSourceTooltip(page, locator)
    }
    record('member, shift, rule and reference badges expose real hover/focus tooltips with exact saved source and local timestamp')

    await section(page, '成员管理')
    await page.getByRole('button', { name: `编辑${currentMemberName}`, exact: true }).click()
    const pendingDialog = page.getByRole('dialog', { name: '编辑成员资料', exact: true })
    assert.equal(await pendingDialog.locator('.sp-source-badge').count(), 1)
    await pendingDialog.getByRole('textbox', { name: '岗位', exact: true }).fill('尚未保存的新岗位')
    const pendingBadge = pendingDialog.locator('[data-source-path="employees.qa-1"]')
    await sourceTooltip(page, pendingBadge, fieldStamps['employees.qa-1'], { pending: true })
    await screenshot(page, 'pending-source-tooltip')
    await dismissSourceTooltip(page, pendingBadge)
    await pendingDialog.getByRole('button', { name: '取消', exact: true }).click()
    await pendingDialog.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '编辑测试成员乙', exact: true }).click()
    const unknownDialog = page.getByRole('dialog', { name: '编辑成员资料', exact: true })
    assert.equal(await unknownDialog.locator('.sp-source-badge').count(), 0)
    await unknownDialog.getByRole('textbox', { name: '员工姓名', exact: true }).fill('旧数据未保存的修改')
    const unknownBadge = unknownDialog.locator('[data-source-path="employees.qa-2"]')
    await sourceTooltip(page, unknownBadge, undefined, { pending: true, focus: true })
    await dismissSourceTooltip(page, unknownBadge)
    await unknownDialog.getByRole('textbox', { name: '员工姓名', exact: true }).fill('测试成员乙')
    assert.equal(await unknownDialog.locator('.sp-source-badge').count(), 0, 'restoring the original draft hides an untracked pending badge')
    await unknownDialog.getByRole('button', { name: '取消', exact: true }).click()
    await unknownDialog.waitFor({ state: 'detached' })
    record('each edit dialog has one pending card badge with the last saved time, and untracked drafts hide it again when restored')

    await page.setViewportSize({ width: 320, height: 480 })
    const narrowBadge = page.locator('[data-source-path="employees.qa-1"]').first()
    assert.equal(await page.locator('#member-qa-1 .sp-source-badge').count(), 1)
    assert.equal(await page.locator('#member-qa-2 .sp-source-badge').count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await sourceTooltip(page, narrowBadge, fieldStamps['employees.qa-1'])
    await screenshot(page, 'source-tooltip-320px')
    await dismissSourceTooltip(page, narrowBadge)
    await page.setViewportSize({ width: 1440, height: 960 })
    await section(page, '排班日历')
    record('source tooltips stay visible and unclipped at 320px viewport width')

    dialog = await openSettings(page)
    for (const viewport of [{ width: 800, height: 600 }, { width: 1280, height: 430 }, { width: 320, height: 480 }]) {
      await page.setViewportSize(viewport)
      await fits(page)
      const body = dialog.locator('.integration-body'), heading = dialog.locator('.sp-modal-heading')
      const bounds = await dialog.boundingBox()
      assert.ok(bounds.width <= 560, `compact settings dialog should be at most 560px wide: ${bounds.width}`)
      await body.evaluate(node => { node.scrollTop = 0 })
      await screenshot(page, `settings-compact-${viewport.width}x${viewport.height}`)
      const headerBefore = await heading.boundingBox()
      const needsScroll = await body.evaluate(node => node.scrollHeight > node.clientHeight)
      if (viewport.height < 600) assert.equal(needsScroll, true)
      assert.equal(await body.evaluate(node => getComputedStyle(node).overflowY), 'auto')
      await body.evaluate(node => { node.scrollTop = node.scrollHeight })
      assert.equal(await body.evaluate(node => node.scrollTop > 0), needsScroll)
      const headerAfter = await heading.boundingBox()
      assert.ok(Math.abs(headerBefore.y - headerAfter.y) < 1)
      assert.ok(Math.abs(headerBefore.height - headerAfter.height) < 1)
      assert.equal(await dialog.getByRole('button', { name: '关闭设置', exact: true }).isVisible(), true)
      await dialog.getByRole('button', { name: '复制 MCP 配置', exact: true }).click()
      assert.equal(JSON.parse(await copied(page)).mcpServers['shift-schedule-expert'].type, 'http')
      await screenshot(page, `settings-scroll-${viewport.width}x${viewport.height}`)
    }
    record('compact settings at 800x600, short, and 320px viewports scroll internally with a stationary heading and accessible close/copy controls')
    await page.close()
    await checkAggregatedCards()

    const web = await preparePage(false)
    dialog = await openSettings(web)
    assert.equal(await dialog.getByRole('switch', { name: 'MCP', exact: true }).isDisabled(), true)
    assert.equal(await dialog.getByRole('switch', { name: 'MCP', exact: true }).getAttribute('aria-checked'), 'false')
    assert.match(await dialog.innerText(), /请使用桌面版/)
    assert.equal(await dialog.getByRole('checkbox').count(), 4)
    for (const [name, checked] of [['成员', true], ['班次', false], ['排班规则', false], ['排班结果', false]]) {
      const checkbox = dialog.getByRole('checkbox', { name: `允许修改${name}`, exact: true })
      assert.equal(await checkbox.isDisabled(), true)
      assert.equal(await checkbox.isChecked(), checked)
    }
    assert.equal(await dialog.locator('input:not([type="checkbox"])').count(), 0)
    assert.equal(await dialog.getByRole('button', { name: '复制 MCP 配置', exact: true }).count(), 0)
    await screenshot(web, 'browser-unsupported')
    await web.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    record('browser version clearly requests the desktop app and disables the unavailable service switch')
    await web.close()
    const touch = await preparePage(true, { hasTouch: true, viewport: { width: 390, height: 844 } })
    assert.equal(await touch.evaluate(() => matchMedia('(pointer: coarse)').matches), true)
    await settingsTrigger(touch, 40)
    await screenshot(touch, 'settings-trigger-touch-390')
    await touch.getByRole('button', { name: '设置', exact: true }).tap()
    dialog = touch.getByRole('dialog', { name: '设置', exact: true })
    await dialog.waitFor()
    await fits(touch)
    await touch.waitForFunction(() => !document.querySelector('[role="switch"]').disabled)
    await dialog.getByRole('switch', { name: 'MCP', exact: true }).tap()
    await touch.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true')
    await dialog.getByRole('button', { name: '复制 MCP 配置', exact: true }).tap()
    assert.equal(JSON.parse(await copied(touch)).mcpServers['shift-schedule-expert'].type, 'http')
    await screenshot(touch, 'settings-compact-touch-390')
    await closeSettings(touch)
    record('touch settings gear provides a 40px target and opens a working MCP dialog')
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
