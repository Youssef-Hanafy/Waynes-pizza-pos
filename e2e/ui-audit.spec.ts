import { test, expect, type Page } from '@playwright/test';
const root = 'docs/elo-ui-audit';
async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wayne-pos-keyboard','on'));
  await page.route('**/*',async r => {
    const url = new URL(r.request().url());
    if(url.hostname !== '127.0.0.1') return r.abort();
    if(url.pathname === '/pos-sw.js') return r.abort();
    if(!url.pathname.startsWith('/api/')) return r.continue();
    const arrays=['/api/pos/open-orders','/api/pos/drafts','/api/pos/tip-drafts','/api/pos/terminal','/api/pos/customers','/api/pos/discounts'];
    const body = arrays.includes(url.pathname) ? [] : url.pathname==='/api/version' ? {build:'audit_A',commit:'086c5d6',builtAt:'2026-11-01T00:00:00Z',contract:1,minimumClient:0,minimumBridge:1} : url.pathname==='/api/pos/delivery' ? {waiting:[],drivers:[{driver_id:'00000000-0000-4000-8000-000000009999',name:'Fixture driver',clocked_in:true,orders:[]}]} : url.pathname==='/api/pos/day-orders' ? {day:'2026-11-01',orders:[]} : url.pathname==='/api/pos/delivery/day-report' ? {day:'2026-11-01',timezone:'America/New_York',drivers:[]} : {ok:true,events:[],blockers:[],build:'audit_A'};
    return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('/pos');
  await expect(page.getByRole('navigation',{name:'POS sections'})).toBeVisible();
}
async function menu(page: Page) { await page.getByRole('button',{name:'Jump to take order →'}).click(); }
async function item(page: Page) { await page.getByRole('button',{name:'Pizza 1 From $12.00',exact:true}).click(); }
async function fits(page: Page) { expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
for(const [width,height,dpr] of [[1920,1080,1],[1280,720,1.5],[1024,600,1],[960,540,2],[800,600,1],[768,500,1],[767,600,1],[1280,400,1]]) {
  test(`register and item dialog ${width}x${height} DPR ${dpr}`,async ({browser},testInfo)=>{
    const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:dpr,hasTouch:true});
    const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await boot(page);await fits(page);await menu(page);await fits(page);
    await page.getByRole('button',{name:'Dinners',exact:true}).tap();
    await page.getByRole('button',{name:'Pizza',exact:true}).tap();await item(page);
    await expect(page.getByRole('button',{name:'Close item'})).toBeInViewport();
    await page.getByRole('button',{name:'Increase item quantity',exact:true}).tap();
    await page.getByRole('button',{name:/Add to ticket/}).tap();
    const increase=page.getByRole('button',{name:'Increase item',exact:true});
    await increase.scrollIntoViewIfNeeded();const box=await increase.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);expect(box!.height).toBeGreaterThanOrEqual(44);
    await increase.tap();
    await page.screenshot({path:`${root}/after-menu-${width}x${height}-run${testInfo.repeatEachIndex+1}.png`,fullPage:true});
    expect(errors).toEqual([]);await context.close();
  });
}
test('item notes keyboard leaves footer usable and preserves single-tap add',async ({page},testInfo)=>{
  await page.setViewportSize({width:1280,height:720});await boot(page);await menu(page);await item(page);
  await page.getByLabel('Item notes',{exact:true}).tap();
  const keyboard=page.getByRole('group',{name:'Keyboard',exact:true});await expect(keyboard).toBeVisible();
  const add=page.getByRole('button',{name:/Add to ticket/});
  await expect.poll(async()=>{const a=await add.boundingBox(),k=await keyboard.boundingBox();return a!.y+a!.height <= k!.y;}).toBe(true);
  await page.screenshot({path:`${root}/after-keyboard-run${testInfo.repeatEachIndex+1}.png`});
  await add.tap();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Increase item',exact:true})).toHaveCount(1);
});
test('repeated section navigation, Back, refresh, offline and reconnect preserve loaded document',async ({page,context},testInfo)=>{
  await page.setViewportSize({width:1280,height:720});await boot(page);
  const nav=page.getByRole('navigation',{name:'POS sections'});
  await page.evaluate(()=>{(window as Window & {auditDocument?:string}).auditDocument='same-document';});
  for(let i=0;i<3;i++)for(const name of ['Phone','Payments','Orders',"Today's Orders",'Customers','Deliveries','More','New Order']) {
    await nav.getByRole('button',{name,exact:true}).tap();await fits(page);
    await expect(nav.getByRole('button',{name,exact:true})).toHaveAttribute('aria-current','page');
    await page.waitForTimeout(200);
    if(i===0)await page.screenshot({path:`${root}/screen-${name.replace(/[^a-z]/gi,'')}-run${testInfo.repeatEachIndex+1}.png`});
  }
  await nav.getByRole('button',{name:'More',exact:true}).tap();
  await page.getByRole('button',{name:/^Back to New order/}).tap();
  await expect(nav.getByRole('button',{name:'New Order',exact:true})).toHaveAttribute('aria-current','page');
  await menu(page);await item(page);await page.getByRole('button',{name:/Add to ticket/}).tap();
  await context.setOffline(true);await page.evaluate(()=>{window.dispatchEvent(new Event('offline'));});
  await expect(page.getByRole('button',{name:'Increase item',exact:true})).toHaveCount(1);
  await context.setOffline(false);await page.evaluate(()=>{window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('wayne:reconnected'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));document.dispatchEvent(new Event('visibilitychange'));});
  expect(await page.evaluate(()=>(window as Window & {auditDocument?:string}).auditDocument)).toBe('same-document');
  for(let i=0;i<3;i++){await page.reload();await expect(page.getByRole('button',{name:'Increase item',exact:true})).toHaveCount(1);}
});
test('second register waits without evicting first',async ({page,context})=>{
  await boot(page);const second=await context.newPage();await second.goto('/pos');
  await expect(second.getByRole('heading',{name:'Waiting for this register'})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'POS sections'})).toBeVisible();
  await page.close();await expect(second.getByRole('navigation',{name:'POS sections'})).toBeVisible();
});

