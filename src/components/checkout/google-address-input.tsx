"use client";

import { useEffect, useRef } from "react";

export type SuggestedAddress = { address1: string; city: string; state: string; postal_code: string };
type AddressComponent = { longText?: string; shortText?: string; types?: string[] };
type Place = { addressComponents?: AddressComponent[]; formattedAddress?: string; fetchFields: (options: { fields: string[] }) => Promise<void> };
type PlacePrediction = { toPlace: () => Place };
type PlaceAutocompleteElement = HTMLElement & { addEventListener: (event: "gmp-select", listener: (event: Event & { placePrediction?: PlacePrediction }) => void) => void };
type PlacesLibrary = { PlaceAutocompleteElement?: new (options?: { includedRegionCodes?: string[]; includedPrimaryTypes?: string[] }) => PlaceAutocompleteElement };
type GoogleWindow = Window & { google?: { maps?: { importLibrary?: (library: "places") => Promise<PlacesLibrary>; places?: PlacesLibrary } } };

type Props = {
  id?: string; name?: string; label?: string; defaultValue?: string; value?: string; required?: boolean;
  onChange?: (value: string) => void;
  onAddressSelect?: (address: SuggestedAddress) => void;
  bare?: boolean;
  className?: string;
  placeholder?: string;
  maxLength?: number;
  autoComplete?: string;
};

/** Google Places API (New), with a native-input fallback for ordinary forms. */
export function GoogleAddressInput({ id = "address1", name = "address1", label = "Find your delivery address", defaultValue = "", value, required = true, onChange, onAddressSelect, bare = false, className, placeholder, maxLength, autoComplete = "street-address" }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const widgetRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onAddressSelect);
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  useEffect(() => { selectRef.current = onAddressSelect; }, [onAddressSelect]);

  useEffect(() => {
    if (!apiKey || !inputRef.current || !widgetRef.current) return;
    let cancelled = false;
    let widget: PlaceAutocompleteElement | null = null;
    const setNativeValue = (next: string) => {
      const field = inputRef.current;
      if (!field) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(field, next);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const applyAddress = (address: SuggestedAddress) => {
      setNativeValue(address.address1);
      if (selectRef.current) { selectRef.current(address); return; }
      for (const [fieldName, fieldValue] of Object.entries(address)) {
        const field = document.querySelector<HTMLInputElement>(`input[name="${fieldName}"]`);
        if (!field || !fieldValue) continue;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(field, fieldValue);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
    const connect = async () => {
      const maps = (window as GoogleWindow).google?.maps;
      if (!maps?.importLibrary) return;
      const library = await maps.importLibrary("places").catch(() => undefined);
      const PlaceAutocomplete = library?.PlaceAutocompleteElement ?? maps?.places?.PlaceAutocompleteElement;
      if (cancelled || !PlaceAutocomplete || !widgetRef.current) return;
      widget = new PlaceAutocomplete({ includedRegionCodes: ["us"], includedPrimaryTypes: ["street_address"] });
      widget.setAttribute("aria-label", label);
      widget.setAttribute("placeholder", placeholder ?? "Start typing your street address");
      widgetRef.current.replaceChildren(widget);
      // Do this directly instead of setting React state: a re-render would remove
      // the Google-owned custom element we just attached.
      widgetRef.current.classList.remove("hidden");
      inputRef.current?.style.setProperty("display", "none");
      widget.addEventListener("gmp-select", async (event) => {
        const place = event.placePrediction?.toPlace();
        if (!place) return;
        await place.fetchFields({ fields: ["addressComponents", "formattedAddress"] });
        const components = place.addressComponents ?? [];
        const part = (type: string, long = false) => components.find((component) => component.types?.includes(type))?.[long ? "longText" : "shortText"] ?? "";
        applyAddress({
          address1: [part("street_number"), part("route", true)].filter(Boolean).join(" ") || place.formattedAddress || "",
          city: part("locality", true) || part("postal_town", true) || part("sublocality", true),
          state: part("administrative_area_level_1"), postal_code: part("postal_code"),
        });
      });
    };
    const existing = document.getElementById("wayne-google-places") as HTMLScriptElement | null;
    if ((window as GoogleWindow).google?.maps) void connect();
    else if (existing) existing.addEventListener("load", () => { void connect(); }, { once: true });
    else {
      const script = document.createElement("script");
      script.id = "wayne-google-places";
      script.async = true;
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async`;
      script.addEventListener("load", () => { void connect(); }, { once: true });
      document.head.appendChild(script);
    }
    return () => { cancelled = true; widget?.remove(); };
  }, [apiKey, label, placeholder]);

  const nativeField = <input autoComplete={autoComplete} className={className ?? "min-h-11 rounded-xl border border-wayne-border bg-white px-3.5 py-2 font-normal transition hover:border-wayne-border-strong"} defaultValue={value === undefined ? defaultValue : undefined} id={id} maxLength={maxLength} name={name} onChange={(event) => onChange?.(event.target.value)} placeholder={placeholder} ref={inputRef} required={required} value={value} />;
  const googleWidget = <div aria-label={`${label} suggestions`} className="hidden" ref={widgetRef} />;
  if (bare) return <>{googleWidget}{nativeField}</>;
  return <div className="grid content-start gap-1.5 sm:col-span-2">
    <label className="text-sm font-bold tracking-tight" htmlFor={id}>{label}{required ? <span aria-hidden className="ml-1 text-wayne-red">*</span> : null}</label>
    {googleWidget}{nativeField}
    <p className="text-xs text-wayne-muted">{apiKey ? "Start typing, then choose an address to fill in the city, state, and ZIP." : "Enter the full street address."}</p>
  </div>;
}
