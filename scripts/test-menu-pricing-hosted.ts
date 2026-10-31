/** Run pgTAP inside rolled-back transactions on the named staging DB only. */
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';
const project='pkjrdvtdygiprmsojdqg';
const files=process.argv.slice(2);
if(!files.length)files.push('001_phase0_rls.test.sql','002_phase1_menu_rls.test.sql','011_hanafy_phase1_tenancy_rls.test.sql','012_hanafy_phase3_workspace_rls.test.sql','016_menu_pricing.test.sql');
await mkdir('.vercel',{recursive:true});
let failed=false;
for(const file of files){
  if(basename(file)!==file||!/^\d+_[a-z0-9_]+\.test\.sql$/.test(file))throw new Error('Only repository pgTAP test files are allowed');
  let sql=await readFile(`supabase/tests/${file}`,'utf8');
  if(!/^begin;/im.test(sql)||!/^rollback;/im.test(sql))throw new Error('Transactional rollback test required');
  sql=sql.replace(/^begin;\s*$/gim,'').replace(/^rollback;\s*$/gim,'');
  sql=sql.replace(/^select (plan|ok|is|has_table|lives_ok|throws_ok)\(/gim,'insert into pg_temp.pricing_tap_lines select $1(');
  sql=sql.replace(/^select \* from finish\(\);/gim,'insert into pg_temp.pricing_tap_lines select * from finish();');
  sql=`begin;create temporary table pricing_tap_lines(line text);do $tap$ begin execute format('grant usage on schema %I to anon,authenticated',(select nspname from pg_namespace where oid=pg_my_temp_schema())); end $tap$;grant all on pg_temp.pricing_tap_lines to anon,authenticated;\n${sql}\nreset role;select jsonb_agg(line order by ctid) as tap from pg_temp.pricing_tap_lines;rollback;`;
  const path=`.vercel/hosted-${file}`;await writeFile(path,sql);
  const result=spawnSync('npx',['supabase','db','query','--linked','--project-ref',project,'--file',path,'--output','json'],{encoding:'utf8'});
  if(result.status!==0){failed=true;console.log(`${file}: ERROR\n${result.stderr}\n${result.stdout}`);continue;}
  const start=result.stdout.indexOf('{'),end=result.stdout.lastIndexOf('}');
  const response=JSON.parse(result.stdout.slice(start,end+1));
  const lines:string[]=response.rows?.[0]?.tap??[];
  const bad=lines.filter(line=>/^(?:not ok|# Looks like)/m.test(line));
  if(!lines.length||bad.length){failed=true;console.log(`${file}: FAILED\n${lines.join('\n')}`);}else console.log(`${file}: PASS\n${lines.join('\n')}`);
}
if(failed)process.exitCode=1;
