import { describe, expect, it } from "vitest";
import { isSoftwarePath, normalizeHost, routeByHost, softwareHost } from "./hosts";

const app = "app.hanafymedia.com";
const route = (host: string, pathname: string, search = "", target: string | null = app) => routeByHost({ host, pathname, search, softwareHost: target });

describe("software vs storefront addresses", () => {
  it("reads the software address from the environment", () => {
    expect(softwareHost({ NEXT_PUBLIC_SOFTWARE_HOST: " App.HanafyMedia.com:443 " })).toBe(app);
    expect(softwareHost({})).toBeNull();
    expect(normalizeHost("waynespizzaofworcester.com., proxy")).toBe("waynespizzaofworcester.com");
  });

  it("knows which pages are the software", () => {
    for (const path of ["/platform", "/platform/billing", "/w/waynes-pizza", "/admin/menu", "/pos", "/kitchen", "/driver", "/login", "/auth/callback"]) expect(isSoftwarePath(path)).toBe(true);
    for (const path of ["/", "/menu", "/rewards", "/offers", "/r/abc", "/checkout", "/order/1", "/about", "/wings", "/posters"]) expect(isSoftwarePath(path)).toBe(false);
  });

  it("sends software pages on a store's address to app.hanafymedia.com", () => {
    expect(route("waynespizzaofworcester.com", "/admin/orders", "?status=open")).toEqual({ action: "redirect", location: "https://app.hanafymedia.com/admin/orders?status=open" });
    expect(route("waynes-pizza-pos.vercel.app", "/pos")).toEqual({ action: "redirect", location: "https://app.hanafymedia.com/pos" });
    expect(route("waynespizzaofworcester.com", "/rewards")).toEqual({ action: "continue" });
  });

  it("keeps the customer website off the software address", () => {
    expect(route(app, "/platform")).toEqual({ action: "continue" });
    expect(route(app, "/")).toEqual({ action: "redirect", location: "https://app.hanafymedia.com/w" });
    expect(route(app, "/menu")).toEqual({ action: "not_found" });
  });

  it("never touches APIs, local development, or a deployment without the setting", () => {
    expect(route("waynespizzaofworcester.com", "/api/phone/calls")).toEqual({ action: "continue" });
    expect(route(app, "/api/rewards")).toEqual({ action: "continue" });
    expect(route("localhost:3000", "/admin")).toEqual({ action: "continue" });
    expect(route("waynespizzaofworcester.com", "/admin", "", null)).toEqual({ action: "continue" });
  });
});
