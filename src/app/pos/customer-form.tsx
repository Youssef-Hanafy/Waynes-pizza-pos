"use client";

import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { blankAddress } from "@/lib/orders/drafts";
import { formatPhone } from "@/lib/phone/normalize";
import { posCustomerSchema, type PosCustomer } from "@/lib/pos/schemas";

/**
 * Create or edit a customer from the POS (§14).  Used by the phone screen's
 * "Create customer + start order" and by the Customers section.  Nothing is
 * saved until a person presses the button (§33).
 */
export function CustomerForm({ customer, initialPhone = "", submitLabel, onSaved, onCancel }: {
  customer?: PosCustomer | null;
  initialPhone?: string;
  submitLabel: string;
  onSaved: (customer: PosCustomer) => void;
  onCancel?: () => void;
}) {
  const [firstName, setFirstName] = useState(customer?.first_name ?? "");
  const [lastName, setLastName] = useState(customer?.last_name ?? "");
  const [phone, setPhone] = useState(customer ? formatPhone(customer.phone) : formatPhone(initialPhone, ""));
  const [email, setEmail] = useState(customer?.email ?? "");
  const [extraPhone, setExtraPhone] = useState("");
  const [address, setAddress] = useState(blankAddress);
  const [showAddress, setShowAddress] = useState(!customer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/pos/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_id: customer?.id ?? "", first_name: firstName, last_name: lastName, phone, email,
          extra_phone: extraPhone, address: address.address1.trim() ? address : undefined,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      const body: unknown = await response.json().catch(() => null);
      const parsed = posCustomerSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw new Error(body && typeof body === "object" && "error" in body ? String(body.error) : "The customer could not be saved.");
      onSaved(parsed.data);
    } catch (saveError) {
      setError(saveError instanceof TypeError ? "No connection. The customer was not saved." : saveError instanceof Error ? saveError.message : "The customer could not be saved.");
    } finally { setBusy(false); }
  }

  return <form className="grid gap-3" onSubmit={save}>
    <div className="grid gap-3 sm:grid-cols-2">
      <Input autoFocus id="cf-first" label="First name" onChange={(e) => setFirstName(e.target.value)} required value={firstName} />
      <Input id="cf-last" label="Last name" onChange={(e) => setLastName(e.target.value)} required value={lastName} />
      <Input inputMode="tel" id="cf-phone" label="Phone" onChange={(e) => setPhone(e.target.value)} required type="tel" value={phone} />
      <Input id="cf-email" label="Email (optional)" onChange={(e) => setEmail(e.target.value)} type="email" value={email} />
      <Input hint="A second number they call from, such as a work or home line." inputMode="tel" id="cf-extra" label="Another number (optional)" onChange={(e) => setExtraPhone(e.target.value)} type="tel" value={extraPhone} />
    </div>
    {showAddress ? <fieldset className="grid gap-3 rounded-xl border border-wayne-border p-3">
      <legend className="px-1 text-sm font-black">{customer ? "Add an address" : "Address (optional)"}</legend>
      <Input id="cf-address1" label="Street address" onChange={(e) => setAddress({ ...address, address1: e.target.value })} value={address.address1} />
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_6rem_7rem]">
        <Input id="cf-address2" label="Unit" onChange={(e) => setAddress({ ...address, address2: e.target.value })} value={address.address2} />
        <Input id="cf-city" label="City" onChange={(e) => setAddress({ ...address, city: e.target.value })} value={address.city} />
        <Input id="cf-state" label="State" onChange={(e) => setAddress({ ...address, state: e.target.value })} value={address.state} />
        <Input id="cf-zip" label="ZIP" onChange={(e) => setAddress({ ...address, postal_code: e.target.value })} value={address.postal_code} />
      </div>
      <Input id="cf-instructions" label="Delivery instructions" onChange={(e) => setAddress({ ...address, delivery_instructions: e.target.value })} value={address.delivery_instructions} />
    </fieldset> : <Button onClick={() => setShowAddress(true)} size="sm" type="button" variant="ghost">+ Add an address</Button>}
    {error ? <p aria-live="polite" className="rounded-xl bg-wayne-alert-soft p-3 text-sm font-bold text-wayne-alert">{error}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy} size="lg" type="submit">{busy ? "Saving…" : submitLabel}</Button>
      {onCancel ? <Button onClick={onCancel} size="lg" type="button" variant="secondary">Cancel</Button> : null}
    </div>
  </form>;
}
