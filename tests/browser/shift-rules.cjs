/* Real browser acceptance checks for per-member shift sequence/frequency rules.
 * Start Vite first, then run from the project root:
 * SHIFT_FLOW_PYTHON=/path/to/python PLAYWRIGHT_MODULE_PATH=/path/to/playwright node tests/browser/shift-rules.cjs
 * Optional: SHIFT_RULES_TEST_URL, SHIFT_RULES_TEST_OUTPUT,
 * PLAYWRIGHT_EXECUTABLE_PATH (otherwise Playwright's installed browser is used).
 * Set SHIFT_RULES_FEEDBACK_ONLY=1 for the focused calendar-only result regression.
 * Set SHIFT_RULES_GROUPS_ONLY=1 for personal/team grouping and save isolation.
 * Uses Vue, browser-worker generation, JSON downloads, and real Python CP-SAT.
 * Tauri IPC is bridged for the diagnostic test; native packaging is not covered.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')); }
catch { console.error('Install Playwright separately or set PLAYWRIGHT_MODULE_PATH to its package directory.'); process.exit(2); }
const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.SHIFT_RULES_TEST_OUTPUT || path.join(repo, 'test-results/shift-rules'));
const url = process.env.SHIFT_RULES_TEST_URL || 'http://127.0.0.1:5193/';
const python = process.env.SHIFT_FLOW_PYTHON || path.join(repo, 'solver/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const report = { url, startedAt: new Date().toISOString(), scope: 'Vue UI, browser worker and real CP-SAT; excludes native packaging', checks: [], errors: [], screenshots: [] };
const clone = value => JSON.parse(JSON.stringify(value));
const fixture = {
  version: 1, teamName: '班次规则验收', month: '2026-10',
  employees: ['甲','乙','丙','丁'].map((name, index) => ({ id: `qa-${index + 1}`, name: `测试成员${name}`, role: '测试岗位', group: '验收组', color: '#d7e8f8', minHoursPerMonth: 0, minHoursPerWeek: 0, maxHoursPerWeek: 168, eligibleShiftIds: ['morning','evening','night'], unavailableDates: [] })),
  shifts: [
    { id: 'morning', name: '早班', shortName: '早', start: '08:00', end: '16:00', color: '#dbeee6', required: 1, staffingMode: 'fixed', normalAllowance: 0 },
    { id: 'evening', name: '晚班', shortName: '晚', start: '14:00', end: '22:00', color: '#e5def7', required: 0, staffingMode: 'fixed', normalAllowance: 0 },
    { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#dce8fa', required: 1, staffingMode: 'fixed', normalAllowance: 50 },
  ],
  rules: { minRestHours: 0, maxConsecutiveDays: 31 },
  // Unlocked adjacent-month entries are fixed context, not new work to overwrite.
  assignments: [
    { employeeId: 'qa-1', date: '2026-09-30', shiftId: 'night', locked: false },
    { employeeId: 'qa-2', date: '2026-11-01', shiftId: 'night', locked: false },
  ],
};
function record(name, detail) { report.checks.push({ name, ...(detail ? { detail } : {}) }); console.log('PASS', name); }
function monday(date) { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); }
function nextDate(date) { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
function audit(state, assignments) {
  const work = assignments.filter(item => item.shiftId !== 'off');
  assert.equal(new Set(work.map(item => `${item.employeeId}:${item.date}`)).size, work.length, 'One shift per employee per start date');
  for (const rule of state.rules.nonConsecutiveShifts || []) {
    const dates = new Set(work.filter(item => item.shiftId === rule.shiftId).map(item => `${item.employeeId}:${item.date}`));
    for (const item of work.filter(item => item.shiftId === rule.shiftId)) assert.ok(!dates.has(`${item.employeeId}:${nextDate(item.date)}`), `${item.employeeId} has consecutive ${rule.shiftId} starts after ${item.date}`);
  }
  const weekly = {};
  for (const rule of state.rules.weeklyShiftLimits || []) {
    const counts = {};
    for (const item of work.filter(item => item.shiftId === rule.shiftId)) {
      const key = `${item.employeeId}:${monday(item.date)}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    for (const [key, count] of Object.entries(counts)) assert.ok(count <= rule.maxPerWeek, `${key} has ${count} ${rule.shiftId} starts, cap ${rule.maxPerWeek}`);
    weekly[rule.shiftId] = counts;
  }
  const days = new Date(Number(state.month.slice(0,4)), Number(state.month.slice(5)), 0).getDate();
  for (let day = 1; day <= days; day++) {
    const date = `${state.month}-${String(day).padStart(2,'0')}`;
    for (const shift of state.shifts) {
      const count = work.filter(item => item.date === date && item.shiftId === shift.id).length;
      if (shift.staffingMode === 'fixed') assert.equal(count, shift.required, `${date} fixed ${shift.id}`);
      else assert.ok(count >= shift.required, `${date} minimum ${shift.id}`);
    }
  }
  for (const item of state.assignments.filter(item => !item.date.startsWith(state.month) || item.locked)) assert.ok(assignments.some(other => ['employeeId','date','shiftId','locked'].every(key => other[key] === item[key])), `Preserve ${JSON.stringify(item)}`);
  return { assignments: assignments.length, weekly };
}
function runSolver(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(repo,'solver/main.py'),'--input',file], { cwd: repo });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Solver replay exceeded 45 seconds')); }, 45000);
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); try { if (code) throw new Error(`Solver exit ${code}: ${stderr}`); resolve(JSON.parse(stdout)); } catch (error) { reject(error); } });
  });
}
async function currentState(page) { return page.evaluate(() => JSON.parse(localStorage.getItem('shift-planner:v1') || 'null')); }
async function persisted(page, predicate) {
  for (let attempt = 0; attempt < 120; attempt++) { const state = await currentState(page); if (state && predicate(state)) return state; await page.waitForTimeout(50); }
  assert.fail('Expected configuration/roster was not persisted');
}
async function navigate(page, label) {
  const toggle = page.getByRole('button', { name: '打开导航', exact: true });
  const mobile = await toggle.isVisible();
  if (mobile) await toggle.click();
  // Member navigation includes the live member count in its accessible name.
  await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: label }).click();
  if (mobile) await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0);
}
async function importDocument(page, document) {
  await page.locator('input[type=file]').setInputFiles({ name: 'shift-rules.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) });
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  return persisted(page, state => state.teamName === document.teamName && JSON.stringify(state.rules) === JSON.stringify(document.rules) && JSON.stringify(state.assignments) === JSON.stringify(document.assignments));
}
async function download(page, button, file) {
  const pending = page.waitForEvent('download'); await button.click();
  const item = await pending; const target = path.join(out, file); await item.saveAs(target);
  return { file: target, data: JSON.parse(await fs.readFile(target, 'utf8')), name: item.suggestedFilename() };
}
async function screenshot(page, name) { const file = path.join(out, `${name}.png`); await page.screenshot({ path: file, fullPage: false }); report.screenshots.push(file); }
async function noOverflow(page) {
  const size = await page.evaluate(() => ({ width: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(size.html <= size.width && size.body <= size.width, JSON.stringify(size));
  return size;
}
async function open(page, state = fixture, desktop = false) {
  page.on('pageerror', error => report.errors.push(error.stack || error.message));
  await page.addInitScript(({ state, desktop }) => {
    Math.random = () => 1010.5 / 2147483647;
    // Set the fixture once per tab so a reload really tests persisted edits.
    if (!sessionStorage.getItem('shift-rules-fixture')) { localStorage.setItem('shift-planner:v1', JSON.stringify(state)); sessionStorage.setItem('shift-rules-fixture', '1'); }
    if (desktop) {
      window.isTauri = true; let callback = 0;
      window.__TAURI_INTERNALS__ = { invoke: (cmd, args) => window.qaInvoke(cmd, args), transformCallback: () => ++callback, unregisterCallback: () => {} };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    }
  }, { state, desktop });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '排班日历', exact: true }).waitFor();
}
async function checkFeedbackVisibility(page, name) {
  const original = await page.locator('.sp-solve-result').innerText();
  for (const section of ['成员管理','班次设置','排班规则']) {
    await navigate(page,section);
    assert.equal(await page.locator('.sp-solve-result').count(),0,`${name}: result hidden in ${section}`);
    await navigate(page,'排班日历');
    assert.equal(await page.locator('.sp-solve-result').innerText(),original,`${name}: result survives navigation`);
  }
  record(`${name}: result hides in all three settings menus and reappears unchanged in calendar`);
}

async function main() {
  await fs.mkdir(out, { recursive: true });
  await fs.rm(path.join(out,'failure.png'), { force: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const card = kind => page.locator(`[data-rule-kind="${kind}"]`);
  const short = kind => kind === 'nonConsecutiveShifts' ? '不相连' : '周次数';
  const select = (kind, index) => card(kind).getByLabel(`第 ${index} 条${short(kind)}规则班次`, { exact: true });
  const cap = index => card('weeklyShiftLimits').getByLabel(`第 ${index} 条周次数规则每周最多次数`, { exact: true });
  const save = (kind, index) => card(kind).getByRole('button', { name: `保存第 ${index} 条${short(kind)}规则`, exact: true }).click();
  const cancel = (kind, index) => card(kind).getByRole('button', { name: `取消第 ${index} 条${short(kind)}规则修改`, exact: true }).click();
  const remove = (kind, index) => card(kind).getByRole('button', { name: `删除第 ${index} 条${short(kind)}规则`, exact: true }).click();
  const add = kind => card(kind).getByRole('button', { name: `添加${kind === 'nonConsecutiveShifts' ? '班次不相连' : '周班次限制'}规则`, exact: true });
  async function addRule(kind, shiftId, maximum) {
    await add(kind).click();
    const index = await card(kind).locator('.sp-shift-rule-row').count();
    await select(kind,index).selectOption(shiftId);
    if (maximum !== undefined) await cap(index).fill(String(maximum));
    await save(kind,index);
    await persisted(page, state => state.rules[kind]?.some(rule => rule.shiftId === shiftId && (maximum === undefined || rule.maxPerWeek === maximum)));
  }
  try {
    await open(page);
    await navigate(page, '排班规则');
    assert.equal(await card('nonConsecutiveShifts').locator('.sp-shift-rule-row').count(), 0);
    assert.equal(await card('weeklyShiftLimits').locator('.sp-shift-rule-row').count(), 0);
    record('legacy documents have both new restrictions disabled');

    await page.getByLabel('班间最短休息小时数', { exact: true }).fill('1');
    await page.evaluate(() => { window.qaRandomUUID = crypto.randomUUID; crypto.randomUUID = undefined; });
    await addRule('nonConsecutiveShifts','night');
    await addRule('nonConsecutiveShifts','morning');
    await addRule('weeklyShiftLimits','night',2);
    await addRule('weeklyShiftLimits','morning',3);
    assert.equal(await page.getByLabel('班间最短休息小时数', { exact: true }).inputValue(), '1');
    assert.equal((await currentState(page)).rules.minRestHours, 0);
    await page.getByLabel('班间最短休息小时数', { exact: true }).fill('0');
    record('multiple independent rules save without losing pending basic-rule edits');
    await page.evaluate(() => { crypto.randomUUID = window.qaRandomUUID; });
    const initialRules = (await currentState(page)).rules;
    assert.equal(new Set([...initialRules.nonConsecutiveShifts,...initialRules.weeklyShiftLimits].map(rule => rule.id)).size, 4);
    record('both kinds add unique rules when secure-context randomUUID is unavailable');

    for (const kind of ['nonConsecutiveShifts','weeklyShiftLimits']) {
      assert.equal(await select(kind,1).locator('option[value="morning"]').evaluate(option => option.disabled), true);
      assert.equal(await select(kind,2).locator('option[value="night"]').evaluate(option => option.disabled), true);
    }
    await select('nonConsecutiveShifts',1).selectOption('evening');
    await cancel('nonConsecutiveShifts',1);
    assert.equal(await select('nonConsecutiveShifts',1).inputValue(), 'night');
    await cap(1).fill('4'); await save('weeklyShiftLimits',1);
    await persisted(page, state => state.rules.weeklyShiftLimits[0].maxPerWeek === 4);
    await cap(1).fill('2'); await save('weeklyShiftLimits',1);
    await persisted(page, state => state.rules.weeklyShiftLimits[0].maxPerWeek === 2);
    record('rule editing, cancellation and duplicate-shift prevention work');

    for (const value of ['', '-1', '1.5', '8']) {
      await cap(1).fill(value); await save('weeklyShiftLimits',1);
      assert.match(await card('weeklyShiftLimits').getByRole('alert').innerText(), /0–7.*整数/);
      assert.equal((await currentState(page)).rules.weeklyShiftLimits[0].maxPerWeek, 2);
    }
    await cancel('weeklyShiftLimits',1);
    await cap(1).fill('0'); await save('weeklyShiftLimits',1);
    await persisted(page, state => state.rules.weeklyShiftLimits[0].maxPerWeek === 0);
    await cap(1).fill('2'); await save('weeklyShiftLimits',1);
    await persisted(page, state => state.rules.weeklyShiftLimits[0].maxPerWeek === 2);
    record('weekly caps reject blank/negative/fractional/over-seven input and accept zero');

    await addRule('nonConsecutiveShifts','evening');
    assert.equal(await add('nonConsecutiveShifts').isDisabled(), true);
    await remove('nonConsecutiveShifts',3);
    await persisted(page, state => state.rules.nonConsecutiveShifts.length === 2);
    assert.equal(await add('nonConsecutiveShifts').isEnabled(), true);
    await add('weeklyShiftLimits').click();
    assert.equal(await select('weeklyShiftLimits',3).inputValue(), 'evening');
    await cancel('weeklyShiftLimits',3);
    assert.equal((await currentState(page)).rules.weeklyShiftLimits.length, 2);
    record('add/delete/draft-cancel maintain distinct saved rows and available choices');

    await add('nonConsecutiveShifts').click(); await add('weeklyShiftLimits').click();
    await save('nonConsecutiveShifts',3);
    await persisted(page,state => state.rules.nonConsecutiveShifts.length === 3);
    assert.equal(await card('weeklyShiftLimits').locator('.sp-shift-rule-row').count(),3);
    assert.equal((await currentState(page)).rules.weeklyShiftLimits.length,2);
    await remove('nonConsecutiveShifts',3); await cancel('weeklyShiftLimits',3);
    await persisted(page,state => state.rules.nonConsecutiveShifts.length === 2);
    record('saving one rule group preserves the other group’s unsaved draft');

    await add('nonConsecutiveShifts').click(); await add('weeklyShiftLimits').click();
    await page.getByLabel('全局排班月份',{exact:true}).fill('2026-11');
    await page.getByLabel('全局排班月份',{exact:true}).dispatchEvent('change');
    await persisted(page,state => state.month === '2026-11');
    assert.equal(await card('nonConsecutiveShifts').locator('.sp-shift-rule-row').count(),2);
    assert.equal(await card('weeklyShiftLimits').locator('.sp-shift-rule-row').count(),2);
    await page.getByLabel('全局排班月份',{exact:true}).fill('2026-10');
    await page.getByLabel('全局排班月份',{exact:true}).dispatchEvent('change');
    await persisted(page,state => state.month === '2026-10');
    record('month changes discard uncommitted rule drafts without altering saved rules');

    const configured = await currentState(page);
    await screenshot(page, 'rules-desktop');
    await noOverflow(page);
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
    const backup = await download(page, page.getByRole('button', { name: /^导出完整备份/ }), 'rules-backup.json');
    assert.deepEqual(backup.data.rules, configured.rules);
    if (await page.getByRole('button', { name: '关闭备份面板', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭备份面板', exact: true }).click();
    await remove('nonConsecutiveShifts',1); await remove('weeklyShiftLimits',1);
    await persisted(page, state => state.rules.nonConsecutiveShifts.length === 1 && state.rules.weeklyShiftLimits.length === 1);
    await importDocument(page, backup.data);
    assert.equal(await select('nonConsecutiveShifts',1).inputValue(), 'night');
    assert.equal(await cap(1).inputValue(), '2');
    await select('nonConsecutiveShifts',1).selectOption('evening'); await cap(1).fill('7');
    await importDocument(page,backup.data);
    assert.equal(await select('nonConsecutiveShifts',1).inputValue(),'night'); assert.equal(await cap(1).inputValue(),'2');
    record('importing unchanged IDs/values resets unsaved drafts in both groups');

    const sameIds = clone(backup.data);
    sameIds.rules.nonConsecutiveShifts[0].id = 'shared-rule-id';
    sameIds.rules.weeklyShiftLimits[0].id = 'shared-rule-id';
    await importDocument(page,sameIds);
    await cap(1).fill('4'); await save('weeklyShiftLimits',1);
    await persisted(page,state => state.rules.weeklyShiftLimits[0].maxPerWeek === 4);
    assert.equal(await page.evaluate(() => document.activeElement.closest('[data-rule-kind]')?.dataset.ruleKind),'weeklyShiftLimits');
    const ids = await page.locator('.sp-shift-rule-row').evaluateAll(rows => rows.map(row => row.id));
    assert.equal(new Set(ids).size,ids.length);
    await importDocument(page,backup.data);
    record('same rule ID in different kinds keeps distinct DOM IDs and correct save focus');
    await page.reload({ waitUntil: 'networkidle' });
    await navigate(page, '排班规则');
    assert.deepEqual((await currentState(page)).rules, configured.rules);
    assert.equal(await card('weeklyShiftLimits').locator('.sp-shift-rule-row').count(), 2);
    record('new rules survive download/import and a real reload');

    for (const width of [390,320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0);
      for (const kind of ['nonConsecutiveShifts','weeklyShiftLimits']) {
        await select(kind,1).scrollIntoViewIfNeeded();
        const size = await noOverflow(page);
        for (const control of [select(kind,1), ...(kind === 'weeklyShiftLimits' ? [cap(1)] : [])]) {
          const box = await control.boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.height >= 44, `touch control outside ${width}px viewport: ${JSON.stringify(box)}`);
        }
        await screenshot(page, `${kind}-${width}`);
        record(`${width}px ${kind} controls fit and have touch-sized targets`,size);
      }
      await cap(1).fill('3'); await cancel('weeklyShiftLimits',1);
      assert.equal(await cap(1).inputValue(), '2');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    record('mobile inline changes can be cancelled without losing saved values');

    await navigate(page,'班次设置');
    await page.getByRole('button', { name: '删除夜班', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    const cleaned = await persisted(page, state => !state.shifts.some(shift => shift.id === 'night'));
    assert.deepEqual(cleaned.rules.nonConsecutiveShifts.map(rule => rule.shiftId), ['morning']);
    assert.deepEqual(cleaned.rules.weeklyShiftLimits.map(rule => rule.shiftId), ['morning']);
    await importDocument(page, backup.data);
    record('deleting a shift removes both related rule types and backup restores them');

    await navigate(page,'排班日历');
    const exported = await download(page, page.getByRole('button', { name: '导出规则', exact: true }), 'rules-solver-input.json');
    assert.deepEqual(exported.data.state.rules, configured.rules);
    assert.deepEqual(exported.data.state.assignments, fixture.assignments);
    record('solver-debug JSON includes both rule lists and adjacent-month assignments');

    if (!process.env.SHIFT_RULES_UI_ONLY) {
      const solved = await runSolver(exported.file);
      await fs.writeFile(path.join(out,'rules-solver-result.json'),JSON.stringify(solved,null,2));
      assert.ok(['OPTIMAL','FEASIBLE'].includes(solved.status), JSON.stringify(solved));
      record('actual Python --input replay obeys all rules, staffing and cross-month boundaries', audit(exported.data.state, solved.assignments));

      await page.getByRole('button', { name: '自动排班', exact: true }).click();
      await page.getByRole('button', { name: '开始生成', exact: true }).click();
      await page.locator('.sp-solve-result').waitFor({ timeout: 45000 });
      const message = await page.locator('.sp-solve-result').innerText();
      assert.equal(await page.locator('.sp-solve-result').evaluate(element => element.classList.contains('is-warning')),false,message);
      const generated = await persisted(page,state => state.assignments.filter(item => item.date.startsWith('2026-10')).length === 62);
      record('real browser worker obeys both rule types and preserves boundary assignments',audit(configured,generated.assignments));
      assert.match(await page.locator('.sp-check-status').innerText(), /排班检查通过/);
      await screenshot(page,'valid-browser-roster');
      await checkFeedbackVisibility(page,'browser-success');

      const conflict = clone(configured);
      conflict.teamName = '锁定跨月冲突验收';
      conflict.shifts.forEach(shift => { shift.required = 0; shift.staffingMode = 'minimum'; });
      conflict.rules.nonConsecutiveShifts = [{ id: 'no-night-pair', shiftId: 'night' }];
      conflict.rules.weeklyShiftLimits = [{ id: 'night-once', shiftId: 'night', maxPerWeek: 1 }];
      conflict.assignments = [
        { employeeId: 'qa-1', date: '2026-09-30', shiftId: 'night', locked: false },
        { employeeId: 'qa-1', date: '2026-10-01', shiftId: 'night', locked: true },
        { employeeId: 'qa-1', date: '2026-10-02', shiftId: 'night', locked: true },
      ];
      await importDocument(page, conflict);
      await page.locator('.sp-check-status').click();
      const manual = await page.locator('.sp-issues').innerText();
      assert.match(manual, /测试成员甲/); assert.match(manual, /夜班/);
      assert.match(manual, /连续|相连/); assert.match(manual, /最多.*1|上限.*1/);
      record('calendar flags manually entered consecutive and weekly-count conflicts',manual);

      const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
      let lastResult;
      await desktop.exposeFunction('qaInvoke',async(cmd,args)=>{
        if (cmd === 'plugin:event|listen') return 1;
        if (cmd === 'plugin:event|unlisten') return null;
        if (cmd === 'solver_info') return { engine: 'ortools-cp-sat', protocolVersion: 1, version: 'browser-acceptance-bridge', local: true };
        if (cmd === 'solve_schedule') {
          const file = path.join(out,'conflict-solver-input.json'); await fs.writeFile(file,JSON.stringify(args.request,null,2));
          lastResult = await runSolver(file); await fs.writeFile(path.join(out,'conflict-solver-result.json'),JSON.stringify(lastResult,null,2)); return lastResult;
        }
        throw new Error(`Unexpected IPC: ${cmd}`);
      });
      await open(desktop, conflict, true);
      await desktop.getByRole('button', { name: '自动排班', exact: true }).click();
      await desktop.getByRole('button', { name: '开始生成', exact: true }).click();
      await desktop.locator('.sp-solve-result').waitFor({ timeout: 45000 });
      const text = await desktop.locator('.sp-solve-result').innerText();
      assert.equal(lastResult.status,'INFEASIBLE');
      assert.match(text,/测试成员甲/); assert.match(text,/夜班/); assert.match(text,/2026-09-30|2026-10-01/);
      assert.match(text,/连续|相连/); assert.match(text,/最多.*1|上限.*1/); assert.match(text,/建议/);
      assert.match(text,/原排班未改变/);
      assert.deepEqual((await currentState(desktop)).assignments,conflict.assignments);
      record('real CP-SAT failure names conflicting member/shift/dates and preserves locked roster',text);
      await screenshot(desktop,'conflict-desktop');
      await checkFeedbackVisibility(desktop,'desktop-failure');
      const ruleAction = desktop.locator('.sp-conflict-list button').filter({ hasText: /规则/ }).first();
      assert.ok(await ruleAction.count() > 0,'A conflict must offer a rule settings action');
      await ruleAction.click(); assert.equal(await desktop.locator('h1').innerText(),'排班规则');
      record('new-rule conflict action navigates to rule settings');
      await navigate(desktop,'排班日历');
      await desktop.setViewportSize({ width: 390, height: 844 });
      await desktop.waitForFunction(() => document.querySelector('.sp-sidebar').getBoundingClientRect().right <= 0);
      await noOverflow(desktop); await screenshot(desktop,'conflict-mobile');
      record('new-rule diagnostic guidance remains within mobile viewport');
      await desktop.close();
    }
    assert.deepEqual(report.errors,[]);
    record('no unhandled browser exceptions');
    report.ok = true;
  } catch (error) {
    report.ok = false; report.failure = error.stack || String(error);
    report.failureState = await currentState(page).catch(()=>null);
    report.failureControls = await page.locator('[data-rule-kind]').evaluateAll(cards => cards.map(card => ({ kind: card.dataset.ruleKind, rows: [...card.querySelectorAll('form')].map(row => ({ id: row.id, select: row.querySelector('select')?.value, options: [...row.querySelectorAll('option')].map(option => ({ value: option.value, disabled: option.disabled })) })) }))).catch(()=>[]);
    await screenshot(page,'failure').catch(()=>{});
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
    await browser.close();
  }
}

async function feedbackRegression() {
  await fs.mkdir(out,{recursive:true});
  const browser = await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
  try {
    for (const outcome of ['success','failure','team-capacity']) {
      const state = clone(fixture);
      if (outcome === 'failure') {
        state.shifts.forEach(shift=>{shift.required=0;shift.staffingMode='minimum';});
        state.rules.nonConsecutiveShifts=[{id:'no-night-pair',shiftId:'night'}];
        state.rules.weeklyShiftLimits=[{id:'night-once',shiftId:'night',maxPerWeek:1}];
        state.assignments=[
          {employeeId:'qa-1',date:'2026-09-30',shiftId:'night',locked:false},
          {employeeId:'qa-1',date:'2026-10-01',shiftId:'night',locked:true},
          {employeeId:'qa-1',date:'2026-10-02',shiftId:'night',locked:true},
        ];
      }
      if(outcome==='team-capacity'){
        state.employees=state.employees.slice(0,2).map(employee=>({...employee,eligibleShiftIds:['morning']}));
        state.shifts=[{...state.shifts[0],required:2}];state.assignments=[];
        state.rules.separationGroups=[{id:'all-staff-exclusive',name:'全员错班',employeeIds:state.employees.map(employee=>employee.id),shiftIds:['morning']}];
      }
      const page = await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN',timezoneId:'Asia/Shanghai'});
      let request,result; const saved=[];
      await page.exposeFunction('qaInvoke',async(cmd,args)=>{
        if(cmd==='plugin:event|listen')return 1;if(cmd==='plugin:event|unlisten')return null;
        if(cmd==='solver_info')return {engine:'ortools-cp-sat',protocolVersion:1,version:'browser-acceptance-bridge',local:true};
        if(cmd==='solve_schedule'){
          request=args.request;const file=path.join(out,`feedback-${outcome}-request.json`);await fs.writeFile(file,JSON.stringify(request,null,2));
          result=await runSolver(file);await fs.writeFile(path.join(out,`feedback-${outcome}-result.json`),JSON.stringify(result,null,2));return result;
        }
        if(cmd==='save_export'){
          const data=JSON.parse(Buffer.from(args.contents).toString());saved.push(data);await fs.writeFile(path.join(out,`feedback-${outcome}-export-${saved.length}.json`),JSON.stringify(data,null,2));return true;
        }
        throw new Error(`Unexpected IPC ${cmd}`);
      });
      await open(page,state,true);
      await page.getByRole('button',{name:'自动排班',exact:true}).click();
      await page.getByRole('button',{name:'开始生成',exact:true}).click();
      await page.locator('.sp-solve-result').waitFor({timeout:45000});
      assert.equal(await page.locator('.sp-solve-result').evaluate(el=>el.classList.contains('is-warning')),outcome!=='success');
      assert.equal(['OPTIMAL','FEASIBLE'].includes(result.status),outcome==='success');
      record(`real CP-SAT ${outcome} result appears in calendar`);
      await checkFeedbackVisibility(page,`desktop-${outcome}`);
      if(outcome==='team-capacity'){
        assert.ok(result.issues.some(issue=>issue.type==='separation-capacity'),JSON.stringify(result.issues));
        await page.locator('.sp-conflict-list button').filter({hasText:/规则/}).first().click();
        assert.equal(await page.getByRole('tab',{name:'团队规则',exact:true}).getAttribute('aria-selected'),'true');
        assert.equal(await page.evaluate(()=>document.activeElement.id),'sp-rule-panel-team');
        assert.equal(await page.locator('.sp-solve-result').count(),0);
        record('real separation-capacity diagnostic opens and focuses the visible team rules panel');
        await screenshot(page,'feedback-team-capacity-action');
      }
      if(outcome==='failure'){
        const snapshot=async()=>{
          const previous=saved.length;await page.getByRole('button',{name:'导出本次规则',exact:true}).click();
          for(let i=0;i<100&&saved.length===previous;i++)await page.waitForTimeout(25);
          assert.equal(saved.length,previous+1);const exported=saved.at(-1);
          assert.deepEqual(exported.state,request.state);assert.deepEqual(exported.options,request.options);assert.equal(exported.requestId,request.requestId);return exported;
        };
        await snapshot();record('failure snapshot remains exportable after leaving and returning to calendar');
        await navigate(page,'排班规则');
        await page.getByLabel('班间最短休息小时数',{exact:true}).fill('1');
        await page.getByRole('button',{name:/^保存(?:个人)?规则$/}).click();
        await persisted(page,value=>value.rules.minRestHours===1);
        assert.equal(await page.locator('.sp-solve-result').count(),0);
        await navigate(page,'排班日历');await page.locator('.sp-diagnostic-stale').waitFor();
        assert.deepEqual((await currentState(page)).assignments,state.assignments);
        record('editing rules while failure is hidden restores stale guidance without changing roster');
        const past=await snapshot();assert.equal(past.state.rules.minRestHours,0);
        record('stale failure export retains the exact original request after configuration changes');
        await page.setViewportSize({width:390,height:844});
        await page.waitForFunction(()=>document.querySelector('.sp-sidebar').getBoundingClientRect().right<=0);
        await noOverflow(page);await screenshot(page,'feedback-stale-mobile');
        await navigate(page,'成员管理');assert.equal(await page.locator('.sp-solve-result').count(),0);
        await screenshot(page,'feedback-hidden-members-mobile');
        await navigate(page,'排班日历');assert.equal(await page.locator('.sp-diagnostic-stale').isVisible(),true);
        record('mobile menu navigation hides failure and retains stale result on returning');
      }
      await page.close();
    }
    assert.deepEqual(report.errors,[]);record('no unhandled exceptions in feedback navigation');report.ok=true;
  }catch(error){
    report.ok=false;report.failure=error.stack||String(error);
    report.failurePages=[];
    for(const [index,page] of browser.contexts().flatMap(context=>context.pages()).entries()){
      report.failurePages.push(await page.locator('body').innerText().catch(()=>''));
      await screenshot(page,`feedback-failure-${index}`).catch(()=>{});
    }
    throw error;
  }
  finally{report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(out,'feedback-report.json'),JSON.stringify(report,null,2)+'\n');await browser.close();}
}

async function groupRegression() {
  await fs.mkdir(out,{recursive:true});
  const browser = await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
  const page = await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN',timezoneId:'Asia/Shanghai'});
  const personal = () => page.getByRole('tab',{name:'个人规则',exact:true});
  const team = () => page.getByRole('tab',{name:'团队规则',exact:true});
  try{
    await open(page);await navigate(page,'排班规则');
    assert.equal(await personal().getAttribute('aria-selected'),'true');
    assert.equal(await page.getByLabel('班间最短休息小时数',{exact:true}).isVisible(),true);
    assert.equal(await page.locator('[data-rule-kind="nonConsecutiveShifts"]').isVisible(),true);
    assert.equal(await page.locator('[data-rule-kind="weeklyShiftLimits"]').isVisible(),true);
    assert.equal(await page.getByLabel('启用上班权重',{exact:true}).isVisible(),false);
    assert.equal(await page.locator('.sp-settings-separation').isVisible(),false);
    record('personal rules are the default and contain rest, consecutive days and both shift limits');
    await personal().focus();await personal().press('ArrowRight');
    assert.equal(await team().getAttribute('aria-selected'),'true');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'sp-rule-tab-team');
    assert.equal(await page.getByLabel('启用上班权重',{exact:true}).isVisible(),true);
    assert.equal(await page.locator('.sp-settings-separation').isVisible(),true);
    assert.equal(await page.getByLabel('班间最短休息小时数',{exact:true}).isVisible(),false);
    await team().press('ArrowLeft');
    assert.equal(await personal().getAttribute('aria-selected'),'true');
    record('team tab contains weights and separation, with keyboard-accessible category switching');

    await page.getByLabel('班间最短休息小时数',{exact:true}).fill('2');
    await page.getByLabel('最大连续工作天数',{exact:true}).fill('4');
    await page.getByRole('button',{name:'添加班次不相连规则',exact:true}).click();
    await page.getByLabel('第 1 条不相连规则班次',{exact:true}).selectOption('night');
    await team().click();
    await page.getByLabel('启用上班权重',{exact:true}).check();
    await page.getByLabel('所选星期合计占比',{exact:true}).fill('40');
    await page.getByRole('button',{name:'保存团队规则',exact:true}).click();
    const first = await persisted(page,state=>state.rules.weekdayWeights?.percent===40);
    assert.equal(first.rules.minRestHours,0);assert.equal(first.rules.maxConsecutiveDays,31);assert.equal(first.rules.nonConsecutiveShifts,undefined);
    await personal().click();
    assert.equal(await page.getByLabel('班间最短休息小时数',{exact:true}).inputValue(),'2');
    assert.equal(await page.getByLabel('最大连续工作天数',{exact:true}).inputValue(),'4');
    assert.equal(await page.getByLabel('第 1 条不相连规则班次',{exact:true}).inputValue(),'night');
    record('team save leaves personal basic and new-row drafts uncommitted and intact');
    await page.getByRole('button',{name:'保存个人规则',exact:true}).click();
    const second = await persisted(page,state=>state.rules.minRestHours===2&&state.rules.maxConsecutiveDays===4);
    assert.deepEqual(second.rules.weekdayWeights,{days:[1,6],percent:40});assert.equal(second.rules.nonConsecutiveShifts,undefined);
    record('personal save changes only personal basic settings and leaves team weight unchanged');

    await team().click();await page.getByLabel('所选星期合计占比',{exact:true}).fill('50');
    await personal().click();await page.getByRole('button',{name:'保存第 1 条不相连规则',exact:true}).click();
    const third = await persisted(page,state=>state.rules.nonConsecutiveShifts?.[0].shiftId==='night');
    assert.equal(third.rules.weekdayWeights.percent,40);
    await team().click();assert.equal(await page.getByLabel('所选星期合计占比',{exact:true}).inputValue(),'50');
    await page.getByRole('button',{name:'保存团队规则',exact:true}).click();
    const fourth = await persisted(page,state=>state.rules.weekdayWeights?.percent===50);
    assert.deepEqual(fourth.rules.nonConsecutiveShifts,third.rules.nonConsecutiveShifts);
    record('saving an individual shift row preserves unsaved team weight and vice versa');

    await page.getByLabel('启用上班权重',{exact:true}).uncheck();
    await personal().click();await page.getByLabel('班间最短休息小时数',{exact:true}).fill('3');
    await page.getByRole('button',{name:'保存个人规则',exact:true}).click();
    assert.equal((await persisted(page,state=>state.rules.minRestHours===3)).rules.weekdayWeights.percent,50);
    await team().click();assert.equal(await page.getByLabel('启用上班权重',{exact:true}).isChecked(),false);
    await page.getByRole('button',{name:'保存团队规则',exact:true}).click();
    const fifth = await persisted(page,state=>state.rules.weekdayWeights===undefined);
    assert.equal(fifth.rules.minRestHours,3);assert.equal(fifth.rules.nonConsecutiveShifts.length,1);
    record('disabling team weights does not overwrite personal rules or cross-save pending changes');

    await personal().click();await page.getByRole('button',{name:'添加周班次限制规则',exact:true}).click();
    await page.getByLabel('第 1 条周次数规则班次',{exact:true}).selectOption('night');
    await team().click();await page.getByRole('button',{name:/添加互斥组/}).click();
    await page.getByLabel('规则名称',{exact:true}).fill('测试错班');
    await page.locator('.sp-settings-member-options input').nth(0).check();await page.locator('.sp-settings-member-options input').nth(1).check();
    await page.getByRole('button',{name:'保存互斥组',exact:true}).click();
    const sixth = await persisted(page,state=>state.rules.separationGroups?.[0].name==='测试错班');
    assert.equal(sixth.rules.weeklyShiftLimits,undefined);
    await personal().click();assert.equal(await page.getByLabel('第 1 条周次数规则班次',{exact:true}).inputValue(),'night');
    await page.getByRole('button',{name:'保存第 1 条周次数规则',exact:true}).click();
    const seventh = await persisted(page,state=>state.rules.weeklyShiftLimits?.[0].shiftId==='night');
    assert.deepEqual(seventh.rules.separationGroups,sixth.rules.separationGroups);
    record('team separation saves independently while a personal weekly-limit draft survives');
    await personal().scrollIntoViewIfNeeded();await screenshot(page,'groups-personal-desktop');
    await team().click();await team().scrollIntoViewIfNeeded();await screenshot(page,'groups-team-desktop');

    for(const width of [390,320]){
      await page.setViewportSize({width,height:844});
      await page.waitForFunction(()=>document.querySelector('.sp-sidebar').getBoundingClientRect().right<=0);
      for(const [label,tab] of [['personal',personal],['team',team]]){
        await tab().click();await tab().scrollIntoViewIfNeeded();await noOverflow(page);
        const box=await tab().boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width);
        await screenshot(page,`groups-${label}-${width}`);
      }
      record(`${width}px personal/team tabs switch without viewport overflow`);
    }
    await page.reload({waitUntil:'networkidle'});await navigate(page,'排班规则');
    assert.equal(await personal().getAttribute('aria-selected'),'true');
    assert.deepEqual((await currentState(page)).rules,seventh.rules);
    record('both categories persist together after reload while reopening on personal rules');
    assert.deepEqual(report.errors,[]);record('no browser exceptions during grouped rule editing');report.ok=true;
  }catch(error){report.ok=false;report.failure=error.stack||String(error);await screenshot(page,'groups-failure').catch(()=>{});throw error;}
  finally{report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(out,'groups-report.json'),JSON.stringify(report,null,2)+'\n');await browser.close();}
}
(process.env.SHIFT_RULES_GROUPS_ONLY ? groupRegression : process.env.SHIFT_RULES_FEEDBACK_ONLY ? feedbackRegression : main)().catch(error => { console.error(error); process.exitCode = 1; });
