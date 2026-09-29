import { describe, expect, it } from "vitest";
import { cleanHostname } from "./domains";

describe("web address input", () => {
  it("accepts what people paste and keeps only the host", () => {
    expect(cleanHostname("https://Orders.JoesDeli.com/menu?x=1")).toBe("orders.joesdeli.com");
    expect(cleanHostname("joesdeli.com:443")).toBe("joesdeli.com");
    expect(cleanHostname("www.waynespizzaofworcester.com.")).toBe("www.waynespizzaofworcester.com");
  });
  it("refuses things that are not a web address", () => {
    expect(cleanHostname("localhost")).toBeNull();
    expect(cleanHostname("joes deli")).toBeNull();
    expect(cleanHostname("-bad-.com")).toBeNull();
  });
});
