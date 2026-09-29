import { describe, expect, it } from "vitest";
import { parseWhozzCallingRecord } from "./schemas";

/**
 * The examples below are copied verbatim from CallerID.com's Ethernet Link
 * manual (EL_Manual.pdf), the official source the build sheet requires (§19).
 */
describe("CallerID.com Ethernet Link records", () => {
  it("reads the manual's end-of-call example", () => {
    expect(parseWhozzCallingRecord("^^<U>000001<S>000002$01 I E 0000 G A2 12/17 04:54 PM 770-263-7111 CALLERID.COM___")).toEqual({
      line_number: 1, direction: "inbound", event: "end", caller_number: "7702637111", caller_name: "CALLERID.COM", unit_number: "1",
    });
  });

  it("reads the manual's start-of-call example on line 3", () => {
    expect(parseWhozzCallingRecord("^^<U>000123<S>004567$03 I S 0000 G A0 03/26 02:47 PM 555-867-5309 JOHN DOE")).toMatchObject({
      line_number: 3, event: "start", caller_number: "5558675309", caller_name: "JOHN DOE", unit_number: "123",
    });
  });

  it("reads after the 21st character even when the serial field holds a '$' (manual's warning)", () => {
    const header = "^^<U>\u0001\u0002$\u0004\u0005\u0006<S>\u0007$\u0009\u000a\u000b\u000c$";
    expect(header.length).toBe(21);
    expect(parseWhozzCallingRecord(`${header}02 I S 0000 G A2 12/17 04:54 PM 5085551212 SMITH JOHN`)).toMatchObject({
      line_number: 2, caller_number: "5085551212", caller_name: "SMITH JOHN", unit_number: "",
    });
  });

  it("ignores detail records rather than popping a card", () => {
    expect(parseWhozzCallingRecord("^^<U>000001<S>000002$01 R 12/17 04:54:10 PM")).toBeNull();
    expect(parseWhozzCallingRecord("$01 F 12/17 04:54:12 PM")).toBeNull();
  });
});
