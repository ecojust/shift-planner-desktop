/* Start Vite first, then run from the project root:
 * SHIFT_FLOW_PYTHON=/path/to/python PLAYWRIGHT_MODULE_PATH=/path/to/playwright node tests/browser/solver-diagnostics.cjs
 * Optional: SOLVER_DIAGNOSTICS_TEST_URL, SOLVER_DIAGNOSTICS_TEST_OUTPUT,
 * PLAYWRIGHT_EXECUTABLE_PATH (otherwise Playwright's installed browser is used).
 * Uses real Vue UI, downloads and Python CP-SAT; only Tauri IPC / file dialogs
 * are replaced by a test bridge. Does not exercise native packaging or dialogs.
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  try {
    if (!process.env.PLAYWRIGHT_MODULE_PATH) throw new Error('Playwright is not installed');
    ({ chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH));
  } catch {
    console.error('Browser checks need Playwright. Install it separately or set PLAYWRIGHT_MODULE_PATH to its package directory.');
    process.exit(2);
  }
}
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.SOLVER_DIAGNOSTICS_TEST_OUTPUT || path.join(repo, 'test-results/solver-diagnostics'));
const url = process.env.SOLVER_DIAGNOSTICS_TEST_URL || 'http://127.0.0.1:5193/';
const python = process.env.SHIFT_FLOW_PYTHON || path.join(repo, 'solver/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const report = { url, startedAt: new Date().toISOString(), checks: [], failures: [], errors: [], screenshots: [] };
const names = ['陈晨','林晚晴','周予安','许知夏','江远','沈一诺','陆星遥','顾南风','宋宁','唐悦','苏念','程屿'];
const fixture = {
  version: 1, teamName: '我的排班', month: '2026-10', monthlyReferenceHours: { '2026-10': 144 },
  employees: names.map((name,i) => ({ id:`employee-${i+1}`,name,role:'服务专员',group:'测试组',color:'#d7e8f8',minHoursPerMonth:null,minHoursPerWeek:40,maxHoursPerWeek:56,eligibleShiftIds:['morning','evening','night'],unavailableDates:[] })),
  shifts: [
    {id:'morning',name:'早班',shortName:'早',start:'08:00',end:'16:00',color:'#dbeee6',required:1,staffingMode:'fixed',normalAllowance:0},
    {id:'evening',name:'晚班',shortName:'晚',start:'14:00',end:'22:00',color:'#e5def7',required:1,staffingMode:'fixed',normalAllowance:0},
    {id:'night',name:'夜班',shortName:'夜',start:'22:00',end:'06:00',color:'#dce8fa',required:1,staffingMode:'fixed',normalAllowance:50},
  ],
  rules: { minRestHours:11,maxConsecutiveDays:5 },
  assignments: [
    {employeeId:'employee-1',date:'2026-10-01',shiftId:'morning',locked:true},
    {employeeId:'employee-2',date:'2026-09-30',shiftId:'night',locked:false},
  ],
};
function runSolver(input) {
  return new Promise((resolve,reject) => {
    const p = spawn(python,[path.join(repo,'solver/main.py'),'--input',input],{cwd:repo});
    let stdout='',stderr=''; const timeout=setTimeout(()=>{p.kill('SIGKILL');reject(new Error('solver child timeout'));},45000);
    p.stdout.on('data',data=>stdout+=data);p.stderr.on('data',data=>stderr+=data);
    p.on('error',error=>{clearTimeout(timeout);reject(error);});p.on('close',code=>{clearTimeout(timeout);try{const result=JSON.parse(stdout);if(code)throw new Error(`Solver exit ${code}: ${stderr}`);resolve(result);}catch(e){reject(e);}});
  });
}
async function check(label,fn) { try {await fn(); report.checks.push(label); console.log('PASS',label);}catch(e){report.failures.push({label,error:e.stack});console.log('FAIL',label,e.message);} }
async function saveSnapshot(page, buttonName, saved) {
  const previous = saved.length;
  await page.getByRole('button',{name:buttonName,exact:true}).click();
  const deadline = Date.now() + 5000;
  while(saved.length === previous && Date.now() < deadline) await page.waitForTimeout(25);
  assert.equal(saved.length,previous+1,'export must finish writing one file');
  return saved.at(-1);
}
async function shot(page,name) {const file=path.join(out,name+'.png');await page.screenshot({path:file,fullPage:false});report.screenshots.push(file);}
async function overflow(page,label) {const x=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth}));assert.equal(x.scroll,x.width,label+JSON.stringify(x));assert.equal(x.body,x.width,label+JSON.stringify(x));}
async function plainInterface(page) {
  assert.doesNotMatch(await page.locator('body').innerText(), /CP-SAT|OR-Tools|启发式|命令行|原生协议|求解器|引擎|组件|Vue|TypeScript|npm run|browser-test-bridge/i);
}
async function fillState(page,desktop=false,state=fixture) {
  await page.addInitScript(({fixture,desktop})=>{
    localStorage.setItem('shift-planner:v1',JSON.stringify(fixture));
    if(desktop){
      window.isTauri=true; let cb=0;
      window.__TAURI_INTERNALS__={invoke:(cmd,args)=>window.qaInvoke(cmd,args),transformCallback:()=>++cb,unregisterCallback:()=>{}};
      window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
    }
  },{fixture:state,desktop});
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(url,{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'排班日历',exact:true}).waitFor();
}
(async()=>{
  await fs.mkdir(out,{recursive:true}); await fs.writeFile(path.join(out,'fixture.json'),JSON.stringify(fixture,null,2));
  const browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
  try {
    const web=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
    await fillState(web);
    await check('browser toolbar export is downloadable and complete',async()=>{
      await plainInterface(web);
      const pending=web.waitForEvent('download');await web.getByRole('button',{name:'导出规则',exact:true}).click();const d=await pending;
      await d.saveAs(path.join(out,'browser-current.json'));
      const data=JSON.parse(await fs.readFile(path.join(out,'browser-current.json'),'utf8'));
      assert.equal(data.protocolVersion,1);assert.equal(data.state.employees.length,12);assert.equal(data.state.shifts.length,3);
      assert.deepEqual(data.state.rules,fixture.rules);assert.deepEqual(data.state.assignments,fixture.assignments);
      assert.ok(data.state.employees.every(e=>e.minHoursPerMonth===144));assert.equal(data.debug.source,'current');assert.equal(data.debug.runtime,'browser');
      assert.equal(data.options.timeLimitSeconds,15);assert.equal(data.options.allowPartial,false);assert.equal(Number.isInteger(data.options.seed),true);
      report.browserFileName=d.suggestedFilename();report.browserJSONKeys=Object.keys(data);
    });
    await check('downloaded browser JSON replays against real Python --input',async()=>{const r=await runSolver(path.join(out,'browser-current.json'));assert.equal(r.status,'INFEASIBLE');report.browserReplay=r;await fs.writeFile(path.join(out,'browser-replay.json'),JSON.stringify(r,null,2));});
    await check('desktop-width calendar has no viewport overflow',()=>overflow(web,'desktop'));
    await shot(web,'calendar-desktop');
    const mobile=await browser.newPage({viewport:{width:390,height:844},acceptDownloads:true});await fillState(mobile);
    await check('390px calendar and new toolbar remain within viewport',()=>overflow(mobile,'mobile'));
    await shot(mobile,'calendar-mobile');
    await check('mobile export button downloads',async()=>{const pending=mobile.waitForEvent('download');await mobile.getByRole('button',{name:'导出规则',exact:true}).click();const d=await pending;await d.saveAs(path.join(out,'mobile-current.json'));assert.equal(JSON.parse(await fs.readFile(path.join(out,'mobile-current.json'),'utf8')).state.employees.length,12);});

    const desktop=await browser.newPage({viewport:{width:1440,height:900}});let lastRequest,lastResult;const saved=[];
    await desktop.exposeFunction('qaInvoke',async(cmd,args)=>{
      if(cmd==='plugin:event|listen')return 1;if(cmd==='plugin:event|unlisten')return null;
      if(cmd==='solver_info')return {engine:'ortools-cp-sat',protocolVersion:1,version:'browser-test-bridge',local:true};
      if(cmd==='solve_schedule'){lastRequest=args.request;const file=path.join(out,'desktop-actual-request.json');await fs.writeFile(file,JSON.stringify(lastRequest));lastResult=await runSolver(file);await fs.writeFile(path.join(out,'desktop-actual-result.json'),JSON.stringify(lastResult,null,2));return lastResult;}
      if(cmd==='save_export'){const data=Buffer.from(args.contents);const file=path.join(out,`native-${saved.length}.json`);await fs.writeFile(file,data);saved.push({file,name:args.fileName,data:JSON.parse(data.toString())});return true;}
      throw new Error(`unexpected invoke ${cmd}`);
    });
    await fillState(desktop,true);
    await desktop.getByRole('button',{name:'自动排班',exact:true}).click();await desktop.getByRole('button',{name:'开始生成',exact:true}).click();
    await desktop.locator('.sp-solve-result').waitFor({timeout:45000});
    await check('real CP-SAT failure shows concrete evidence and actions',async()=>{
      const text=await desktop.locator('.sp-solve-result').innerText();report.failureText=text;
      await plainInterface(desktop);
      assert.equal(lastRequest.options.allowPartial,false,'actual generation must require complete staffing');
      assert.equal(lastResult.status,'INFEASIBLE');assert.match(text,/1728/);assert.match(text,/原排班未改变/);assert.ok(await desktop.locator('.sp-conflict-list button').count()>0);
      assert.doesNotMatch(text,/请检查月\/周最低工时、周最高工时、锁定安排/);assert.ok(text.includes('建议：'));
    });
    await check('failed solve leaves assignments unchanged',async()=>{await desktop.waitForTimeout(500);const state=await desktop.evaluate(()=>JSON.parse(localStorage.getItem('shift-planner:v1')));assert.deepEqual(state.assignments,fixture.assignments);});
    await shot(desktop,'failure-desktop');
    await check('failed attempt export exactly reproduces solve request',async()=>{
      const {data:d,file}=await saveSnapshot(desktop,'导出本次规则',saved);
      assert.equal(d.debug.source,'attempt');assert.equal(d.requestId,lastRequest.requestId);assert.deepEqual(d.options,lastRequest.options);assert.deepEqual(d.state,lastRequest.state);
      const replay=await runSolver(file);assert.equal(replay.status,lastResult.status);assert.deepEqual(replay.issues,lastResult.issues);
    });
    await check('diagnostic action navigates to intended configuration section',async()=>{
      const button=desktop.locator('.sp-conflict-list button').first(),label=await button.innerText();await button.click();report.firstAction=label;
      const expected=label.includes('成员')?'成员管理':label.includes('班次')?'班次设置':label.includes('规则')?'排班规则':'排班日历';
      assert.equal(await desktop.locator('h1').innerText(),expected);
    });
    await desktop.getByRole('button',{name:'排班日历',exact:true}).click();
    await desktop.getByLabel('全局排班月份',{exact:true}).fill('2026-11');
    await desktop.getByLabel('全局排班月份',{exact:true}).dispatchEvent('change');
    await check('editing settings marks diagnostics stale and keeps failed snapshot separate',async()=>{
      await desktop.locator('.sp-diagnostic-stale').waitFor();
      const {data:past}=await saveSnapshot(desktop,'导出本次规则',saved);assert.equal(past.state.month,'2026-10');assert.deepEqual(past.options,lastRequest.options);
      const {data:current}=await saveSnapshot(desktop,'导出规则',saved);
      assert.equal(current.state.month,'2026-11');assert.equal(current.debug.source,'current');assert.notEqual(current.requestId,lastRequest.requestId);
    });
    await desktop.setViewportSize({width:390,height:844});await desktop.waitForTimeout(600);await desktop.evaluate(()=>scrollTo(0,0));
    if (await desktop.getByRole('button',{name:'关闭提示',exact:true}).isVisible()) await desktop.getByRole('button',{name:'关闭提示',exact:true}).click();
    await check('390px actionable failure card has no viewport overflow',()=>overflow(desktop,'mobile failure'));
    await shot(desktop,'failure-mobile');
    report.nativeExports=saved.map(s=>({file:s.file,name:s.name,month:s.data.state.month,source:s.data.debug.source}));

    // A second real solver request exercises member-specific and date-specific
    // guidance, including a previously active member search hiding the target.
    const actionState=JSON.parse(JSON.stringify(fixture));
    actionState.employees.forEach(e=>{e.minHoursPerMonth=0;e.minHoursPerWeek=0;});
    actionState.employees[0].eligibleShiftIds=['morning'];
    actionState.shifts.forEach(s=>s.staffingMode='minimum');
    actionState.assignments=[
      {employeeId:'employee-1',date:'2026-10-01',shiftId:'night',locked:true},
      {employeeId:'employee-1',date:'2026-10-02',shiftId:'morning',locked:true},
    ];
    const actionPage=await browser.newPage({viewport:{width:1440,height:900}});
    await actionPage.exposeFunction('qaInvoke',async(cmd,args)=>{
      if(cmd==='plugin:event|listen')return 1;if(cmd==='plugin:event|unlisten')return null;
      if(cmd==='solver_info')return {engine:'ortools-cp-sat',protocolVersion:1,version:'browser-test-bridge',local:true};
      if(cmd==='solve_schedule'){
        const file=path.join(out,'action-request.json');await fs.writeFile(file,JSON.stringify(args.request));
        const result=await runSolver(file);await fs.writeFile(path.join(out,'action-result.json'),JSON.stringify(result,null,2));return result;
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });
    await fillState(actionPage,true,actionState);
    await actionPage.getByRole('button',{name:'自动排班',exact:true}).click();await actionPage.getByRole('button',{name:'开始生成',exact:true}).click();
    await actionPage.locator('.sp-solve-result').waitFor({timeout:45000});
    await check('locked rest conflict gives exact person, dates and interval',async()=>{
      const text=await actionPage.locator('.sp-solve-result').innerText();
      assert.match(text,/陈晨/);assert.match(text,/2026-10-01/);assert.match(text,/2026-10-02/);assert.match(text,/间隔仅 2 小时/);assert.match(text,/11 小时/);
    });
    await check('member action focuses the exact card',async()=>{
      await actionPage.getByRole('button',{name:'查看成员设置 →',exact:true}).click();
      assert.equal(await actionPage.evaluate(()=>document.activeElement.id),'member-employee-1');
    });
    await check('member action clears existing search to reveal its target',async()=>{
      await actionPage.getByPlaceholder('搜索姓名、岗位或分组').fill('林晚晴');
      assert.equal(await actionPage.locator('#member-employee-1').count(),0);
      assert.equal(await actionPage.locator('.sp-solve-result').count(),0,'solve feedback stays in the calendar');
      await actionPage.getByRole('button',{name:'排班日历',exact:true}).click();
      await actionPage.getByRole('button',{name:'查看成员设置 →',exact:true}).click();
      assert.equal(await actionPage.evaluate(()=>document.activeElement.id),'member-employee-1');
      assert.equal(await actionPage.getByPlaceholder('搜索姓名、岗位或分组').inputValue(),'');
    });
    await check('date action selects the target week and member',async()=>{
      assert.equal(await actionPage.locator('.sp-solve-result').count(),0,'member settings do not show the calendar result');
      await actionPage.getByRole('button',{name:'排班日历',exact:true}).click();
      await actionPage.getByRole('button',{name:'查看对应日期 →',exact:true}).click();
      assert.equal(await actionPage.locator('h1').innerText(),'排班日历');
      assert.equal(await actionPage.getByRole('textbox',{name:'搜索成员',exact:true}).inputValue(),'陈晨');
      assert.equal(await actionPage.getByRole('button',{name:'陈晨 2026-10-02 早班，点击编辑',exact:true}).count(),1);
    });
    await actionPage.waitForTimeout(600);await shot(actionPage,'action-date-desktop');
    await check('diagnostic navigation preserves locked assignments',async()=>{
      const current=await actionPage.evaluate(()=>JSON.parse(localStorage.getItem('shift-planner:v1')));
      assert.deepEqual(current.assignments,actionState.assignments);
    });
  } catch(e){report.failures.push({label:'unhandled QA run error',error:e.stack});console.error(e);}
  finally {await browser.close();report.ok=report.failures.length===0&&report.errors.length===0;if(!report.ok)process.exitCode=1;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
})();
