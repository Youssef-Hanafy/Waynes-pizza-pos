import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PosAutoRefresh } from "../../src/app/pos/pos-auto-refresh";
import { beginCriticalWork } from "../../src/lib/pos/update-activity";
import { FulfillmentEditor } from "../../src/app/pos/fulfillment-editor";
import { CustomerScreen } from "../../src/app/pos/display/customer-screen";
import { CustomerSignStep } from "../../src/app/pos/customer-steps";
import type { OpenOrder } from "../../src/lib/orders/status";

function Register() {
  const [revision, setRevision] = useState(0);
  const [finished, setFinished] = useState(0);
  // A background order-list refresh gives the parent a new callback/object.
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("fixture:refresh", refresh);
    return () => window.removeEventListener("fixture:refresh", refresh);
  }, []);
  return <><p>Revision {revision} · Finished {finished}</p><CustomerSignStep
    order={{ id: "00000000-0000-4000-8000-000000000001", order_number: "W1", total_cents: revision ? 1700 : 1200 } as OpenOrder}
    tipCents={revision ? 0 : 500} onFinished={() => setFinished(revision + 1)} /></>;
}
function Fulfillment() {
 const [result, setResult] = useState("No change saved");
 return <><p>{result}</p><FulfillmentEditor orderId="00000000-0000-4000-8000-000000000001" onChanged={value => setResult(`Saved ${value.fulfillment_type} ${value.total_cents}`)} /></>;
}
function Runtime() {
  const [value, setValue] = useState("Original menu");
  useEffect(() => {
    let finish: (() => void) | null = null;
    const busy = () => { finish ??= beginCriticalWork("checkout"); };
    const idle = () => { finish?.(); finish = null; };
    window.addEventListener("fixture:busy", busy); window.addEventListener("fixture:idle", idle);
    return () => { idle(); window.removeEventListener("fixture:busy", busy); window.removeEventListener("fixture:idle", idle); };
  }, []);
  return <><p>{value}</p><PosAutoRefresh isSafe={() => true} onData={data => setValue(data.workspaceName)} /></>;
}
localStorage.setItem("wayne-customer-screen-register", "Front");
createRoot(document.getElementById("root")!).render(location.pathname === "/runtime" ? <Runtime /> : location.pathname === "/fulfillment" ? <Fulfillment /> : location.pathname === "/register" ? <Register /> : <CustomerScreen storeName="Test store" />);
