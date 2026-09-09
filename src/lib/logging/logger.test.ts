import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger";

describe("structured logger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits parseable JSON with context", () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logger.info("request complete", { correlation_id: "request-1", status: 200 });
    const entry = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(entry).toMatchObject({ level: "info", message: "request complete", correlation_id: "request-1", status: 200 });
  });

  it("does not serialize stack traces or arbitrary error properties", () => {
    const write = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logger.error("request failed", new Error("safe message"));
    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain("safe message");
    expect(output).not.toContain("stack");
  });
});
