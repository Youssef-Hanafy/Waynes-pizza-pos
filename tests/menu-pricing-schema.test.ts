import { describe, expect, it } from 'vitest';
import dinners from './fixtures/dinner-pricing.json';
import { menuItemPayloadSchema, modifierGroupSchema } from '@/lib/menu/schemas';
// Normalized from the owner's read-only production results, 2026-10-31.
export function dinnerPayload(index: number) {
  return { ...dinners[index], base_price_cents:1425, description:'',image_path:null,image_alt:'',tax_category:'prepared_food',included_count_label:'',
    sold_out:false,customer_visible:true,pos_visible:true,featured:false,kitchen_route:'',available_days:[0,1,2,3,4,5,6],available_start:'',available_end:'',sort_order:0 };
}
describe('production dinner configuration regression',()=>{
  for(const [index,item] of dinners.entries()) {
    it(`allows a price edit for ${item.name} with its existing empty optional Meats group`,()=>{
      const payload=dinnerPayload(index);
      expect(payload.modifier_groups.some(g=>g.choices.length===0)).toBe(true);
      const result=menuItemPayloadSchema.safeParse(payload);
      expect(result.success,JSON.stringify(result.success?[]:result.error.issues)).toBe(true);
    });
  }
  it('rejects empty required groups',()=>{
    expect(modifierGroupSchema.safeParse({name:'Required',customer_label:'Pick one',min_select:1,max_select:1,required:true,allow_quantities:false,choices:[]}).success).toBe(false);
  });
});
