// A draft size keeps its original override key while its display name changes.
// Only the submitted payload uses the current name expected by the database.
export function editorConfiguration<Variant extends { name: string; price_key?: string }, Group extends { choices: { variant_prices: Record<string,string> }[] }>(variants: Variant[], groups: Group[]) {
  return { variants, modifier_groups: groups.map(group=>({...group,choices:group.choices.map(choice=>({...choice,
    variant_prices:Object.fromEntries(variants.flatMap(variant=>{
      const price=choice.variant_prices[variant.price_key??variant.name];
      return price===undefined?[]:[[variant.name,price]];
    })),
  }))})) };
}
