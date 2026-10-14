const assert = require('node:assert/strict')

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

module.exports = { selectGlobalMonth, readGlobalMonth, openMonthPicker }