test('ringing call does not dismiss driver clock dialog',async ({page},testInfo)=>{
  await page.setViewportSize({width:1280,height:720});await boot(page);
  await page.getByRole('navigation',{name:'POS sections'}).getByRole('button',{name:'Deliveries',exact:true}).tap();
  await page.getByRole('button',{name:'⏱ Driver clock in/out',exact:true}).tap();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(()=>window.dispatchEvent(new Event('audit:ring')));
  await expect(page.getByRole('navigation',{name:'POS sections'}).getByRole('button',{name:'Deliveries',exact:true})).toHaveAttribute('aria-current','page');
  await expect(page.getByRole('dialog')).toBeVisible();
  const cancel=page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true});
  await cancel.scrollIntoViewIfNeeded();await expect(cancel).toBeInViewport({ratio:1});
  await page.screenshot({path:`${root}/driver-ring-run${testInfo.repeatEachIndex+1}.png`});
  await cancel.tap();await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a deployment waits for operator approval and a later target requires new approval',async ({page})=>{
  await page.setViewportSize({width:1280,height:720});
  await page.clock.install();await boot(page);
  const initialHeader = await page.locator('header').boundingBox();
  let build='audit_B';
  await page.route('**/api/version?*',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({build,commit:'abcdef123',builtAt:'2026-11-02T00:00:00Z',contract:1,minimumClient:0,minimumBridge:1})}));
  await page.evaluate(()=>{(window as Window & {auditDocument?:string}).auditDocument='original';});
  const pass=async(ms:number)=>{for(let t=0;t<ms;t+=15000){await page.clock.runFor(15000);await page.waitForTimeout(30);}};
  await pass(10*60_000);
  expect(await page.locator('header').boundingBox()).toEqual(initialHeader);
  expect(await page.evaluate(()=>(window as Window & {auditDocument?:string}).auditDocument)).toBe('original');
  await page.getByRole('navigation',{name:'POS sections'}).getByRole('button',{name:'More',exact:true}).tap();
  await page.getByRole('button',{name:'Update when register is idle'}).click();
  build='audit_C';await page.evaluate(()=>window.dispatchEvent(new Event('online')));await pass(4*60_000);
  expect(await page.evaluate(()=>(window as Window & {auditDocument?:string}).auditDocument)).toBe('original');
  await page.route('**/api/pos/update-status?*',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({build:'audit_C',blockers:[]})}));
  await page.getByRole('button',{name:'Update when register is idle'}).click();await pass(90_000);
  await expect(page).toHaveURL(/wayne_update=audit_C/);
});
test('rich dinner modifiers, discount and open item dialogs can be dismissed',async ({page},testInfo)=>{
  await page.setViewportSize({width:1280,height:720});await boot(page);await menu(page);
  await page.getByRole('button',{name:'Dinners',exact:true}).tap();
  await page.getByRole('button',{name:'Dinners 1 $12.00',exact:true}).tap();
  await expect(page.getByRole('dialog')).toContainText('French Fries');
  const modifier=page.getByRole('button',{name:'Add French Fries',exact:true});
  await expect.poll(async()=> (await modifier.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  expect((await modifier.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await modifier.tap();
  await page.screenshot({path:`${root}/dinner-modifiers-run${testInfo.repeatEachIndex+1}.png`});
  await page.getByRole('button',{name:'Close item'}).tap();
  await page.getByRole('button',{name:'－ Discount',exact:true}).tap();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:/Cancel|Close/}).first().tap();
  await page.getByRole('button',{name:'＋ Open item',exact:true}).tap();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:/Cancel|Close/}).first().tap();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('idle caller auto pickup remains available',async ({page})=>{
  await boot(page);await page.evaluate(()=>window.dispatchEvent(new Event('audit:ring')));
  await expect(page.getByRole('navigation',{name:'POS sections'}).getByRole('button',{name:/^Phone/})).toHaveAttribute('aria-current','page');
});
test('slow rendering, latency and repeated dialog cycles keep navigation and ticket positions',async ({page,context})=>{
  test.setTimeout(120_000);
  await page.setViewportSize({width:1280,height:720});await boot(page);
  const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:300,downloadThroughput:150_000,uploadThroughput:100_000});
  await menu(page);
  for(let i=0;i<5;i++){await item(page);await page.getByRole('button',{name:'Close item'}).tap();}
  await item(page);await page.getByRole('button',{name:/Add to ticket/}).tap();
  const control=page.getByRole('button',{name:'Increase item',exact:true});const before=await control.boundingBox();
  for(let i=0;i<3;i++){await page.reload();await expect(control).toBeVisible();expect(await control.boundingBox()).toEqual(before);}
});

