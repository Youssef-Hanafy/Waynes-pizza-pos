import { readFile,writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { expect,test,type Page } from '@playwright/test';
const baseURL=process.env.MENU_PRICING_APP_URL??'https://waynes-pos-staging.vercel.app';
if(!['https://waynes-pos-staging.vercel.app','http://127.0.0.1:3105'].includes(baseURL))throw new Error('Named staging app or isolated local candidate required');
const ids=['418c30cc-344c-4200-917d-0d60c183c77c','5677ccf0-ba1d-41a1-8382-473233f61ea9'];
const stagingSupabaseUrl='https://pkjrdvtdygiprmsojdqg.supabase.co';
const enabled=process.env.MENU_PRICING_HOSTED==='1';
type Reviewer={id:string;email:string;password:string;pin:string;role:string};
const users:Reviewer[]=enabled?JSON.parse(await readFile('.vercel/menu-pricing-users.json','utf8')):[];
const owner=users.find(u=>u.role==='owner')!,cashier=users.find(u=>u.role==='cashier')!;
const env=enabled?parseEnv(await readFile('.env.staging.local','utf8')):{NEXT_PUBLIC_SUPABASE_URL:'https://pkjrdvtdygiprmsojdqg.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'hosted-tests-disabled',NEXT_PUBLIC_SUPABASE_ANON_KEY:'hosted-tests-disabled',NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:''};
if(env.NEXT_PUBLIC_SUPABASE_URL!=='https://pkjrdvtdygiprmsojdqg.supabase.co')throw new Error('Named isolated staging database required');
const db=createClient(stagingSupabaseUrl,env.SUPABASE_SERVICE_ROLE_KEY??'',{auth:{persistSession:false}});
function posPayload(id:string,note:string) {
  return {idempotency_key:crypto.randomUUID(),source:'pos',customer_mode:'walk_in',customer_id:'',fulfillment_type:'pickup',payment_method:'test_manual',is_test:true,
    first_name:'',last_name:'',phone:'',email:'',address_id:'',address:{address1:'',address2:'',city:'',state:'',postal_code:'',delivery_instructions:''},
    promo_code:'',manual_discount_type:'',manual_discount_value:0,manual_discount_reason:'',tip_cents:0,special_instructions:note,
    items:[{menu_item_id:id,variant_id:null,quantity:1,modifiers:[],special_instructions:note}]};
}
async function login(page:Page,next:string,role=owner) {
  await page.goto(`${baseURL}/login?next=${encodeURIComponent(next)}`);
  await page.getByRole('textbox',{name:'Email',exact:true}).fill(role.email);
  await page.getByLabel('Password',{exact:false}).fill(role.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  if(role.role==='owner'&&next.startsWith('/admin')) {
    await expect(page.getByRole('heading',{name:'Enter manager PIN'})).toBeVisible();
    for(const digit of role.pin)await page.getByRole('button',{name:digit,exact:true}).click();
    await page.getByRole('button',{name:'Open Admin',exact:true}).click();
    await expect(page).toHaveURL(/\/admin(?:\/|$)/);
    await page.goto(baseURL+next);
    await expect(page).toHaveURL(baseURL+next);
  }
}
test.describe('real hosted menu pricing',()=>{
  test.skip(process.env.MENU_PRICING_HOSTED!=='1','Explicit isolated staging opt-in required');
  test('baseline: both real admin submissions reproduce the empty-group rejection',async({page})=>{
    test.skip(process.env.MENU_PRICING_PHASE!=='baseline','Only before installing the candidate');
    await login(page,`/admin/menu/items/${ids[0]}`);
    for(const id of ids){
      await page.goto(`/admin/menu/items/${id}`);
      await page.getByRole('textbox',{name:'Base price ($)',exact:true}).fill('14.25');
      await page.getByRole('button',{name:'Save menu item',exact:true}).click();
      await expect(page).toHaveURL(/\/admin\/menu\?error=/);
      expect(new URL(page.url()).searchParams.get('error')).toContain('>=1');
      const result=await db.from('menu_items').select('base_price_cents').eq('id',id).single();
      expect(result.error).toBeNull();expect(result.data?.base_price_cents).toBe(1350);
      const response=await page.request.post('/api/pos/orders',{data:posPayload(id,'Synthetic historical price baseline')});
      expect(response.ok(),await response.text()).toBe(true);
      const order=await response.json();
      const line=await db.from('order_items').select('unit_price_cents').eq('order_id',order.id).single();expect(line.error).toBeNull();expect(line.data?.unit_price_cents).toBe(1350);
      await writeFile(`.vercel/pricing-historical-${id}.json`,JSON.stringify({order_id:order.id,price:1350}));
    }
    await page.context().storageState({path:'.vercel/pricing-owner-state.json'});
  });
  test('candidate: real staff login/PIN, both saves, reload, new POS charges and online price',async({page,browser})=>{
    test.skip(process.env.MENU_PRICING_PHASE==='baseline','Candidate only');
    await login(page,`/admin/menu/items/${ids[0]}`);
    const customerContext=await browser.newContext({baseURL});const customer=await customerContext.newPage();
    for(const [index,id] of ids.entries()){
      await page.goto(`/admin/menu/items/${id}`);
      if(page.url().includes('/pos/admin-pin')) {
        for(const digit of owner.pin)await page.getByRole('button',{name:digit,exact:true}).click();
        await page.getByRole('button',{name:'Open Admin',exact:true}).click();
        await expect(page).toHaveURL(/\/admin(?:\/|$)/);
        await page.goto(`/admin/menu/items/${id}`);
      }
      await page.getByRole('textbox',{name:'Item price ($)',exact:true}).fill('14.26');
      await page.getByRole('button',{name:'Save prices only',exact:true}).click();
      await expect(page.getByText('Prices saved to the database.',{exact:true})).toBeVisible();
      await page.reload();await expect(page.getByRole('textbox',{name:'Item price ($)',exact:true})).toHaveValue('14.26');
      await page.getByRole('textbox',{name:'Item price ($)',exact:true}).fill('14.25');
      await page.getByRole('button',{name:'Save menu item',exact:true}).click();
      await expect(page).toHaveURL(/\/admin\/menu\?saved=1/);
      await page.goto(`/admin/menu/items/${id}`);await page.reload();
      await expect(page.getByRole('textbox',{name:'Item price ($)',exact:true})).toHaveValue('14.25');
      const record=await db.from('menu_items').select('base_price_cents').eq('id',id).single();expect(record.error).toBeNull();expect(record.data?.base_price_cents).toBe(1425);
      await page.goto('/pos');
      await page.getByRole('checkbox',{name:/Test order/}).check();
      await page.getByRole('button',{name:'Walk-in At the counter',exact:true}).click();
      await page.getByRole('button',{name:/Dinners/}).first().click();
      await page.getByRole('button',{name:new RegExp(index===0?'Cheeseburger Dinner':'Gyro Dinner')}).click();
      await expect(page.getByRole('dialog').getByRole('button',{name:/Add to ticket.*14.25/})).toBeVisible();
      await page.getByRole('dialog').getByRole('button',{name:/Add to ticket/}).click();
      const saved=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/pos/orders'&&response.request().method()==='POST');
      await page.getByRole('button',{name:/TEST · Take payment/}).click();
      const response=await saved;
      expect(response.ok(),await response.text()).toBe(true);const created=await response.json();
      const line=await db.from('order_items').select('unit_price_cents').eq('order_id',created.id).single();expect(line.error).toBeNull();expect(line.data?.unit_price_cents).toBe(1425);
      await writeFile(`.vercel/pricing-order-${index}.json`,JSON.stringify({order_id:created.id,price:1425}));
      await customer.goto('/menu');
      await customer.evaluate(()=>localStorage.setItem('wayne-order-details-v1',JSON.stringify({fulfillment:'pickup',first_name:'Synthetic'})));
      await customer.reload();await customer.getByRole('button',{name:'Dinners',exact:true}).last().click();
      const card=customer.locator('article').filter({hasText:index===0?'Cheeseburger Dinner':'Gyro Dinner'});await expect(card.getByText('$14.25',{exact:true})).toBeVisible();
    }
    await customerContext.close();
    for(const id of ids){const previous=JSON.parse(await readFile(`.vercel/pricing-historical-${id}.json`,'utf8'));const line=await db.from('order_items').select('unit_price_cents').eq('order_id',previous.order_id).single();expect(line.error).toBeNull();expect(line.data?.unit_price_cents).toBe(1350);}
    await page.context().storageState({path:'.vercel/pricing-owner-state.json'});
  });
  test('public sandbox checkout saves both dinners at 1425 cents',async({page})=>{
    test.setTimeout(120_000);
    test.skip(process.env.MENU_PRICING_PHASE==='baseline','Candidate only');
    await page.goto('/order');await page.getByRole('link',{name:'Choose pickup'}).click();
    const gate=page.getByRole('dialog').filter({has:page.getByRole('button',{name:'Start my order'})});
    await gate.getByLabel('First name').fill('Synthetic');await gate.getByLabel('Last name').fill('Pricing');
    await gate.getByLabel('Mobile number').fill('2025550142');await gate.getByRole('button',{name:'Start my order'}).click();
    await expect(gate).not.toBeVisible();await page.getByRole('button',{name:'Dinners',exact:true}).last().click();
    for(const name of ['Cheeseburger Dinner','Gyro Dinner']){
      const card=page.locator('article').filter({has:page.getByRole('heading',{name,exact:true})});
      await card.getByRole('button',{name:'Customize & add'}).click();
      const dialog=page.getByRole('dialog');await expect(dialog.getByRole('button',{name:/Add ·.*14.25/})).toBeVisible();
      await dialog.getByRole('button',{name:/^Add ·/}).click();
    }
    await page.getByRole('link',{name:'Continue to checkout'}).click();
    const checkout=page.locator('main form');await checkout.getByLabel('First name').fill('Synthetic');
    await checkout.getByLabel('Last name').fill('Pricing');await checkout.getByLabel('Phone').fill('2025550142');
    const recoveryId=process.env.MENU_PRICING_RECOVER_ORDER;
    if(recoveryId){
      const existing=await db.from('orders').select('idempotency_key,customer_name_snapshot,source').eq('id',recoveryId).single();
      expect(existing.error).toBeNull();expect(existing.data?.customer_name_snapshot).toBe('Synthetic Pricing');expect(existing.data?.source).toBe('online');
      const lines=await db.from('order_items').select('menu_item_id,unit_price_cents').eq('order_id',recoveryId);
      expect(lines.error).toBeNull();expect(lines.data?.map(l=>l.menu_item_id).sort()).toEqual([...ids].sort());expect(lines.data?.every(l=>l.unit_price_cents===1425)).toBe(true);
      await page.evaluate(key=>sessionStorage.setItem('wayne-order-idempotency-v1',key),existing.data!.idempotency_key);
    }
    const cardPayment=page.getByRole('button',{name:/^Pay \$28.50 and place order$/});
    if(await cardPayment.isVisible()){
      const config=await db.from('location_payment_configurations').select('provider,environment').eq('workspace_id','40000000-0000-4000-8000-000000000001');
      expect(config.error).toBeNull();expect(config.data?.some(c=>c.provider==='stripe'&&c.environment==='sandbox')).toBe(true);
      expect(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.startsWith('pk_test_')).toBe(true);
      const card=page.locator('[aria-label="Card details"]').frameLocator('iframe').first();
      await card.getByRole('textbox',{name:'Credit or debit card number'}).fill('4242424242424242');
      await card.getByPlaceholder('MM / YY').fill('1230');await card.getByPlaceholder('CVC').fill('123');
      await cardPayment.click();
    }else await page.getByRole('button',{name:'Place test order',exact:true}).click();
    await expect(page).toHaveURL(/\/order\/[0-9a-f-]+\?token=/,{timeout:60_000});
    await expect(page.getByText('Order saved',{exact:true})).toBeVisible();
    const created={id:new URL(page.url()).pathname.split('/').pop()!};
    const lines=await db.from('order_items').select('menu_item_id,unit_price_cents').eq('order_id',created.id);
    expect(lines.error).toBeNull();expect(lines.data).toHaveLength(2);
    expect(lines.data?.map(l=>l.menu_item_id).sort()).toEqual([...ids].sort());
    expect(lines.data?.every(l=>l.unit_price_cents===1425)).toBe(true);
    await writeFile('.vercel/pricing-online-order.json',JSON.stringify({order_id:created.id,price:1425}));
  });
  test('cashier session cannot edit menu pricing',async({page})=>{
    test.skip(process.env.MENU_PRICING_PHASE==='baseline','Candidate only');
    await login(page,`/admin/menu/items/${ids[0]}`,cashier);await expect(page).toHaveURL(/\/unauthorized/,{timeout:15_000});
    const client=createClient(stagingSupabaseUrl,env.NEXT_PUBLIC_SUPABASE_ANON_KEY??'',{auth:{persistSession:false}});
    expect((await client.auth.signInWithPassword({email:cashier.email,password:cashier.password})).error).toBeNull();
    const result=await client.rpc('wayne_set_menu_prices',{target_item_id:ids[0],expected_revision:0,base_price_cents:1350,variant_prices:[]});expect(result.error?.code).toBe('42501');
    await page.goto('/pos');await expect(page.getByRole('button',{name:'Walk-in At the counter',exact:true})).toBeVisible();
    await page.context().storageState({path:'.vercel/pricing-cashier-state.json'});
  });
  test('real concurrent editors reject a stale save and retain the unsaved draft',async({page,browser})=>{
    test.skip(process.env.MENU_PRICING_PHASE==='baseline','Candidate only');
    const path=`/admin/menu/items/${ids[0]}`;
    await login(page,path);
    const otherRegister=await browser.newContext({storageState:await page.context().storageState()});
    const second=await otherRegister.newPage();await second.goto(baseURL+path);
    await page.getByRole('textbox',{name:'Item price ($)',exact:true}).fill('14.26');
    await page.getByRole('button',{name:'Save prices only',exact:true}).click();
    await expect(page.getByText('Prices saved to the database.',{exact:true})).toBeVisible();
    await second.getByRole('textbox',{name:'Item price ($)',exact:true}).fill('13.50');
    await second.getByRole('button',{name:'Save menu item',exact:true}).click();
    await expect(second.getByRole('main').getByRole('alert')).toContainText('another register',{timeout:20_000});
    await expect(second.getByRole('textbox',{name:'Item price ($)',exact:true})).toHaveValue('13.50');
    await page.getByRole('textbox',{name:'Item price ($)',exact:true}).fill('14.25');
    await page.getByRole('button',{name:'Save prices only',exact:true}).click();
    await expect(page.getByText('Prices saved to the database.',{exact:true})).toBeVisible();
    await second.reload();await expect(second.getByRole('textbox',{name:'Item price ($)',exact:true})).toHaveValue('14.25');
    await page.context().storageState({path:'.vercel/pricing-owner-state.json'});await otherRegister.close();
  });

});
