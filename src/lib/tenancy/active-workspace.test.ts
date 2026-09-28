import { describe, expect, it } from "vitest";
import { parseWorkspaceSlug, workspaceSlugFromPath, workspaceStorageKey } from "./active-workspace";

describe("active workspace selection", () => {
  it("accepts only well-formed slugs", () => {
    expect(parseWorkspaceSlug("waynes-pizza")).toBe("waynes-pizza");
    expect(parseWorkspaceSlug(" Waynes-Pizza ")).toBe("waynes-pizza");
    expect(parseWorkspaceSlug("../etc")).toBeNull();
    expect(parseWorkspaceSlug("a--b")).toBeNull();
    expect(parseWorkspaceSlug("")).toBeNull();
    expect(parseWorkspaceSlug(null)).toBeNull();
  });

  it("reads the workspace from a shell path only", () => {
    expect(workspaceSlugFromPath("/w/waynes-pizza")).toBe("waynes-pizza");
    expect(workspaceSlugFromPath("/w/waynes-pizza/overview")).toBe("waynes-pizza");
    expect(workspaceSlugFromPath("/w")).toBeNull();
    expect(workspaceSlugFromPath("/admin/w/x")).toBeNull();
  });

  it("scopes browser storage keys by workspace", () => {
    expect(workspaceStorageKey("40000000-0000-4000-8000-000000000001", "pos-drafts.v1")).toBe("hanafy:40000000-0000-4000-8000-000000000001:pos-drafts.v1");
    expect(workspaceStorageKey(null, "pos-drafts.v1")).toBe("hanafy:unscoped:pos-drafts.v1");
  });
});
