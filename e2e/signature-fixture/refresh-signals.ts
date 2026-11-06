/** Deterministic event transport for exercising the real display/runtime UI. */
export function watchPosRefresh(topic: string, _key: string, changed: () => void, connection?: (ready: boolean) => void) {
  const update = () => changed();
  const status = (event: Event) => { connection?.((event as CustomEvent<boolean>).detail); changed(); };
  window.addEventListener(`fixture:${topic}`, update);
  window.addEventListener("fixture:connection", status);
  connection?.(false);
  return () => { window.removeEventListener(`fixture:${topic}`, update); window.removeEventListener("fixture:connection", status); };
}
