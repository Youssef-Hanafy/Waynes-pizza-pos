import { createRoot } from "react-dom/client";
import { DeliveriesScreen } from "../src/app/pos/deliveries-screen";
createRoot(document.getElementById("root")!).render(<DeliveriesScreen canProcessCards timeZone="America/New_York" />);
