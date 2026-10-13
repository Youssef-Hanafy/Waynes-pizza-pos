import { describe, expect, it } from "vitest";
import { posCallReportSchema } from "./schemas";

describe("recording a ring from the caller ID box", () => {
  it("strips the raw header bytes Postgres can't store (the reason real calls never matched a customer)", () => {
    const parsed = posCallReportSchema.parse({
      event_key: "cid-1-0-0000", line_number: 1, caller_number: "7744645557",
      raw_record: "^^<U>\u0000\u0000\u000112<S>x$01 I S 0000", device_id: "192.168.0.90\u0000", source: "android_native",
    });
    expect(parsed.raw_record).not.toContain("\u0000");
    expect(parsed.device_id).toBe("192.168.0.90");
  });
});
