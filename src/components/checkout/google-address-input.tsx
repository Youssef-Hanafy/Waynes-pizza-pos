"use client";

import { memo, useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

export type SuggestedAddress = { address1: string; city: string; state: string; postal_code: string };
type AddressComponent = { longText?: string; shortText?: string; types?: string[] };
type Place = { addressComponents?: AddressComponent[]; formattedAddress?: string; fetchFields: (options: { fields: string[] }) => Promise<void> };
type PlacePrediction = { toPlace: () => Place };
type PlaceAutocompleteElement = HTMLElement & {
  includedRegionCodes?: string[];
  includedPrimaryTypes?: string[];
  addEventListener: (event: "gmp-select", listener: (event: Event & { placePrediction?: PlacePrediction }) => void) => void;
};
type PlacesLibrary = { PlaceAutocompleteElement?: new (options?: { includedRegionCodes?: string[]; includedPrimaryTypes?: string[] }) => PlaceAutocompleteElement };
type GoogleWindow = Window & { google?: { maps?: { importLibrary?: (library: "places") => Promise<PlacesLibrary>; places?: PlacesLibrary } } };

const PlacesWidgetHost = memo(function PlacesWidgetHost({ ariaLabel, hostRef }: { ariaLabel: string; hostRef: (node: HTMLDivElement | null) => void }) {
  // Google owns the child of this host. Memoization prevents routine form re-renders
  // from clearing that child after the library mounts it.
  return <div aria-label={ariaLabel} className="hidden" ref={hostRef} />;
});

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
  const widgetHostRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onAddressSelect);
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  useEffect(() => { selectRef.current = onAddressSelect; }, [onAddressSelect]);
  const setWidgetHost = useCallback((node: HTMLDivElement | null) => { widgetHostRef.current = node; }, []);

  useEffect(() => {
    if (!apiKey || !inputRef.current || !widgetHostRef.current) return;
    let cancelled = false;
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
    const connect = async (attempt = 0) => {
      const maps = (window as GoogleWindow).google?.maps;
      if (!maps?.importLibrary) {
        if (!cancelled && attempt < 20) window.setTimeout(() => { void connect(attempt + 1); }, 100);
        return;
      }
      const library = await maps.importLibrary("places").catch(() => undefined);
      const PlaceAutocomplete = library?.PlaceAutocompleteElement;
      if (!PlaceAutocomplete) {
        if (!cancelled && attempt < 20) window.setTimeout(() => { void connect(attempt + 1); }, 100);
        return;
      }
      if (cancelled || !widgetHostRef.current) return;
      const widgetElement = new PlaceAutocomplete({ includedRegionCodes: ["us"], includedPrimaryTypes: ["street_address"] });
      widgetElement.setAttribute("aria-label", label);
      widgetElement.setAttribute("placeholder", placeholder ?? "Start typing your street address");
      widgetHostRef.current.replaceChildren(widgetElement);
      widgetHostRef.current.classList.remove("hidden");
      inputRef.current?.style.setProperty("display", "none");
      widgetElement.addEventListener("gmp-select", async (event) => {
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
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&v=weekly`;
      script.addEventListener("load", () => { void connect(); }, { once: true });
      document.head.appendChild(script);
    }
    return () => { cancelled = true; };
  }, [apiKey, label, placeholder]);

  const nativeField = <input autoComplete={autoComplete} className={className ?? "min-h-11 rounded-xl border border-wayne-border bg-white px-3.5 py-2 font-normal transition hover:border-wayne-border-strong"} defaultValue={value === undefined ? defaultValue : undefined} id={id} maxLength={maxLength} name={name} onChange={(event) => onChange?.(event.target.value)} placeholder={placeholder} ref={inputRef} required={required} value={value} />;
  const googleWidget = <PlacesWidgetHost ariaLabel={`${label} suggestions`} hostRef={setWidgetHost} />;
  if (bare) return <>{googleWidget}{nativeField}</>;
  return <div className="grid content-start gap-1.5 sm:col-span-2">
    <label className="text-sm font-bold tracking-tight" htmlFor={id}>{label}{required ? <span aria-hidden className="ml-1 text-wayne-red">*</span> : null}</label>
    {googleWidget}{nativeField}
    <p className="text-xs text-wayne-muted">{apiKey ? "Start typing, then choose an address to fill in the city, state, and ZIP." : "Enter the full street address."}</p>
  </div>;
}

/*
 * POS address box with Google suggestions (owner, 2026-10-19: "when you type in
 * the address it would automatically start showing the address or similar
 * ones ... its not doing that any more").
 *
 * Why not Google's own box here: Google's <gmp-place-autocomplete> now keeps
 * its text field in a closed shadow root, so Wayne's on-screen keyboard
 * (pos-keyboard.tsx) can't see or type into it and no suggestions ever appear
 * on the counter tablet.  This is an ordinary text box — Wayne's keyboard, the
 * tablet's keyboard and a real keyboard all work — that asks Google Places
 * (New) for the same street-address matches as you type and lists them right
 * under the box.  Tap one to fill the street, city, state and ZIP, exactly as
 * picking from Google's box did.  The website's checkout box is unchanged.
 */
type Suggestion = { placePrediction?: { text?: { text?: string }; mainText?: { text?: string }; secondaryText?: { text?: string }; toPlace: () => Place } | null };
type SuggestLibrary = {
  AutocompleteSuggestion?: { fetchAutocompleteSuggestions: (request: { input: string; includedRegionCodes?: string[]; includedPrimaryTypes?: string[]; sessionToken?: unknown }) => Promise<{ suggestions?: Suggestion[] }> };
  AutocompleteSessionToken?: new () => unknown;
};
type SuggestItem = { key: string; main: string; secondary: string; toPlace: () => Place };

let suggestLibrary: Promise<SuggestLibrary | undefined> | null = null;

/** Loads Google's Places library once (same script tag as the website box). */
function loadSuggestLibrary(apiKey: string): Promise<SuggestLibrary | undefined> {
  if (suggestLibrary) return suggestLibrary;
  const ready = new Promise<void>((resolve) => {
    const waitForMaps = (attempt = 0) => {
      if ((window as GoogleWindow).google?.maps?.importLibrary || attempt > 100) resolve();
      else window.setTimeout(() => waitForMaps(attempt + 1), 100);
    };
    if ((window as GoogleWindow).google?.maps?.importLibrary || document.getElementById("wayne-google-places")) { waitForMaps(); return; }
    const script = document.createElement("script");
    script.id = "wayne-google-places";
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&v=weekly`;
    script.addEventListener("load", () => waitForMaps(), { once: true });
    script.addEventListener("error", () => resolve(), { once: true });
    document.head.appendChild(script);
  });
  const loading = ready.then(async () => {
    const maps = (window as GoogleWindow).google?.maps;
    if (!maps?.importLibrary) return undefined;
    return (await maps.importLibrary("places").catch(() => undefined)) as unknown as SuggestLibrary | undefined;
  });
  suggestLibrary = loading;
  // A failed load (offline for a moment) is retried on the next keystroke.
  void loading.then((library) => { if (!library?.AutocompleteSuggestion && suggestLibrary === loading) suggestLibrary = null; });
  return loading;
}

function addressFromPlace(place: Place): SuggestedAddress {
  const components = place.addressComponents ?? [];
  const part = (type: string, long = false) => components.find((component) => component.types?.includes(type))?.[long ? "longText" : "shortText"] ?? "";
  return {
    address1: [part("street_number"), part("route", true)].filter(Boolean).join(" ") || place.formattedAddress || "",
    city: part("locality", true) || part("postal_town", true) || part("sublocality", true),
    state: part("administrative_area_level_1"), postal_code: part("postal_code"),
  };
}

/** What picking a suggestion fills: always the street; city, state and ZIP when Google has them. */
export type PickedAddress = Partial<SuggestedAddress> & { address1: string };

type PosAddressProps = {
  id: string; name: string; label?: string; value: string; required?: boolean; placeholder?: string;
  onChange?: (value: string) => void;
  onAddressSelect?: (address: PickedAddress) => void;
};

export function PosAddressInput({ id, name, label = "Street address", value, required = true, placeholder, onChange, onAddressSelect }: PosAddressProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [items, setItems] = useState<SuggestItem[]>([]);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const typedRef = useRef(false); // only search after someone types (not for an address already filled in)
  const requestRef = useRef(0);
  const sessionRef = useRef<unknown>(null);
  const selectRef = useRef(onAddressSelect);
  useEffect(() => { selectRef.current = onAddressSelect; }, [onAddressSelect]);

  // Ask Google as the street is typed (short pause so every key isn't a request).
  useEffect(() => {
    if (!apiKey || !typedRef.current) return;
    const text = value.trim();
    const request = ++requestRef.current;
    const timer = window.setTimeout(async () => {
      if (text.length < 3) { setItems([]); setActive(-1); return; }
      const library = await loadSuggestLibrary(apiKey);
      const Suggest = library?.AutocompleteSuggestion;
      if (!Suggest || request !== requestRef.current) return;
      if (!sessionRef.current && library?.AutocompleteSessionToken) sessionRef.current = new library.AutocompleteSessionToken();
      try {
        // House-number addresses: Google files some as "premise" (a building) rather than "street_address".
        const result = await Suggest.fetchAutocompleteSuggestions({ input: text, includedRegionCodes: ["us"], includedPrimaryTypes: ["street_address", "premise", "subpremise"], sessionToken: sessionRef.current ?? undefined });
        if (request !== requestRef.current) return;
        const next: SuggestItem[] = [];
        for (const [index, suggestion] of (result.suggestions ?? []).entries()) {
          const prediction = suggestion.placePrediction;
          if (!prediction) continue;
          const main = prediction.mainText?.text ?? prediction.text?.text ?? "";
          if (!main) continue;
          next.push({ key: `${index}-${prediction.text?.text ?? main}`, main, secondary: prediction.secondaryText?.text ?? "", toPlace: () => prediction.toPlace() });
        }
        setItems(next);
        setActive(-1);
      } catch {
        if (request === requestRef.current) setItems([]);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [apiKey, value]);

  // The list is never left hidden under Wayne's keyboard or the bottom of the card: show all of it.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (items.length) listRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [items.length]);

  // A tap anywhere else closes the list (taps on Wayne's on-screen keyboard don't).
  useEffect(() => {
    if (!items.length) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || wrapRef.current?.contains(target) || target.closest('[aria-label="Keyboard"]')) return;
      requestRef.current++;
      setItems([]);
      setActive(-1);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [items.length]);

  const pick = async (index: number) => {
    const item = items[index];
    if (!item) return;
    typedRef.current = false;
    requestRef.current++;
    setItems([]);
    setActive(-1);
    let found: SuggestedAddress = { address1: "", city: "", state: "", postal_code: "" };
    try {
      const place = item.toPlace();
      await place.fetchFields({ fields: ["addressComponents", "formattedAddress"] });
      found = addressFromPlace(place);
    } catch {
      // Google didn't answer: the street that was tapped still goes in; the rest stays as typed.
    }
    sessionRef.current = null; // Google's search session ends once an address is picked
    // Only the parts Google gave: a blank one never wipes what's already in City / State / ZIP.
    const address: PickedAddress = { address1: found.address1 || item.main };
    if (found.city) address.city = found.city;
    if (found.state) address.state = found.state;
    if (found.postal_code) address.postal_code = found.postal_code;
    if (selectRef.current) selectRef.current(address);
    else onChange?.(address.address1);
  };

  // Tapping a suggestion never takes the focus (or Wayne's keyboard) away from the box first.
  const hold = (event: ReactPointerEvent | ReactMouseEvent) => event.preventDefault();

  return <div className="grid content-start gap-1.5 sm:col-span-2" ref={wrapRef}>
    <label className="text-sm font-bold tracking-tight" htmlFor={id}>{label}{required ? <span aria-hidden className="ml-1 text-wayne-red">*</span> : null}</label>
    <div className="relative min-w-0">
    <input aria-activedescendant={active >= 0 ? `${id}-option-${active}` : undefined} aria-autocomplete="list" aria-controls={`${id}-suggestions`} aria-expanded={items.length > 0} autoComplete="off" className="min-h-11 w-full rounded-xl border border-wayne-border bg-white px-3.5 py-2 font-normal transition hover:border-wayne-border-strong" id={id} name={name} onChange={(event) => { typedRef.current = true; onChange?.(event.target.value); }}
      onKeyDown={(event) => {
        if (!items.length) return;
        if (event.key === "ArrowDown") { event.preventDefault(); setActive((current) => (current + 1) % items.length); }
        else if (event.key === "ArrowUp") { event.preventDefault(); setActive((current) => (current <= 0 ? items.length - 1 : current - 1)); }
        // Enter (also Wayne's on-screen Enter) takes the highlighted match, or the top one.
        else if (event.key === "Enter") { event.preventDefault(); void pick(active >= 0 ? active : 0); }
        else if (event.key === "Escape") { requestRef.current++; setItems([]); setActive(-1); }
      }}
      placeholder={placeholder ?? (apiKey ? "Start typing, then pick the address" : "Street address")} required={required} role="combobox" spellCheck={false} value={value} />
    {/* Floats over the boxes below it, so nothing on the screen moves while typing. */}
    {items.length ? <div className="absolute inset-x-0 top-full z-40 mt-1 grid max-h-[min(20rem,50vh)] overflow-y-auto overscroll-contain rounded-xl border border-wayne-border-strong bg-white shadow-xl" id={`${id}-suggestions`} ref={listRef} role="listbox">
      {items.map((item, index) => <button aria-selected={index === active} className={`block min-h-12 w-full px-3.5 py-2 text-left ${index === active ? "bg-wayne-cream" : "bg-white hover:bg-wayne-cream"}`} id={`${id}-option-${index}`} key={item.key} onClick={() => { void pick(index); }} onMouseDown={hold} onPointerDown={hold} role="option" type="button">
        <span className="block font-bold">{item.main}</span>
        {item.secondary ? <span className="block text-sm text-wayne-muted">{item.secondary}</span> : null}
      </button>)}
      <span className="block px-3.5 py-1 text-right text-xs text-wayne-muted">Powered by Google</span>
    </div> : null}
    </div>
  </div>;
}
