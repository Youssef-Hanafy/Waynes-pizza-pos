"use client";

import { useEffect, useRef } from "react";

type PlaceComponent = { short_name?: string; types?: string[] };
type GoogleAutocomplete = {
  addListener: (event: "place_changed", callback: () => void) => void;
  getPlace: () => { address_components?: PlaceComponent[]; formatted_address?: string };
};
type GoogleWindow = Window & {
  google?: { maps?: { places?: { Autocomplete: new (input: HTMLInputElement, options: { componentRestrictions: { country: string }; fields: string[] }) => GoogleAutocomplete } } };
};

export function GoogleAddressInput() {
  const inputRef = useRef<HTMLInputElement>(null);
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  useEffect(() => {
    if (!apiKey || !inputRef.current) return;
    const connect = () => {
      const Autocomplete = (window as GoogleWindow).google?.maps?.places?.Autocomplete;
      if (!Autocomplete || !inputRef.current) return;
      const autocomplete = new Autocomplete(inputRef.current, { componentRestrictions: { country: "us" }, fields: ["address_components", "formatted_address"] });
      autocomplete.addListener("place_changed", () => {
        const place = autocomplete.getPlace();
        const components = place.address_components ?? [];
        const valueFor = (type: string) => components.find((part) => part.types?.includes(type))?.short_name ?? "";
        const set = (name: string, value: string) => {
          const field = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
          if (field && value) field.value = value;
        };
        set("address1", [valueFor("street_number"), valueFor("route")].filter(Boolean).join(" ") || place.formatted_address || "");
        set("city", valueFor("locality") || valueFor("postal_town"));
        set("state", valueFor("administrative_area_level_1"));
        set("postal_code", valueFor("postal_code"));
      });
    };
    if ((window as GoogleWindow).google?.maps?.places) { connect(); return; }
    const existing = document.getElementById("wayne-google-places") as HTMLScriptElement | null;
    if (existing) { existing.addEventListener("load", connect, { once: true }); return () => existing.removeEventListener("load", connect); }
    const script = document.createElement("script");
    script.id = "wayne-google-places";
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places`;
    script.addEventListener("load", connect, { once: true });
    document.head.appendChild(script);
  }, [apiKey]);

  return <div className="grid content-start gap-1.5 sm:col-span-2"><label className="text-sm font-bold tracking-tight" htmlFor="address1">{apiKey ? "Find your delivery address" : "Street address"}<span aria-hidden className="ml-1 text-wayne-red">*</span></label><input ref={inputRef} className="min-h-11 rounded-xl border border-wayne-border bg-white px-3.5 py-2 font-normal transition hover:border-wayne-border-strong" id="address1" name="address1" required /><p className="text-xs text-wayne-muted">{apiKey ? "Choose a suggestion from Google Maps for accurate delivery." : "Google address suggestions appear after NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is configured."}</p></div>;
}
