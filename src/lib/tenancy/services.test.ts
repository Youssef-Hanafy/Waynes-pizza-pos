import { describe, expect, it } from "vitest";
import { isPathEnabled, missingServiceForPath, servicesForPath } from "./services";

describe("service route map", () => {
  it("uses the longest matching prefix and leaves core routes ungated", () => {
    expect(servicesForPath("/pos")).toEqual(["pos"]);
    expect(servicesForPath("/admin/orders/123?x=1")).toEqual(["pos", "online_ordering", "delivery", "analytics"]);
    expect(servicesForPath("/admin")).toBeNull();
    expect(servicesForPath("/admin/audit")).toBeNull();
    expect(servicesForPath("/administrator")).toBeNull();
  });

  it("enables a route when any one of its services is on", () => {
    expect(isPathEnabled("/admin/menu", ["online_ordering"])).toBe(true);
    expect(isPathEnabled("/admin/menu", ["crm"])).toBe(false);
    expect(isPathEnabled("/admin", [])).toBe(true);
  });

  it("names the service a blocked route needs", () => {
    expect(missingServiceForPath("/driver", ["pos"])).toBe("delivery");
    expect(missingServiceForPath("/driver", ["delivery"])).toBeNull();
  });
});