test('open synthetic order and payment selection without submitting a charge',async ({page},testInfo)=>{
  await page.setViewportSize({width:1280,height:720});await boot(page);
  const order={id:'00000000-0000-4000-8000-000000008888',order_number:'AUDIT-1',daily_number:1,customer_name:'Fixture pickup',fulfillment_type:'pickup',source:'pos',status:'placed',payment_method:'test_manual',payment_status:'unpaid',total_cents:1200,paid_cents:0,placed_at:'2026-11-01T18:00:00Z',promised_at:null,ready_at:null,is_test:true};
  await page.route('**/api/pos/open-orders',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify([order])}));
  await page.route('**/api/pos/orders/*/lines',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({order:{...order,discount_cents:0},lines:[{id:'00000000-0000-4000-8000-000000008889',menu_item_id:'00000000-0000-4000-8000-000000000100',variant_id:null,name:'Pizza 1',variant:null,quantity:1,unit_price_cents:1200,modifier_unit_total_cents:0,line_total_cents:1200,instructions:'',pos_line:null,modifiers:[]}]})}));
  const nav=page.getByRole('navigation',{name:'POS sections'});
  await nav.getByRole('button',{name:'Orders',exact:true}).tap();
  await page.getByRole('button',{name:/tap to edit/}).tap();
  await expect(page.getByRole('complementary',{name:'Current ticket'})).toContainText('Pizza 1');
  await nav.getByRole('button',{name:'Payments',exact:true}).tap();
  await page.getByRole('button',{name:/Fixture pickup/}).tap();
  await expect(page.getByRole('region',{name:'Take payment'})).toContainText('Amount due');
  await page.getByRole('button',{name:/Cash Change shown/}).tap();
  await expect(page.getByRole('button',{name:'Record cash',exact:true})).toBeVisible();
  await fits(page);await page.screenshot({path:`${root}/cash-selection-run${testInfo.repeatEachIndex+1}.png`});
});
test('customer lookup opens a representative customer without saving records',async ({page},testInfo)=>{
  await page.setViewportSize({width:1280,height:720});await boot(page);
  const customer={id:'00000000-0000-4000-8000-000000007777',first_name:'Fixture',last_name:'Customer',phone:'5085550100',email:null,first_order_at:null,last_order_at:null,order_count:0,lifetime_spend_cents:0,average_order_value_cents:0,addresses:[]};
  await page.route('**/api/pos/customers?*',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify([customer])}));
  await page.route('**/api/pos/customers/*/orders',r=>r.fulfill({status:200,contentType:'application/json',body:'[]'}));
  const nav=page.getByRole('navigation',{name:'POS sections'});
  await nav.getByRole('button',{name:'Customers',exact:true}).tap();
  await page.getByRole('searchbox',{name:'Search customers'}).fill('5085550100');
  await page.getByRole('button',{name:/Fixture Customer/}).tap();
  await expect(page.getByRole('heading',{name:'Fixture Customer',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start order',exact:true})).toBeVisible();
  await page.waitForTimeout(200);await fits(page);
  await page.screenshot({path:`${root}/customer-lookup-run${testInfo.repeatEachIndex+1}.png`});
  await nav.getByRole('button',{name:'New Order',exact:true}).tap();
});

test('modifier controls keep their positions when reopening and switching between category items',async ({page})=>{
  await page.setViewportSize({width:1280,height:720});await boot(page);await menu(page);
  await page.getByRole('button',{name:'Dinners',exact:true}).tap();
  const positions=async()=>page.getByRole('dialog').getByRole('button',{name:/^(Add|Remove) /}).evaluateAll(buttons=>buttons.map(button=>{
    const box=button.getBoundingClientRect();return {name:button.getAttribute('aria-label'),x:Math.round(box.x),y:Math.round(box.y),width:Math.round(box.width),height:Math.round(box.height)};
  }));
  await page.getByRole('button',{name:'Dinners 1 $12.00',exact:true}).tap();
  await expect(page.getByRole('button',{name:'Add French Fries',exact:true})).toBeVisible();
  await page.waitForTimeout(250);
  const reference=await positions();
  for(const name of ['Dinners 2 $12.00','Dinners 1 $12.00']){
    await page.getByRole('button',{name:'Close item'}).tap();
    await page.getByRole('button',{name,exact:true}).tap();
    await expect.poll(positions).toEqual(reference);
  }
});
