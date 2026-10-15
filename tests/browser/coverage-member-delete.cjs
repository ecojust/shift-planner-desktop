/* Production Vue/Worker regression for deleting a member after generation has
 * created scheduleCoverage. Run with the usual PLAYWRIGHT_* environment vars. */
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const url = process.env.COVERAGE_MEMBER_DELETE_TEST_URL || 'http://127.0.0.1:5194/'
const output = path.resolve(process.env.COVERAGE_MEMBER_DELETE_TEST_OUTPUT || 'test-results/coverage-member-delete')
const fixture = {
  version: 1, teamName: '生成完整记录后删除成员', month: '2026-10', calendar: {},
  employees: ['删除成员', '保留成员'].map((name, index) => ({ id: `member-${index + 1}`, name, role: '测试', group: '测试组', color: '#d7e8f8', minHoursPerWeek: 0, maxHoursPerWeek: 48, eligibleShiftIds: ['day'], unavailableDates: [] })),
  shifts: [{ id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 1, staffingMode: 'fixed', normalAllowance: 0 }],
  rules: { minRestHours: 0, maxConsecutiveDays: 31, separationGroups: [{ id: 'pair', name: '成员互斥', employeeIds: ['member-1', 'member-2'], shiftIds: ['day'] }] },
  assignments: [
    { employeeId: 'member-1', date: '2026-03-01', shiftId: 'day', locked: true },
    { employeeId: 'member-2', date: '2026-03-02', shiftId: 'day', locked: true },
    { employeeId: 'member-1', date: '2026-10-01', shiftId: 'day', locked: true },
    { employeeId: 'member-2', date: '2026-10-02', shiftId: 'day', locked: true },
  ],
  scheduleCoverage: { '2026-03': { employeeIds: ['member-1', 'member-2'] } },
}
const report = { url, startedAt: new Date().toISOString(), checks: [], errors: [], ok: false }
const record = name => { report.checks.push({ name, ok: true }); console.log(`PASS ${name}`) }
async function main() {
  await fs.mkdir(output, { recursive: true })
  await fs.rm(path.join(output, 'failure.png'), { force: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  page.setDefaultTimeout(10000)
  await page.clock.setFixedTime(new Date('2026-10-15T04:00:00Z'))
  await page.addInitScript(document => {
    if (!localStorage.getItem('coverage-delete-fixture-loaded')) {
      localStorage.setItem('shift-planner:v1', JSON.stringify(document))
      localStorage.setItem('coverage-delete-fixture-loaded', 'true')
    }
    const ActualWorker = window.Worker
    window.__coverageResult = null
    window.Worker = class extends ActualWorker {
      constructor(...args) { super(...args); this.addEventListener('message', event => { if (event.data.result) window.__coverageResult = event.data.result }) }
    }
  }, fixture)
  page.on('pageerror', error => report.errors.push(error.stack || String(error)))
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1')))
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '自动排班', exact: true }).click()
    await page.getByRole('button', { name: '开始生成', exact: true }).click()
    await page.waitForFunction(() => window.__coverageResult !== null, null, { timeout: 45000 })
    const result = await page.evaluate(() => window.__coverageResult)
    assert.equal(result.success, true, JSON.stringify(result.issues))
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('shift-planner:v1')).scheduleCoverage?.['2026-10']?.employeeIds.length === 2)
    const before = await state()
    assert.ok(before.assignments.some(item => item.employeeId === 'member-1' && item.date.startsWith('2026-10')))
    assert.ok(before.assignments.some(item => item.employeeId === 'member-2' && item.date.startsWith('2026-10')))
    record('real-worker-generation-creates-current-coverage-and-work-for-both-members')
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: '成员管理', exact: true }).click()
    await page.getByRole('button', { name: '删除删除成员', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '确认删除', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('shift-planner:v1')).employees.length === 1)
    const after = await state()
    assert.deepEqual(after.employees, before.employees.filter(item => item.id !== 'member-1'))
    assert.deepEqual(after.assignments, before.assignments.filter(item => item.employeeId !== 'member-1'), 'All locked and unlocked associations across all months must be removed atomically')
    assert.deepEqual(after.scheduleCoverage, { '2026-03': { employeeIds: ['member-2'] }, '2026-10': { employeeIds: ['member-2'] } })
    assert.ok((after.rules.separationGroups ?? []).every(group => !group.employeeIds.includes('member-1')))
    assert.deepEqual(after.shifts, before.shifts)
    record('delete-cleans-employee-all-month-assignments-coverage-and-rule-references-while-preserving-other-member')
    await page.reload({ waitUntil: 'networkidle' })
    assert.deepEqual(await state(), after, 'Reload must accept the saved document instead of falling back to defaults')
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: '成员管理', exact: true }).click()
    assert.equal(await page.locator('.sp-settings-employee-card').count(), 1)
    assert.equal(await page.getByRole('button', { name: '删除保留成员', exact: true }).count(), 1)
    await page.screenshot({ path: path.join(output, 'remaining-member-after-refresh.png') })
    record('deleted-member-stays-removed-after-refresh-and-surviving-document-remains-loadable')
    assert.deepEqual(report.errors, [])
    record('no-browser-console-or-page-errors')
    report.ok = true
  } catch (error) {
    report.failure = error.stack || String(error)
    report.lastState = await state().catch(() => null)
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
