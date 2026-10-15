const assert = require('node:assert/strict')
const statusLabels = { empty: '未排班', scheduled: '已排班', invalid: '规则已修改，排班已失效', pending: '已排班 · 跨月待确认', conflict: '排班有冲突，需重新检查' }

async function assertStatusDescription(locator, expected) {
  assert.equal(await locator.getAttribute('data-schedule-status'), expected)
  const description = await locator.evaluate(node => (node.getAttribute('aria-describedby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '))
  assert.ok(description.includes(statusLabels[expected]), `Expected ${statusLabels[expected]} in accessible description: ${description}`)
}

async function assertCurrentMonthStatus(page, expected) {
  const trigger = page.getByRole('button', { name: '全局排班月份', exact: true })
  await trigger.waitFor()
  await assertStatusDescription(trigger, expected)
  assert.equal(await page.locator('.sp-month-schedule-status').count(), 0, 'The old calendar heading must not duplicate month status')
}

async function assertMonthChoiceStatus(dialog, month, expected) {
  const choice = dialog.getByRole('button', { name: `${Number(month.slice(0, 4))} 年 ${Number(month.slice(5))} 月`, exact: true })
  await assertStatusDescription(choice, expected)
  const visibleStatus = choice.locator('.sp-month-picker-status')
  assert.equal(await visibleStatus.isVisible(), true)
  assert.equal((await visibleStatus.innerText()).replace(/[\s，·]/g, ''), statusLabels[expected].replace(/[\s，·]/g, ''), `${month}: the month grid visibly explains its saved schedule status`)
}

async function readGlobalMonth(page) {
  const text = await page.getByRole('button', { name: '全局排班月份', exact: true }).innerText()
  const match = text.match(/(\d{1,4})\s*年\s*(\d{1,2})\s*月/)
  assert.ok(match, `Expected a displayed year and month: ${text}`)
  return `${match[1].padStart(4, '0')}-${match[2].padStart(2, '0')}`
}

// Browse through the actual selection controls; never inject a model value.
// Return the month grid before selecting so race checks can activate a real
// month button in the same browser task as another pending settings edit.
async function openMonthPicker(page, value) {
  assert.match(value, /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/)
  const year = Number(value.slice(0, 4))
  await page.getByRole('button', { name: '全局排班月份', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '选择排班月份', exact: true })
  await dialog.waitFor()
  const title = dialog.getByRole('button', { name: '选择年份', exact: true })
  const current = Number((await title.innerText()).match(/\d+/)?.[0])
  assert.ok(current >= 1 && current <= 9999)
  if (current !== year) {
    await title.click()
    const target = dialog.getByRole('button', { name: `${year} 年`, exact: true })
    const direction = year < current ? '上一组年份' : '下一组年份'
    for (let step = 0; step < 834 && !(await target.count()); step++) {
      await dialog.getByRole('button', { name: direction, exact: true }).click()
    }
    await target.click()
  }
  return dialog
}

async function selectGlobalMonth(page, value) {
  const dialog = await openMonthPicker(page, value)
  await dialog.getByRole('button', { name: `${Number(value.slice(0, 4))} 年 ${Number(value.slice(5))} 月`, exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await readGlobalMonth(page), value)
}

module.exports = { selectGlobalMonth, readGlobalMonth, openMonthPicker, assertCurrentMonthStatus, assertMonthChoiceStatus }
