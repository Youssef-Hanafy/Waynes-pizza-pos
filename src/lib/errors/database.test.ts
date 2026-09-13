import { describe, expect, it } from "vitest";
import { spokenDatabaseMessage } from "./database";

const fallback = "Try again.";

describe("spoken database messages", () => {
  it("repeats the messages our own functions raise", () => {
    for (const code of ["22023", "40001", "42501", "P0001", "P0002"]) {
      expect(spokenDatabaseMessage({ code, message: "Count the drawer before closing it" }, fallback))
        .toBe("Count the drawer before closing it");
    }
  });

  it("hides internal errors that happen to quote our own names", () => {
    const internal = [
      { code: "42P01", message: 'relation "public.register_shifts" does not exist' },
      { code: "42P01", message: 'relation "public.refunds" does not exist' },
      { code: "42703", message: 'column "driver_cash_cents" does not exist' },
      { code: "23514", message: 'violates check constraint "cash_movements_amount_check"' },
      { code: "23502", message: 'null value in column "reason" violates not-null constraint' },
      { code: "22P02", message: "invalid input syntax for type uuid" },
      { code: "XX000", message: "relation secret_table does not exist" },
    ];
    for (const error of internal) expect(spokenDatabaseMessage(error, fallback)).toBe(fallback);
  });

  it("hides an error with no code at all", () => {
    expect(spokenDatabaseMessage({ message: "fetch failed" }, fallback)).toBe(fallback);
    expect(spokenDatabaseMessage({ code: "", message: "Drawer not found" }, fallback)).toBe(fallback);
  });
});
