/* Start Vite on 5197, then run with PLAYWRIGHT_MODULE_PATH and optionally
 * PLAYWRIGHT_EXECUTABLE_PATH. Tauri detection, event registration and solver_info
 * are MOCKED solely to exercise the desktop dialog UI in Chromium. No Rust,
 * Python, OR-Tools, real IPC, native packaging or actual solving is tested. */
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
  const url = process.env.GENERATION_TEST_URL || 'http://127.0.0.1:5197'
  const output = path.resolve(process.env.GENERATION_TEST_OUTPUT || 'test-results/generation-options-ui')
  await fs.mkdir(output, { recursive: true })
  await fs.rm(path.join(output, 'failure.png'), { force: true })
  const checks = [], errors = []
  const report = { url, scope: 'Chromium UI only with mocked Tauri startup IPC; no native solver or real solve', startedAt: new Date().toISOString(), checks, errors, ok: false }
  const record = name => { checks.push({ name, ok: true }); console.log(`PASS ${name}`) }
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  const pages = []
  let activePage
  async function makePage(mode) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    pages.push(page); activePage = page
    page.on('pageerror', error => errors.push(error.stack || String(error)))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.addInitScript(initialMode => {
      // Only this isolated page sees the mock. Unexpected calls fail explicitly;
      // the test never starts generation or substitutes a fake solved roster.
      window.isTauri = true
      window.__generationUiMock = { mode: initialMode, calls: [] }
      let callbackId = 0
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => ++callbackId,
        invoke: async command => {
          window.__generationUiMock.calls.push(command)
          if (command === 'plugin:event|listen') return 1
          if (command === 'plugin:event|unlisten') return undefined
          if (command === 'solver_info') {
            if (window.__generationUiMock.mode === 'error') throw new Error('STARTUP_TIMEOUT: mock loading timeout（阶段 loading）')
            return { engine: 'ortools-cp-sat', protocolVersion: 1, version: '9.14.6206' }
          }
          throw new Error(`Unexpected mocked IPC command: ${command}`)
        },
      }
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    }, mode)
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => window.__generationUiMock.calls.includes('solver_info'))
    await page.getByRole('button', { name: '自动排班', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    return page
  }
  async function assertFocused(locator) {
    assert.equal(await locator.evaluate(element => element === document.activeElement), true)
  }
  async function assertStartReachable(page) {
    const start = page.getByRole('dialog').getByRole('button', { name: '开始生成', exact: true })
    assert.equal(await start.isEnabled(), true)
    await start.click({ trial: true })
    const bounds = await start.boundingBox(), viewport = page.viewportSize()
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height, 'start button fits in viewport')
  }
  async function assertPlainInterface(page) {
    assert.doesNotMatch(await page.locator('body').innerText(), /CP-SAT|OR-Tools|启发式|命令行|原生协议|求解器|引擎|组件|Vue|TypeScript|npm run|STARTUP_TIMEOUT|mock loading|阶段 loading/i)
  }
  try {
    const page = await makePage('ready')
    const dialog = page.getByRole('dialog'), advanced = dialog.locator('.sp-generation-advanced'), summary = advanced.locator('summary')
    const time = dialog.getByLabel('最长等待时间', { exact: true })
    assert.equal(await advanced.evaluate(element => element.open), false)
    assert.equal(await time.isVisible(), false)
    assert.match(await summary.innerText(), /15 秒/)
    assert.equal(await dialog.getByRole('checkbox').count(), 0, 'generation always requires complete staffing')
    await assertPlainInterface(page)
    record('desktop-advanced-options-default-to-collapsed-15-seconds')
    await assertStartReachable(page)
    record('default-start-button-is-enabled-and-reachable')

    await dialog.getByRole('button', { name: '关闭自动排班', exact: true }).focus()
    await page.keyboard.press('Tab')
    await assertFocused(summary)
    await page.keyboard.press('Enter')
    assert.equal(await advanced.evaluate(element => element.open), true)
    await page.keyboard.press('Tab')
    await assertFocused(dialog.getByRole('button', { name: '最长等待时间说明', exact: true }))
    await page.getByRole('tooltip').waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('tooltip').waitFor({ state: 'detached' })
    assert.equal(await dialog.isVisible(), true, 'Dismissing help must keep generation options open')
    await page.keyboard.press('Tab')
    await assertFocused(time)
    record('keyboard-tab-reaches-summary-and-enter-opens-options')

    assert.equal(await time.inputValue(), '15')
    await time.selectOption('30')
    assert.equal(await time.inputValue(), '30')
    await time.selectOption('15')
    assert.equal(await time.inputValue(), '15')
    await time.selectOption('30')
    assert.equal(await dialog.getByRole('checkbox').count(), 0, 'expanding options cannot enable incomplete staffing')
    record('expanded-options-edit-15-or-30-seconds-without-shortage-mode')
    await summary.click()
    assert.equal(await time.isVisible(), false)
    assert.match(await summary.innerText(), /30 秒/)
    assert.doesNotMatch(await dialog.innerText(), /允许(?:岗位缺编|部分班次缺人|缺员)/)
    record('collapsed-summary-retains-selected-time-and-complete-staffing')

    await summary.focus()
    await page.keyboard.press('Tab')
    await assertFocused(dialog.getByRole('button', { name: '取消', exact: true }))
    await page.keyboard.press('Tab')
    await assertFocused(dialog.getByRole('button', { name: '开始生成', exact: true }))
    await page.keyboard.press('Tab')
    await assertFocused(dialog.getByRole('button', { name: '关闭自动排班', exact: true }))
    await page.keyboard.press('Shift+Tab')
    await assertFocused(dialog.getByRole('button', { name: '开始生成', exact: true }))
    record('focus-trap-skips-collapsed-inputs-and-wraps-in-both-directions')
    await page.screenshot({ path: path.join(output, '01-desktop-collapsed.png') })

    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '自动排班', exact: true }).click()
    assert.equal(await advanced.evaluate(element => element.open), false)
    assert.match(await summary.innerText(), /30 秒/)
    await summary.click()
    assert.equal(await time.inputValue(), '30')
    assert.equal(await dialog.getByRole('checkbox').count(), 0)
    await summary.click()
    record('cancel-and-reopen-keeps-options-without-starting-a-solve')

    await page.setViewportSize({ width: 390, height: 844 })
    await assertStartReachable(page)
    const width = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }))
    assert.ok(width.body <= width.viewport && width.html <= width.viewport, JSON.stringify(width))
    await page.screenshot({ path: path.join(output, '02-mobile-collapsed.png') })
    record('compact-desktop-dialog-start-remains-reachable-at-mobile-width')

    const failed = await makePage('error')
    const errorDialog = failed.getByRole('dialog'), errorAdvanced = errorDialog.locator('.sp-generation-advanced')
    const errorBox = errorDialog.locator('.sp-solver-engine.is-error')
    assert.equal(await errorAdvanced.evaluate(element => element.open), false)
    assert.equal(await errorBox.isVisible(), true)
    assert.match(await errorBox.innerText(), /排班准备超时/)
    await assertPlainInterface(failed)
    assert.equal(await errorDialog.getByRole('button', { name: '开始生成', exact: true }).isDisabled(), true)
    record('mock-startup-error-stays-visible-outside-collapsed-advanced-options')
    await errorAdvanced.locator('summary').click()
    assert.equal(await errorBox.isVisible(), true)
    await errorAdvanced.locator('summary').click()
    assert.equal(await errorBox.isVisible(), true)
    await failed.screenshot({ path: path.join(output, '03-mock-startup-error.png') })
    record('expanding-or-collapsing-options-does-not-hide-startup-error')
    await failed.evaluate(() => { window.__generationUiMock.mode = 'ready' })
    await errorDialog.getByRole('button', { name: '重试检测', exact: true }).click()
    await failed.waitForFunction(() => !document.querySelector('.sp-modal .sp-solver-engine.is-error'))
    await assertStartReachable(failed)
    record('mock-startup-retry-restores-start-without-opening-advanced-options')

    for (const entry of pages) {
      const calls = await entry.evaluate(() => window.__generationUiMock.calls)
      assert.equal(calls.includes('solve_schedule'), false)
      assert.ok(calls.every(command => ['solver_info', 'plugin:event|listen', 'plugin:event|unlisten'].includes(command)), JSON.stringify(calls))
    }
    assert.deepEqual(errors, [])
    record('no-real-or-mocked-solve-and-no-browser-errors')
    report.ok = true
  } catch (error) {
    report.failure = error.stack || String(error)
    await activePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    await browser.close()
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
