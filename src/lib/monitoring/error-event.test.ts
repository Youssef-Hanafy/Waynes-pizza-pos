import { describe, expect, it } from "vitest";
import { buildErrorEvent, scrub } from "./error-event";

describe("server error capture", () => {
  it("drops query strings and redacts credentials before storing an error", () => {
    const error = Object.assign(new Error("Failed with token=abc123 for eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature"), { digest: "123" });
    const event = buildErrorEvent(error, { path: "/order/1?phone=5085550100", method: "GET" }, { routePath: "/order/[id]", routeType: "render" });
    expect(event.request_path).toBe("/order/1");
    expect(event.digest).toBe("123");
    expect(event.message).not.toContain("abc123");
    expect(event.message).not.toContain("eyJhbGci");
    expect(event.route_type).toBe("render");
  });

  it("handles non-Error throws and bounds field length", () => {
    const event = buildErrorEvent("x".repeat(5000), { path: "/api/orders", method: "POST" }, { routePath: "/api/orders", routeType: "route" });
    expect(event.message).toHaveLength(2000);
    expect(event.stack).toBeNull();
    expect(scrub("password=hunter2&ok=1", 100)).toBe("[redacted]&ok=1");
  });
});
