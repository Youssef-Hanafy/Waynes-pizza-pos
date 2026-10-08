/**
 * Android 10's WebView has fetch but not AbortSignal.timeout(). The POS uses
 * timeout signals for every network write; without this shim WebView throws
 * before fetch starts and the offline-safe queue mistakes it for no internet.
 * This runs before React hydrates (Next's instrumentation-client convention).
 */
if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout !== "function") {
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value(milliseconds: number) {
      const controller = new AbortController();
      window.setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    },
  });
}
