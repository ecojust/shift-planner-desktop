const assert = require('node:assert/strict')

async function openSelect(page, trigger) {
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  const id = await trigger.getAttribute('aria-controls')
  assert.ok(id, 'An expanded select must identify its options list')
  const list = page.locator(`[role="listbox"][id=${JSON.stringify(id)}]`)
  await list.waitFor()
  return list
}

async function selectOption(page, trigger, value) {
  const list = await openSelect(page, trigger)
  const options = list.getByRole('option')
  const values = await options.evaluateAll(elements => elements.map(element => element.getAttribute('data-value')))
  const matching = values.flatMap((entry, index) => entry === String(value) ? [index] : [])
  assert.equal(matching.length, 1, `Expected exactly one option for ${JSON.stringify(value)}`)
  const target = options.nth(matching[0])
  assert.notEqual(await target.getAttribute('aria-disabled'), 'true', `${JSON.stringify(value)} must be available`)
  await target.click()
  await list.waitFor({ state: 'detached' })
  assert.equal(await trigger.getAttribute('data-value'), String(value))
}

module.exports = { openSelect, selectOption }
