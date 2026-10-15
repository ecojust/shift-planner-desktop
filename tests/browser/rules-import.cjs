/* Real rules export/import UI checks. Run against Vite with RULES_IMPORT_TEST_URL,
 * PLAYWRIGHT_MODULE_PATH and optionally PLAYWRIGHT_EXECUTABLE_PATH.
 * Desktop file dialogs are represented by controlled Tauri IPC only.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')

const url = process.env.RULES_IMPORT_TEST_URL || 'http://127.0.0.1:5190/'
const out = path.resolve(__dirname, '../../test-results/rules-import')
const storageKey = 'shift-planner:v1'
const permissionKey = 'shift-planner:integration-permissions:v1'
const previewTitle = '导入这个规则文件？'
const sourceAt = '2026-10-13T08:30:00.000Z'
const currentAt = '2026-10-14T09:45:00.000Z'
const fixture = {
  version: 1, teamName: '规则导出原工作区', month: '2026-10',
  monthlyReferenceHours: { '2026-10': 160 },
  employees: ['甲', '乙'].map((name, index) => ({
    id: `import-${index + 1}`, name: `导入测试成员${name}`, role: index ? '服务员' : '原始岗位', group: '原始工作组',
    color: '#d7e8f8', minHoursPerMonth: index ? 0 : null, minHoursPerWeek: 0,
    maxHoursPerWeek: 56, eligibleShiftIds: ['day', 'night'], unavailableDates: [],
  })),
  shifts: [
    { id: 'day', name: '原始日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 1, staffingMode: 'fixed', normalAllowance: 12 },
    { id: 'night', name: '原始夜班', shortName: '夜', start: '16:00', end: '00:00', color: '#d7e8f8', required: 1, staffingMode: 'minimum', normalAllowance: 24 },
  ],
  rules: { minRestHours: 11, maxConsecutiveDays: 5 },
  assignments: [
    { employeeId: 'import-1', date: '2026-09-30', shiftId: 'night', locked: true },
    { employeeId: 'import-1', date: '2026-10-01', shiftId: 'day', locked: true },
    { employeeId: 'import-2', date: '2026-10-02', shiftId: 'off', locked: false },
  ],
  provenance: {
    fields: { 'employees.import-1.role': { source: 'mcp', at: sourceAt }, 'rules.minRestHours': { source: 'http', at: sourceAt } },
    scheduleUpdates: { '2026-10': { source: 'mcp', at: sourceAt } },
  },
}
const report = { url, scope: 'Real browser rules downloads, file selection, preview and persistence; controlled desktop file-dialog IPC', checks: [], errors: [], screenshots: [], ok: false }
const clone = value => JSON.parse(JSON.stringify(value))
let browser, activePage, downloadCount = 0
function record(name) { report.checks.push(name); console.log('PASS', name) }
async function shot(page, name) {
  const file = path.join(out, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  report.screenshots.push(file)
}
async function stored(page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey) }
async function preparePage(desktop, initial = fixture) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', acceptDownloads: true })
  activePage = page
  page.on('pageerror', error => report.errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })
  const avatar = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 8
    const context = canvas.getContext('2d')
    context.fillStyle = '#245b4e'
    context.fillRect(0, 0, 8, 8)
    return canvas.toDataURL('image/jpeg', 0.8)
  })
  const seed = clone(initial)
  seed.employees[0].avatar = avatar
  await page.addInitScript(({ initial, desktop, storageKey, permissionKey }) => {
    const nextFixture = sessionStorage.getItem('rules-import-next-fixture')
    if (nextFixture) {
      localStorage.setItem(storageKey, nextFixture)
      sessionStorage.removeItem('rules-import-next-fixture')
    }
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify(initial))
    if (!localStorage.getItem(permissionKey)) localStorage.setItem(permissionKey, JSON.stringify({ members: true, shifts: false, rules: false, assignments: false }))
    window.__rulesImportFaults = { failSave: false }
    const save = Storage.prototype.setItem
    Storage.prototype.setItem = function(key, value) {
      if (key === storageKey && window.__rulesImportFaults.failSave) throw new DOMException('Rules import storage fault', 'QuotaExceededError')
      return save.call(this, key, value)
    }
    if (!desktop) return
    window.isTauri = true
    let callbackId = 0, listenerId = 0
    const callbacks = new Map()
    const control = window.__rulesImportDesktop = { commands: [], importContents: null, exports: [] }
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback) { callbacks.set(++callbackId, callback); return callbackId },
      unregisterCallback(id) { callbacks.delete(id) },
      async invoke(command, args = {}) {
        control.commands.push(command)
        if (command === 'plugin:event|listen') return ++listenerId
        if (command === 'plugin:event|unlisten') return null
        if (command === 'solver_info') return { engine: 'ortools-cp-sat', protocolVersion: 1, version: 'controlled-import-test', local: true }
        if (command === 'integration_status' || command === 'integration_stop') {
          if (!['mcp', 'http'].includes(args.service)) throw new Error('Expected an explicit integration service')
          return { enabled: false, url: '', token: '', serviceId: '' }
        }
        if (command === 'import_backup') return control.importContents
        if (command === 'save_export') { control.exports.push({ ...args }); return true }
        throw new Error(`Unexpected desktop command: ${command}`)
      },
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
  }, { initial: seed, desktop, storageKey, permissionKey })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '排班日历', exact: true }).waitFor()
  return page
}
async function exportFile(page, desktop = false) {
  if (desktop) {
    const count = await page.evaluate(() => window.__rulesImportDesktop.exports.length)
    await page.getByRole('button', { name: '导出规则', exact: true }).click()
    await page.waitForFunction(before => window.__rulesImportDesktop.exports.length > before, count)
    const download = await page.evaluate(() => window.__rulesImportDesktop.exports.at(-1))
    const bytes = Buffer.from(download.contents)
    return { name: download.fileName, bytes, data: JSON.parse(bytes.toString('utf8')) }
  }
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出规则', exact: true }).click()
  const download = await pending
  assert.equal(await download.failure(), null)
  const destination = path.join(out, `download-${++downloadCount}.json`)
  await download.saveAs(destination)
  const bytes = await fs.readFile(destination)
  return { name: download.suggestedFilename(), bytes, data: JSON.parse(bytes.toString('utf8')) }
}
async function chooseFile(page, file, desktop = false) {
  if (desktop) {
    await page.evaluate(contents => { window.__rulesImportDesktop.importContents = contents }, file?.bytes.toString('utf8') ?? null)
    await page.getByRole('button', { name: '导入规则', exact: true }).click()
    return
  }
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '导入规则', exact: true }).click()
  await (await chooser).setFiles({ name: file.name, mimeType: 'application/json', buffer: file.bytes })
}
function preview(page) { return page.getByRole('alertdialog', { name: previewTitle, exact: true }) }
async function overwriteCurrent(page) {
  const changed = clone(await stored(page))
  changed.teamName = '导入前当前工作区'
  changed.employees[0].role = '导入前岗位'
  changed.employees[0].minHoursPerMonth = 72
  changed.employees[0].minHoursPerWeek = 14
  changed.shifts[0].name = '导入前班次'
  changed.rules.minRestHours = 6
  changed.assignments = [{ employeeId: 'import-2', date: '2026-10-03', shiftId: 'night', locked: false }]
  changed.provenance = {
    fields: { 'employees.import-1.role': { source: 'http', at: currentAt }, 'rules.minRestHours': { source: 'mcp', at: currentAt } },
    scheduleUpdates: { '2026-10': { source: 'http', at: currentAt } },
  }
  // Seed the next page before app startup: the outgoing app flushes its own
  // live state on pagehide, so changing localStorage before reload is insufficient.
  await page.evaluate(value => sessionStorage.setItem('rules-import-next-fixture', JSON.stringify(value)), changed)
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '排班日历', exact: true }).waitFor()
  return changed
}
async function waitSaved(page, employeeRole) {
  await page.waitForFunction(({ key, role }) => JSON.parse(localStorage.getItem(key)).employees[0].role === role, { key: storageKey, role: employeeRole })
}
async function section(page, name) {
  await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: new RegExp(name) }).click()
  await page.getByRole('heading', { name, exact: true }).waitFor()
}
async function assertRestored(page, original, prior, confirmationStarted) {
  await waitSaved(page, fixture.employees[0].role)
  const actual = await stored(page)
  assert.equal(actual.teamName, fixture.teamName)
  assert.equal(actual.month, fixture.month)
  assert.equal(actual.employees[0].role, fixture.employees[0].role)
  assert.equal(actual.employees[0].minHoursPerMonth, null)
  assert.equal(actual.employees[0].minHoursPerWeek, 0)
  assert.equal(actual.employees[0].avatar, prior.employees[0].avatar)
  assert.equal(actual.shifts[0].name, fixture.shifts[0].name)
  assert.equal(actual.rules.minRestHours, fixture.rules.minRestHours)
  assert.deepEqual(actual.assignments, fixture.assignments)
  assert.deepEqual(actual.monthlyReferenceHours, fixture.monthlyReferenceHours)
  for (const field of ['employees.import-1.role', 'shifts.day.name', 'rules.minRestHours']) {
    assert.equal(actual.provenance.fields[field].source, 'manual', field)
    assert.ok(Date.parse(actual.provenance.fields[field].at) >= confirmationStarted, `${field} needs a new saved timestamp`)
  }
  assert.deepEqual(actual.provenance.scheduleUpdates, prior.provenance.scheduleUpdates)
  assert.equal(await page.locator('.sp-schedule-update time').getAttribute('datetime'), currentAt)
  assert.equal(original.data.debug.originalHourDefaults[0].minHoursPerMonth, null)
  return actual
}
async function main() {
  await fs.mkdir(out, { recursive: true })
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  try {
    const page = await preparePage(false)
    const exported = await exportFile(page)
    assert.match(exported.name, /^排班规则-2026-10-当前设置.*\.json$/)
    assert.equal(exported.data.debug.format, 'shiftflow-solver-debug')
    assert.equal(exported.data.state.employees.length, 2)
    assert.equal(exported.data.state.shifts.length, 2)
    assert.equal(exported.data.state.assignments.length, 3)
    assert.equal(exported.data.state.employees[0].avatar, undefined)
    assert.equal(typeof exported.data.state.employees[0].minHoursPerMonth, 'number')
    assert.equal(exported.data.debug.originalHourDefaults[0].minHoursPerMonth, null)
    assert.equal(exported.data.debug.originalHourDefaults[0].minHoursPerWeek, 0)
    record('browser downloads the actual exported rules protocol with defaults and complete historical assignments')

    const prior = await overwriteCurrent(page)
    const permissionsBefore = await page.evaluate(key => localStorage.getItem(key), permissionKey)
    const beforeCancel = await exportFile(page)
    await chooseFile(page, exported)
    const dialog = preview(page)
    await dialog.waitFor()
    const previewText = await dialog.innerText()
    assert.match(previewText, /2026-10|2026 年 10 月/)
    assert.equal(await dialog.locator('dl > div').filter({ hasText: /^成员/ }).locator('dd').innerText(), '2 人')
    assert.equal(await dialog.locator('dl > div').filter({ hasText: /^班次/ }).locator('dd').innerText(), '2 种')
    assert.equal(await dialog.locator('dl > div').filter({ hasText: /^所有月份排班/ }).locator('dd').innerText(), '3 条')
    assert.equal(await dialog.locator('dl > div').filter({ hasText: /^其中锁定安排/ }).locator('dd').innerText(), '2 条')
    assert.deepEqual(await stored(page), prior)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual((await exportFile(page)).data.state, beforeCancel.data.state)
    assert.deepEqual(await stored(page), prior)
    record('import preview reports file counts and cancellation preserves current memory and storage')

    await chooseFile(page, exported)
    await dialog.waitFor()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(await stored(page), prior)
    const cancelledSelection = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '导入规则', exact: true }).click()
    await (await cancelledSelection).setFiles([])
    assert.equal(await dialog.count(), 0)
    assert.equal(await page.getByRole('button', { name: '导入规则', exact: true }).isEnabled(), true)
    assert.deepEqual(await stored(page), prior)
    record('Escape and an empty file-picker selection cancel safely and allow the same rules file to be reopened')

    await chooseFile(page, exported)
    await dialog.waitFor()
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      const bounds = await dialog.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= 845)
      assert.equal(await dialog.evaluate(node => node.scrollWidth > node.clientWidth), false)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await shot(page, `preview-${width}`)
    }
    await page.setViewportSize({ width: 1440, height: 960 })
    const confirmationStarted = Date.now()
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    const restored = await assertRestored(page, exported, prior, confirmationStarted)
    assert.equal(await page.evaluate(key => localStorage.getItem(key), permissionKey), permissionsBefore)
    await shot(page, 'browser-imported')
    record('confirmed import restores members, shifts, rules and assignments, preserves null hour defaults and matching avatar, and stamps changes manually')

    await page.reload({ waitUntil: 'networkidle' })
    assert.deepEqual(await stored(page), restored)
    await section(page, '成员管理')
    const memberBadge = page.locator('[data-source-path="employees.import-1"]')
    assert.equal(await page.locator('#member-import-1 .sp-source-badge').count(), 1)
    assert.equal(await memberBadge.getAttribute('data-source'), 'manual')
    await memberBadge.hover()
    assert.equal(await page.getByRole('tooltip').locator('time').getAttribute('datetime'), restored.provenance.fields['employees.import-1'].at)
    await shot(page, 'imported-manual-source')
    await section(page, '排班日历')
    assert.equal(await page.locator('.sp-schedule-update time').getAttribute('datetime'), currentAt)
    record('imported data and manual source timestamps persist across reload while the prior external schedule time remains intact')

    const beforeInvalid = await exportFile(page)
    await chooseFile(page, { name: 'invalid-rules.json', bytes: Buffer.from('{invalid-json') })
    await page.getByRole('alert').filter({ hasText: /规则|JSON|文件|导入/ }).waitFor()
    assert.equal(await preview(page).count(), 0)
    assert.deepEqual((await exportFile(page)).data.state, beforeInvalid.data.state)
    assert.deepEqual(await stored(page), restored)
    record('invalid files show a user-visible error and preserve both displayed and persisted data')

    const beforeFailure = await overwriteCurrent(page)
    const beforeFailureExport = await exportFile(page)
    await chooseFile(page, exported)
    await preview(page).waitFor()
    await page.evaluate(() => { window.__rulesImportFaults.failSave = true })
    await preview(page).getByRole('button', { name: '确认导入', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: /保存|存储|空间/ }).waitFor()
    assert.deepEqual(await stored(page), beforeFailure)
    await page.evaluate(() => { window.__rulesImportFaults.failSave = false })
    if (await preview(page).count()) await preview(page).getByRole('button', { name: '取消', exact: true }).click()
    assert.deepEqual((await exportFile(page)).data.state, beforeFailureExport.data.state)
    assert.deepEqual(await stored(page), beforeFailure)
    await shot(page, 'save-failure-preserves-state')
    record('a failed local save leaves the old document and metadata intact without a partial in-memory import')

    const stalePicker = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '导入规则', exact: true }).click()
    const pendingSelection = await stalePicker
    await page.getByRole('button', { name: '下个月', exact: true }).click()
    await pendingSelection.setFiles({ name: exported.name, mimeType: 'application/json', buffer: exported.bytes })
    await page.getByRole('alert').filter({ hasText: /数据已变化|重新导入/ }).waitFor()
    assert.equal(await preview(page).count(), 0)
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).month === '2026-11', storageKey)
    assert.equal((await stored(page)).employees[0].role, beforeFailure.employees[0].role)
    assert.equal((await exportFile(page)).data.state.month, '2026-11')
    assert.equal(await page.getByRole('button', { name: '导入规则', exact: true }).isEnabled(), true)
    record('data changes while file selection is pending invalidate that selection instead of overwriting newer state')
    await page.close()

    const desktop = await preparePage(true)
    const desktopExport = await exportFile(desktop, true)
    assert.equal(desktopExport.data.debug.runtime, 'desktop')
    const desktopPrior = await overwriteCurrent(desktop)
    await chooseFile(desktop, null, true)
    assert.equal(await preview(desktop).count(), 0)
    assert.deepEqual(await stored(desktop), desktopPrior)
    await chooseFile(desktop, desktopExport, true)
    await preview(desktop).waitFor()
    const desktopConfirmStarted = Date.now()
    await preview(desktop).getByRole('button', { name: '确认导入', exact: true }).click()
    await preview(desktop).waitFor({ state: 'detached' })
    await assertRestored(desktop, desktopExport, desktopPrior, desktopConfirmStarted)
    assert.equal(await desktop.evaluate(() => window.__rulesImportDesktop.commands.filter(command => command === 'import_backup').length), 2)
    await shot(desktop, 'desktop-imported')
    record('desktop file-dialog cancellation and confirmed import use the native IPC path with the same restoration semantics')
    assert.deepEqual(report.errors, [])
    report.ok = true
    record('all rules import scenarios complete without browser errors')
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
