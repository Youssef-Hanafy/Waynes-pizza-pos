/**
 * "Add to Home screen" on the customer-facing tablet opens the customer screen
 * full screen — no address bar, no tabs (owner, 2026-10-11).
 */
export function GET() {
  return Response.json({
    name: "Customer screen",
    short_name: "Customer screen",
    start_url: "/pos/display",
    scope: "/pos/display",
    display: "fullscreen",
    display_override: ["fullscreen", "standalone"],
    orientation: "landscape",
    background_color: "#f8f1e4",
    theme_color: "#14532d",
    icons: [],
  }, { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" } });
}
