import { describe, expect, it } from "vitest";
import { isProtectedPath, safeNextPath } from "./routes";

describe("route protection", () => {
  it.each(["/admin", "/admin/staff", "/pos", "/kitchen/tickets", "/driver"])("protects %s", (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  it.each(["/", "/login", "/menu", "/administrator"])("leaves %s outside the authenticated route matcher", (path) => {
    expect(isProtectedPath(path)).toBe(false);
  });

  it("allows only local protected post-login destinations", () => {
    expect(safeNextPath("/admin?day=today")).toBe("/admin?day=today");
    expect(safeNextPath("https://attacker.example")).toBe("/admin");
    expect(safeNextPath("//attacker.example")).toBe("/admin");
    expect(safeNextPath("/menu")).toBe("/admin");
  });
});
