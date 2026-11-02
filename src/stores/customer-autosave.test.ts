import { describe, expect, it } from "vitest";
import { mergePending } from "./customer-autosave";

const address = { address1: "12 Elm St", address2: "", city: "Worcester", state: "MA", postal_code: "01605", delivery_instructions: "" };

describe("customer saves waiting to go through (owner's dad, 2026-11-01)", () => {
  it("keeps one waiting save per phone, newest name, and never drops an address", () => {
    let queue = mergePending([], { phone: "5085556117", first_name: "Destinie", last_name: "", email: "", address }, 1);
    queue = mergePending(queue, { phone: "5085550504", first_name: "Carl", last_name: "", email: "" }, 2);
    queue = mergePending(queue, { phone: "5085556117", first_name: "Destiny", last_name: "Ray", email: "" }, 3);
    expect(queue).toHaveLength(2);
    expect(queue.find((item) => item.payload.phone === "5085556117")).toEqual({
      queuedAt: 3, payload: { phone: "5085556117", first_name: "Destiny", last_name: "Ray", email: "", address },
    });
  });

  it("a blank newer name never wipes the one waiting", () => {
    const queue = mergePending(mergePending([], { phone: "5085559957", first_name: "Ahmed", last_name: "", email: "" }, 1), { phone: "5085559957", first_name: "", last_name: "", email: "", address }, 2);
    expect(queue[0]!.payload).toMatchObject({ first_name: "Ahmed", address });
  });
});
