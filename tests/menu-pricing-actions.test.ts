import { beforeEach, describe, expect, it, vi } from 'vitest';
import dinners from './fixtures/dinner-pricing.json';
import { parseMoneyToCents, parseSignedMoneyToCents } from '@/lib/menu/schemas';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),permission:vi.fn(),revalidate:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error(`REDIRECT:${path}`);}}));
vi.mock('@/lib/auth/access',()=>({requirePermission:mocks.permission}));
vi.mock('@/lib/images/upload',()=>({uploadOptimizedImage:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:async()=>({rpc:mocks.rpc})}));
import { updateMenuItemAction } from '@/app/admin/menu/actions';
const id='79000000-0000-4000-8000-000000000011';
function form(price='14.25') {
  const data=new FormData();
  for(const [k,v] of Object.entries({save_mode:'prices',expected_revision:'3',base_price:price,configuration:JSON.stringify({variants:[],modifier_groups:[]})}))data.set(k,v);
  return data;
}
beforeEach(()=>{vi.resetAllMocks();mocks.permission.mockResolvedValue({});});
describe('production menu save action',()=>{
  it('sends exact cents and confirms only after the expected database ID returns',async()=>{
    mocks.rpc.mockResolvedValue({data:id,error:null});
    await expect(updateMenuItemAction(id,form())).rejects.toThrow('REDIRECT:');
    expect(mocks.rpc).toHaveBeenCalledWith('wayne_set_menu_prices',{target_item_id:id,expected_revision:3,base_price_cents:1425,variant_prices:[]});
    expect(mocks.revalidate).toHaveBeenCalledWith('/pos');
    expect(mocks.revalidate).toHaveBeenCalledWith('/menu');
  });
  it.each(dinners)('saves the complete $name form with its empty optional Meats group',async item=>{
    const data=form();data.delete('save_mode');
    for(const [key,value] of Object.entries({category_id:item.category_id,name:item.name,description:'',tax_category:'prepared_food',included_count_label:'',kitchen_route:'',sort_order:'0',image_alt:'',available_start:'',available_end:''}))data.set(key,value);
    for(let day=0;day<7;day++)data.set(`available_day_${day}`,'on');
    data.set('configuration',JSON.stringify({variants:[],modifier_groups:item.modifier_groups.map(g=>({...g,choices:g.choices.map(c=>({...c,price:(c.price_delta_cents/100).toFixed(2),variant_prices:{}}))}))}));
    mocks.rpc.mockResolvedValue({data:item.id,error:null});
    await expect(updateMenuItemAction(item.id,data)).rejects.toThrow('REDIRECT:');
    expect(mocks.rpc).toHaveBeenCalledWith('wayne_update_menu_item',expect.objectContaining({target_item_id:item.id,payload:expect.objectContaining({base_price_cents:1425})}));
  });
  it('returns the database error to the form without confirming or invalidating',async()=>{
    mocks.rpc.mockResolvedValue({data:null,error:{message:'Permission denied'}});
    expect(await updateMenuItemAction(id,form())).toEqual({error:'Permission denied'});
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it('explains missing acknowledgement and network failures',async()=>{
    mocks.rpc.mockResolvedValue({data:null,error:null});
    expect(await updateMenuItemAction(id,form())).toMatchObject({error:expect.stringContaining('did not confirm')});
    mocks.rpc.mockRejectedValue(new Error('network'));
    expect(await updateMenuItemAction(id,form())).toMatchObject({error:expect.stringContaining('Could not confirm')});
  });
  it('requires staff permission and a revision before writing',async()=>{
    const data=form();data.delete('expected_revision');
    expect(await updateMenuItemAction(id,data)).toMatchObject({error:expect.stringContaining('Reload')});
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.permission.mockRejectedValue(new Error('Unauthorized'));
    await expect(updateMenuItemAction(id,form())).rejects.toThrow('Unauthorized');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(['14.251','-1','NaN','1e2','1,425','10000.01','90071992547409999'])('rejects invalid currency %s',async value=>{
    expect(await updateMenuItemAction(id,form(value))).toMatchObject({error:expect.stringContaining('Enter prices')});
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('parses dollars without binary rounding and rejects unsafe integers',()=>{
    expect(parseMoneyToCents('14.25')).toBe(1425);expect(parseMoneyToCents('0.29')).toBe(29);
    expect(parseSignedMoneyToCents('-0.29')).toBe(-29);expect(parseMoneyToCents('90071992547409999')).toBeNull();
  });
});
