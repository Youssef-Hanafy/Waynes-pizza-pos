import { describe, expect, it } from "vitest";
import { createPacketInterpreter } from "./bridge";

const ring = (line: string, phase: "S" | "E", number: string) => `^^<U>000001<S>000002$${line} I ${phase} 0000 G A2 12/17 04:54 PM ${number} SMITH JOHN`;

describe("Android caller ID packets (build sheet §17, §52)", () => {
  it("turns a start record into a call, and keeps one id for repeated packets", () => {
    const interpret = createPacketInterpreter();
    const first = interpret(ring("01", "S", "508-555-1234"), "192.168.88.20", Date.parse("2026-09-20T22:42:00Z"));
    expect(first).toMatchObject({ line: 1, phoneNumber: "5085551234", callerName: "SMITH JOHN", deviceId: "1" });
    const repeat = interpret(ring("01", "S", "508-555-1234"), "192.168.88.20", Date.parse("2026-09-20T22:42:01Z"));
    expect(repeat!.id).toBe(first!.id);
  });

  it("gives a call back after hang-up its own id, and never pops an end record", () => {
    const interpret = createPacketInterpreter();
    const first = interpret(ring("02", "S", "5085551234"), "x", 0)!;
    expect(interpret(ring("02", "E", "5085551234"), "x", 1000)).toBeNull();
    const again = interpret(ring("02", "S", "5085551234"), "x", 20_000)!;
    expect(again.id).not.toBe(first.id);
  });

  it("ignores packets that are not caller ID records", () => {
    expect(createPacketInterpreter()("hello", "x", 0)).toBeNull();
  });
});
