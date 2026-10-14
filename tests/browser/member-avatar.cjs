/* Start a production preview, then run:
 * AVATAR_TEST_URL=http://127.0.0.1:5194 PLAYWRIGHT_MODULE_PATH=/path/to/playwright PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium node tests/browser/member-avatar.cjs
 * Real Vue profile uploads, storage, backups and solver-debug exports. Fixtures
 * are drawn with browser Canvas; no external images or personal data are used.
 * The race checks delay the native createImageBitmap promise, then release real
 * image decodes out of order. Native OS file pickers/packaging are not covered.
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const url = process.env.AVATAR_TEST_URL || 'http://127.0.0.1:5194/'
const output = path.resolve(process.env.AVATAR_TEST_OUTPUT || 'test-results/member-avatar')
const report = { url, startedAt: new Date().toISOString(), scope: 'Real browser image upload/processing, offline persistence and JSON exports; no native file dialogs', checks: [], errors: [], screenshots: [], ok: false }
const record = (name, detail) => { report.checks.push({ name, ...(detail ? { detail } : {}) }); console.log('PASS', name) }
const fixture = {
  version: 1, teamName: '头像验收团队', month: '2026-10', monthlyReferenceHours: { '2026-10': 144 },
  employees: ['测试成员甲', '测试成员乙'].map((name, index) => ({ id: `avatar-${index + 1}`, name, role: '测试岗位', group: '验收组', color: '#d7e8f8', minHoursPerMonth: 0, minHoursPerWeek: 40, maxHoursPerWeek: 48, eligibleShiftIds: ['day','night'], unavailableDates: index ? [] : ['2026-10-20'] })),
  shifts: [
    { id: 'day', name: '日班', shortName: '日', start: '08:00', end: '16:00', color: '#dbeee6', required: 0, staffingMode: 'minimum', normalAllowance: 20 },
    { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#e5def7', required: 0, staffingMode: 'minimum', normalAllowance: 50 },
  ],
  rules: { minRestHours: 0, maxConsecutiveDays: 5, nonConsecutiveShifts: [{ id: 'night-no-pair', shiftId: 'night' }], weeklyShiftLimits: [{ id: 'night-cap', shiftId: 'night', maxPerWeek: 2 }] },
  assignments: [{ employeeId: 'avatar-1', date: '2026-10-03', shiftId: 'day', locked: true }],
}
async function main() {
  await fs.mkdir(output,{recursive:true})
  await fs.rm(path.join(output,'failure.png'),{force:true})
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', acceptDownloads: true })
  page.on('pageerror',error=>report.errors.push(error.stack||String(error)))
  page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text())})
  await page.addInitScript(fixture=>{
    if(!sessionStorage.getItem('avatar-fixture')){localStorage.setItem('shift-planner:v1',JSON.stringify(fixture));sessionStorage.setItem('avatar-fixture','1')}
    const native = window.createImageBitmap.bind(window)
    window.qaHoldBitmaps=false;window.qaHeldBitmaps=[];window.qaBitmapCompleted=[]
    window.createImageBitmap=(...args)=>window.qaHoldBitmaps?new Promise((resolve,reject)=>window.qaHeldBitmaps.push({name:args[0]?.name,args,resolve,reject})):native(...args)
    window.qaReleaseBitmap=name=>{const index=window.qaHeldBitmaps.findIndex(job=>job.name===name);if(index<0)throw new Error('No held image '+name);const [job]=window.qaHeldBitmaps.splice(index,1);native(...job.args).then(bitmap=>{job.resolve(bitmap);queueMicrotask(()=>window.qaBitmapCompleted.push(name))},error=>{job.reject(error);queueMicrotask(()=>window.qaBitmapCompleted.push(name))})}
  },fixture)
  const state = () => page.evaluate(()=>JSON.parse(localStorage.getItem('shift-planner:v1')))
  async function persisted(predicate){for(let i=0;i<160;i++){const s=await state();if(s&&predicate(s))return s;await page.waitForTimeout(50)}assert.fail('Expected profile data did not persist')}
  async function navigate(label){const toggle=page.getByRole('button',{name:'打开导航',exact:true});const compact=await toggle.isVisible();if(compact)await toggle.click();await page.getByRole('navigation',{name:'应用导航'}).getByRole('button',{name:label}).click();if(compact)await page.waitForFunction(()=>document.querySelector('.sp-sidebar').getBoundingClientRect().right<=0)}
  const member = name => page.locator('.sp-settings-employee-card').filter({has:page.getByRole('heading',{name,exact:true})})
  const dialog = () => page.getByRole('dialog',{name:'编辑成员资料',exact:true})
  const upload = () => dialog().getByLabel('上传成员头像',{exact:true})
  const preview = () => dialog().getByRole('img',{name:'头像预览',exact:true})
  async function edit(name='测试成员甲'){await page.getByRole('button',{name:`编辑${name}`,exact:true}).click();await dialog().waitFor()}
  async function source(){return await preview().count()?preview().getAttribute('src'):null}
  async function ready(){await page.waitForFunction(()=>!document.querySelector('.sp-employee-dialog footer button[type=submit]')?.disabled)}
  async function put(file){await upload().setInputFiles(file);await ready();assert.equal(await dialog().getByRole('alert').count(),0);return source()}
  async function save(){await dialog().getByRole('button',{name:'保存人员',exact:true}).click();await dialog().waitFor({state:'hidden'})}
  async function screenshot(name){const file=path.join(output,name+'.png');await page.screenshot({path:file,fullPage:false});report.screenshots.push(file)}
  async function width(){const s=await page.evaluate(()=>({width:innerWidth,html:document.documentElement.scrollWidth,body:document.body.scrollWidth}));assert.ok(s.html<=s.width&&s.body<=s.width,JSON.stringify(s));return s}
  async function download(button,file){const pending=page.waitForEvent('download');await button.click();const item=await pending;const target=path.join(output,file);await item.saveAs(target);return JSON.parse(await fs.readFile(target,'utf8'))}
  async function importDocument(document){await page.locator('input[type=file]').first().setInputFiles({name:'avatar-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(document))});await page.getByRole('button',{name:'确认导入',exact:true}).click();return persisted(s=>{try{assert.deepEqual(s.employees,document.employees);return true}catch{return false}})}
  function file(data,name,mimeType){return {name,mimeType,buffer:Buffer.from(data.split(',')[1],'base64')}}
  async function checkThumb(data){assert.match(data,/^data:image\/jpeg;base64,/);assert.ok(data.length<=8192);const dimensions=await page.evaluate(async data=>{const img=new Image();img.src=data;await img.decode();return {width:img.naturalWidth,height:img.naturalHeight}},data);assert.equal(dimensions.width,dimensions.height);assert.ok(dimensions.width<=96&&dimensions.width>0);return dimensions}
  try{
    await page.goto(url,{waitUntil:'networkidle'})
    const assets=await page.evaluate(()=>{
      const make=(type,color,accent)=>{const canvas=document.createElement('canvas');canvas.width=360;canvas.height=240;const c=canvas.getContext('2d');c.fillStyle=color;c.fillRect(0,0,360,240);c.fillStyle=accent;c.fillRect(80,40,200,160);c.fillStyle='#fff';c.beginPath();c.arc(180,100,32,0,Math.PI*2);c.fill();c.fillRect(120,150,120,35);return canvas.toDataURL(type,.92)}
      const noise=document.createElement('canvas');noise.width=noise.height=96;const context=noise.getContext('2d'),pixels=context.createImageData(96,96);let seed=17;for(let i=0;i<pixels.data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels.data[i]=i%4===3?255:seed>>>24}context.putImageData(pixels,0,0)
      return {png:make('image/png','#b91c3c','#ef5684'),jpeg:make('image/jpeg','#93580a','#e7ad1c'),webp:make('image/webp','#125b5e','#23a89d'),noise:noise.toDataURL('image/png')}
    })
    const png=file(assets.png,'avatar-red.png','image/png'),jpeg=file(assets.jpeg,'avatar-gold.jpg','image/jpeg'),webp=file(assets.webp,'avatar-teal.webp','image/webp')
    await navigate('成员管理')
    assert.equal(await page.getByRole('link',{name:'Shift Schedule Expert',exact:true}).count(),1)
    assert.equal(await member('测试成员甲').locator('.sp-settings-avatar img').count(),0)
    assert.equal(await member('测试成员乙').locator('.sp-settings-avatar img').count(),0)
    assert.equal(await member('测试成员甲').locator('.sp-avatar-initials').innerText(),'员甲')
    assert.equal(await member('测试成员乙').locator('.sp-avatar-initials').innerText(),'员乙')
    assert.equal(await member('测试成员甲').locator('.sp-settings-avatar').evaluate(node=>node.style.background),fixture.employees[0].color.replace(/^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i,(_,r,g,b)=>`rgb(${parseInt(r,16)}, ${parseInt(g,16)}, ${parseInt(b,16)})`))
    assert.ok((await state()).employees.every(e=>e.avatar==null))
    await edit('测试成员乙');await dialog().getByLabel('员工姓名',{exact:true}).fill('雨')
    assert.equal(await dialog().locator('.sp-employee-avatar-initials').innerText(),'雨')
    await page.keyboard.press('Escape')
    record('members without pictures show their last two name characters and color; a single-character name stays whole')

    await edit();const pngThumb=await put(png);const pngDimensions=await checkThumb(pngThumb)
    assert.ok((await state()).employees[0].avatar==null)
    await dialog().getByRole('button',{name:'取消',exact:true}).click()
    assert.ok((await state()).employees[0].avatar==null)
    await edit();await put(jpeg);await page.keyboard.press('Escape');assert.equal(await dialog().count(),0);assert.ok((await state()).employees[0].avatar==null)
    record('PNG/JPEG preview remains a draft and Cancel/Escape leaves stored profiles unchanged',pngDimensions)
    await edit();const noisyThumb=await put(file(assets.noise,'avatar-complex.png','image/png'));await checkThumb(noisyThumb);await page.keyboard.press('Escape')
    record('high-detail image compresses within the 8192-character thumbnail limit',{characters:noisyThumb.length})

    await edit();await put(png);await save();await persisted(s=>s.employees[0].avatar===pngThumb)
    assert.equal(await member('测试成员甲').locator('.sp-settings-avatar img').getAttribute('src'),pngThumb)
    await page.reload({waitUntil:'networkidle'});await navigate('成员管理')
    assert.equal((await state()).employees[0].avatar,pngThumb)
    assert.equal(await member('测试成员甲').locator('.sp-settings-avatar img').getAttribute('src'),pngThumb)
    record('saved thumbnail appears on the member card and survives a real reload')

    await edit();const jpegThumb=await put(jpeg);assert.notEqual(jpegThumb,pngThumb);await checkThumb(jpegThumb);await save();await persisted(s=>s.employees[0].avatar===jpegThumb)
    await edit();const webpThumb=await put(webp);assert.notEqual(webpThumb,jpegThumb);await checkThumb(webpThumb);await save();await persisted(s=>s.employees[0].avatar===webpThumb)
    record('JPEG and WebP replacements are stored as bounded square JPEG thumbnails')

    await edit();await dialog().getByRole('button',{name:'移除头像',exact:true}).click();assert.equal(await preview().count(),0);await page.keyboard.press('Escape');assert.equal((await state()).employees[0].avatar,webpThumb)
    await edit();await dialog().getByRole('button',{name:'移除头像',exact:true}).click();await save();await persisted(s=>s.employees[0].avatar==null)
    assert.equal(await member('测试成员甲').locator('.sp-settings-avatar img').count(),0)
    assert.equal(await member('测试成员甲').locator('.sp-avatar-initials').innerText(),'员甲')
    record('avatar removal is cancellable and only committed when the profile is saved')

    await edit();await put(png);await save();await persisted(s=>s.employees[0].avatar===pngThumb)
    const beforeInvalid=await state();await edit()
    const oversized=Buffer.alloc(10*1024*1024+1)
    const hugeDimensions=Buffer.from(png.buffer);hugeDimensions.writeUInt32BE(20000,16);hugeDimensions.writeUInt32BE(1,20)
    for(const [bad,pattern] of [
      [{name:'not-image.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')},/JPG.*PNG.*WebP/],
      [{name:'too-large.png',mimeType:'image/png',buffer:oversized},/10 MB/],
      [{name:'broken.png',mimeType:'image/png',buffer:Buffer.from('broken image')},/无法读取|有效/],
      [{name:'empty.jpg',mimeType:'image/jpeg',buffer:Buffer.alloc(0)},/大于 0|10 MB/],
      [{name:'oversized-dimensions.png',mimeType:'image/png',buffer:hugeDimensions},/16384|4000 万/],
    ]){
      await upload().setInputFiles(bad);await ready();assert.match(await dialog().getByRole('alert').innerText(),pattern);assert.equal(await source(),pngThumb);assert.deepEqual((await state()).employees,beforeInvalid.employees)
    }
    await page.keyboard.press('Escape')
    record('unsupported, oversized, corrupt, empty and excessive-dimension uploads preserve the saved image')

    await edit();await page.evaluate(()=>{window.qaHoldBitmaps=true})
    await upload().setInputFiles({...png,name:'slow-red.png'});await page.waitForFunction(()=>window.qaHeldBitmaps.some(job=>job.name==='slow-red.png'))
    assert.equal(await dialog().getByRole('button',{name:'保存人员',exact:true}).isDisabled(),true)
    await upload().setInputFiles({...jpeg,name:'fast-gold.jpg'});await page.waitForFunction(()=>window.qaHeldBitmaps.some(job=>job.name==='fast-gold.jpg'))
    await page.evaluate(()=>window.qaReleaseBitmap('fast-gold.jpg'));await ready();assert.equal(await source(),jpegThumb)
    await page.evaluate(()=>window.qaReleaseBitmap('slow-red.png'));await page.waitForFunction(()=>window.qaBitmapCompleted.includes('slow-red.png'));assert.equal(await source(),jpegThumb)
    await page.evaluate(()=>{window.qaHoldBitmaps=false});await save();await persisted(s=>s.employees[0].avatar===jpegThumb)
    record('out-of-order image decoding keeps the last selected picture and blocks premature save')

    await edit();await page.evaluate(()=>{window.qaHoldBitmaps=true});await upload().setInputFiles({...png,name:'removed-red.png'});await page.waitForFunction(()=>window.qaHeldBitmaps.some(job=>job.name==='removed-red.png'))
    await dialog().getByRole('button',{name:'移除头像',exact:true}).click();await ready();assert.equal(await preview().count(),0)
    await page.evaluate(()=>window.qaReleaseBitmap('removed-red.png'));await page.waitForFunction(()=>window.qaBitmapCompleted.includes('removed-red.png'));assert.equal(await preview().count(),0)
    await page.evaluate(()=>{window.qaHoldBitmaps=false});await save();await persisted(s=>s.employees[0].avatar==null)
    record('removing during image processing prevents a late result from restoring the image')

    await edit();await page.evaluate(()=>{window.qaHoldBitmaps=true});await upload().setInputFiles({...png,name:'closed-red.png'});await page.waitForFunction(()=>window.qaHeldBitmaps.some(job=>job.name==='closed-red.png'))
    await page.keyboard.press('Escape');await edit('测试成员乙');await page.evaluate(()=>window.qaReleaseBitmap('closed-red.png'));await page.waitForFunction(()=>window.qaBitmapCompleted.includes('closed-red.png'))
    assert.equal(await preview().count(),0);assert.ok((await state()).employees.every(e=>e.avatar==null));await page.evaluate(()=>{window.qaHoldBitmaps=false});await page.keyboard.press('Escape')
    record('closing the dialog cancels pending image results and cannot alter another member')

    await edit();await put(webp);await save();await persisted(s=>s.employees[0].avatar===webpThumb)
    await page.getByRole('button',{name:'备份与恢复',exact:true}).click()
    const backup=await download(page.getByRole('button',{name:/^导出完整备份/}),'avatar-backup.json')
    assert.equal(backup.employees[0].avatar,webpThumb);assert.deepEqual(backup.rules,fixture.rules)
    await edit();await dialog().getByRole('button',{name:'移除头像',exact:true}).click();await save();await persisted(s=>s.employees[0].avatar==null)
    await importDocument(backup);assert.equal(await member('测试成员甲').locator('.sp-settings-avatar img').getAttribute('src'),webpThumb)
    record('full JSON backup export and reimport preserve uploaded avatars and rules')

    await navigate('排班日历')
    const calendarImg=page.locator('.sp-person').filter({has:page.getByText('测试成员甲',{exact:true})}).locator('img')
    assert.equal(await calendarImg.getAttribute('src'),webpThumb)
    assert.equal(await page.locator('.sp-person').filter({has:page.getByText('测试成员乙',{exact:true})}).locator('.sp-avatar-initials').innerText(),'员乙')
    const debug=await download(page.getByRole('button',{name:'导出规则',exact:true}),'avatar-free-solver-debug.json')
    assert.ok(debug.state.employees.every(e=>!Object.hasOwn(e,'avatar')));assert.ok(!JSON.stringify(debug).includes('data:image/'))
    assert.deepEqual(debug.state.employees,backup.employees.map(({avatar,...employee})=>employee));assert.deepEqual(debug.state.rules,backup.rules);assert.deepEqual(debug.state.shifts,backup.shifts);assert.deepEqual(debug.state.assignments,backup.assignments)
    record('calendar shows uploaded picture while solver-debug strips avatars and retains scheduling data')

    await navigate('成员管理');await edit();await width();await screenshot('avatar-modal-desktop');await page.keyboard.press('Escape');await screenshot('avatar-members-desktop')
    for(const viewport of [390,320]){
      await page.setViewportSize({width:viewport,height:844});await page.waitForFunction(()=>document.querySelector('.sp-sidebar').getBoundingClientRect().right<=0)
      await member('测试成员甲').scrollIntoViewIfNeeded();await width();await screenshot(`avatar-members-${viewport}`)
      await edit();await width();const bounds=await dialog().boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=viewport)
      const control=await upload().boundingBox();assert.ok(control&&control.height>=44&&control.x>=0&&control.x+control.width<=viewport)
      await put(viewport===390?png:jpeg);await screenshot(`avatar-modal-${viewport}`);await dialog().getByRole('button',{name:'取消',exact:true}).click();assert.equal((await state()).employees[0].avatar,webpThumb)
      record(`${viewport}px mobile file input, preview and cancel work without overflow`)
    }
    assert.deepEqual((await state()).assignments,fixture.assignments);assert.deepEqual(report.errors,[]);record('avatar operations preserve locked roster and emit no browser errors');report.ok=true
  }catch(error){report.failure=error.stack||String(error);await screenshot('failure').catch(()=>{});report.failureText=await page.locator('body').innerText().catch(()=>'');throw error}
  finally{report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');await browser.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
