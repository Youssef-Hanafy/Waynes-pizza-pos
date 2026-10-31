import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { startTipPostgres,ownerId } from './helpers/tip-postgres';
const category='79000000-0000-4000-8000-000000000002';
const base={category_id:category,name:'Pricing review fixture',description:'',image_path:null,image_alt:'',base_price_cents:1200,tax_category:'prepared_food',included_count_label:'',sold_out:false,customer_visible:true,pos_visible:true,featured:false,kitchen_route:'',available_days:[0,1,2,3,4,5,6],available_start:'',available_end:'',sort_order:0,
  variants:[{name:'Small',price_cents:1200,sku:'',sort_order:0}],modifier_groups:[{name:'Toppings',customer_label:'Toppings',min_select:0,max_select:3,required:false,allow_quantities:true,allow_halves:true,choices:[{name:'Cheddar',price_delta_cents:100,default_selected:false,variant_prices:[{variant_name:'Small',price_delta_cents:150}]}]}]};
describe('independent pricing database regressions',()=>{
  let db:Awaited<ReturnType<typeof startTipPostgres>>;
  beforeAll(async()=>{db=await startTipPostgres();},60_000);
  afterAll(async()=>{await db?.stop();});
  async function call(name:string,args:unknown[]) {
    const client=await db.connect();
    try{await client.query('begin;set local role authenticated');await client.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
      const result=await client.query(`select ${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) value`,args.map(v=>typeof v==='object'?JSON.stringify(v):v));
      await client.query('commit');return result.rows[0].value;
    }catch(error){await client.query('rollback');throw error;}finally{await db.disconnect(client);}
  }
  it('preserves size allowances when the ordinary full editor saves prices and renames a size',async()=>{
    const id=await call('wayne_create_menu_item',[base]);
    const group=(await db.admin.query('select modifier_group_id id from menu_item_modifier_groups where menu_item_id=$1 and active',[id])).rows[0].id;
    const variant=(await db.admin.query('select id from menu_item_variants where menu_item_id=$1 and active',[id])).rows[0].id;
    await db.admin.query("insert into modifier_group_size_rules(modifier_group_id,size_name,included_count,max_portions,extra_each_cents) values($1,'Small',1,3,75)",[group]);
    const revision=(await db.admin.query('select menu_revision from menu_items where id=$1',[id])).rows[0].menu_revision;
    const payload={...base,expected_revision:revision,base_price_cents:1425,variants:[{...base.variants[0],id:variant,name:'Medium',price_cents:1425}],modifier_groups:[{...base.modifier_groups[0],id:group,choices:[{...base.modifier_groups[0].choices[0],variant_prices:[{variant_name:'Medium',price_delta_cents:150}]}]}]};
    await call('wayne_update_menu_item',[id,payload]);
    const rules=(await db.admin.query('select r.size_name,r.included_count,r.max_portions,r.extra_each_cents from modifier_group_size_rules r join menu_item_modifier_groups l on l.modifier_group_id=r.modifier_group_id where l.menu_item_id=$1 and l.active',[id])).rows;
    expect(rules).toEqual([{size_name:'Medium',included_count:1,max_portions:3,extra_each_cents:75}]);
  });
  it('rejects foreign definition IDs instead of copying another business configuration',async()=>{
    const id=await call('wayne_create_menu_item',[base]);
    const revision=(await db.admin.query('select menu_revision from menu_items where id=$1',[id])).rows[0].menu_revision;
    await expect(call('wayne_update_menu_item',[id,{...base,expected_revision:revision,modifier_groups:[{...base.modifier_groups[0],id:randomUUID()}]}])).rejects.toThrow(/modifier.*changed|modifier.*belong/i);
  });
  it('enforces required group rules for direct database clients, too',async()=>{
    const id=await call('wayne_create_menu_item',[base]);
    const revision=(await db.admin.query('select menu_revision from menu_items where id=$1',[id])).rows[0].menu_revision;
    await expect(call('wayne_update_menu_item',[id,{...base,expected_revision:revision,modifier_groups:[{...base.modifier_groups[0],required:true,min_select:1,choices:[]}]}])).rejects.toThrow(/active choice/i);
  });
});
