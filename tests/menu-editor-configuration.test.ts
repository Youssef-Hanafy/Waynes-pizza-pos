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

it('keeps each size allowance through renaming and removes only the deleted size rule',()=>{
  const groups=[{size_rules:[{variant_name:'',included_count:1},{variant_name:'Small',included_count:1},{variant_name:'Large',included_count:2}],choices:[]}];
  const variants=[{name:'One Size',price_key:'Small'},{name:'Large',price_key:'Large'}];
  expect(editorConfiguration(variants,groups).modifier_groups[0].size_rules).toEqual([{variant_name:'',included_count:1},{variant_name:'One Size',included_count:1},{variant_name:'Large',included_count:2}]);
  expect(editorConfiguration(variants.slice(1),groups).modifier_groups[0].size_rules).toEqual([{variant_name:'',included_count:1},{variant_name:'Large',included_count:2}]);
});
