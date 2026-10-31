// Isolated PostgreSQL and a small PostgREST transport. No .env or live URL is read.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dinners from '../../tests/fixtures/dinner-pricing.json';
import { startTipPostgres, ownerId } from '../../tests/helpers/tip-postgres';
const db=await startTipPostgres();
const category='3fcd712d-f81a-45cf-9251-228af6584bdc';
await db.admin.query("insert into menu_categories(id,name) values($1,'Dinners')",[category]);
for(const item of dinners) {
  await db.admin.query('insert into menu_items(id,category_id,name,base_price_cents) values($1,$2,$3,1350)',[item.id,category,item.name]);
  await db.admin.query('begin');
  await db.admin.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
  await db.admin.query('select wayne_write_menu_children($1,$2)',[item.id,JSON.stringify(item)]);
  await db.admin.query('commit');
}
let failNext=false;
const tables=new Set(['menu_items','menu_categories','menu_item_variants','menu_item_modifier_groups','modifier_groups','modifier_choices','menu_item_included_choices','modifier_choice_variant_prices']);
const rpcs=new Set(['wayne_set_menu_prices','wayne_update_menu_item','wayne_pos_menu','wayne_public_menu']);
function column(s:string) {if(!/^[a-z_]+$/.test(s))throw new Error('Invalid fixture column');return `"${s}"`;}
const transport=createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://127.0.0.1');
  if(url.pathname==='/control/fail-save'){failNext=true;res.end('{}');return;}
  const client=await db.connect();
  res.setHeader('content-type','application/json');
  try {
    await client.query('begin;set local role authenticated');
    await client.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
    let data:unknown;
    const parts=url.pathname.split('/'), name=parts.at(-1)!;
    if(parts.includes('rpc')) {
      let body='';for await(const chunk of req)body+=chunk;
      const args=JSON.parse(body||'{}');
      if(failNext&&name==='wayne_set_menu_prices'){failNext=false;throw new Error('Injected database write failure');}
      if(name==='fixture_place_order') {
        const line=args.line;
        const order=(await client.query('select wayne_create_pos_order($1) value',[{idempotency_key:randomUUID(),customer_mode:'walk_in',source:'pos',fulfillment_type:'pickup',payment_method:'test_manual',items:[line]}])).rows[0].value;
        const price=(await client.query('select unit_price_cents from order_items where order_id=$1',[order.id])).rows[0].unit_price_cents;
        data={id:order.id,price};
      }else{
        if(!rpcs.has(name))throw new Error('Invalid fixture RPC');
        const entries=Object.entries(args);
        data=(await client.query(`select public.${name}(${entries.map(([k],i)=>`${column(k)}=>$${i+1}`).join(',')}) value`,entries.map(([,v])=>typeof v==='object'&&v!==null?JSON.stringify(v):v))).rows[0].value;
      }
    }else{
      if(!tables.has(name))throw new Error('Invalid fixture table');
      const select=url.searchParams.get('select')!.split(',').map(column).join(',');
      const values:unknown[]=[],where:string[]=[];
      for(const [k,v]of url.searchParams){
        if(['select','order'].includes(k))continue;
        if(v==='is.null'){where.push(`${column(k)} is null`);continue;}
        const op=v.split('.')[0], value=v.slice(op.length+1);
        if(op==='eq'){values.push(value);where.push(`${column(k)}=$${values.length}`);}
        else if(op==='in'){values.push(value.slice(1,-1).split(','));where.push(`${column(k)}=any($${values.length}::uuid[])`);}
        else throw new Error('Invalid fixture filter');
      }
      const order=url.searchParams.get('order')?.split(',').map(v=>column(v.split('.')[0])).join(',');
      const rows=(await client.query(`select ${select} from public.${name} ${where.length?'where '+where.join(' and '):''} ${order?'order by '+order:''}`,values)).rows;
      data=req.headers.accept?.includes('vnd.pgrst.object') ? rows[0]??null : rows;
    }
    await client.query('commit');res.end(JSON.stringify(data));
  }catch(error){await client.query('rollback');res.statusCode=400;res.end(JSON.stringify({message:(error as Error).message,code:'P0001'}));}
  finally { await db.disconnect(client); }
});
await new Promise<void>(resolve=>transport.listen(0,'127.0.0.1',resolve));
const address=transport.address();if(!address||typeof address==='string')throw new Error('No fixture port');
const fixtureUrl=`http://127.0.0.1:${address.port}`;
const next=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','e2e/pricing-fixture','--webpack','-p','3107'],{stdio:'inherit',env:{...process.env,PRICING_FIXTURE_URL:fixtureUrl}});
let stopped=false;
async function stop(){if(stopped)return;stopped=true;next.kill();transport.close();await db.stop();process.exit();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);next.on('exit',()=>{void stop();});
