"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { SiteIcon } from "./site-icon";
import {
  estimateRange,
  residenceLabels,
  residenceNeedsUnit,
  residenceTypes,
  type OrderDetails,
  type ResidenceType,
} from "@/lib/orders/order-details";

/**
 * The question asked before the first click on the menu.
 *
 * Delivery cannot be quoted, routed or driven without an address, and the
 * honest place to ask for it is before someone spends ten minutes building a
 * cart — not at the end, when finding out Wayne's cannot reach them is a wasted
 * evening.  Pickup needs a name and nothing more, so that is all it asks for.
 *
 * Whatever is entered is carried through to checkout, so nobody types their
 * address twice.
 */
export function OrderStartGate({
  deliveryMinutes,
  fulfillment,
  initial,
  onCancel,
  onSave,
  open,
  pickupMinutes,
}: {
  deliveryMinutes: number;
  fulfillment: "pickup" | "delivery";
  initial: OrderDetails | null;
  onCancel: () => void;
  onSave: (details: OrderDetails) => void;
  open: boolean;
  pickupMinutes: number;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [residence, setResidence] = useState<ResidenceType>(initial?.residence_type ?? "house");

  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) element?.showModal();
    if (!open && element?.open) element.close();
  }, [open]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? "").trim();
    onSave({
      fulfillment,
      first_name: value("first_name"),
      last_name: value("last_name"),
      phone: value("phone"),
      residence_type: residence,
      address1: value("address1"),
      address2: value("address2"),
      city: value("city"),
      state: value("state"),
      postal_code: value("postal_code"),
      delivery_instructions: value("delivery_instructions"),
    });
  }

  const minutes = fulfillment === "delivery" ? deliveryMinutes : pickupMinutes;

  return (
    <dialog className="order-gate" onCancel={onCancel} ref={dialog}>
      <form onSubmit={submit}>
        <p className="eyebrow">
          {fulfillment === "delivery" ? "DELIVERY" : "PICKUP"}
        </p>
        <h2>
          {fulfillment === "delivery"
            ? "Where are we bringing it?"
            : "Who’s picking it up?"}
        </h2>
        <p className="order-gate-estimate">
          <SiteIcon name={fulfillment === "delivery" ? "truck" : "bag"} size={18} />
          <strong>
            {fulfillment === "delivery" ? "Delivery time" : "Ready in"}{" "}
            {estimateRange(minutes)}
          </strong>
          <span>
            {fulfillment === "delivery"
              ? "from the time your order goes in."
              : "once the kitchen has it."}
          </span>
        </p>

        <div className="order-gate-names">
          <label>
            First name
            <input
              autoComplete="given-name"
              defaultValue={initial?.first_name ?? ""}
              maxLength={100}
              name="first_name"
              required
            />
          </label>
          <label>
            Last name
            <input
              autoComplete="family-name"
              defaultValue={initial?.last_name ?? ""}
              maxLength={100}
              name="last_name"
            />
          </label>
        </div>
        <label>
          Mobile number
          <input
            autoComplete="tel"
            defaultValue={initial?.phone ?? ""}
            inputMode="tel"
            maxLength={24}
            name="phone"
            placeholder="(508) 000-0000"
            type="tel"
          />
        </label>

        {fulfillment === "delivery" ? (
          <>
            <fieldset className="order-gate-residence">
              <legend>Is this a house or an apartment?</legend>
              <div>
                {residenceTypes.map((type) => (
                  <button
                    className={residence === type ? "is-selected" : ""}
                    key={type}
                    onClick={() => setResidence(type)}
                    type="button"
                  >
                    {residenceLabels[type]}
                  </button>
                ))}
              </div>
            </fieldset>
            <label>
              Street address
              <input
                autoComplete="address-line1"
                defaultValue={initial?.address1 ?? ""}
                maxLength={200}
                name="address1"
                placeholder="123 West Boylston St"
                required
              />
            </label>
            {residenceNeedsUnit[residence] ? (
              <label>
                {residence === "dorm"
                  ? "Building and room"
                  : residence === "business"
                    ? "Suite / floor / company"
                    : "Apartment or unit number"}
                <input
                  autoComplete="address-line2"
                  defaultValue={initial?.address2 ?? ""}
                  maxLength={200}
                  name="address2"
                  required
                />
              </label>
            ) : (
              <input defaultValue={initial?.address2 ?? ""} name="address2" type="hidden" />
            )}
            <div className="order-gate-city">
              <label>
                City
                <input
                  autoComplete="address-level2"
                  defaultValue={initial?.city ?? "Worcester"}
                  maxLength={120}
                  name="city"
                  required
                />
              </label>
              <label>
                State
                <input
                  autoComplete="address-level1"
                  defaultValue={initial?.state ?? "MA"}
                  maxLength={80}
                  name="state"
                  required
                />
              </label>
              <label>
                ZIP
                <input
                  autoComplete="postal-code"
                  defaultValue={initial?.postal_code ?? ""}
                  inputMode="numeric"
                  maxLength={20}
                  name="postal_code"
                  required
                />
              </label>
            </div>
            <label>
              Anything the driver should know? (optional)
              <textarea
                defaultValue={initial?.delivery_instructions ?? ""}
                maxLength={1000}
                name="delivery_instructions"
                placeholder="Buzzer code, side door, dog in the yard…"
                rows={2}
              />
            </label>
          </>
        ) : (
          <>
            <input name="address1" type="hidden" value="" />
            <input name="address2" type="hidden" value="" />
            <input name="city" type="hidden" value="" />
            <input name="state" type="hidden" value="" />
            <input name="postal_code" type="hidden" value="" />
            <input name="delivery_instructions" type="hidden" value="" />
            <p className="order-gate-note">
              Pay when you pick it up — cash or card at the counter.
            </p>
          </>
        )}

        <div className="order-gate-actions">
          <button className="order-button" type="submit">
            Start my order <SiteIcon name="arrow" size={17} />
          </button>
          <button className="order-gate-cancel" onClick={onCancel} type="button">
            {fulfillment === "delivery" ? "Switch to pickup" : "Just browsing"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
