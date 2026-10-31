import { expect,it } from 'vitest';
import { editorConfiguration } from '@/lib/menu/editor-configuration';
it('keeps each size override through partial typing, duplicate draft names, renames and removal',()=>{
  const groups=[{choices:[{variant_prices:{Small:'1.50',Large:'2.50'}}]}];
  const variants=[{name:'Large',price_key:'Small'},{name:'Large',price_key:'Large'}];
  // A temporarily duplicate name is rejected by the payload schema; the draft
  // data must not have overwritten either size's original override meanwhile.
  editorConfiguration(variants,groups);
  variants[0].name='Medium';
  expect(editorConfiguration(variants,groups).modifier_groups[0].choices[0].variant_prices).toEqual({Medium:'1.50',Large:'2.50'});
  expect(editorConfiguration(variants.slice(1),groups).modifier_groups[0].choices[0].variant_prices).toEqual({Large:'2.50'});
  expect(groups[0].choices[0].variant_prices).toEqual({Small:'1.50',Large:'2.50'});
});
