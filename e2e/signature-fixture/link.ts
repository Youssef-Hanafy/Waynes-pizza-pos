export function stopCustomerDisplayLink() {}
export function useCustomerScreen() { return { showing: true, screenOnline: true }; }
export function thankCustomer() { window.dispatchEvent(new Event("fixture:thanks")); }
export function reclaimCustomerScreen() {}
export function showOnCustomerScreen() {}
export function askCustomer() {
  window.dispatchEvent(new Event("fixture:ask"));
  let resolve!: (answer: Record<string, unknown> | null) => void;
  const answer = new Promise<Record<string, unknown> | null>(done => { resolve = done; });
  const receive = ((event: CustomEvent) => resolve(event.detail)) as EventListener;
  window.addEventListener("fixture:answer", receive, { once: true });
  return { answer, cancel() { window.removeEventListener("fixture:answer", receive); resolve(null); } };
}
