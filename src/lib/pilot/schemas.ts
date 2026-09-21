import { z } from "zod";

export const pilotResultSchema = z.enum(["pass", "fail", "not_applicable"]);

export const pilotCheckSchema = z.object({
  key: z.string(),
  section: z.string(),
  label: z.string(),
  detail: z.string(),
  required: z.boolean(),
  result: pilotResultSchema.nullable(),
  note: z.string(),
  checked_by: z.string().nullable(),
  checked_at: z.string().nullable(),
});
export type PilotCheck = z.infer<typeof pilotCheckSchema>;

export const pilotRecordSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{3,60}$/),
  result: z.union([pilotResultSchema, z.literal("")]),
  note: z.string().trim().max(1000),
});

/**
 * The go-live answer for the Thrive side-by-side pilot (build sheet Phase 9:
 * "Do not remove Thrive until the new POS is proven reliable").  GO only when
 * every required check has passed and nothing has failed.
 */
export function pilotDecision(checks: PilotCheck[]) {
  const required = checks.filter((check) => check.required);
  const failed = checks.filter((check) => check.result === "fail");
  const open = required.filter((check) => check.result !== "pass");
  const passed = required.length - open.length;
  return {
    go: failed.length === 0 && open.length === 0 && required.length > 0,
    failed,
    open,
    passed,
    required: required.length,
  };
}
