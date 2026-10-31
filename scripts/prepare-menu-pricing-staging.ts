/** Creates only synthetic pricing fixtures on the named staging project. */
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { randomUUID,randomInt } from 'node:crypto';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import dinners from '../tests/fixtures/dinner-pricing.json';
const project='pkjrdvtdygiprmsojdqg';
const env=parseEnv(await readFile('.env.staging.local','utf8'));
const link=JSON.parse(await readFile('.vercel/project.json','utf8'));
if(env.NEXT_PUBLIC_SUPABASE_URL!==`https://${project}.supabase.co`||link.projectName!=='waynes-pos-staging')throw new Error('Named staging app/database required');
await mkdir('.vercel',{recursive:true});
const service=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY??'',{auth:{persistSession:false,autoRefreshToken:false}});
type Reviewer={id:string;email:string;password:string;pin:string;role:'owner'|'cashier'};
let users:Reviewer[];
try{users=JSON.parse(await readFile('.vercel/menu-pricing-users.json','utf8'));}catch{users=[];}
for(const role of ['owner','cashier'] as const){
    if(users.some(user=>user.role===role))continue;
    const email=`menu-pricing-${role}-${randomUUID().slice(0,8)}@example.invalid`,password=`Synthetic-${randomUUID()}-Aa1!`;
    const result=await service.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{display_name:`Synthetic pricing review ${role}`}});
    if(result.error||!result.data.user)throw new Error(result.error?.message??'Test account creation failed');
    users.push({id:result.data.user.id,email,password,pin:String(randomInt(100000,999999)),role});
    await writeFile('.vercel/menu-pricing-users.json',JSON.stringify(users),{mode:0o600});
}
const literal=(value:unknown)=>`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`;
let sql='begin;\n';
for(const user of users){
  if(!['owner','cashier'].includes(user.role)||!/^[0-9a-f-]{36}$/.test(user.id)||!/^\d{6}$/.test(user.pin))throw new Error('Invalid fixture account');
  sql+=`update public.profiles set active=true,role_id=(select id from public.roles where code='${user.role}') where id='${user.id}' and display_name='Synthetic pricing review ${user.role}';\n`;
  sql+=`select public.wayne_store_staff_pin('${user.id}','${user.pin}');\n`;
}
const owner=users.find(u=>u.role==='owner')!;
sql+=`insert into public.menu_categories(id,name,description,sort_order) values('3fcd712d-f81a-45cf-9251-228af6584bdc','Dinners','Synthetic pricing review fixtures; staging only',-900) on conflict(id) do nothing;\n`;
for(const item of dinners){
  sql+=`do $fixture$ begin
    if exists(select 1 from public.menu_items where id='${item.id}' and (name<>${literal(item.name)}#>>'{}' or description<>'Synthetic pricing review fixture; staging only')) then
      raise exception 'Unexpected existing fixture ID; refusing to overwrite shared data';
    end if;
    if not exists(select 1 from public.menu_items where id='${item.id}') then
      insert into public.menu_items(id,category_id,name,description,base_price_cents,sort_order)
      values('${item.id}','${item.category_id}',${literal(item.name)}#>>'{}','Synthetic pricing review fixture; staging only',1350,0);
      perform set_config('request.jwt.claim.sub','${owner.id}',true);
      perform public.wayne_write_menu_children('${item.id}',${literal(item)});
      perform set_config('request.jwt.claim.sub','',true);
    end if;
  end $fixture$;\n`;
}
sql+='commit;\n';
const file='.vercel/menu-pricing-fixtures.sql';await writeFile(file,sql,{mode:0o600});
const result=spawnSync('npx',['supabase','db','query','--linked','--project-ref',project,'--file',file,'--output','json'],{encoding:'utf8'});
if(result.status!==0){console.error(result.stderr);throw new Error('Staging fixture SQL failed');}
console.log('Prepared two production-shaped dinner fixtures and synthetic owner/cashier accounts on waynes-pos-staging. Private credentials remain under .vercel/.');
