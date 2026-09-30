"use client";

import { useEffect, useRef } from "react";

export type SuggestedAddress = { address1: string; city: string; state: string; postal_code: string };
type PlaceComponent = { long_name?: string; short_name?: string; types?: string[] };
type Place = { address_components?: PlaceComponent[]; formatted_address?: string; name?: string };
type GoogleAutocomplete = {
  addListener: (event: "place_changed", callback: () => void) => { remove?: () => void };
  getPlace: () => Place;
};
type GoogleWindow = Window & {
  google?: { maps?: { places?: { Autocomplete: new (input: HTMLInputElement, options: { componentRestrictions: { country: string }; fields: string[]; types: string[] }) => GoogleAutocomplete } } };
};

type Props = {
  id?: string; name?: string; label?: string; defaultValue?: string; value?: string; required?: boolean;
  onChange?: (value: string) => void;
  onAddressSelect?: (address: SuggestedAddress) => void;
};

/** Google Places suggestions can update React state or an ordinary checkout form. */
export function GoogleAddressInput({ id = "address1", name = "address1", label = "Find your delivery address", defaultValue = "", value, required = true, onChange, onAddressSelect }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef(onAddressSelect);
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  useEffect(() => { selectRef.current = onAddressSelect; }, [onAddressSelect]);

  useEffect(() => {
    if (!apiKey || !inputRef.current) return;
    let listener: { remove?: () => void } | undefined;
    let cancelled = false;
    const connect = () => {
      const Autocomplete = (window as GoogleWindow).google?.maps?.places?.Autocomplete;
      if (cancelled || !Autocomplete || !inputRef.current) return;
      const autocomplete = new Autocomplete(inputRef.current, { componentRestrictions: { country: "us" }, fields: ["address_components", "formatted_address", "name"], types: ["address"] });
      listener = autocomplete.addListener("place_changed", () => {
        const place = autocomplete.getPlace();
        const components = place.address_components ?? [];
        const part = (type: string, long = false) => components.find((component) => component.types?.includes(type))?.[long ? "long_name" : "short_name"] ?? "";
        const address = {
          address1: [part("street_number"), part("route", true)].filter(Boolean).join(" ") || place.name || place.formatted_address || "",
          city: part("locality", true) || part("postal_town", true) || part("sublocality", true),
          state: part("administrative_area_level_1"), postal_code: part("postal_code"),
        };
        if (selectRef.current) {
          selectRef.current(address);
          return;
        }
        // The public checkout is an HTML form, so fill its native fields too.
        for (const [fieldName, fieldValue] of Object.entries(address)) {
          const field = document.querySelector<HTMLInputElement>(`input[name="${fieldName}"]`);
          if (!field || !fieldValue) continue;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(field, fieldValue);
          field.dispatchEvent(new Event("input", { bubbles: true }));
          field.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    };
    if ((window as GoogleWindow).google?.maps?.places) {
      connect();
      return () => { cancelled = true; listener?.remove?.(); };
    }
    const existing = document.getElementById("wayne-google-places") as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", connect, { once: true });
      return () => { cancelled = true; existing.removeEventListener("load", connect); listener?.remove?.(); };
    }
    const script = document.createElement("script");
    script.id = "wayne-google-places";
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places`;
    script.addEventListener("load", connect, { once: true });
    document.head.appendChild(script);
    return () => { cancelled = true; listener?.remove?.(); };
  }, [apiKey]);

  return <div className="grid content-start gap-1.5 sm:col-span-2">
    <label className="text-sm font-bold tracking-tight" htmlFor={id}>{label}{required ? <span aria-hidden className="ml-1 text-wayne-red">*</span> : null}</label>
    <input autoComplete="street-address" className="min-h-11 rounded-xl border border-wayne-border bg-white px-3.5 py-2 font-normal transition hover:border-wayne-border-strong" defaultValue={value === undefined ? defaultValue : undefined} id={id} name={name} onChange={(event) => onChange?.(event.target.value)} ref={inputRef} required={required} value={value} />
    <p className="text-xs text-wayne-muted">{apiKey ? "Start typing, then choose an address to fill in the city, state, and ZIP." : "Enter the full street address."}</p>
  </div>;
}
