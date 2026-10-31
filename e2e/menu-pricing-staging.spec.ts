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
const env=enabled?parseEnv(await readFile('.env.staging.local','utf8')):{NEXT_PUBLIC_SUPABASE_URL:'https://pkjrdvtdygiprmsojdqg.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'hosted-tests-disabled',NEXT_PUBLIC_SUPABASE_ANON_KEY:'hosted-tests-disabled'};
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
  test('candidate: real staff login/PIN, both saves, reload, new POS charges and online price',async({page})=>{
    test.skip(process.env.MENU_PRICING_PHASE==='baseline','Candidate only');
    await login(page,`/admin/menu/items/${ids[0]}`);
    for(const [index,id] of ids.entries()){
      await page.goto(`/admin/menu/items/${id}`);
      if(page.url().includes('/pos/admin-pin')) {
        for(const digit of owner.pin)await page.getByRole('button',{name:digit,exact:true}).click();
        await page.getByRole('button',{name:'Open Admin',exact:true}).click();
        await expect(page).toHaveURL(baseURL+`/admin/menu/items/${id}`);
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
      await page.evaluate(()=>localStorage.setItem('wayne-order-details-v1',JSON.stringify({fulfillment:'pickup',first_name:'Synthetic'})));
      await page.goto('/menu');await page.getByRole('button',{name:'Dinners',exact:true}).last().click();
      const card=page.locator('article').filter({hasText:index===0?'Cheeseburger Dinner':'Gyro Dinner'});await expect(card.getByText('$14.25',{exact:true})).toBeVisible();
    }
    for(const id of ids){const previous=JSON.parse(await readFile(`.vercel/pricing-historical-${id}.json`,'utf8'));const line=await db.from('order_items').select('unit_price_cents').eq('order_id',previous.order_id).single();expect(line.error).toBeNull();expect(line.data?.unit_price_cents).toBe(1350);}
    await page.context().storageState({path:'.vercel/pricing-owner-state.json'});
  });
  test('cashier session cannot edit menu pricing',async({page})=>{
    test.skip(process.env.MENU_PRICING_PHASE==='baseline','Candidate only');
    await login(page,`/admin/menu/items/${ids[0]}`,cashier);await expect(page).toHaveURL(/\/unauthorized/);
    const client=createClient(stagingSupabaseUrl,env.NEXT_PUBLIC_SUPABASE_ANON_KEY??'',{auth:{persistSession:false}});
    expect((await client.auth.signInWithPassword({email:cashier.email,password:cashier.password})).error).toBeNull();
    const result=await client.rpc('wayne_set_menu_prices',{target_item_id:ids[0],expected_revision:0,base_price_cents:1350,variant_prices:[]});expect(result.error?.code).toBe('42501');
    await page.goto('/pos');await expect(page.getByRole('button',{name:'Walk-in At the counter',exact:true})).toBeVisible();
    await page.context().storageState({path:'.vercel/pricing-cashier-state.json'});
  });
  test('real concurrent editors reject a stale save and retain the unsaved draft',async({page})=>{
    test.skip(process.env.MENU_PRICING_PHASE==='baseline','Candidate only');
    const path=`/admin/menu/items/${ids[0]}`;
    await login(page,path);
    const second=await page.context().newPage();await second.goto(path);
    await page.getByRole('textbox',{name:'Item price ($)',exact:true}).fill('14.26');
    await page.getByRole('button',{name:'Save prices only',exact:true}).click();
    await expect(page.getByText('Prices saved to the database.',{exact:true})).toBeVisible();
    await second.getByRole('textbox',{name:'Item price ($)',exact:true}).fill('13.50');
    await second.getByRole('button',{name:'Save menu item',exact:true}).click();
    await expect(second.getByRole('main').getByRole('alert')).toContainText('another register');
    await expect(second.getByRole('textbox',{name:'Item price ($)',exact:true})).toHaveValue('13.50');
    await page.getByRole('textbox',{name:'Item price ($)',exact:true}).fill('14.25');
    await page.getByRole('button',{name:'Save prices only',exact:true}).click();
    await expect(page.getByText('Prices saved to the database.',{exact:true})).toBeVisible();
    await second.reload();await expect(second.getByRole('textbox',{name:'Item price ($)',exact:true})).toHaveValue('14.25');
    await page.context().storageState({path:'.vercel/pricing-owner-state.json'});await second.close();
  });

});
