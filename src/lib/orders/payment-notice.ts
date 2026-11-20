import { formatCents } from "@/lib/menu/schemas";
import type { PublicOrderStatus } from "./schemas";

/** Describe the saved payment outcome, never the checkout's original test-mode copy. */
export function orderPaymentNotice(order: Pick<PublicOrderStatus, "payment_status" | "payment_method" | "total_cents">) {
  const card = order.payment_method === "card";
  switch (order.payment_status) {
    case "paid":
      return { confirmed: true, title: "Payment received", description: `${card ? "Your card payment" : "Your payment"} of ${formatCents(order.total_cents)} was received.` };
    case "refunded":
      return { confirmed: false, title: "Payment refunded", description: "Your payment has been refunded. Contact the store if you need help." };
    case "partially_refunded":
      return { confirmed: false, title: "Payment partially refunded", description: "Part of your payment has been refunded. Contact the store for details." };
    case "authorized":
      return { confirmed: false, title: "Card authorized", description: "Your card has been authorized. The payment has not yet been captured." };
    case "failed":
      return { confirmed: false, title: "Payment unsuccessful", description: "Your payment did not complete. Contact the store before trying again." };
    default:
      if (card) return { confirmed: false, title: "Payment confirmation pending", description: "We are checking your card payment. Contact the store before paying again." };
      if (order.payment_method === "test_manual") return { confirmed: false, title: "TEST / MANUAL payment", description: "This order was placed without an online card payment." };
      return { confirmed: false, title: "Payment due", description: "This order has not been paid. Please arrange payment with the store." };
  }
}
