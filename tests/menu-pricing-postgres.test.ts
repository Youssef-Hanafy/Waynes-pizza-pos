import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTipPostgres, ownerId } from './helpers/tip-postgres';

describe('menu pricing on isolated PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  const ids: string[] = [];
  const category = '3fcd712d-f81a-45cf-9251-228af6584bdc';
  beforeAll(async () => {
    db = await startTipPostgres({ skipMigration: process.env.MENU_PRICING_BASELINE === '1' ? '20261122080000_menu_price_editing.sql' : undefined });
    await db.admin.query("insert into menu_categories(id,name) values($1,'Dinners')",[category]);
    for (const [index,name] of ['Cheeseburger Dinner', 'Gyro Dinner'].entries()) {
      const id = ['418c30cc-344c-4200-917d-0d60c183c77c','5677ccf0-ba1d-41a1-8382-473233f61ea9'][index]; ids.push(id);
      await db.admin.query('insert into menu_items(id,category_id,name,base_price_cents) values($1,$2,$3,1350)', [id, category, name]);
    }
  }, 60_000);
  afterAll(async () => { await db?.stop(); });
  async function save(id: string, price: number, revision?: number, variants: unknown[] = []) {
    const client = await db.connect();
    try {
      const version = revision ?? (await client.query('select menu_revision from menu_items where id=$1', [id])).rows[0].menu_revision;
      await client.query('begin;set local role authenticated');
      await client.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
      const result = await client.query('select wayne_set_menu_prices($1,$2,$3,$4) value', [id, version, price, JSON.stringify(variants)]);
      await client.query('commit'); return result.rows[0].value;
    } catch (e) { await client.query('rollback'); throw e; }
  }
  for (const [index, name] of ['Cheeseburger Dinner', 'Gyro Dinner'].entries()) {
    it(`saves and reloads ${name} at $14.25`, async () => {
      await save(ids[index], 1425);
      expect((await db.admin.query('select base_price_cents from menu_items where id=$1', [ids[index]])).rows[0].base_price_cents).toBe(1425);
    });
  }
  it('rejects stale full-editor payloads (legacy RPC silently accepted them)', async () => {
    const id=ids[1];
    const client=await db.connect();
    const item=(await client.query('select * from menu_items where id=$1',[id])).rows[0];
    const payload={...item, expected_revision:item.menu_revision, image_path:null, kitchen_route:'',available_start:'',available_end:'',variants:[],modifier_groups:[]};
    await client.query('begin;set local role authenticated');
    await client.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
    await client.query('select wayne_update_menu_item($1,$2)',[id,{...payload,base_price_cents:1425}]);
    await client.query('commit');
    await client.query('begin;set local role authenticated');
    await client.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
    await expect(client.query('select wayne_update_menu_item($1,$2)',[id,{...payload,base_price_cents:1350}])).rejects.toThrow(/another register/i);
    await client.query('rollback');
  });
  it('rejects a stale register instead of overwriting the acknowledged save', async () => {
    const id = ids[0];
    const revision = (await db.admin.query('select menu_revision from menu_items where id=$1', [id])).rows[0].menu_revision;
    const results = await Promise.allSettled([save(id, 1431, revision), save(id, 1432, revision)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  });
  it('updates a size by ID, keeps its identity and rejects incomplete or duplicate size lists', async () => {
    const id = randomUUID(), variant = randomUUID();
    await db.admin.query('insert into menu_items(id,category_id,name,base_price_cents) values($1,$2,$3,100)', [id, category, 'Other editable item']);
    await db.admin.query("insert into menu_item_variants(id,menu_item_id,name,price_cents) values($1,$2,'Large',200)", [variant,id]);
    await expect(save(id,100)).rejects.toThrow(/sizes changed/i);
    await expect(save(id,100,undefined,[{id:variant,price_cents:325},{id:variant,price_cents:325}])).rejects.toThrow(/sizes changed/i);
    await save(id,100,undefined,[{id:variant,price_cents:325}]);
    expect((await db.admin.query('select id,price_cents,active from menu_item_variants where menu_item_id=$1',[id])).rows).toEqual([{id:variant,price_cents:325,active:true}]);
  });
  it('rejects invalid cents atomically', async () => {
    const before = (await db.admin.query('select base_price_cents from menu_items where id=$1',[ids[1]])).rows[0];
    await expect(save(ids[1],-1)).rejects.toThrow(/price/i);
    expect((await db.admin.query('select base_price_cents from menu_items where id=$1',[ids[1]])).rows[0]).toEqual(before);
  });
  it('denies cashier and cross-workspace writes', async () => {
    const cashier=randomUUID(), other=randomUUID(), otherItem=randomUUID();
    await db.admin.query('insert into auth.users(id,email) values($1,$2)',[cashier,'cashier-pricing@example.invalid']);
    await db.admin.query("insert into workspaces(id,slug,name) values($1,'pricing-other','Other business')",[other]);
    await db.admin.query("insert into menu_items(id,category_id,name,workspace_id) values($1,$2,'Other tenant', $3)",[otherItem,category,other]);
    const client=await db.connect();
    for(const [actor,id] of [[cashier,ids[0]],[ownerId,otherItem]]) {
      await client.query('begin;set local role authenticated');
      await client.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);
      await expect(client.query("select wayne_set_menu_prices($1,0,1425,'[]')",[id])).rejects.toThrow(/permission/i);
      await client.query('rollback');
    }
  });
  it('prices NEW POS and online orders from the saved price and preserves placed orders', async () => {
    const id=ids[1];
    await save(id,1350);
    const client=await db.connect();
    async function place(online=false) {
      await client.query(`begin;set local role ${online?'service_role':'authenticated'}`);
      await client.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
      const payload={ idempotency_key:randomUUID(), customer_mode:'walk_in',source:online?'online':'pos',fulfillment_type:'pickup',payment_method:'test_manual',
        first_name:'Synthetic',last_name:'Pricing Test',phone:'5085550198',email:'pricing@example.invalid',
        items:[{menu_item_id:id,variant_id:null,quantity:1,modifiers:[],special_instructions:''}] };
      const order=(await client.query(`select ${online?'wayne_create_test_order':'wayne_create_pos_order'}($1) value`,[payload])).rows[0].value;
      await client.query('commit'); return order.id;
    }
    const original=await place();
    await save(id,1425);
    const pos=await place(),online=await place(true);
    for(const [order,price] of [[original,1350],[pos,1425],[online,1425]]) {
      expect((await db.admin.query('select unit_price_cents from order_items where order_id=$1',[order])).rows[0].unit_price_cents).toBe(price);
    }
    await client.query('begin;set local role authenticated');
    await client.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
    for(const fn of ['wayne_pos_menu','wayne_public_menu']) {
      const menu=(await client.query(`select ${fn}() value`)).rows[0].value;
      expect(menu.flatMap((c: {items: {id:string; base_price_cents:number}[]})=>c.items).find((i:{id:string})=>i.id===id).base_price_cents).toBe(1425);
    }
    await client.query('rollback');
    expect((await db.admin.query("select count(*)::int count from audit_log where entity_id=$1 and changes::text like '%base_price_cents%'",[id])).rows[0].count).toBeGreaterThan(0);
  });
  it('keeps modifier IDs, size overrides, included quantities and half settings on price-only save', async () => {
    const id=ids[0], group=randomUUID(),choice=randomUUID();
    await db.admin.query("insert into modifier_groups(id,name,customer_label,allow_halves) values($1,'Synthetic toppings','Toppings',true)",[group]);
    await db.admin.query('insert into menu_item_modifier_groups(menu_item_id,modifier_group_id) values($1,$2)',[id,group]);
    await db.admin.query("insert into modifier_choices(id,modifier_group_id,name,price_delta_cents,default_selected) values($1,$2,'Synthetic cheese',125,true)",[choice,group]);
    const sibling=randomUUID(),variant=randomUUID();
    await db.admin.query("insert into menu_items(id,category_id,name) values($1,$2,'Sized sibling')",[sibling,category]);
    await db.admin.query("insert into menu_item_variants(id,menu_item_id,name,price_cents) values($1,$2,'Large',2000)",[variant,sibling]);
    await db.admin.query('insert into menu_item_modifier_groups(menu_item_id,modifier_group_id) values($1,$2)',[sibling,group]);
    await db.admin.query('insert into modifier_choice_variant_prices(modifier_choice_id,menu_item_variant_id,price_delta_cents) values($1,$2,250)',[choice,variant]);
    await db.admin.query("insert into modifier_group_size_rules(modifier_group_id,size_name,included_count,max_portions,extra_each_cents) values($1,'Large',1,3,125)",[group]);
    const revision=(await db.admin.query('select menu_revision from menu_items where id=$1',[id])).rows[0].menu_revision;
    await db.admin.query('update modifier_choices set price_delta_cents=150 where id=$1',[choice]);
    await expect(save(id,1425,revision)).rejects.toThrow(/another register/i);
    await save(id,1425);
    expect((await db.admin.query('select id,price_delta_cents,default_selected from modifier_choices where id=$1',[choice])).rows).toEqual([{id:choice,price_delta_cents:150,default_selected:true}]);
    expect((await db.admin.query('select price_delta_cents from modifier_choice_variant_prices where modifier_choice_id=$1 and menu_item_variant_id=$2',[choice,variant])).rows[0].price_delta_cents).toBe(250);
    expect((await db.admin.query('select included_count from modifier_group_size_rules where modifier_group_id=$1',[group])).rows[0].included_count).toBe(1);
    expect((await db.admin.query('select allow_halves from modifier_groups where id=$1',[group])).rows[0].allow_halves).toBe(true);
  });
  it('applies the correction twice without duplicates and refuses unexpected prices', async () => {
    await db.admin.query('update menu_categories set name=$1 where id=$2',['Dinners',category]);
    await db.admin.query('update menu_items set base_price_cents=1350 where id=any($1::uuid[])',[ids]);
    const sql=await readFile('scripts/correct-dinner-prices.sql','utf8');
    await db.admin.query(sql); await db.admin.query(sql);
    expect((await db.admin.query('select base_price_cents from menu_items where id=any($1::uuid[])',[ids])).rows.map(r=>r.base_price_cents)).toEqual([1425,1425]);
    const duplicate=randomUUID();
    await db.admin.query("insert into menu_items(id,category_id,name,base_price_cents) values($1,$2,'Gyro Dinner',1425)",[duplicate,category]);
    await expect(db.admin.query(sql)).rejects.toThrow(/exactly one/i);await db.admin.query('rollback');
    await db.admin.query('delete from menu_items where id=$1',[duplicate]);
    const unexpectedSize=randomUUID();
    await db.admin.query("insert into menu_item_variants(id,menu_item_id,name,price_cents) values($1,$2,'Unexpected',1425)",[unexpectedSize,ids[1]]);
    await expect(db.admin.query(sql)).rejects.toThrow(/size price override/i);await db.admin.query('rollback');
    await db.admin.query('delete from menu_item_variants where id=$1',[unexpectedSize]);
    await db.admin.query('update menu_items set base_price_cents=1500 where id=$1',[ids[0]]);
    await expect(db.admin.query(sql)).rejects.toThrow(/unexpected price/i); await db.admin.query('rollback');
  });
});
