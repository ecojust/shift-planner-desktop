/* Real Vue acceptance checks for chronological shift cards, staffing labels,
 * and the shift editing modal's validation, scrolling and focus lifecycle.
 * Start Vite, then run with PLAYWRIGHT_MODULE_PATH and (optionally)
 * PLAYWRIGHT_EXECUTABLE_PATH. SHIFT_ORDER_TEST_URL defaults to localhost:5193.
 * Checks the browser worker for zero-minimum / zero-fixed behavior; no native
 * bridge, Python process, or packaging is needed for this focused UI regression.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')); }
catch { console.error('Install Playwright separately or set PLAYWRIGHT_MODULE_PATH.'); process.exit(2); }
const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.SHIFT_ORDER_TEST_OUTPUT || path.join(repo, 'test-results/shift-order'));
const url = process.env.SHIFT_ORDER_TEST_URL || 'http://127.0.0.1:5193/';
const report = { url, startedAt: new Date().toISOString(), checks: [], errors: [], screenshots: [] };
const shift = (id, name, start, end, required, staffingMode) => ({ id, name, shortName: name.slice(0,1), start, end, required, ...(staffingMode ? { staffingMode } : {}), color: '#dbeee6', normalAllowance: 0 });
const original = [
  shift('night', '跨夜值班', '22:00', '06:00', 1, 'minimum'),
  shift('tie-z', '同点先建', '08:00', '12:00', 1, 'minimum'),
  shift('fixed', '午间固定', '12:00', '20:00', 2, 'fixed'),
  shift('tie-a', '旧版早班', '08:00', '16:00', 1),
  shift('zero-fixed', '零人固定', '16:00', '20:00', 0, 'fixed'),
  shift('zero-minimum', '零人最少', '06:00', '14:00', 0, 'minimum'),
];
const fixture = {
  version: 1, teamName: '班次排序验收', month: '2026-10',
  employees: [{ id: 'qa', name: '验收成员', role: '员工', group: '测试组', color: '#d7e8f8', minHoursPerWeek: 0, maxHoursPerWeek: 168, eligibleShiftIds: original.map(item => item.id), unavailableDates: [] }],
  shifts: original, rules: { minRestHours: 0, maxConsecutiveDays: 31 }, assignments: [],
};
const originalIds = original.map(item => item.id);
const initialOrder = ['zero-minimum', 'tie-z', 'tie-a', 'fixed', 'zero-fixed', 'night'];
const record = (name, details) => { report.checks.push({ name, ...(details ? { details } : {}) }); console.log('PASS', name); };
async function state(page) { return page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1'))); }
async function persisted(page, predicate) {
  for (let i = 0; i < 100; i++) { const value = await state(page); if (value && predicate(value)) return value; await page.waitForTimeout(50); }
  assert.fail('Expected settings were not persisted.');
}
async function navigate(page, label) {
  const toggle = page.getByRole('button', { name: '打开导航', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('heading', { name: label, exact: true }).waitFor();
}
async function open(page, document = fixture) {
  page.on('pageerror', error => report.errors.push(error.stack || error.message));
  await page.addInitScript(document => {
    if (!sessionStorage.getItem('shift-order-seeded')) { localStorage.setItem('shift-planner:v1', JSON.stringify(document)); sessionStorage.setItem('shift-order-seeded', '1'); }
  }, document);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '排班日历', exact: true }).waitFor();
}
async function cardOrder(page) { return page.locator('.sp-settings-shift-card').evaluateAll(cards => cards.map(card => card.id.slice('shift-'.length))); }
async function screenshot(page, name) { const file = path.join(out, `${name}.png`); await page.screenshot({ path: file, fullPage: false }); report.screenshots.push(file); }
async function noOverflow(page) {
  const sizes = await page.evaluate(() => ({ width: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth,
    cards: [...document.querySelectorAll('.sp-settings-shift-card')].map(card => ({ id: card.id, left: card.getBoundingClientRect().left, right: card.getBoundingClientRect().right, scroll: card.scrollWidth, width: card.clientWidth })) }));
  assert.ok(sizes.html <= sizes.width && sizes.body <= sizes.width, JSON.stringify(sizes));
  for (const card of sizes.cards) assert.ok(card.left >= 0 && card.right <= sizes.width + 1 && card.scroll <= card.width + 1, JSON.stringify(card));
  return sizes;
}
async function focused(locator) {
  assert.equal(await locator.evaluate(node => node === document.activeElement), true, 'expected control has focus');
}
async function modalTrap(page, modal) {
  const first = modal.getByRole('button', { name: '关闭班次编辑', exact: true });
  const last = modal.getByRole('button', { name: '保存班次', exact: true });
  await first.focus(); await page.keyboard.press('Shift+Tab'); await focused(last);
  await page.keyboard.press('Tab'); await focused(first);
}
async function modalFits(page, modal) {
  const viewport = page.viewportSize(), bounds = await modal.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, JSON.stringify({ viewport, bounds }));
  const save = modal.getByRole('button', { name: '保存班次', exact: true }), button = await save.boundingBox();
  assert.ok(button && button.height >= 40 && button.y >= 0 && button.y + button.height <= viewport.height + 1, JSON.stringify(button));
  await save.click({ trial: true });
  const overflow = await modal.evaluate(node => ({ scroll: node.scrollWidth, width: node.clientWidth }));
  assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow));
}
async function closedWithFocus(modal, trigger) {
  await modal.waitFor({ state: 'hidden' });
  await focused(trigger);
}

(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  try {
    await open(page);
    await navigate(page, '班次设置');
    assert.deepEqual(await cardOrder(page), initialOrder);
    assert.deepEqual((await state(page)).shifts.map(item => item.id), originalIds);
    assert.match(await page.locator('#shift-night').innerText(), /跨夜班次/);
    assert.match(await page.locator('#shift-night .sp-settings-shift-time').innerText(), /22:00.*06:00.*次日/s);
    record('cards sort by shift start, preserve equal-time insertion order and show overnight endings');

    const minimum = page.locator('#shift-tie-a');
    const fixed = page.locator('#shift-fixed');
    assert.match(await minimum.innerText(), /≥/);
    assert.match(await minimum.innerText(), /每日最少/);
    assert.match(await fixed.innerText(), /=/);
    assert.match(await fixed.innerText(), /每日固定/);
    assert.equal(await minimum.locator('.sp-settings-staffing-badge').getAttribute('data-staffing-mode'), 'minimum');
    assert.equal(await fixed.locator('.sp-settings-staffing-badge').getAttribute('data-staffing-mode'), 'fixed');
    const minimumColor = await minimum.locator('.sp-settings-staffing-badge').evaluate(node => getComputedStyle(node).backgroundColor);
    const fixedColor = await fixed.locator('.sp-settings-staffing-badge').evaluate(node => getComputedStyle(node).backgroundColor);
    assert.notEqual(minimumColor, fixedColor, 'Badges must be visually distinct as well as labeled');
    assert.notEqual(minimumColor, 'rgba(0, 0, 0, 0)');
    assert.notEqual(fixedColor, 'rgba(0, 0, 0, 0)');
    assert.match(await page.locator('#shift-zero-minimum').innerText(), /0.*人/s);
    assert.match(await page.locator('#shift-zero-fixed').innerText(), /0.*人/s);
    assert.match(await page.locator('#shift-zero-minimum').innerText(), /不设下限.*仍可增派/);
    assert.match(await page.locator('#shift-zero-fixed').innerText(), /此班停排/);
    record('minimum and fixed staffing have symbols plus text; missing legacy mode is minimum');
    await noOverflow(page);
    await screenshot(page, 'shift-order-desktop');

    const editTrigger = page.getByRole('button', { name: '编辑午间固定', exact: true });
    const editing = page.getByRole('dialog', { name: '编辑班次', exact: true });
    await editTrigger.click(); await editing.waitFor();
    await focused(editing.getByLabel('班次名称', { exact: true }));
    assert.equal(await editing.getAttribute('aria-modal'), 'true');
    await modalFits(page, editing); await modalTrap(page, editing);
    assert.equal(await page.locator('.sp-settings-editor').count(), 0, 'shift editor no longer expands inline');
    record('editing opens a labeled modal with initial name focus and keyboard focus wrapping');
    const beforeCancel = await state(page);
    await editing.getByLabel('班次名称', { exact: true }).fill('不保存的班次');
    await editing.getByLabel('开始时间', { exact: true }).fill('05:15');
    await editing.getByRole('button', { name: '取消', exact: true }).click();
    await closedWithFocus(editing, editTrigger); await page.waitForTimeout(450);
    assert.deepEqual(await state(page), beforeCancel);
    await editTrigger.click();
    assert.equal(await editing.getByLabel('班次名称', { exact: true }).inputValue(), '午间固定');
    await editing.getByLabel('班次津贴', { exact: true }).fill('88');
    await page.keyboard.press('Escape');
    await closedWithFocus(editing, editTrigger); await page.waitForTimeout(450);
    assert.deepEqual(await state(page), beforeCancel);
    record('cancel and Escape discard shift drafts and restore focus without changing persisted data');

    await editTrigger.click();
    await editing.getByLabel('结束时间', { exact: true }).fill('12:00');
    await editing.getByRole('button', { name: '保存班次', exact: true }).click();
    const validation = editing.getByRole('alert'); await validation.waitFor();
    assert.match(await validation.innerText(), /开始和结束不能相同/);
    const errorBounds = await validation.boundingBox(), viewport = page.viewportSize();
    assert.ok(errorBounds && errorBounds.y >= 0 && errorBounds.y + errorBounds.height <= viewport.height + 1, JSON.stringify(errorBounds));
    assert.deepEqual(await state(page), beforeCancel);
    await screenshot(page, 'shift-modal-validation-desktop');
    record('invalid equal start and end times keep the modal open with visible error and no data write');
    await editing.getByLabel('结束时间', { exact: true }).fill('20:00');
    await editing.getByLabel('开始时间', { exact: true }).fill('05:30');
    await editing.getByRole('button', { name: '保存班次', exact: true }).click();
    await closedWithFocus(editing, editTrigger);
    await persisted(page, value => value.shifts.find(item => item.id === 'fixed').start === '05:30');
    const editedOrder = ['fixed', 'zero-minimum', 'tie-z', 'tie-a', 'zero-fixed', 'night'];
    assert.deepEqual(await cardOrder(page), editedOrder);
    assert.deepEqual((await state(page)).shifts.map(item => item.id), originalIds);
    record('editing the start time repositions the card without reordering stored shifts');

    const newTrigger = page.getByRole('button', { name: '新建班次', exact: false }).first();
    const creating = page.getByRole('dialog', { name: '新建班次', exact: true });
    await newTrigger.click(); await creating.waitFor();
    await focused(creating.getByLabel('班次名称', { exact: true }));
    await creating.getByLabel('班次名称', { exact: true }).fill('取消的新班');
    await creating.getByRole('button', { name: '取消', exact: true }).click();
    await closedWithFocus(creating, newTrigger);
    assert.equal((await state(page)).shifts.length, original.length);
    await newTrigger.click();
    assert.equal(await creating.getByLabel('班次名称', { exact: true }).inputValue(), '');
    await creating.getByLabel('班次名称', { exact: true }).fill('新增上午班');
    await creating.getByLabel('日历简称', { exact: true }).fill('新');
    await creating.getByLabel('开始时间', { exact: true }).fill('10:30');
    await creating.getByLabel('结束时间', { exact: true }).fill('18:30');
    await screenshot(page, 'shift-modal-new-desktop');
    await creating.getByRole('button', { name: '保存班次', exact: true }).click();
    await closedWithFocus(creating, newTrigger);
    record('new shift uses its own modal, resets cancelled drafts and restores focus after save');
    const updated = await persisted(page, value => value.shifts.length === original.length + 1);
    const newId = updated.shifts.find(item => item.name === '新增上午班').id;
    const finalOrder = ['fixed', 'zero-minimum', 'tie-z', 'tie-a', newId, 'zero-fixed', 'night'];
    assert.deepEqual(await cardOrder(page), finalOrder);
    assert.deepEqual(updated.shifts.map(item => item.id), [...originalIds, newId]);
    record('new shifts appear in chronological position while their stored record appends normally');

    await page.reload({ waitUntil: 'networkidle' });
    await navigate(page, '班次设置');
    assert.deepEqual(await cardOrder(page), finalOrder);
    assert.deepEqual((await state(page)).shifts.map(item => item.id), [...originalIds, newId]);
    record('reloading retains edits and stable chronological display without rewriting persisted order');

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 640 });
      await page.evaluate(() => scrollTo(0, 0));
      await noOverflow(page);
      assert.deepEqual(await cardOrder(page), finalOrder);
      assert.match(await page.locator('#shift-tie-a').innerText(), /≥.*每日最少|每日最少.*≥/s);
      assert.match(await page.locator('#shift-fixed').innerText(), /=.*每日固定|每日固定.*=/s);
      await screenshot(page, `shift-order-${width}`);
      const mobileTrigger = page.getByRole('button', { name: '编辑旧版早班', exact: true });
      const beforeMobile = await state(page);
      await mobileTrigger.click(); await editing.waitFor();
      await noOverflow(page);
      await modalFits(page, editing); await modalTrap(page, editing);
      assert.equal(await editing.getByRole('radio', { name: '人数模式：每日最少人数', exact: true }).isChecked(), true);
      const scrollBody = editing.locator('.sp-shift-dialog-body'), header = editing.locator('header'), footer = editing.locator('footer');
      const beforeScroll = { top: (await header.boundingBox()).y, bottom: (await footer.boundingBox()).y, pageY: await page.evaluate(() => scrollY) };
      assert.equal(await scrollBody.evaluate(node => node.scrollHeight > node.clientHeight), true, 'mobile body can scroll independently');
      await scrollBody.evaluate(node => { node.scrollTop = node.scrollHeight; });
      assert.ok(await scrollBody.evaluate(node => node.scrollTop > 0));
      assert.equal((await header.boundingBox()).y, beforeScroll.top);
      assert.equal((await footer.boundingBox()).y, beforeScroll.bottom);
      assert.equal(await page.evaluate(() => scrollY), beforeScroll.pageY);
      await modalFits(page, editing);
      await screenshot(page, `shift-modal-${width}`);
      await editing.getByLabel('班次津贴', { exact: true }).fill('99');
      await page.keyboard.press('Escape'); await closedWithFocus(editing, mobileTrigger);
      await page.waitForTimeout(450); assert.deepEqual(await state(page), beforeMobile);
      record(`${width}px modal body scrolls independently with fixed header, reachable footer and keyboard focus containment`);
    }

    // With no coverage floor, the eight-hour weekly minimum can only be met by the
    // minimum-zero shift. Fixed-zero must remain unused even when eligible.
    const zeroState = structuredClone(fixture);
    zeroState.shifts = [shift('zero-fixed', '零人固定', '08:00', '16:00', 0, 'fixed'), shift('zero-minimum', '零人最少', '08:00', '16:00', 0, 'minimum')];
    zeroState.employees[0].eligibleShiftIds = ['zero-fixed', 'zero-minimum'];
    zeroState.employees[0].minHoursPerWeek = 8;
    const zeroPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await open(zeroPage, zeroState);
    await zeroPage.getByRole('button', { name: '自动排班', exact: true }).click();
    await zeroPage.getByRole('button', { name: '开始生成', exact: true }).click();
    await zeroPage.locator('.sp-solve-result').waitFor({ timeout: 20000 });
    const zeroResult = await persisted(zeroPage, value => value.assignments.length > 0);
    assert.ok(zeroResult.assignments.every(item => item.shiftId === 'zero-minimum'));
    assert.equal(await zeroPage.locator('.sp-solve-result.is-warning').count(), 0);
    record('real browser generation can use minimum-zero to meet hours and never assigns fixed-zero', { assignments: zeroResult.assignments.length });
    await zeroPage.close();
  } catch (error) {
    report.failure = error.stack || error.message;
    console.error(error);
    await screenshot(page, 'failure').catch(() => {});
  } finally {
    await browser.close();
    report.ok = !report.failure && report.errors.length === 0;
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
})();
