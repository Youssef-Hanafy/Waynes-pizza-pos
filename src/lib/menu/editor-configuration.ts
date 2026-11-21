// A draft size keeps its original key while its display name changes. Convert
// both price overrides and included-portion rules to current names on submit.
export function editorConfiguration<
  Variant extends { name: string; price_key?: string },
  Group extends { size_rules?: { variant_name: string }[]; choices: { variant_prices: Record<string, string> }[] },
>(variants: Variant[], groups: Group[]) {
  return {
    variants,
    modifier_groups: groups.map(group => ({
      ...group,
      ...(group.size_rules ? {
        size_rules: group.size_rules.flatMap(rule => {
          if (!rule.variant_name) return [rule];
          const variant = variants.find(v => (v.price_key ?? v.name).trim().toLowerCase() === rule.variant_name.trim().toLowerCase());
          return variant ? [{ ...rule, variant_name: variant.name }] : [];
        }),
      } : {}),
      choices: group.choices.map(choice => ({
        ...choice,
        variant_prices: Object.fromEntries(variants.flatMap(variant => {
          const price = choice.variant_prices[variant.price_key ?? variant.name];
          return price === undefined ? [] : [[variant.name, price]];
        })),
      })),
    })),
  };
}
