import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
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
    order={{ id: "00000000-0000-4000-8000-000000000001", order_number: "W1", total_cents: 1200 } as OpenOrder}
    tipCents={0} onFinished={() => setFinished(revision + 1)} /></>;
}
localStorage.setItem("wayne-customer-screen-register", "Front");
createRoot(document.getElementById("root")!).render(location.pathname === "/register" ? <Register /> : <CustomerScreen storeName="Test store" />);
