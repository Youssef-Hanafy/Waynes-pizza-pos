import { z } from "zod";
export const printJobSchema = z.object({
  id: z.uuid(), order_id: z.uuid(), destination: z.string(), job_type: z.string(),
  payload: z.record(z.string(), z.unknown()), status: z.enum(["pending","processing","printed","failed"]),
  attempts: z.number().int(), last_error: z.string().nullable(),
  lease_token: z.uuid().nullable(), lease_expires_at: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(), printed_at: z.string().nullable(),
});
export type PrintJobRecord = z.infer<typeof printJobSchema>;
