import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const state=vi.hoisted(()=>({revision:1,changeDuringLoad:false,reads:[] as string[]}));
vi.mock('@/lib/auth/access',()=>({requirePermission:async()=>({})}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('not found');}}));
vi.mock('@/app/admin/menu/actions',()=>({savePosAutoAddAction:async()=>{},updateMenuItemAction:async()=>{}}));
vi.mock('@/app/admin/menu/menu-item-form',()=>({MenuItemForm:()=>null}));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:async()=>({from:(table:string)=>{
  let columns='';
  const query={select:(value:string)=>{columns=value;return query;},eq:()=>query,is:()=>query,in:()=>query,order:()=>query,maybeSingle:()=>query,
    then:(resolve:(value:{data:unknown;error:null})=>unknown)=>{
      state.reads.push(`${table}:${columns}`);
      if(table==='menu_item_variants'&&state.changeDuringLoad)state.revision=2;
      const item={id:'418c30cc-344c-4200-917d-0d60c183c77c',menu_revision:state.revision,name:'Cheeseburger Dinner',category_id:'3fcd712d-f81a-45cf-9251-228af6584bdc',base_price_cents:1350,image_alt:'',available_days:[0,1,2,3,4,5,6]};
      return Promise.resolve({data:table==='menu_items'?(columns==='menu_revision'?{menu_revision:state.revision}:item):[],error:null}).then(resolve);
    }};
  return query;
}})}));
import Page from '@/app/admin/menu/items/[id]/page';
beforeEach(()=>{state.revision=1;state.changeDuringLoad=false;state.reads=[];});
describe('menu editor snapshot consistency',()=>{
  it('refuses mixed editor data when another register saves while children load',async()=>{
    state.changeDuringLoad=true;
    const html=renderToStaticMarkup(await Page({params:Promise.resolve({id:'418c30cc-344c-4200-917d-0d60c183c77c'}),searchParams:Promise.resolve({})}));
    expect(html).toContain('changed while it was loading');
    expect(html).not.toContain('Save menu item');
    expect(state.reads.at(-1)).toBe('menu_items:menu_revision');
  });
  it('reads the item revision before reading children and rechecks it afterward',async()=>{
    await Page({params:Promise.resolve({id:'418c30cc-344c-4200-917d-0d60c183c77c'}),searchParams:Promise.resolve({})});
    expect(state.reads[0]).toMatch(/^menu_items:/);
    expect(state.reads.at(-1)).toBe('menu_items:menu_revision');
  });
});
